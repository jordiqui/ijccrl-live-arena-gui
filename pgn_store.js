// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Jorge Ruiz Centelles
// PGNStore (24/7-safe):
// - Append a out/games.pgn
// - Idempotent: dedup by stable GameKey (IJCCRL tags + White/Black/Result)
// - Persistent dedup state: out/seen_games.json (survives reboot)
// - Serialised writes (mutex queue) to avoid concurrent append corruption
// Node ESM ("type": "module")

import fsp from "fs/promises";
import path from "path";
import crypto from "crypto";

function safeName(s){
  return String(s || "")
    .trim()
    .replace(/[^\w\-\.]+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 80) || "engine";
}

function pad2(n){ return String(n).padStart(2, "0"); }

function stampNow(){
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = pad2(d.getMonth() + 1);
  const dd = pad2(d.getDate());
  const hh = pad2(d.getHours());
  const mi = pad2(d.getMinutes());
  return `${yyyy}-${mm}-${dd}-${hh}${mi}`;
}

async function ensureDir(dir){
  await fsp.mkdir(dir, { recursive: true });
}

// Parse PGN tags into a map: { TagName: "value" }
function parsePgnTags(pgnText){
  const s = String(pgnText || "");
  const tags = {};
  // Only parse header tag lines: [Key "Value"]
  const re = /^\s*\[([A-Za-z0-9_]+)\s+"([^"]*)"\]\s*$/gm;
  let m;
  while ((m = re.exec(s)) !== null){
    tags[m[1]] = m[2];
  }
  return tags;
}

function sha1(text){
  return crypto.createHash("sha1").update(String(text), "utf8").digest("hex");
}

// Stable game identity for IJCCRL.
// If these fields are stable, the same finished game will always yield the same key.
function buildGameKeyFromTags(tags){
  const phase = tags.IJCCRL_Phase || "";
  const cycle = tags.IJCCRL_Cycle || "";
  const pair = tags.IJCCRL_PairIndex || "";
  const pairNo = tags.IJCCRL_PairGameNo || "";
  const opIdx = tags.IJCCRL_OpeningIndex || "";
  const white = tags.White || "";
  const black = tags.Black || "";
  const result = tags.Result || "";

  // If any of IJCCRL_* are missing, key still works but is weaker.
  return [
    phase, cycle, pair, pairNo, opIdx,
    white, black, result
  ].join(" | ");
}

async function readJsonSafe(filePath, fallback){
  try{
    const t = await fsp.readFile(filePath, "utf8");
    return JSON.parse(t);
  }catch{
    return fallback;
  }
}

async function writeJsonAtomic(filePath, obj){
  const tmp = filePath + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(obj, null, 2), "utf8");
  await fsp.rename(tmp, filePath);
}

export class PGNStore {
  constructor(opts = {}){
    this.baseDir = opts.baseDir || process.cwd();
    this.outDir = opts.outDir || path.join(this.baseDir, "out");
    this.bundleName = opts.bundleName || "games.pgn";
    this.writePerGame = Boolean(opts.writePerGame ?? true);
    this.debug = Boolean(opts.debug ?? false);

    // Dedup + persistence
    this.dedup = Boolean(opts.dedup ?? true);
    this.seenFileName = opts.seenFileName || "seen_games.json";

    this.bundlePath = path.join(this.outDir, this.bundleName);
    this.seenPath = path.join(this.outDir, this.seenFileName);

    // In-process serialisation queue
    this._q = Promise.resolve();

    // In-memory set of already-written game keys/hashes (loaded from seen file)
    this._seenKeys = new Set();
    this._seenMeta = {}; // key -> { firstSeenTs, pgnSha1, lastWriteTs }
  }

  async init(){
    await ensureDir(this.outDir);
    // touch bundle
    await fsp.appendFile(this.bundlePath, "", "utf8");

    if (this.dedup){
      const data = await readJsonSafe(this.seenPath, { keys: {}, version: 1 });
      if (data && data.keys && typeof data.keys === "object"){
        this._seenMeta = data.keys;
        for (const k of Object.keys(this._seenMeta)){
          this._seenKeys.add(k);
        }
      }
    }

    if (this.debug){
      console.log("[PGNStore] outDir:", this.outDir);
      console.log("[PGNStore] bundle:", this.bundlePath);
      if (this.dedup){
        console.log("[PGNStore] dedup enabled, seen:", this._seenKeys.size, "keys");
        console.log("[PGNStore] seen file:", this.seenPath);
      }
    }
  }

  /**
   * Append of a game to out/games.pgn (idempotent if dedup enabled)
   * @param {Object} g
   * @param {string} g.pgn  - full PGN (tags + movetext)
   * @param {string} [g.white]
   * @param {string} [g.black]
   * @param {string} [g.result]
   * @param {number|string} [g.gameId]
   */
  async appendGame(g){
    // Serialise writes to avoid concurrent append issues
    this._q = this._q.then(() => this._appendGameInternal(g));
    return this._q;
  }

  async _appendGameInternal(g){
    const pgnRaw = String(g?.pgn || "").trim();
    if (!pgnRaw){
      if (this.debug) console.warn("[PGNStore] appendGame: empty pgn, skipped");
      return { ok:false, reason:"empty_pgn" };
    }

    await ensureDir(this.outDir);

    // Normalise: ensure exactly one trailing newline, and add an extra blank line between games
    const payload = pgnRaw.endsWith("\n") ? pgnRaw : (pgnRaw + "\n");
    const block = payload + "\n";

    // Build dedup key
    let key = null;
    let tags = null;
    let pgnHash = null;

    if (this.dedup){
      tags = parsePgnTags(pgnRaw);
      key = buildGameKeyFromTags(tags);
      pgnHash = sha1(pgnRaw);

      // Stronger uniqueness: combine stable key + hash.
      // (If same key but different PGN ever happens, we’ll treat it as different.)
      const compoundKey = `${key} :: ${pgnHash}`;

      if (this._seenKeys.has(compoundKey)){
        if (this.debug){
          console.log("[PGNStore] DUP_SKIP:", compoundKey);
        }
        return { ok:true, skipped:true, reason:"duplicate", bundle:this.bundlePath };
      }

      // Mark as seen BEFORE writing (so even if process dies after write, we still avoid repeats next boot)
      const now = new Date().toISOString();
      this._seenKeys.add(compoundKey);
      this._seenMeta[compoundKey] = {
        firstSeenTs: this._seenMeta[compoundKey]?.firstSeenTs || now,
        pgnSha1: pgnHash,
        lastWriteTs: now
      };

      // Persist seen state (atomic)
      await writeJsonAtomic(this.seenPath, { version: 1, keys: this._seenMeta });
    }

    // 1) Append to bundle
    await fsp.appendFile(this.bundlePath, block, "utf8");

    // 2) Optional: per-game file (only if not skipped)
    let perGamePath = null;
    if (this.writePerGame){
      const white = safeName(g?.white || (tags?.White ?? ""));
      const black = safeName(g?.black || (tags?.Black ?? ""));
      const gid = (g?.gameId != null) ? String(g.gameId) : "game";
      const ts = stampNow();
      const fn = `game-${gid}-${white}-vs-${black}-${ts}.pgn`;
      perGamePath = path.join(this.outDir, fn);
      await fsp.writeFile(perGamePath, payload, "utf8");
    }

    if (this.debug){
      console.log("[PGNStore] saved:", { bundle:this.bundlePath, perGamePath });
    }

    return { ok:true, skipped:false, bundle:this.bundlePath, perGamePath };
  }

  async readBundle(){
    try{
      return await fsp.readFile(this.bundlePath, "utf8");
    }catch{
      return "";
    }
  }

  async clearBundle(){
    await ensureDir(this.outDir);
    await fsp.writeFile(this.bundlePath, "", "utf8");
    if (this.dedup){
      this._seenKeys.clear();
      this._seenMeta = {};
      await writeJsonAtomic(this.seenPath, { version: 1, keys: {} });
    }
    return { ok:true };
  }
}