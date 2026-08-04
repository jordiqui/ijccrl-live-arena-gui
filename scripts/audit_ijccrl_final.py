#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Jorge Ruiz Centelles
# audit_ijccrl_final.py
# IJCCRL - Tournament audit from out/games.pgn (+ optional out/results.json and out/scheduler_state.json)
#
# Usage:
#   python audit_ijccrl_final.py out/games.pgn
#   python audit_ijccrl_final.py out/games.pgn --results out/results.json --state out/scheduler_state.json --write audit_out
#
# Output:
#   - Prints a PASS/WARN/ALERT style report to stdout
#   - Optionally writes audit_report.json + audit_report.md + audit_snippet.html in --write dir
#
# No third-party dependencies.

from __future__ import annotations
import argparse
import dataclasses
import hashlib
import json
import os
import re
from collections import Counter, defaultdict
from datetime import datetime
from typing import Dict, List, Tuple, Optional, Any

TAG_RE = re.compile(r'^\[([A-Za-z0-9_]+)\s+\"(.*)\"\]\s*$')

FINAL_RESULTS = {"1-0", "0-1", "1/2-1/2", "0.5-0.5"}
FINAL_OR_STAR = set(FINAL_RESULTS) | {"*"}

def split_pgn_games(text: str) -> List[str]:
    t = text.replace("\r", "")
    chunks = re.split(r"\n\s*\n(?=\[)", t)
    return [c.strip() for c in chunks if c.strip()]

def parse_tags(game_chunk: str) -> Dict[str, str]:
    tags: Dict[str, str] = {}
    for line in game_chunk.split("\n"):
        line = line.strip()
        if not line.startswith("["):
            break
        m = TAG_RE.match(line)
        if m:
            tags[m.group(1)] = m.group(2)
    return tags

def movetext_from_chunk(game_chunk: str) -> str:
    lines = game_chunk.replace("\r", "").split("\n")
    i = 0
    while i < len(lines) and lines[i].strip().startswith("["):
        i += 1
    return "\n".join(lines[i:]).strip()

def norm_ws(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").strip())

def sha256_hex(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8", errors="replace")).hexdigest()

def sev_rank(sev: str) -> int:
    sev = (sev or "").lower()
    return {"pass": 0, "warn": 1, "alert": 2}.get(sev, 1)

def worse(a: str, b: str) -> str:
    return a if sev_rank(a) >= sev_rank(b) else b

def parse_int(s: str) -> Optional[int]:
    try:
        s2 = str(s).strip()
        if s2 == "":
            return None
        return int(float(s2))
    except Exception:
        return None

def get_any(tags: Dict[str, str], keys: List[str], default: str = "") -> str:
    for k in keys:
        v = tags.get(k, "")
        if str(v).strip() != "":
            return str(v).strip()
    return default

@dataclasses.dataclass
class Game:
    idx: int
    tags: Dict[str, str]
    white: str
    black: str
    result: str
    termination: str
    cycle: str
    pair_index: str
    pair_game_no: str
    opening_index: Optional[int]
    opening_ref: str
    opening_block: str
    round_tag: str
    time_control: str
    phase: str
    blocked: bool
    movetext_norm: str
    fp_d1: str
    fp_d2: str

def parse_games(pgn_path: str) -> List[Game]:
    raw = open(pgn_path, "r", encoding="utf-8", errors="replace").read()
    chunks = split_pgn_games(raw)
    out: List[Game] = []
    for i, ch in enumerate(chunks, start=1):
        tags = parse_tags(ch)
        white = get_any(tags, ["White"], "")
        black = get_any(tags, ["Black"], "")
        result = get_any(tags, ["Result"], "")
        termination = get_any(tags, ["Termination", "IJCCRL_Termination", "IJCCRL_EndReason", "EndReason"], "")
        cycle = get_any(tags, ["IJCCRL_Cycle", "Cycle"], "")
        pair_index = get_any(tags, ["IJCCRL_PairIndex", "PairIndex"], "")
        pair_game_no = get_any(tags, ["IJCCRL_PairGameNo", "IJCCRL_PairGame", "PairGameNo", "PairGame"], "")
        opening_index = parse_int(get_any(tags, ["IJCCRL_OpeningIndex", "OpeningIndex"], ""))
        opening_block = get_any(tags, ["IJCCRL_OpeningBlock", "OpeningBlock", "ECO"], "")
        opening_ref = get_any(tags, ["Annotator", "OpeningRef"], "")
        round_tag = get_any(tags, ["Round", "IJCCRL_Round"], "")
        tc = get_any(tags, ["TimeControl"], "")
        phase = get_any(tags, ["IJCCRL_Phase", "Phase"], "")

        blocked = bool(re.search(r'\[IJCCRL_ResultBlocked\s+\"[^\"]+\"\]', ch, re.IGNORECASE))

        movetext = movetext_from_chunk(ch)
        moves_uci = get_any(tags, ["MovesUCI", "MovesUci", "Moves"], "")
        movetext_norm = norm_ws(movetext + (" | uci:" + moves_uci if moves_uci else ""))

        fp_d2 = sha256_hex(movetext_norm)
        key_bits = [
            norm_ws(white), norm_ws(black), norm_ws(result), norm_ws(tc),
            norm_ws(phase), norm_ws(cycle), norm_ws(pair_index), norm_ws(pair_game_no),
            str(opening_index or ""), norm_ws(opening_block), norm_ws(opening_ref),
        ]
        fp_d1 = sha256_hex("|".join(key_bits) + "||" + movetext_norm)

        out.append(Game(
            idx=i, tags=tags, white=white, black=black, result=result,
            termination=termination, cycle=cycle, pair_index=pair_index, pair_game_no=pair_game_no,
            opening_index=opening_index, opening_ref=opening_ref, opening_block=opening_block,
            round_tag=round_tag, time_control=tc, phase=phase, blocked=blocked,
            movetext_norm=movetext_norm, fp_d1=fp_d1, fp_d2=fp_d2
        ))
    return out

def check_mandatory_tags(games: List[Game]) -> Dict[str, Any]:
    core = ["Event", "Site", "Date", "Round", "White", "Black", "Result", "TimeControl"]
    ijccrl = ["IJCCRL_Phase", "IJCCRL_Cycle", "IJCCRL_PairIndex", "IJCCRL_PairGameNo", "IJCCRL_OpeningIndex"]
    extra = ["Termination", "IJCCRL_DurationMs", "IJCCRL_TBHitsTotal"]

    def missing_for(tag: str) -> int:
        c = 0
        for g in games:
            if g.blocked:
                continue
            if tag == "IJCCRL_Phase":
                v = g.phase
            elif tag == "IJCCRL_Cycle":
                v = g.cycle
            elif tag == "IJCCRL_PairIndex":
                v = g.pair_index
            elif tag == "IJCCRL_PairGameNo":
                v = g.pair_game_no
            elif tag == "IJCCRL_OpeningIndex":
                v = "" if g.opening_index is None else str(g.opening_index)
            elif tag == "Termination":
                v = g.termination
            else:
                v = g.tags.get(tag, "")
            if str(v).strip() == "":
                c += 1
        return c

    total = sum(0 if g.blocked else 1 for g in games)
    core_m = {t: missing_for(t) for t in core}
    ij_m = {t: missing_for(t) for t in ijccrl}
    ex_m = {t: missing_for(t) for t in extra}

    sev = "pass"
    if any(core_m[t] > 0 for t in core):
        sev = "alert"

    ij_missing_total = sum(ij_m.values())
    if ij_missing_total > 0:
        sev = worse(sev, "warn")
        if ij_missing_total > max(3, int(total * 0.05)):
            sev = worse(sev, "alert")

    return {"severity": sev, "total": total, "core_missing": core_m, "ijccrl_missing": ij_m, "extra_missing": ex_m}

def check_results_complete(games: List[Game]) -> Dict[str, Any]:
    nonfinal = [g.idx for g in games if (not g.blocked and g.result not in FINAL_RESULTS)]
    sev = "pass" if not nonfinal else ("alert" if len(nonfinal) >= 2 else "warn")
    return {"severity": sev, "count": len(nonfinal), "examples": nonfinal[:20]}

def check_openingindex_monotone(games: List[Game]) -> Dict[str, Any]:
    seq = [(g.idx, g.opening_index) for g in games if (not g.blocked and g.opening_index is not None)]
    dec = []
    prev = None
    for idx, v in seq:
        if prev is not None and v < prev:
            dec.append({"game": idx, "to": v, "prev": prev})
        prev = v
    jumps = []
    prev = None
    for idx, v in seq:
        if prev is not None:
            d = v - prev
            if d != 1:
                jumps.append({"game": idx, "delta": d, "from": prev, "to": v})
        prev = v

    sev = "pass"
    if dec:
        sev = "alert"
    elif jumps:
        sev = "warn"
        if len(jumps) > 10:
            sev = "alert"

    return {"severity": sev, "with_opening_index": len(seq), "decreases": dec[:50], "non_unit_steps": jumps[:50], "decrease_count": len(dec), "jump_count": len(jumps)}

def check_triplet_uniqueness(games: List[Game]) -> Dict[str, Any]:
    seen = {}
    dups = []
    for g in games:
        if g.blocked:
            continue
        key = (str(g.cycle).strip(), str(g.pair_index).strip(), str(g.pair_game_no).strip())
        if key == ("", "", ""):
            continue
        if key in seen:
            dups.append({"first": seen[key], "dup": g.idx, "cycle": key[0], "pairIndex": key[1], "pairGameNo": key[2]})
        else:
            seen[key] = g.idx
    return {"severity": ("pass" if not dups else "alert"), "count": len(dups), "examples": dups[:50]}

def check_pair_mirror(games: List[Game]) -> Dict[str, Any]:
    groups: Dict[Tuple[str, str], List[Game]] = defaultdict(list)
    for g in games:
        if g.blocked:
            continue
        if str(g.cycle).strip() and str(g.pair_index).strip():
            groups[(str(g.cycle).strip(), str(g.pair_index).strip())].append(g)

    missing_leg = []
    not_swapped = []
    opening_mismatch = []

    for (cy, pi), lst in groups.items():
        by_no = {}
        for g in lst:
            by_no[str(g.pair_game_no).strip()] = g

        if "1" not in by_no or "2" not in by_no:
            missing_leg.append({"cycle": cy, "pairIndex": pi, "present": sorted(by_no.keys()), "games": [g.idx for g in lst]})
            continue

        g1, g2 = by_no["1"], by_no["2"]

        if not (norm_ws(g1.white) == norm_ws(g2.black) and norm_ws(g1.black) == norm_ws(g2.white)):
            not_swapped.append({"cycle": cy, "pairIndex": pi, "g1": g1.idx, "g2": g2.idx, "g1W": g1.white, "g1B": g1.black, "g2W": g2.white, "g2B": g2.black})

        if g1.opening_ref and g2.opening_ref and norm_ws(g1.opening_ref) != norm_ws(g2.opening_ref):
            opening_mismatch.append({"cycle": cy, "pairIndex": pi, "g1": g1.idx, "g2": g2.idx, "ref1": g1.opening_ref, "ref2": g2.opening_ref})

        if g1.opening_block and g2.opening_block and norm_ws(g1.opening_block) != norm_ws(g2.opening_block):
            opening_mismatch.append({"cycle": cy, "pairIndex": pi, "g1": g1.idx, "g2": g2.idx, "ob1": g1.opening_block, "ob2": g2.opening_block})

    sev = "pass"
    if missing_leg:
        sev = worse(sev, "warn")
    if not_swapped:
        sev = worse(sev, "alert")
    if opening_mismatch:
        sev = worse(sev, "warn")
    return {
        "severity": sev,
        "groups": len(groups),
        "missing_leg_count": len(missing_leg),
        "not_swapped_count": len(not_swapped),
        "opening_mismatch_count": len(opening_mismatch),
        "missing_leg": missing_leg[:50],
        "not_swapped": not_swapped[:50],
        "opening_mismatch": opening_mismatch[:50],
    }

def check_duplicates(games: List[Game]) -> Dict[str, Any]:
    d1 = defaultdict(list)
    d2 = defaultdict(list)
    for g in games:
        if g.blocked:
            continue
        d1[g.fp_d1].append(g.idx)
        d2[g.fp_d2].append(g.idx)

    dup1 = [v for v in d1.values() if len(v) > 1]
    dup2 = [v for v in d2.values() if len(v) > 1]

    sev = "pass"
    if dup1:
        sev = worse(sev, "alert")
    if dup2:
        sev = worse(sev, "warn")

    return {"severity": sev, "dup_d1_count": len(dup1), "dup_d2_count": len(dup2), "dup_d1_examples": dup1[:20], "dup_d2_examples": dup2[:20]}

def colour_balance(games: List[Game]) -> Dict[str, Any]:
    wc = Counter(); bc = Counter(); tot = Counter()
    for g in games:
        if g.blocked:
            continue
        if g.white: wc[g.white] += 1; tot[g.white] += 1
        if g.black: bc[g.black] += 1; tot[g.black] += 1

    rows = []
    for e in sorted(tot.keys()):
        rows.append({"engine": e, "white": wc[e], "black": bc[e], "total": tot[e], "diff": wc[e]-bc[e]})
    rows.sort(key=lambda r: (abs(r["diff"]), r["total"], r["engine"]), reverse=True)

    worst_abs = abs(rows[0]["diff"]) if rows else 0
    sev = "pass"
    if worst_abs >= 2: sev = "warn"
    if worst_abs >= 4: sev = "alert"
    return {"severity": sev, "engines": len(rows), "worst_abs_diff": worst_abs, "top": rows[:30]}

def pair_ratio(games: List[Game]) -> Dict[str, Any]:
    directed = Counter()
    und = Counter()
    for g in games:
        if g.blocked:
            continue
        a, b = g.white, g.black
        if not a or not b:
            continue
        directed[(a,b)] += 1
        und[tuple(sorted((a,b)))] += 1

    imbs = []
    for (a,b), tot in und.items():
        ab = directed[(a,b)]
        ba = directed[(b,a)]
        diff = abs(ab-ba)
        imbs.append({"a": a, "b": b, "a_as_white": ab, "b_as_white": ba, "total": tot, "diff": diff})
    imbs.sort(key=lambda x: (x["diff"], x["total"]), reverse=True)

    sev = "pass"
    if imbs and imbs[0]["diff"] >= 2: sev = "warn"
    if imbs and imbs[0]["diff"] >= 4: sev = "alert"
    return {"severity": sev, "pairs": len(imbs), "top": imbs[:40]}

def termination_coverage(games: List[Game]) -> Dict[str, Any]:
    c = Counter()
    for g in games:
        if g.blocked:
            continue
        c[(g.termination.strip() or "(missing)")] += 1
    miss = c.get("(missing)", 0)
    sev = "pass"
    if miss > 0: sev = "warn"
    if miss > 5: sev = "alert"
    return {"severity": sev, "missing": miss, "top": c.most_common(30)}

def tb_evidence(games: List[Game]) -> Dict[str, Any]:
    with_hits = 0
    hits_sum = 0
    with_reported = 0
    for g in games:
        if g.blocked:
            continue
        t = str(g.tags.get("IJCCRL_TBHitsTotal", "")).strip()
        if t:
            v = parse_int(t)
            if v is not None:
                hits_sum += v
                if v > 0:
                    with_hits += 1
        rw = str(g.tags.get("IJCCRL_TBReportedWhite","")).strip().lower()
        rb = str(g.tags.get("IJCCRL_TBReportedBlack","")).strip().lower()
        if rw in ("1","true","yes","y") or rb in ("1","true","yes","y"):
            with_reported += 1
    return {"severity": "pass", "games_with_tb_hits": with_hits, "tb_hits_total_sum": hits_sum, "games_with_tb_reported_flag": with_reported}

def load_json(path: str) -> Any:
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        return json.load(f)

def results_json_consistency(games: List[Game], results_path: str) -> Dict[str, Any]:
    try:
        j = load_json(results_path)
    except Exception as e:
        return {"severity": "warn", "notes": [f"Failed to read results.json: {e}"]}

    notes = []
    sev = "pass"

    pgn_count = sum(0 if g.blocked else 1 for g in games)
    js_games = j.get("games") if isinstance(j, dict) else None
    if isinstance(js_games, list):
        if len(js_games) != pgn_count:
            sev = worse(sev, "warn")
            notes.append(f"Game count mismatch: PGN={pgn_count} vs results.json games={len(js_games)}")
    else:
        sev = worse(sev, "warn")
        notes.append("results.json has no 'games' array (skip deep cross-check).")

    return {"severity": sev, "notes": (notes or ["OK"])}

def escape_html(s: str) -> str:
    return (s or "").replace("&","&amp;").replace("<","&lt;").replace(">","&gt;").replace('"',"&quot;").replace("'","&#39;")

def build_markdown(report: Dict[str, Any]) -> str:
    lines = []
    lines.append("# IJCCRL Tournament Audit")
    lines.append("")
    lines.append(f"- Generated: {report['generated_at']}")
    lines.append(f"- PGN: `{report['pgn_path']}`")
    if report.get("results_path"):
        lines.append(f"- results.json: `{report['results_path']}`")
    if report.get("state_path"):
        lines.append(f"- scheduler_state.json: `{report['state_path']}`")
    lines.append("")
    lines.append(f"## Overall verdict: **{report['overall_severity'].upper()}**")
    lines.append("")
    for s in report["sections"]:
        lines.append(f"### {s['title']} - **{s['severity'].upper()}**")
        for ln in s["lines"]:
            lines.append(f"- {ln}")
        lines.append("")
    return "\n".join(lines)

def build_html_snippet(report: Dict[str, Any]) -> str:
    rows_html = "\n".join([
        f"<tr><td>{escape_html(s['title'])}</td><td><strong>{escape_html(s['severity'].upper())}</strong></td></tr>"
        for s in report["sections"]
    ])
    return f"""<!-- IJCCRL - Tournament Audit Summary (auto) -->
<div style=\"background:#0b1220;border:1px solid rgba(148,163,184,.22);border-radius:16px;padding:14px 16px;color:#e5e7eb;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;\">
  <div style=\"display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between;\">
    <div style=\"font-weight:800;letter-spacing:.3px\">IJCCRL Tournament Audit</div>
    <div style=\"opacity:.85;font-size:12px\">Generated: {escape_html(report['generated_at'])}</div>
  </div>
  <div style=\"margin-top:10px;display:flex;flex-wrap:wrap;gap:8px\">
    <span style=\"padding:6px 10px;border-radius:999px;background:rgba(11,95,255,.18);border:1px solid rgba(11,95,255,.35)\"><strong>Verdict:</strong> {escape_html(report['overall_severity'].upper())}</span>
    <span style=\"padding:6px 10px;border-radius:999px;background:rgba(34,197,94,.10);border:1px solid rgba(34,197,94,.25)\"><strong>Games:</strong> {report['games_count']}</span>
    <span style=\"padding:6px 10px;border-radius:999px;background:rgba(148,163,184,.08);border:1px solid rgba(148,163,184,.22)\"><strong>Engines:</strong> {report['engines_count']}</span>
  </div>
  <div style=\"margin-top:12px;overflow:auto\">
    <table style=\"width:100%;border-collapse:collapse;font-size:13px\">
      <thead><tr><th style=\"text-align:left;padding:8px;border-bottom:1px solid rgba(148,163,184,.22)\">Check</th><th style=\"text-align:left;padding:8px;border-bottom:1px solid rgba(148,163,184,.22)\">Status</th></tr></thead>
      <tbody>
        {rows_html}
      </tbody>
    </table>
  </div>
  <div style=\"margin-top:10px;font-size:12px;opacity:.8\">
    <div><strong>PGN SHA256:</strong> <code style=\"color:#e5e7eb\">{escape_html(report['pgn_sha256'])}</code></div>
  </div>
</div>
"""

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("pgn", help="Path to out/games.pgn (or any PGN you want to audit)")
    ap.add_argument("--results", default="", help="Optional: out/results.json")
    ap.add_argument("--state", default="", help="Optional: out/scheduler_state.json")
    ap.add_argument("--write", default="", help="Optional: output directory")
    args = ap.parse_args()

    games = parse_games(args.pgn)
    counted = [g for g in games if not g.blocked]
    engines = sorted(set([g.white for g in counted if g.white] + [g.black for g in counted if g.black]))

    sections = []

    def add(title: str, payload: Dict[str, Any], lines: List[str]):
        sections.append({"title": title, "severity": payload["severity"], "lines": lines, "payload": payload})

    m = check_mandatory_tags(counted)
    add("Mandatory tags", m, [
        f"Counted games: {m['total']}",
        "Core missing: " + ", ".join([f"{k}={v}" for k,v in m["core_missing"].items() if v]) or "Core missing: none",
        "IJCCRL missing: " + ", ".join([f"{k}={v}" for k,v in m["ijccrl_missing"].items() if v]) or "IJCCRL missing: none",
    ])

    rc = check_results_complete(counted)
    add("Results complete", rc, [f"Non-final Result tags: {rc['count']}" + (f" (examples: {rc['examples']})" if rc["count"] else "")])

    mono = check_openingindex_monotone(counted)
    add("OpeningIndex monotonicity", mono, [
        f"Games with OpeningIndex: {mono['with_opening_index']}",
        f"Decreases: {mono['decrease_count']}",
        f"Non-unit steps: {mono['jump_count']}",
    ])

    tr = check_triplet_uniqueness(counted)
    add("Triplet uniqueness (cycle,pairIndex,pairGameNo)", tr, [f"Duplicates: {tr['count']}"] + ([f"Example: {tr['examples'][0]}"] if tr["count"] else []))

    pm = check_pair_mirror(counted)
    add("Pair mirror (leg 1/2 swap + opening consistency)", pm, [
        f"Pair groups: {pm['groups']}",
        f"Missing a leg: {pm['missing_leg_count']}",
        f"Not swapped: {pm['not_swapped_count']}",
        f"Opening mismatch: {pm['opening_mismatch_count']}",
    ])

    dp = check_duplicates(counted)
    add("Duplicate detection (D1/D2)", dp, [
        f"Duplicate D1 groups: {dp['dup_d1_count']}",
        f"Duplicate D2 groups: {dp['dup_d2_count']}",
    ])

    cb = colour_balance(counted)
    add("Colour balance per engine", cb, [
        f"Engines: {cb['engines']}",
        f"Worst |W-B|: {cb['worst_abs_diff']}",
        "Top diffs: " + "; ".join([f"{r['engine']}({r['diff']:+d})" for r in cb["top"][:8]]) if cb["top"] else "Top diffs: n/a",
    ])

    pr = pair_ratio(counted)
    add("Pair ratio (A-B vs B-A)", pr, [
        f"Distinct pairs: {pr['pairs']}",
        "Top diffs: " + "; ".join([f"{x['a']} vs {x['b']} diff={x['diff']} tot={x['total']}" for x in pr["top"][:8]]) if pr["top"] else "Top diffs: n/a",
    ])

    tc = termination_coverage(counted)
    add("Termination coverage", tc, [
        f"Missing Termination tag: {tc['missing']}",
        "Top terminations: " + "; ".join([f"{k}={v}" for k,v in tc["top"][:10]]),
    ])

    tb = tb_evidence(counted)
    add("Tablebase evidence (optional)", tb, [
        f"Games with TBHitsTotal>0: {tb['games_with_tb_hits']}",
        f"TBHitsTotal sum: {tb['tb_hits_total_sum']}",
        f"Games with TBReported flag: {tb['games_with_tb_reported_flag']}",
    ])

    if args.results:
        rj = results_json_consistency(counted, args.results)
        add("results.json consistency (optional)", rj, rj["notes"])

    overall = "pass"
    for s in sections:
        overall = worse(overall, s["severity"])

    pgn_sha = hashlib.sha256(open(args.pgn, "rb").read()).hexdigest()

    report = {
        "generated_at": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
        "pgn_path": args.pgn,
        "results_path": args.results,
        "state_path": args.state,
        "games_count": len(counted),
        "engines_count": len(engines),
        "pgn_sha256": pgn_sha,
        "overall_severity": overall,
        "sections": [{"title": s["title"], "severity": s["severity"], "lines": s["lines"]} for s in sections],
        "details": {s["title"]: s["payload"] for s in sections},
    }

    # Print
    print(f"[{overall.upper()}] OVERALL")
    print(f"Games counted: {report['games_count']} | Engines: {report['engines_count']}")
    print(f"PGN SHA256: {pgn_sha}\n")
    for s in sections:
        print(f"[{s['severity'].upper()}] {s['title']}")
        for ln in s["lines"]:
            print("  - " + str(ln))
        print("")

    if args.write:
        os.makedirs(args.write, exist_ok=True)
        with open(os.path.join(args.write, "audit_report.json"), "w", encoding="utf-8") as f:
            json.dump(report, f, indent=2, ensure_ascii=False)
        with open(os.path.join(args.write, "audit_report.md"), "w", encoding="utf-8") as f:
            f.write(build_markdown(report))
        with open(os.path.join(args.write, "audit_snippet.html"), "w", encoding="utf-8") as f:
            f.write(build_html_snippet(report))
        print(f"Wrote audit outputs to: {args.write}")

    return 0 if overall != "alert" else 2

if __name__ == "__main__":
    raise SystemExit(main())
