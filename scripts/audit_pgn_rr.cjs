// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Jorge Ruiz Centelles
// audit_pgn_rr.cjs
// IJCCRL PGN Auditor — Round/Cycle ECO consistency + Pair legs integrity
//
// Usage:
//   node scripts/audit_pgn_rr.cjs "./out/games.pgn"
//
// What it checks:
// - Total games count
// - Engines count (from [White]/[Black])
// - Whether tournament looks like single RR or double RR (based on IJCCRL_PairGameNo presence of "2")
// - Expected game count (N*(N-1)/2 for single, N*(N-1) for double)
// - Per-cycle: all games share the same ECO (or at least no multiple ECOs)
// - For each (Cycle, PairIndex): it expects PairGameNo 1 and 2, and colour swap between legs
// - Reports missing/duplicate legs and likely missing game(s)

const fs = require("fs");
const path = require("path");

function die(msg) {
  console.error("ERROR:", msg);
  process.exit(1);
}

function readText(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch (e) {
    die(`Cannot read file: ${p} (${e && e.message ? e.message : e})`);
  }
}

function splitPgnGames(pgnText) {
  const t = String(pgnText || "").replace(/\r/g, "").trim();
  if (!t) return [];
  // Split on blank line before a new [Event ...]
  return t.split(/\n\s*\n(?=\[Event\s)/g).map(s => s.trim()).filter(Boolean);
}

function getTag(game, tag) {
  // tag is case-sensitive-ish in PGN; make it case-insensitive
  const esc = String(tag).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp("^\\[" + esc + "\\s+\"([^\"]*)\"\\]\\s*$", "im");
  const m = String(game).match(re);
  return m ? String(m[1] ?? "").trim() : "";
}

function norm(s) {
  return String(s ?? "").trim().replace(/\s+/g, " ");
}

function toIntOrNull(s) {
  const n = Number(String(s ?? "").trim());
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function pairKeyUnordered(a, b) {
  const A = norm(a), B = norm(b);
  return (A <= B) ? `${A}__VS__${B}` : `${B}__VS__${A}`;
}

function main() {
  const pgnPath = process.argv[2];
  if (!pgnPath) {
    die('Missing PGN path. Example: node audit_pgn_rr.cjs "./out/games.pgn"');
  }

  const abs = path.resolve(pgnPath);
  const raw = readText(abs);
  const games = splitPgnGames(raw);

  if (!games.length) {
    die("No games found in PGN (file empty or split failed).");
  }

  const engines = new Set();

  // Per cycle: ECO set
  const cycleEco = new Map(); // cycle -> Set(ECO)
  const cycleCount = new Map(); // cycle -> count

  // Pair legs integrity:
  // key = cycle|pairIndex|unorderedPair  -> { leg1:{w,b}, leg2:{w,b}, seen:[...] }
  const pairLegs = new Map();

  // Some stats
  let haveCycleTags = 0;
  let havePairIndexTags = 0;
  let havePairGameNoTags = 0;
  let leg2Seen = 0;

  // Track weird/missing tags
  let missingCycle = 0;
  let missingPairIndex = 0;
  let missingPairGameNo = 0;

  // Track if there are duplicated tags / same (cycle,pairIndex,pairGameNo,white,black)
  const gameSigSet = new Set();
  let dupSig = 0;

  for (let i = 0; i < games.length; i++) {
    const g = games[i];

    const white = norm(getTag(g, "White"));
    const black = norm(getTag(g, "Black"));
    const eco = norm(getTag(g, "ECO"));

    const cycleRaw = getTag(g, "IJCCRL_Cycle");
    const pairIndexRaw = getTag(g, "IJCCRL_PairIndex");
    const pairGameNoRaw = getTag(g, "IJCCRL_PairGameNo");

    const cycle = toIntOrNull(cycleRaw);
    const pairIndex = toIntOrNull(pairIndexRaw);
    const pairGameNo = toIntOrNull(pairGameNoRaw);

    if (white) engines.add(white);
    if (black) engines.add(black);

    if (cycle != null) haveCycleTags++; else missingCycle++;
    if (pairIndex != null) havePairIndexTags++; else missingPairIndex++;
    if (pairGameNo != null) havePairGameNoTags++; else missingPairGameNo++;

    if (pairGameNo === 2) leg2Seen++;

    // Per-cycle ECO set
    if (cycle != null) {
      const key = String(cycle);
      if (!cycleEco.has(key)) cycleEco.set(key, new Set());
      if (eco) cycleEco.get(key).add(eco);
      if (!cycleCount.has(key)) cycleCount.set(key, 0);
      cycleCount.set(key, cycleCount.get(key) + 1);
    }

    // Pair legs map (only if tags exist)
    if (cycle != null && pairIndex != null && pairGameNo != null && white && black) {
      const unordered = pairKeyUnordered(white, black);
      const k = `c=${cycle}|p=${pairIndex}|u=${unordered}`;
      if (!pairLegs.has(k)) pairLegs.set(k, { cycle, pairIndex, unordered, leg1: null, leg2: null, seen: [] });

      const rec = pairLegs.get(k);

      if (pairGameNo === 1) rec.leg1 = { w: white, b: black };
      else if (pairGameNo === 2) rec.leg2 = { w: white, b: black };

      rec.seen.push({ pairGameNo, w: white, b: black });
    }

    // Duplicate signature (helps spot re-writes)
    const sig = `i=${i}|c=${cycleRaw}|p=${pairIndexRaw}|g=${pairGameNoRaw}|w=${white}|b=${black}|eco=${eco}`;
    if (gameSigSet.has(sig)) dupSig++;
    else gameSigSet.add(sig);
  }

  const N = engines.size;

  // Determine if it's double RR:
  // If we see any IJCCRL_PairGameNo=2, treat as double; else single.
  const looksDouble = leg2Seen > 0;
  const expected = (N >= 2)
    ? (looksDouble ? (N * (N - 1)) : (N * (N - 1) / 2))
    : null;

  console.log("==== IJCCRL PGN AUDIT ====");
  console.log("PGN:", abs);
  console.log("Games:", games.length);
  console.log("Engines (unique from tags):", N);
  console.log("Tags coverage:",
    `IJCCRL_Cycle=${haveCycleTags}/${games.length} (missing ${missingCycle})`,
    `IJCCRL_PairIndex=${havePairIndexTags}/${games.length} (missing ${missingPairIndex})`,
    `IJCCRL_PairGameNo=${havePairGameNoTags}/${games.length} (missing ${missingPairGameNo})`
  );
  console.log("Detected format:", looksDouble ? "DOUBLE RR (leg 1/2 present)" : "SINGLE RR (no leg 2 detected)");
  if (expected != null) {
    console.log("Expected games:", expected, "=> delta:", (games.length - expected));
  }
  if (dupSig) console.log("WARNING: duplicate signatures detected:", dupSig);

  // Per-cycle ECO consistency
  console.log("\n---- Per-cycle ECO check ----");
  const cycleKeys = Array.from(cycleEco.keys()).map(x => Number(x)).filter(Number.isFinite).sort((a,b)=>a-b);
  let ecoOk = 0, ecoBad = 0, ecoEmpty = 0;

  for (const c of cycleKeys) {
    const set = cycleEco.get(String(c)) || new Set();
    const count = cycleCount.get(String(c)) || 0;
    const ecos = Array.from(set).filter(Boolean);

    if (!ecos.length) {
      ecoEmpty++;
      console.log(`Cycle ${c}: games=${count} ECO=EMPTY/UNKNOWN`);
      continue;
    }
    if (ecos.length === 1) {
      ecoOk++;
      console.log(`Cycle ${c}: games=${count} ECO=${ecos[0]} ✅`);
    } else {
      ecoBad++;
      console.log(`Cycle ${c}: games=${count} MULTI-ECO=${ecos.join(", ")} ❌`);
    }
  }

  // Pair legs integrity
  console.log("\n---- Pair legs integrity (Cycle + PairIndex) ----");
  let okPairs = 0, missingLeg = 0, badSwap = 0, noisy = 0;

  const keys = Array.from(pairLegs.keys()).sort();
  for (const k of keys) {
    const rec = pairLegs.get(k);
    const { cycle, pairIndex, unordered } = rec;

    // Sometimes duplicates happen (multiple entries in rec.seen). Mark noisy if >2.
    if (rec.seen.length > 2) noisy++;

    const have1 = !!rec.leg1;
    const have2 = !!rec.leg2;

    if (!have1 || !have2) {
      missingLeg++;
      const have = `have:${have1 ? "1" : ""}${have2 ? "2" : ""}` || "have:none";
      console.log(`Cycle ${cycle} PairIndex ${pairIndex} ${unordered} -> MISSING LEG (${have}) ❌  seen=${rec.seen.map(x=>x.pairGameNo).join(",")}`);
      continue;
    }

    // Check colour swap:
    const l1 = rec.leg1, l2 = rec.leg2;
    const swapOk = (l1.w === l2.b) && (l1.b === l2.w);

    if (!swapOk) {
      badSwap++;
      console.log(`Cycle ${cycle} PairIndex ${pairIndex} ${unordered} -> BAD SWAP ❌  leg1 ${l1.w} vs ${l1.b} | leg2 ${l2.w} vs ${l2.b}`);
      continue;
    }

    okPairs++;
  }

  console.log("\n==== SUMMARY ====");
  console.log("Cycles checked:", cycleKeys.length, `ECO ok=${ecoOk} bad=${ecoBad} empty=${ecoEmpty}`);
  console.log("Pairs checked:", keys.length, `ok=${okPairs} missingLeg=${missingLeg} badSwap=${badSwap} noisy(>2 entries)=${noisy}`);

  // If we expect one more game, try to hint where:
  if (expected != null && games.length !== expected) {
    console.log("\n==== EXPECTATION MISMATCH HINTS ====");
    if (looksDouble && games.length === expected - 1) {
      console.log("You are EXACTLY 1 game short for a full DOUBLE RR.");
      console.log("Most likely: one missing leg (PairGameNo 1 or 2) in the report above.");
      console.log("Search for: 'MISSING LEG' line(s) above — that's your missing game candidate.");
    } else {
      console.log("Game count does not match expected. Possible causes:");
      console.log("- Scheduler stopped early by targets (perEngineGamesTarget) OR a game aborted and not saved.");
      console.log("- Some games are missing IJCCRL tags, so legs can't be matched.");
      console.log("- Duplicate writes / partial PGN blocks.");
    }
  }

  console.log("\nDone.");
}

main();