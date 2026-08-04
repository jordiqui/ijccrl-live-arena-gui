// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Jorge Ruiz Centelles
// extract_drr.js — Build a clean DOUBLE RR PGN by pair coverage (1 each colour)
// Usage:
//   node scripts/extract_drr.js "./out/games-full.pgn" "./out/games-official-drr.pgn"

import fs from "node:fs";

const inPath  = process.argv[2];
const outPath = process.argv[3];

if (!inPath || !outPath) {
  console.error("Usage: node extract_drr.js <input.pgn> <output.pgn>");
  process.exit(1);
}

const FINAL = new Set(["1-0", "0-1", "1/2-1/2", "0.5-0.5"]);

function splitGames(pgnText) {
  const t = String(pgnText || "").replace(/\r/g, "").trim();
  if (!t) return [];
  return t.split(/\n\s*\n(?=\[Event\s")/g).map(s => s.trim()).filter(Boolean);
}
function tag(game, name) {
  const re = new RegExp(`\\[${name}\\s+"([^"]*)"\\]`, "i");
  const m = game.match(re);
  return m ? m[1].trim() : "";
}
function pairKey(a,b){ return a < b ? `${a}|||${b}` : `${b}|||${a}`; }

const raw = fs.readFileSync(inPath, "utf8");
const games = splitGames(raw);

// collect games by direction
const directed = new Map(); // "W|||B" -> array of games
const engines = new Set();

for (const g of games) {
  const w = tag(g, "White");
  const b = tag(g, "Black");
  const r = tag(g, "Result");
  const blocked = tag(g, "IJCCRL_ResultBlocked"); // if you ever use it
  if (!w || !b) continue;
  if (!FINAL.has(r)) continue;
  if (blocked) continue;

  engines.add(w); engines.add(b);
  const k = `${w}|||${b}`;
  if (!directed.has(k)) directed.set(k, []);
  directed.get(k).push(g);
}

const engList = Array.from(engines).sort((a,b)=>a.localeCompare(b));
const N = engList.length;
const expectedPairs = (N * (N-1)) / 2;

const selected = [];
const missing = [];

for (let i=0;i<N;i++){
  for (let j=i+1;j<N;j++){
    const a = engList[i], b = engList[j];
    const g1 = (directed.get(`${a}|||${b}`) || []).shift();
    const g2 = (directed.get(`${b}|||${a}`) || []).shift();
    if (!g1 || !g2){
      missing.push({ pair:`${a} vs ${b}`, needAasW: !g1, needBasW: !g2 });
      continue;
    }
    selected.push(g1, g2);
  }
}

// write output
fs.writeFileSync(outPath, selected.join("\n\n") + "\n", "utf8");

// report
console.log("Engines:", N, "Expected pairs:", expectedPairs);
console.log("Selected games:", selected.length, "Expected DRR games:", N*(N-1));
if (missing.length){
  console.log("MISSING PAIRS/DIRECTIONS:", missing.length);
  const repPath = outPath.replace(/\.pgn$/i, "") + "_missing.json";
  fs.writeFileSync(repPath, JSON.stringify(missing, null, 2), "utf8");
  console.log("Wrote:", repPath);
} else {
  console.log("OK: clean DOUBLE RR built.");
}

// quick per-engine count check
const cnt = new Map();
function inc(e){ cnt.set(e, (cnt.get(e)||0)+1); }
for (const g of selected){
  inc(tag(g,"White"));
  inc(tag(g,"Black"));
}
const rows = Array.from(cnt.entries()).sort((x,y)=>x[1]-y[1]);
console.log("Per-engine games (should all be", (N-1)*2, "):");
for (const [e,v] of rows) console.log(v, e);