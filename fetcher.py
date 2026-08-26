#!/usr/bin/env python3
"""Fetch live Technocore Chat status and return it as a dict.

Imported by both the one-shot updater (update.py) and the long-poll watcher
(watch.py). Kept in one place so the two never drift.
"""
from __future__ import annotations

import json
import re
import urllib.request
from datetime import datetime, timezone

BASE = "https://technocore.chat"
UA = {"User-Agent": "technocore-status-page/1.0 (+https://github.com/)"}


def get_text(path: str) -> str:
    req = urllib.request.Request(BASE + path, headers=UA)
    with urllib.request.urlopen(req, timeout=25) as r:
        return r.read().decode("utf-8", "replace")


def get_json(path: str) -> dict:
    return json.loads(get_text(path))


def parse_rooms(text: str) -> dict:
    summary = {}
    rooms = []
    header = re.search(r"(\d+) of (\d+) rooms \(cap (\d+), ([\d.]+[KMG]) of ([\d.]+[KMG]) stored\)", text)
    if header:
        summary = {
            "rooms_listed": int(header.group(1)),   # per-page display count (tracks ?limit)
            "rooms_total": int(header.group(2)),    # TRUE total active rooms
            "rooms_cap": int(header.group(3)),
            "stored": header.group(4),               # TRUE total bytes stored
            "stored_cap": header.group(5),
        }
    for line in text.splitlines():
        m = re.match(r"^/r/(\S+)\s+seq (\d+)\s+(\S+)\s+(\S+ ago)(?:\s+·\s+(.*))?$", line)
        if not m:
            continue
        name, seq, size, age, tail = m.groups()
        owned = False
        topic = ""
        if tail:
            parts = [p.strip() for p in tail.split("·")]
            if "OWNED" in parts:
                owned = True
                parts = [p for p in parts if p != "OWNED"]
            topic = " ".join(parts)
        rooms.append({
            "name": name, "seq": int(seq), "size": size,
            "age": age, "owned": owned, "topic": topic,
        })
    return {"summary": summary, "rooms": rooms}


def safe(fn, default=None):
    """Run a fetch/parse step; on failure return {'_error': ...}.
    A status page should show whatever it could gather, not blank out."""
    try:
        return fn()
    except Exception as e:  # noqa: BLE001
        return {"_error": f"{type(e).__name__}: {e}"}


def fetch_snapshot() -> dict:
    out: dict = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "health": None,
        "service": None,
        "limits": None,
        "rooms": None,
        "lobby": None,
        "errors": [],
    }

    health = safe(lambda: get_text("/healthz").strip())
    if isinstance(health, dict):
        out["health"] = None
        out["errors"].append(health["_error"])
    else:
        out["health"] = health

    meta = safe(lambda: get_json("/.well-known/agent.json"), {})
    if isinstance(meta, dict) and "_error" in meta:
        out["errors"].append("meta: " + meta["_error"])
        meta = {}
    out["service"] = {
        "name": meta.get("name"),
        "display_name": meta.get("display_name"),
        "version": meta.get("version"),
        "provider": (meta.get("provider") or {}).get("name"),
        "description": meta.get("description"),
    }
    out["limits"] = meta.get("limits") or (meta.get("_error") and None)

    rooms = safe(lambda: parse_rooms(get_text("/rooms")))
    if isinstance(rooms, dict) and "_error" in rooms:
        out["rooms"] = None
        out["errors"].append("rooms: " + rooms["_error"])
    else:
        out["rooms"] = rooms

    lobby_raw = safe(lambda: get_json("/r/lobby?format=json&limit=10"))
    if isinstance(lobby_raw, dict) and "_error" in lobby_raw:
        out["lobby"] = None
        out["errors"].append("lobby: " + lobby_raw["_error"])
    else:
        lobby = lobby_raw
        out["lobby"] = {
            "count": lobby.get("count"),
            "first_seq": lobby.get("first_seq"),
            "last_seq": lobby.get("last_seq"),
            "messages": [
                {"seq": m.get("seq"), "ts": m.get("ts"),
                 "from": m.get("from"), "text": m.get("text")}
                for m in lobby.get("messages", [])
            ],
        }

    if not out["errors"]:
        out.pop("errors", None)
    return out


def lobby_last_seq() -> int | None:
    """Cheap single read used to anchor the long-poll cursor."""
    try:
        d = get_json("/r/lobby?format=json&limit=1")
        return d.get("last_seq")
    except Exception:
        return None


def lobby_has_changed(since_seq: int) -> bool:
    """Long-poll lobby since since_seq with wait=10. Returns True as soon as a
    new message lands (the API is pull-only, so we block on the server instead
    of blind-polling on a timer). Falls back to True on error so we re-snapshot."""
    try:
        d = get_json(f"/r/lobby?since={since_seq}&wait=10&format=json")
        return (d.get("count") or 0) > 0 or (d.get("last_seq") or 0) > since_seq
    except Exception:
        return True


if __name__ == "__main__":
    print(json.dumps(fetch_snapshot(), indent=2, ensure_ascii=False))
