#!/usr/bin/env python3
"""Keep repository guidance within Codex's default 32 KiB instruction budget."""

from __future__ import annotations

from pathlib import Path


LIMIT = 32 * 1024
ROOT = Path(__file__).resolve().parents[2]
PATH = ROOT / "AGENTS.md"


def main() -> int:
    size = PATH.stat().st_size
    print(f"AGENTS.md instruction budget: {size}/{LIMIT} bytes ({size / LIMIT:.0%})")
    if size > LIMIT:
        print("AGENTS.md exceeds Codex's default combined instruction limit.")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
