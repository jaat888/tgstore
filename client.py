#!/usr/bin/env python3
"""Client for the Telegram file store. Python stdlib only (works in Termux).

  export STORE_URL=https://your-app.blitz.cloud/p/<project-key>   (copy this link from the dashboard)
  python client.py up  movie.mkv            # resumes automatically if it breaks
  python client.py down <id> movie.mkv      # resumes if movie.mkv is half downloaded
  python client.py ls
  python client.py rm <id>
  python client.py sql "SELECT * FROM t WHERE id=?" '[1]'     # sql! instead of sql = back up to Telegram right now
  python client.py sqlimport dump.sql                         # run a sqlite3 ".dump" text file (moves old data in)
  python client.py olddb old.sqlite                           # download the OLD app's sqlite file of this project
"""
import hashlib
import http.client
import json
import os
import sys
import time
import urllib.parse

BASE = os.environ.get("STORE_URL", "").rstrip("/")
PREFIX = urllib.parse.urlparse(BASE).path.rstrip("/")
BLOCK = 1024 * 1024
MAX_FILE = 25 * 1024 ** 3  # same as the server's default limit


def conn():
    u = urllib.parse.urlparse(BASE)
    cls = http.client.HTTPSConnection if u.scheme == "https" else http.client.HTTPConnection
    return cls(u.netloc, timeout=900)


def call(method, path, headers=None, body=None):
    c = conn()
    c.request(method, PREFIX + path, body=body, headers=headers or {})
    r = c.getresponse()
    body = r.read()
    c.close()
    try:
        return r.status, json.loads(body)
    except Exception:
        return r.status, {}


def sql_call(req):
    code, res = call("POST", "/sql", {"Content-Type": "application/json"}, json.dumps(req))
    if code != 200:
        sys.exit(f"error {code}: {res.get('error')}")
    return res


def olddb(out):
    """The old app kept each project's sqlite file as 1 MB blocks in Telegram; fetch them back as one file."""
    nxt, total = 0, 0
    with open(out, "wb") as f:
        while nxt is not None:
            for attempt in range(8):
                try:
                    c = conn()
                    c.request("GET", PREFIX + f"/olddb?from={nxt}")
                    r = c.getresponse()
                    data = r.read()
                    nb = r.getheader("X-Next-Block") or ""
                    c.close()
                    if r.status == 404:
                        sys.exit("no old SQL database found for this project")
                    if r.status != 200:
                        raise RuntimeError(f"HTTP {r.status}")
                    break
                except RuntimeError as e:
                    print(f"retry ({e})")
                    time.sleep(2 * (attempt + 1))
            else:
                sys.exit("failed")
            f.write(data)
            total += len(data)
            print(f"\r{total / 1e6:,.1f} MB", end="", flush=True)
            nxt = int(nb) if nb else None
    print(f"\nDone: {out}. Now:  sqlite3 {out} .dump > dump.sql   and   python client.py sqlimport dump.sql")


def upload(path):
    size = os.path.getsize(path)
    name = os.path.basename(path)
    if size > MAX_FILE:
        sys.exit(f"{name} is {size / 1e9:,.1f} GB; the limit is {MAX_FILE // 1024 ** 3} GB per file")
    fid = hashlib.sha1(f"{name}|{size}|{int(os.path.getmtime(path))}".encode()).hexdigest()[:16]
    fails = 0
    chunk = 18 * 1024 * 1024
    while True:
        try:
            code, st = call("GET", f"/status/{fid}")
            stored = st.get("stored", 0) if code == 200 else 0
            chunk = st.get("chunk") or chunk
            if code == 200 and st.get("done"):
                print(f"\nDone. id = {fid}")
                return fid
            t0, base = time.time(), stored
            with open(path, "rb") as f:
                while True:
                    f.seek(stored)
                    piece = f.read(chunk)
                    if not piece and size:
                        break
                    q = urllib.parse.urlencode({"id": fid, "name": name, "offset": stored, "size": size,
                                                "sha": hashlib.sha256(piece).hexdigest()})
                    code, res = call("POST", f"/upload?{q}", {"Content-Length": str(len(piece))}, piece)
                    if code == 413 and "chunk" not in res and res.get("error", "").startswith("file is bigger"):
                        sys.exit("the server says this file is too big")
                    if code != 200:
                        raise RuntimeError(f"server said {code}: {res.get('error')}")
                    stored += len(piece)
                    rate = (stored - base) / max(time.time() - t0, 1e-6) / 1e6
                    print(f"\r{stored / max(size, 1) * 100:5.1f}%  {stored / 1e6:,.0f}/{size / 1e6:,.0f} MB  {rate:.1f} MB/s",
                          end="", flush=True)
                    if res.get("done"):
                        print(f"\nDone. id = {fid}")
                        return fid
                    if not size:
                        break
            raise RuntimeError("server did not finish the file")
        except Exception as e:
            fails += 1
            if fails > 100:
                raise
            wait = min(5 * fails, 60)
            print(f"\nbroke ({e}); resuming in {wait}s ...")
            time.sleep(wait)


def download(fid, out):
    fails = 0
    while True:
        have = os.path.getsize(out) if os.path.exists(out) else 0
        try:
            c = conn()
            c.request("GET", f"{PREFIX}/file/{fid}", headers={"Range": f"bytes={have}-"})
            r = c.getresponse()
            if r.status == 416:
                print("already complete")
                return
            if r.status not in (200, 206):
                raise RuntimeError(f"server said {r.status}: {r.read()[:200]!r}")
            if r.status == 200:
                have = 0
            cr = r.getheader("Content-Range")  # bytes a-b/total (a Worker answers a part of the file at a time)
            total = int(cr.rsplit("/", 1)[1]) if cr else have + int(r.getheader("Content-Length"))
            with open(out, "r+b" if have and os.path.exists(out) else "wb") as f:
                f.seek(have)
                while True:
                    b = r.read(BLOCK)
                    if not b:
                        break
                    f.write(b)
                    have += len(b)
                    print(f"\r{have / max(total, 1) * 100:5.1f}%  {have / 1e6:,.0f}/{total / 1e6:,.0f} MB", end="", flush=True)
            c.close()
            if have >= total:
                print("\nDone.")
                return
            continue  # got a part: ask for the next one
        except Exception as e:
            fails += 1
            if fails > 100:
                raise
            print(f"\nbroke ({e}); resuming ...")
            time.sleep(min(5 * fails, 60))


def main():
    if "/p/" not in BASE:
        sys.exit("set STORE_URL to your project link, like https://app.example.com/p/KEY")
    a = sys.argv[1:]
    if len(a) >= 2 and a[0] == "up":
        upload(a[1])
    elif len(a) >= 3 and a[0] == "down":
        download(a[1], a[2])
    elif a[:1] == ["ls"]:
        for f in call("GET", "/files")[1]:
            print(f["id"], f["done"], f"{f['size'] / 1e6:,.1f} MB", f["name"])
    elif len(a) >= 2 and a[0] in ("sql", "sql!"):
        res = sql_call({"sql": a[1], "params": json.loads(a[2]) if len(a) > 2 else [], "sync": a[0] == "sql!"})
        if res["columns"]:
            print(" | ".join(res["columns"]))
            for r in res["rows"]:
                print(" | ".join("NULL" if v is None else "[blob]" if isinstance(v, dict) else str(v) for v in r))
            if res.get("truncated"):
                print("(result cut off)")
        else:
            print("ok, rows changed:", res["rowcount"], "last id:", res["last_id"])
        if a[0] == "sql!":
            print("synced to Telegram" if res.get("synced") else "sync failed: " + str(res.get("sync_error")))
    elif len(a) >= 2 and a[0] == "sqlimport":
        text = open(a[1], encoding="utf-8").read()
        res = sql_call({"script": text})
        print("imported", res.get("statements"), "statements")
    elif len(a) >= 2 and a[0] == "olddb":
        olddb(a[1])
    elif len(a) >= 2 and a[0] == "rm":
        print(call("DELETE", f"/file/{a[1]}"))
    else:
        print(__doc__)


if __name__ == "__main__":
    main()
