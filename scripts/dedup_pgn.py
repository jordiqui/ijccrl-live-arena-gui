#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Jorge Ruiz Centelles
# dedup_pgn.py — remove exact duplicate PGN games (same tags+movetext)
# Usage: python scripts/dedup_pgn.py "./out/games.pgn"

import sys, re, hashlib

def split_pgn_games(text: str):
    t = text.replace("\r", "")
    chunks = re.split(r"\n\s*\n(?=\[)", t)
    return [c.strip() for c in chunks if c.strip()]

def normalize_game(chunk: str):
    # Normalize whitespace so exact duplicates match reliably
    lines = [ln.rstrip() for ln in chunk.replace("\r", "").split("\n")]
    # Remove trailing blank lines
    while lines and lines[-1].strip() == "":
        lines.pop()
    return "\n".join(lines).strip() + "\n"

def game_fingerprint(norm_chunk: str):
    # Strong hash of full normalized chunk
    return hashlib.sha256(norm_chunk.encode("utf-8", "replace")).hexdigest()

def main():
    p = sys.argv[1] if len(sys.argv) > 1 else "games.pgn"
    raw = open(p, "r", encoding="utf-8", errors="replace").read()
    chunks = split_pgn_games(raw)

    seen = set()
    out = []
    dup = 0

    for c in chunks:
        n = normalize_game(c)
        h = game_fingerprint(n)
        if h in seen:
            dup += 1
            continue
        seen.add(h)
        out.append(n)

    out_path = p.rsplit(".", 1)[0] + ".dedup.pgn"
    with open(out_path, "w", encoding="utf-8", errors="replace") as f:
        f.write("\n".join(out).strip() + "\n")

    print(f"Input games: {len(chunks)}")
    print(f"Removed duplicates: {dup}")
    print(f"Output: {out_path}")

if __name__ == "__main__":
    main()