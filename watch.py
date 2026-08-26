#!/usr/bin/env python3
"""Event-driven Technocore status watcher.

Technocore has no push/webhook API (verified live: capabilities are read/say/
wait/list only). The only "live" mechanism is the server's own /r/<room>?since=
<seq>&wait=10 long-poll, which returns the moment a new message lands. So this
process does NOT scan on a timer: it blocks on that long-poll and only writes
status.json (and, if run inside a git repo, commits it) when the lobby actually
changes. That makes the dashboard update on real events instead of every 5 min.

Run:
    python3 watch.py              # writes status.json on change
    python3 watch.py --commit     # also commits status.json to git on change

Keeps running until Ctrl-C. For a public page, host this somewhere always-on
(your machine while awake, or a free-tier VM) and let GitHub Pages serve the
committed status.json.
"""
from __future__ import annotations

import json
import subprocess
import sys
import time

import fetcher

COMMIT_INTERVAL = 30  # at most one git commit per this many seconds even if busy


def write_status(snap: dict) -> None:
    with open("status.json", "w", encoding="utf-8") as f:
        json.dump(snap, f, indent=2, ensure_ascii=False)
        f.write("\n")


def git_commit() -> bool:
    try:
        subprocess.run(["git", "rev-parse", "--is-inside-work-tree"],
                       check=True, capture_output=True)
    except Exception:
        return False
    subprocess.run(["git", "add", "status.json"], capture_output=True)
    r = subprocess.run(["git", "diff", "--cached", "--quiet"], capture_output=True)
    if r.returncode == 0:
        return False  # nothing to commit
    ts = fetcher.datetime.now(fetcher.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    subprocess.run(["git", "commit", "-m", f"snapshot: {ts}"], capture_output=True)
    subprocess.run(["git", "push"], capture_output=True)
    return True


def main() -> None:
    do_commit = "--commit" in sys.argv
    print(f"[watch] starting; commit={'on' if do_commit else 'off'}", flush=True)

    # Bootstrap an initial snapshot so the page is never empty.
    write_status(fetcher.fetch_snapshot())
    print("[watch] initial snapshot written", flush=True)

    last_commit = 0.0
    while True:
        since = fetcher.lobby_last_seq() or 0
        changed = fetcher.lobby_has_changed(since)
        if not changed:
            continue  # long-poll timed out with no activity; loop and re-block
        snap = fetcher.fetch_snapshot()
        write_status(snap)
        now = time.time()
        if do_commit and (now - last_commit) >= COMMIT_INTERVAL:
            if git_commit():
                last_commit = now
                print(f"[watch] committed @ {snap.get('generated_at')}", flush=True)
            else:
                last_commit = now
        else:
            print(f"[watch] updated @ {snap.get('generated_at')}", flush=True)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n[watch] stopped", flush=True)
