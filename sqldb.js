// sqldb.js - project SQL: real SQLite (wa-sqlite, runs inside the Durable Object) whose database FILE lives in Telegram.
//
//  * The file is cut into 1 MB blocks (same format the old blitz app used: manifest "dbs" in D1 + pinned Telegram manifest).
//    So the old big database is opened directly from its blocks - no download, no import, no row limit.
//  * A query only pulls the blocks it really touches from Telegram (cached in RAM, LRU, DB_CACHE_BLOCKS blocks).
//  * Writes go to RAM + Durable Object storage first (safe), then ~SQL_SYNC_SECS later only the CHANGED blocks go to Telegram.
//  * Free plan: one request may do ~50 Telegram calls (SUBREQ_LIMIT, default 44). A query that needs more blocks than that
//    is CONTINUED AUTOMATICALLY: every block it downloaded is also saved in Durable Object storage (disk cache, DB_DISK_BLOCKS),
//    the query is rolled back and answers 503 {retry:true}; worker.js (dbCall) then re-runs it in a NEW request with a fresh
//    budget, which finds the earlier blocks on disk and goes on with the next ones - until it is done (SQL_MAX_ROUNDS rounds).
//    Writes are always inside one transaction that is rolled back first, so a re-run can never apply a change twice.
//
// Needs: package.json dependency "wa-sqlite" (see package.json), Durable Object binding SQLDB (class ProjDB), D1 binding DB.
import SQLiteAsyncESMFactory from "wa-sqlite/dist/wa-sqlite-async.mjs";
import * as SQLite from "wa-sqlite";
import * as VFS from "wa-sqlite/src/VFS.js";
import wasmModule from "wa-sqlite/dist/wa-sqlite-async.wasm";

const BS = 1024 * 1024; // block size, must stay 1 MB (old blocks in Telegram are 1 MB)
const OK = 0, IOERR = 10, NOTFOUND = 12, CANTOPEN = 14, SHORT_READ = 522;
const OPEN_CREATE = 4, OPEN_DELETEONCLOSE = 8;
const MAIN = "main.db";

class BadReq extends Error {}
class Budget extends Error {}
const jd = (code, obj) => new Response(JSON.stringify(obj), { status: code, headers: { "Content-Type": "application/json" } });
const sqlQ = (n) => '"' + String(n).replace(/"/g, '""') + '"';
const toB64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192)); return btoa(s); };
const fromB64 = (s) => { const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };
const encV = (v) => {
  if (v instanceof ArrayBuffer) return { $blob: toB64(new Uint8Array(v)) };
  if (v instanceof Uint8Array) return { $blob: toB64(v) };
  if (typeof v === "bigint") return v <= 9007199254740991n && v >= -9007199254740991n ? Number(v) : v.toString();
  return v;
};
const decV = (v) => (v && typeof v === "object" && typeof v.$blob === "string" ? fromB64(v.$blob) : v === true ? 1 : v === false ? 0 : v);
const ceilDiv = (a, b) => Math.floor((a + b - 1) / b);

// ------------------------------------------------------------------ the database file: blocks in RAM <-> Telegram
class BlockStore {
  constructor(owner) {
    this.o = owner;
    this.cache = new Map(); // n -> Uint8Array(BS), LRU order
    this.inflight = new Map(); // n -> Promise (being downloaded)
    this.unsaved = new Set(); // changed in RAM, not yet written to Durable Object storage (pinned in RAM)
    this.dirty = new Set(); // changed, not yet in Telegram (copy is in Durable Object storage once saved)
    this.gone = new Set(); // dirty storage keys to delete at next save
    this.staged = new Map(); // n -> entry already uploaded to Telegram, waiting for the manifest switch
    this.garbage = []; // staged entries that became obsolete
    this.blocks = []; // published block entries (from D1 "dbs")
    this.size = 0;
    this.cutFrom = Infinity; // blocks >= this were cut off by a truncate: read as zeros until the next publish
    this.metaDirty = false;
    this.lastMiss = -5;
    this.maxCache = Math.max(4, parseInt(owner.env.DB_CACHE_BLOCKS || "40", 10));
    this.maxDirty = Math.max(8, parseInt(owner.env.DB_MAX_DIRTY_BLOCKS || "60", 10));
    this.maxDisk = Math.max(0, parseInt(owner.env.DB_DISK_BLOCKS || "1024", 10)); // downloaded blocks kept in Durable Object storage (0 = off)
    this.cidx = []; // disk cache keys, oldest first
    this.cdel = []; // disk cache keys to delete at next save
    this.idxDirty = false;
    this.wcount = 0; // number of block writes so far (lets run() know whether a failed query had already changed something)
    this.fresh = 0; // blocks downloaded from Telegram during the current request
  }
  // ---- disk cache of blocks downloaded from Telegram (key = the Telegram file of that block, which never changes)
  dk(e) { return "c:" + e.bot + ":" + e.fid; }
  touch(ck) {
    const i = this.cidx.indexOf(ck);
    if (i >= 0) this.cidx.splice(i, 1);
    this.cidx.push(ck);
    const j = this.cdel.indexOf(ck);
    if (j >= 0) this.cdel.splice(j, 1);
    this.idxDirty = true;
    while (this.cidx.length > this.maxDisk) this.cdel.push(this.cidx.shift());
  }
  async keep(ck, data) {
    try {
      await this.o.state.storage.put(ck, data);
      this.touch(ck);
    } catch (x) { console.log("block disk cache failed:", x && x.message); }
  }
  dropDisk(entries) { // blocks that were replaced by a newer version: their cached copy is useless now
    for (const e of entries || []) {
      if (!e || e.fid == null) continue;
      const ck = this.dk(e), i = this.cidx.indexOf(ck);
      if (i >= 0) { this.cidx.splice(i, 1); this.cdel.push(ck); this.idxDirty = true; }
    }
  }
  async saveIdx() {
    if (!this.idxDirty && !this.cdel.length) return;
    const st = this.o.state.storage;
    const del = this.cdel.splice(0);
    for (let i = 0; i < del.length; i += 100) await st.delete(del.slice(i, i + 100));
    await st.put("cidx", this.cidx);
    this.idxDirty = false;
  }
  evict() {
    if (this.cache.size <= this.maxCache) return;
    for (const n of this.cache.keys()) {
      if (this.cache.size <= this.maxCache) break;
      if (this.unsaved.has(n)) continue;
      this.cache.delete(n);
    }
  }
  markDirty(n) {
    this.dirty.add(n);
    this.unsaved.add(n);
    this.gone.delete(n);
    const g = this.staged.get(n);
    if (g) { this.garbage.push(g); this.staged.delete(n); }
    if (this.unsaved.size > this.maxDirty) throw new Error("this change touches too many blocks at once for the 128 MB memory limit; split it into smaller transactions");
  }
  async _read(n) {
    if (this.dirty.has(n)) {
      const v = await this.o.state.storage.get("d:" + n);
      if (v) {
        const u = v instanceof Uint8Array ? v : new Uint8Array(v);
        if (u.length === BS) return u;
        const b = new Uint8Array(BS);
        b.set(u.subarray(0, BS));
        return b;
      }
    }
    const e = n >= this.cutFrom ? null : this.blocks[n];
    if (!e) return new Uint8Array(BS);
    const ck = this.dk(e);
    let data = null;
    if (this.maxDisk > 0) { // already downloaded by an earlier request (or an earlier round of the same query)?
      const v = await this.o.state.storage.get(ck);
      if (v) {
        const u = v instanceof Uint8Array ? v : new Uint8Array(v);
        if (!e.size || u.length === e.size) { data = u; this.touch(ck); }
      }
    }
    if (!data) {
      data = await this.o.fetchBlock(e);
      this.fresh++;
      if (this.maxDisk > 0) await this.keep(ck, data);
    }
    const b = new Uint8Array(BS);
    b.set(data.subarray(0, Math.min(data.length, BS)));
    if (n === 0 && (b[18] === 2 || b[19] === 2)) { b[18] = 1; b[19] = 1; } // old app used WAL; this VFS has no shared memory -> plain rollback format
    return b;
  }
  _fetching(n) {
    let p = this.inflight.get(n);
    if (!p) {
      p = this._read(n).then((b) => {
        if (!this.cache.has(n)) { this.cache.set(n, b); this.evict(); }
        return this.cache.get(n);
      });
      const clear = () => { if (this.inflight.get(n) === p) this.inflight.delete(n); };
      p.then(clear, clear);
      this.inflight.set(n, p);
    }
    return p;
  }
  async load(n) {
    const b = this.cache.get(n);
    if (b) { this.cache.delete(n); this.cache.set(n, b); return b; }
    const sequential = n === this.lastMiss + 1;
    this.lastMiss = n;
    const p = this._fetching(n);
    if (sequential && this.o.budgetLeft() > 12) { // reading forward through a table: fetch the next blocks in parallel
      for (let k = 1; k <= 3; k++) {
        const m = n + k;
        if (m < this.blocks.length && m < this.cutFrom && !this.cache.has(m) && !this.dirty.has(m)) this._fetching(m).catch(() => {});
      }
    }
    await p;
    return this.cache.get(n) || (await this._fetching(n));
  }
  async read(off, out) {
    const len = out.length;
    const end = Math.min(off + len, this.size);
    let pos = off;
    while (pos < end) {
      const n = Math.floor(pos / BS), bo = pos - n * BS, take = Math.min(BS - bo, end - pos);
      const b = await this.load(n);
      out.set(b.subarray(bo, bo + take), pos - off);
      pos += take;
    }
    const got = Math.max(end - off, 0);
    if (got < len) { out.fill(0, got); return SHORT_READ; }
    return OK;
  }
  async write(off, data) {
    this.wcount++;
    const end = off + data.length;
    let pos = off, i = 0;
    while (pos < end) {
      const n = Math.floor(pos / BS), bo = pos - n * BS, take = Math.min(BS - bo, end - pos);
      let b;
      if (bo === 0 && take === BS && !this.cache.has(n) && !this.dirty.has(n)) { // whole block replaced: no need to read the old one
        b = new Uint8Array(BS);
        this.cache.set(n, b);
        this.evict();
      } else b = await this.load(n);
      b.set(data.subarray(i, i + take), bo);
      this.markDirty(n);
      pos += take;
      i += take;
    }
    if (end > this.size) { this.size = end; this.metaDirty = true; }
    return OK;
  }
  async truncate(sz) {
    this.size = sz;
    this.metaDirty = true;
    const keep = ceilDiv(sz, BS);
    this.cutFrom = Math.min(this.cutFrom, keep);
    for (const n of [...this.cache.keys()]) if (n >= keep) this.cache.delete(n);
    for (const n of [...this.dirty]) if (n >= keep) { this.dirty.delete(n); this.unsaved.delete(n); this.gone.add(n); }
    const r = sz % BS;
    if (r && keep > 0) {
      const b = await this.load(keep - 1);
      b.fill(0, r);
      this.markDirty(keep - 1);
    }
    return OK;
  }
  // make the RAM changes durable (Durable Object storage); all or nothing
  async persist() {
    try { await this.saveIdx(); } catch (x) { console.log("disk cache index failed:", x && x.message); }
    if (!this.unsaved.size && !this.gone.size && !this.metaDirty) return;
    const ns = [...this.unsaved];
    await this.o.state.storage.transaction(async (txn) => {
      for (const n of ns) { const b = this.cache.get(n); if (b) await txn.put("d:" + n, b); }
      for (const n of this.gone) await txn.delete("d:" + n);
      await txn.put("meta", { size: this.size, dirty: [...this.dirty], cut: this.cutFrom === Infinity ? -1 : this.cutFrom });
    });
    this.unsaved.clear();
    this.gone.clear();
    this.metaDirty = false;
    this.evict();
  }
}

// ------------------------------------------------------------------ VFS: main.db = BlockStore, everything else (temp files) = RAM
// wa-sqlite 1.0.0 (Asyncify build): a method that has to wait (Telegram, storage) MUST return this.handleAsync(async () => ...);
// a plain Promise would be taken for the result code and SQLite would carry on before the data arrived (-> "file is not a database").
// Methods that never wait (lock, sync, sector size ...) stay normal synchronous functions.
class TgVFS extends VFS.Base {
  constructor(store) {
    super();
    Object.defineProperty(this, "name", { value: "tgblock", writable: true, configurable: true, enumerable: true });
    this.store = store;
    this.files = new Map();
    this.mem = new Map();
  }
  close() {}
  fail(e) { this.store.fail = e; return IOERR; }
  xOpen(name, fileId, flags, pOutFlags) {
    return this.handleAsync(async () => {
      try {
        const nm = name == null ? "tmp_" + fileId : String(name).replace(/^\/+/, "");
        const main = nm === MAIN;
        if (!main && !this.mem.has(nm)) {
          if (!(flags & OPEN_CREATE)) return CANTOPEN;
          this.mem.set(nm, { buf: new Uint8Array(8192), size: 0 });
        }
        this.files.set(fileId, { name: nm, main, flags });
        pOutFlags.setInt32(0, flags, true);
        return OK;
      } catch (e) { return this.fail(e); }
    });
  }
  xClose(fileId) {
    return this.handleAsync(async () => {
      const f = this.files.get(fileId);
      this.files.delete(fileId);
      if (f && !f.main && (f.flags & OPEN_DELETEONCLOSE)) this.mem.delete(f.name);
      return OK;
    });
  }
  xRead(fileId, pData, iOffset) {
    return this.handleAsync(async () => {
      try {
        const f = this.files.get(fileId);
        if (!f) return IOERR;
        if (f.main) return await this.store.read(Number(iOffset), pData);
        const m = this.mem.get(f.name);
        const off = Number(iOffset);
        const end = Math.min(off + pData.length, m.size), n = Math.max(end - off, 0);
        if (n > 0) pData.set(m.buf.subarray(off, end));
        if (n < pData.length) { pData.fill(0, n); return SHORT_READ; }
        return OK;
      } catch (e) { return this.fail(e); }
    });
  }
  xWrite(fileId, pData, iOffset) {
    return this.handleAsync(async () => {
      try {
        const f = this.files.get(fileId);
        if (!f) return IOERR;
        const off = Number(iOffset);
        if (f.main) {
          // pData is a view into the wasm heap: copy it before anything is awaited
          return await this.store.write(off, pData.slice());
        }
        const m = this.mem.get(f.name), end = off + pData.length;
        if (end > m.buf.length) {
          let cap = m.buf.length;
          while (cap < end) cap *= 2;
          const nb = new Uint8Array(cap);
          nb.set(m.buf.subarray(0, m.size));
          m.buf = nb;
        }
        m.buf.set(pData, off);
        if (end > m.size) m.size = end;
        return OK;
      } catch (e) { return this.fail(e); }
    });
  }
  xTruncate(fileId, iSize) {
    return this.handleAsync(async () => {
      try {
        const f = this.files.get(fileId);
        if (!f) return IOERR;
        const sz = Number(iSize);
        if (f.main) return await this.store.truncate(sz);
        const m = this.mem.get(f.name);
        m.buf.fill(0, Math.min(sz, m.buf.length));
        m.size = Math.min(m.size, sz);
        return OK;
      } catch (e) { return this.fail(e); }
    });
  }
  xSync() { return OK; } // changes are made durable by BlockStore.persist() at the end of every request
  xFileSize(fileId, pSize64) {
    return this.handleAsync(async () => {
      const f = this.files.get(fileId);
      if (!f) return IOERR;
      pSize64.setBigInt64(0, BigInt(f.main ? this.store.size : this.mem.get(f.name).size), true);
      return OK;
    });
  }
  xLock() { return OK; } // one query at a time (mutex in ProjDB), no file locks needed
  xUnlock() { return OK; }
  xCheckReservedLock(fileId, pResOut) { pResOut.setInt32(0, 0, true); return OK; }
  xFileControl() { return NOTFOUND; }
  xSectorSize() { return 4096; }
  xDeviceCharacteristics() { return 0; }
  xAccess(name, flags, pResOut) {
    return this.handleAsync(async () => {
      const nm = String(name).replace(/^\/+/, "");
      const ex = nm === MAIN ? this.store.size > 0 : this.mem.has(nm);
      pResOut.setInt32(0, ex ? 1 : 0, true);
      return OK;
    });
  }
  xDelete(name) {
    return this.handleAsync(async () => {
      this.mem.delete(String(name).replace(/^\/+/, ""));
      return OK;
    });
  }
}

// ------------------------------------------------------------------ the Durable Object (one per project)
export function makeProjDB(H) {
  return class ProjDB {
    constructor(state, env) {
      this.state = state;
      this.env = env;
      this.pid = null;
      this.store = null;
      this.sqlite3 = null;
      this.db = null;
      this.initP = null;
      this.ready = false; // engine fully started (opened + pragmas + old data migrated)
      this.pragmas = false;
      this.badTx = false; // a ROLLBACK failed: try again before the next query
      this.initErr = "";
      this.err = "";
      this.q = Promise.resolve();
      this.sub = 0;
      this.deadline = 0;
      this.seq = 0;
    }

    // ---- small helpers
    lock(fn) {
      const run = this.q.then(() => { this.sub = 0; if (this.store) this.store.fresh = 0; return fn(); });
      this.q = run.then(() => {}, () => {});
      return run;
    }
    limit() { return Math.max(5, parseInt(this.env.SUBREQ_LIMIT || "44", 10)); }
    budgetLeft() { return this.limit() - this.sub; }
    tick(k) {
      this.sub += k || 1;
      if (this.sub > this.limit()) {
        throw new Budget("this query needs more Telegram blocks than one request may fetch (free plan: 50 calls). The blocks loaded so far are saved: it continues by itself in the next request; if you still see this message the query is bigger than SQL_MAX_ROUNDS / DB_DISK_BLOCKS allow - run it again, raise those, or use an index / LIMIT so fewer blocks are touched.");
      }
    }
    async remember(pid) {
      if (pid && this.pid !== pid) { this.pid = pid; await this.state.storage.put("pid", pid); }
      if (!this.pid) this.pid = (await this.state.storage.get("pid")) || null;
    }
    async dbsAll() {
      return JSON.parse((await H.kvGet(this.env, "dbs")) || "{}") || {};
    }
    async dbsSave(all) {
      await this.env.DB.batch([H.kvSetStmt(this.env, "dbs", JSON.stringify(all)), H.revStmt(this.env)]);
    }

    // ---- Telegram: download one whole block (checked against its size and sha256)
    async fetchBlock(e) {
      const s = await H.getSettings(this.env);
      const b = (s.bots || {})[String(e.bot)];
      if (!b) throw new Error(`bot ${e.bot} is not configured (a block of this database lives in that bot's chat)`);
      let last;
      for (let a = 0; a < 3; a++) {
        try {
          const row = { bot: e.bot, tgid: e.fid };
          this.tick(H.fpCached(row) && a === 0 ? 1 : 2);
          const path = await H.filePath(this.env, s, row, a > 0);
          const r = await fetch(`${H.TG(this.env)}/file/bot${b.token}/${path}`);
          if (!r.ok) {
            last = new H.TGError(r.status, "block download failed");
            if (r.status === 429) await H.sleep(Math.min(parseInt(r.headers.get("retry-after") || "2", 10), 5) * 1000);
            continue;
          }
          const u = new Uint8Array(await r.arrayBuffer());
          if (e.size && u.length !== e.size) throw new Error(`block has ${u.length} bytes, expected ${e.size}`);
          if (e.sha && H.hex(await crypto.subtle.digest("SHA-256", u)) !== e.sha) throw new Error("block checksum mismatch");
          return u;
        } catch (x) {
          if (x instanceof Budget) throw x;
          last = x;
          await H.sleep(300 * (a + 1));
        }
      }
      throw last || new Error("block download failed");
    }

    // ---- start the engine (first use after the object was idle)
    ensureInit() {
      if (this.ready) return Promise.resolve();
      if (!this.initP) this.initP = this._init().catch((e) => { this.initP = null; this.initErr = String((e && e.message) || e).slice(0, 200); throw e; });
      return this.initP;
    }
    // every step can be repeated: if it stops half way (Telegram budget), the next call goes on where it stopped
    async _init() {
      if (!this.pid) throw new BadReq("missing project");
      const st = this.state.storage;
      this.deadline = Date.now() + 60000;
      if (!this.db) {
        const store = new BlockStore(this);
        const d = (await this.dbsAll())[this.pid] || {};
        store.blocks = d.blocks || [];
        store.size = d.size || 0;
        this.seq = Math.max(d.seq || 0, (await st.get("seq")) || 0);
        const meta = await st.get("meta");
        if (meta) {
          store.size = meta.size || 0;
          store.dirty = new Set(meta.dirty || []);
          store.cutFrom = meta.cut == null || meta.cut < 0 ? Infinity : meta.cut;
        }
        const cidx = await st.get("cidx");
        store.cidx = Array.isArray(cidx) ? cidx : [];
        this.store = store;
        const module = await SQLiteAsyncESMFactory({
          // without locateFile the emscripten code runs new URL("wa-sqlite-async.wasm", import.meta.url) and Workers answer "Invalid URL string"
          locateFile: (f) => f,
          instantiateWasm(imports, done) {
            WebAssembly.instantiate(wasmModule, imports).then((inst) => done(inst, wasmModule));
            return {};
          },
        });
        const sqlite3 = SQLite.Factory(module);
        sqlite3.vfs_register(new TgVFS(store), false);
        const db = await sqlite3.open_v2(MAIN, SQLite.SQLITE_OPEN_READWRITE | SQLite.SQLITE_OPEN_CREATE, "tgblock");
        this.sqlite3 = sqlite3;
        this.db = db;
        sqlite3.progress_handler(db, 20000, () => (Date.now() > this.deadline ? 1 : 0), null);
      }
      if (!this.pragmas) {
        await this.sx("PRAGMA journal_mode=MEMORY");
        await this.sx("PRAGMA temp_store=MEMORY");
        await this.sx("PRAGMA cache_size=-8192");
        this.pragmas = true;
      }
      this.initErr = "";
      await this.migrate();
      await this.store.persist();
      this.ready = true;
      if (this.store.dirty.size) await this.arm();
    }
    // run SQL that returns nothing we need; real errors (Telegram budget etc.) are thrown instead of "disk I/O error"
    async sx(sql) {
      try {
        await this.sqlite3.exec(this.db, sql);
      } catch (e) {
        throw this.realErr(e);
      }
    }
    realErr(e) {
      const f = this.store && this.store.fail;
      if (this.store) this.store.fail = null;
      return f || e;
    }

    // ---- data of the previous Worker version (SQLite built into the object, or its gzip dump in Telegram) -> new engine
    async migrate() {
      const st = this.state.storage;
      if (await st.get("legacy")) return;
      const store = this.store;
      if (store.blocks.length || store.size || store.dirty.size) { await st.put("legacy", 1); return; }
      let dump = null;
      try {
        const sql = this.state.storage.sql;
        const objs = sql.exec("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").toArray();
        if (objs.some((o) => o.type === "table")) {
          dump = { v: 1, schema: objs, data: {}, seq: [] };
          for (const t of objs.filter((o) => o.type === "table")) {
            const cur = sql.exec(`SELECT * FROM ${sqlQ(t.name)}`);
            dump.data[t.name] = { cols: cur.columnNames, rows: [...cur.raw()].map((r) => r.map(encV)) };
          }
          try { dump.seq = sql.exec("SELECT name, seq FROM sqlite_sequence").toArray(); } catch (e) { /* no autoincrement tables */ }
        }
      } catch (e) { /* no built-in sqlite here */ }
      if (!dump) {
        const rec = JSON.parse((await H.kvGet(this.env, "sqldb:" + this.pid)) || "null");
        if (rec && rec.parts && rec.parts.length) {
          const s = await H.getSettings(this.env, true);
          const bufs = [];
          let total = 0;
          for (const p of rec.parts) {
            this.tick(2);
            const path = await H.filePath(this.env, s, { bot: p.bot, tgid: p.fid }, true);
            const r = await fetch(`${H.TG(this.env)}/file/bot${s.bots[String(p.bot)].token}/${path}`);
            if (!r.ok) throw new Error("cannot download the old SQL backup part " + p.n);
            const u = new Uint8Array(await r.arrayBuffer());
            bufs.push(u);
            total += u.length;
          }
          const all = new Uint8Array(total);
          let o = 0;
          for (const u of bufs) { all.set(u, o); o += u.length; }
          dump = JSON.parse(new TextDecoder().decode(await H.gunzip(all)));
        }
      }
      if (dump) await this.loadDump(dump);
      await st.put("legacy", 1);
    }
    async loadDump(d) {
      const sq = this.sqlite3, db = this.db, store = this.store;
      await this.sx("BEGIN");
      try {
        for (const o of d.schema.filter((x) => x.type === "table")) await this.sx(o.sql);
        let rows = 0;
        for (const [name, t] of Object.entries(d.data || {})) {
          if (!t.rows.length) continue;
          const ins = `INSERT INTO ${sqlQ(name)} (${t.cols.map(sqlQ).join(",")}) VALUES (${t.cols.map(() => "?").join(",")})`;
          for await (const stmt of sq.statements(db, ins)) {
            for (const r of t.rows) {
              sq.reset(stmt);
              sq.bind_collection(stmt, r.map(decV));
              await sq.step(stmt);
              if (++rows % 4000 === 0) { await this.sx("COMMIT"); await store.persist(); await this.sx("BEGIN"); }
            }
          }
        }
        for (const o of d.schema.filter((x) => x.type !== "table")) await this.sx(o.sql);
        for (const q of d.seq || []) {
          try { await this.sx(`INSERT OR REPLACE INTO sqlite_sequence(name, seq) VALUES(${sqlLit(q.name)}, ${Number(q.seq) || 0})`); } catch (e) { /* ignore */ }
        }
        await this.sx("COMMIT");
      } catch (e) {
        try { await this.sx("ROLLBACK"); } catch (x) { /* ignore */ }
        throw e;
      }
    }

    // ---- running SQL
    async one(it) {
      const sq = this.sqlite3, db = this.db;
      if (!it || typeof it !== "object") throw new BadReq("each batch item must be an object");
      const q = String(it.sql || "");
      if (!q.trim()) throw new BadReq("sql is empty");
      const prm = it.params == null ? [] : it.params;
      if (!Array.isArray(prm)) throw new BadReq("params must be a list (use ? placeholders; named params are not supported)");
      const max = H.SQL_MAX_ROWS(this.env);
      let cols = [], rows = [], trunc = false, first = true;
      try {
        for await (const stmt of sq.statements(db, q)) {
          if (first && prm.length) sq.bind_collection(stmt, prm.map(decV));
          first = false;
          cols = sq.column_names(stmt);
          rows = [];
          while ((await sq.step(stmt)) === SQLite.SQLITE_ROW) {
            if (!cols.length) continue;
            if (rows.length >= max) { trunc = true; break; }
            rows.push(sq.row(stmt).map(encV));
          }
        }
      } catch (e) {
        throw this.realErr(e);
      }
      let changes = 0, lastId = null;
      if (!cols.length) {
        changes = sq.changes(db);
        try {
          for await (const stmt of sq.statements(db, "SELECT last_insert_rowid()")) {
            if ((await sq.step(stmt)) === SQLite.SQLITE_ROW) lastId = encV(sq.row(stmt)[0]);
          }
        } catch (e) { /* ignore */ }
      }
      return { columns: cols, rows, rowcount: cols.length ? rows.length : changes, last_id: lastId, truncated: trunc };
    }
    async script(text) {
      // .dump style text: run statement by statement; a commit every ~2 MB keeps memory low (a failed import is rolled back only back to the last commit)
      text = text.replace(/^\s*(BEGIN(\s+TRANSACTION)?|COMMIT|END(\s+TRANSACTION)?)\s*;\s*$/gim, "").replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*\w+\s*;\s*$/gim, "");
      const stmts = H.splitSql(text);
      await this.sx("BEGIN");
      let bytes = 0, n = 0, committed = false;
      try {
        for (const q of stmts) {
          await this.sx(q);
          n++;
          bytes += q.length;
          if (bytes > 2000000) { bytes = 0; await this.sx("COMMIT"); committed = true; await this.store.persist(); await this.sx("BEGIN"); }
        }
        await this.sx("COMMIT");
      } catch (e) {
        let ok = true;
        try { await this.sx("ROLLBACK"); } catch (x) { ok = false; this.badTx = true; }
        if (e instanceof Budget) e.safe = ok && !committed; // once a part was committed, running the script again would repeat that part
        throw e;
      }
      return { ok: true, statements: n };
    }
    // one transaction around fn(); when it fails it is rolled back, and a Telegram-budget failure is marked "safe to run again"
    async atomic(fn) {
      await this.sx("BEGIN IMMEDIATE");
      try {
        const r = await fn();
        await this.sx("COMMIT");
        return r;
      } catch (e) {
        let ok = true;
        try { await this.sx("ROLLBACK"); } catch (x) { ok = false; this.badTx = true; }
        if (e instanceof Budget) e.safe = ok;
        throw e;
      }
    }
    async single(body) {
      const q = String(body.sql || "");
      // a text that manages its own transaction / pragma / vacuum cannot be wrapped
      if (/\b(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|PRAGMA|VACUUM|ATTACH|DETACH)\b|\bEND\s+TRANSACTION\b/i.test(q)) {
        const w0 = this.store.wcount;
        try { return await this.one(body); } catch (e) {
          if (e instanceof Budget) e.safe = this.store.wcount === w0; // safe only when nothing had been written yet
          throw e;
        }
      }
      return this.atomic(() => this.one(body)); // several statements in one text: all or nothing, so a re-run is safe
    }
    run(body) {
      return this.lock(async () => {
        try { await this.ensureInit(); } catch (e) { if (e instanceof Budget) e.safe = true; throw e; }
        if (this.badTx) { this.badTx = false; try { await this.sx("ROLLBACK"); } catch (e) { /* no open transaction */ } }
        this.deadline = Date.now() + 30000;
        let res;
        try {
          if (!body || typeof body !== "object" || Array.isArray(body)) throw new BadReq("body must be a JSON object");
          if (body.script != null) res = await this.script(String(body.script));
          else if (body.batch != null) {
            if (!Array.isArray(body.batch) || !body.batch.length) throw new BadReq("batch must be a non-empty list");
            res = await this.atomic(async () => {
              const out = [];
              for (const it of body.batch) out.push(await this.one(it));
              return { results: out };
            });
          } else res = await this.single(body);
        } finally {
          try { await this.store.persist(); } catch (e) { console.log("persist failed:", e && e.message); this.err = String((e && e.message) || e).slice(0, 160); }
        }
        if (this.store.dirty.size) await this.arm();
        return res;
      });
    }

    // ---- sending changed blocks to Telegram
    async arm(secs) {
      const st = this.state.storage;
      const at = Date.now() + (secs == null ? H.SQL_SYNC_SECS(this.env) : secs) * 1000;
      const cur = await st.getAlarm();
      if (cur == null || cur > at) await st.setAlarm(at);
    }
    // uploads the changed blocks (<= max per call), and when ALL of them are up, switches the block list in one step.
    // returns true when everything is in Telegram.
    async flushLocked(max) {
      await this.ensureInit();
      const st = this.store, env = this.env, pid = this.pid;
      const s = await H.getSettings(env, true);
      if (!s.projects || !s.projects[pid]) { await this.wipeLocked(); return true; }
      const nb = ceilDiv(st.size, BS);
      const need = [];
      for (let i = 0; i < nb; i++) if (st.dirty.has(i) || i >= st.blocks.length || i >= st.cutFrom) need.push(i);
      if (!need.length && st.blocks.length === nb && st.cutFrom === Infinity && !st.garbage.length) return true;
      if (st.size >= 100) { // safety: never publish (and never delete the old blocks) when the database file does not look like SQLite
        const h = await st.load(0), magic = "SQLite format 3\0";
        for (let i = 0; i < magic.length; i++) if (h[i] !== magic.charCodeAt(i)) throw new Error("database header is not valid SQLite - backup skipped, nothing in Telegram was changed");
      }
      const todo = need.filter((n) => !st.staged.has(n));
      const part = todo.slice(0, max);
      const par = Math.max(1, Math.min(6, H.enabledBotCount(s)));
      for (let k = 0; k < part.length; k += par) {
        const wave = part.slice(k, k + par);
        const jobs = [];
        for (const n of wave) {
          const b = await st.load(n);
          const len = Math.min(BS, st.size - n * BS);
          const data = b.slice(0, len);
          jobs.push({ n, data, len, seq: ++this.seq });
        }
        await this.state.storage.put("seq", this.seq);
        const res = await Promise.all(jobs.map(async (j) => {
          const sha = H.hex(await crypto.subtle.digest("SHA-256", j.data));
          const r = await H.sendChunk(env, s, "db_" + pid, j.seq, j.data);
          return { n: j.n, e: { n: j.seq, bot: Number(r.bot) || r.bot, ch: r.ch, msg: r.msg, fid: r.tgid, size: r.size, sha } };
        }));
        for (const x of res) st.staged.set(x.n, x.e);
        this.sub += wave.length;
      }
      if (todo.length > part.length) { await this.arm(2); return false; } // more blocks left: next alarm continues

      // everything is uploaded: switch the block list (D1 + pinned manifest), then drop the replaced messages
      const all = await this.dbsAll();
      const d = all[pid] || { seq: 0, ver: 0, size: 0, blocks: [], trash: [], synced: 0 };
      const old = d.blocks || [];
      const nw = [], replaced = [];
      for (let i = 0; i < nb; i++) {
        const g = st.staged.get(i);
        if (g) { nw.push(g); if (old[i]) replaced.push(old[i]); } else nw.push(old[i]);
      }
      for (let i = nb; i < old.length; i++) replaced.push(old[i]);
      const dirtyNow = [...st.dirty];
      all[pid] = { seq: Math.max(d.seq || 0, this.seq), ver: (d.ver || 0) + 1, size: st.size, blocks: nw, trash: (d.trash || []).concat(replaced, st.garbage), synced: Math.floor(Date.now() / 1000) };
      await this.dbsSave(all);
      st.blocks = nw;
      st.cutFrom = Infinity;
      st.dirty.clear();
      st.unsaved.clear();
      st.gone.clear();
      st.staged.clear();
      st.garbage = [];
      for (let i = 0; i < dirtyNow.length; i += 100) await this.state.storage.delete(dirtyNow.slice(i, i + 100).map((n) => "d:" + n));
      await this.state.storage.put("meta", { size: st.size, dirty: [], cut: -1 });
      st.dropDisk(replaced);
      try { await st.saveIdx(); } catch (e) { /* retried at the next save */ }
      let ok = false;
      try { ok = await H.backupManifest(env, true); } catch (e) { console.log("manifest backup after sql sync failed:", e && e.message); }
      if (ok) {
        const trash = all[pid].trash;
        if (trash.length) {
          await H.deleteMsgs(env, trash.map((e) => ({ bot: e.bot, ch: e.ch, msg: e.msg })));
          const again = await this.dbsAll();
          if (again[pid]) { again[pid].trash = []; await this.dbsSave(again); }
        }
      }
      return true;
    }
    flush(force) {
      return this.lock(async () => {
        try {
          const done = await this.flushLocked(Math.max(1, Math.min(36, this.limit() - 8)));
          this.err = "";
          return done;
        } catch (e) {
          this.err = String((e && (e.desc || e.message)) || e).slice(0, 160);
          console.log("sql sync failed:", this.err);
          await this.arm(60);
          return false;
        }
      });
    }
    async alarm() {
      await this.remember(null);
      if (!this.pid) return;
      await this.flush(false);
    }

    async wipeLocked() {
      try { await this.state.storage.deleteAlarm(); } catch (e) { /* ignore */ }
      try { if (this.db) await this.sqlite3.close(this.db); } catch (e) { /* ignore */ }
      await this.state.storage.deleteAll();
      this.db = null;
      this.sqlite3 = null;
      this.store = null;
      this.initP = null;
      this.ready = false;
      this.pragmas = false;
    }
    // throw away everything not yet in Telegram (RAM, Durable Object copy of changed blocks, disk cache) and start again from the published blocks
    async discardLocked() {
      try { await this.state.storage.deleteAlarm(); } catch (e) { /* ignore */ }
      try { if (this.db) await this.sqlite3.close(this.db); } catch (e) { /* ignore */ }
      const st = this.state.storage;
      const seq = Math.max(this.seq || 0, (await st.get("seq")) || 0);
      await st.deleteAll();
      await st.put("pid", this.pid);
      await st.put("seq", seq);
      await st.put("legacy", 1);
      this.db = null;
      this.sqlite3 = null;
      this.store = null;
      this.initP = null;
      this.ready = false;
      this.pragmas = false;
      this.badTx = false;
      this.err = "";
      this.initErr = "";
    }
    async info() {
      const meta = await this.state.storage.get("meta");
      const d = (await this.dbsAll())[this.pid] || {};
      const dirty = this.store ? this.store.dirty.size > 0 : !!(meta && meta.dirty && meta.dirty.length);
      return { init: this.ready, size: (meta && meta.size) || d.size || 0, dirty, synced: d.synced || 0, blocks: (d.blocks || []).length, error: this.err || this.initErr || "" };
    }

    async fetch(req) {
      const p = new URL(req.url).pathname;
      try {
        await this.remember(req.headers.get("x-pid"));
        if (!this.pid) throw new BadReq("missing project");
        if (p === "/info") return jd(200, await this.info());
        if (p === "/wipe") { await this.lock(() => this.wipeLocked()); return jd(200, { ok: true }); }
        if (p === "/discard") { await this.lock(() => this.discardLocked()); return jd(200, { ok: true }); }
        if (p === "/sync") { const ok = await this.flush(true); return jd(200, { synced: ok, error: this.err }); }
        if (p === "/run") {
          const body = await req.json();
          const res = await this.run(body);
          if (body && body.sync) {
            res.synced = await this.flush(true);
            if (!res.synced) res.sync_error = this.err || "more blocks are queued, the rest follows in a few seconds";
          }
          return jd(200, res);
        }
        return jd(404, { error: "not found" });
      } catch (e) {
        if (e instanceof BadReq) return jd(400, { error: e.message });
        if (e instanceof Budget) return jd(503, { error: e.message, retry: !!(e.safe && this.store && this.store.fresh > 0) }); // retry: worker.js runs it again in a new request
        if (e instanceof H.TGError) return jd(502, { error: "Telegram: " + (e.desc || e.message) });
        console.log("sql error:", e && (e.stack || e.message));
        return jd(400, { error: "sql: " + ((e && e.message) || e) });
      }
    }
  };
}

const sqlLit = (v) => "'" + String(v).replace(/'/g, "''") + "'";
