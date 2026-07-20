"""Generate the checked-in public MCP v0.4 contract artifact.

The runtime contract is authored in ``mcp_modules.flat_contract`` and exposed
through ``mcp_modules.public_contract``. This file exists for package and
partner consumers that need a static review artifact; it is never a second
runtime source of truth.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from mcp_modules.public_contract import get_public_contract  # noqa: E402

OUTPUT = ROOT / "mcp_modules" / "tools" / "public_contract.json"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    rendered = json.dumps(get_public_contract(), indent=2, sort_keys=True) + "\n"
    if args.check:
        return 0 if OUTPUT.read_text(encoding="utf-8") == rendered else 1
    OUTPUT.write_text(rendered, encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
