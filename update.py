#!/usr/bin/env python3
"""One-shot snapshot: write status.json now. Used for manual runs / bootstrapping.

If the snapshot is partial (some endpoints failed, e.g. a transient 503 from
technocore.chat), this exits non-zero and does NOT overwrite status.json. The
caller (GitHub Actions) then skips the commit, so the dashboard keeps showing
the last good data instead of a red "partial snapshot" error.
"""
from __future__ import annotations

import json
import sys

import fetcher


def main() -> None:
    snap = fetcher.fetch_snapshot()
    errors = snap.get("errors") or []
    if errors:
        print("PARTIAL snapshot, skipping write:", errors, file=sys.stderr)
        sys.exit(1)
    with open("status.json", "w", encoding="utf-8") as f:
        json.dump(snap, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print("wrote status.json:", snap.get("generated_at"))


if __name__ == "__main__":
    main()
