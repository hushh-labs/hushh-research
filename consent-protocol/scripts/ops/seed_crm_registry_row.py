#!/usr/bin/env python3
"""Deprecated compatibility entrypoint for the canonical CRM registry CLI.

This filename remains so existing runbooks fail safely into the new authority.
It intentionally performs no registry writes of its own.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.ops import configure_crm_registry  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--descriptor", required=True)
    parser.add_argument("--operator", required=True)
    args = parser.parse_args()
    print(
        "DEPRECATED: use configure_crm_registry.py apply <descriptor> --activate --operator ...",
        file=sys.stderr,
    )
    original = sys.argv
    try:
        sys.argv = [
            "configure_crm_registry.py",
            "apply",
            args.descriptor,
            "--activate",
            "--operator",
            args.operator,
        ]
        return configure_crm_registry.main()
    finally:
        sys.argv = original


if __name__ == "__main__":
    raise SystemExit(main())
