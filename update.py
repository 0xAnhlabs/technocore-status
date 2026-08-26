#!/usr/bin/env python3
"""One-shot snapshot: write status.json now. Used for manual runs / bootstrapping."""
from __future__ import annotations

import json
import fetcher


def main() -> None:
    snap = fetcher.fetch_snapshot()
    with open("status.json", "w", encoding="utf-8") as f:
        json.dump(snap, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print("wrote status.json:", snap.get("generated_at"),
          "| errors:", snap.get("errors"))


if __name__ == "__main__":
    main()
