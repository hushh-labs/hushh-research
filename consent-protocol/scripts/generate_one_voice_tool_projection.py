#!/usr/bin/env python3
"""Write (or --check) the derived One Live Voice tool catalog.

``contracts/kai/one-voice-live-tools.v1.json`` is generated from the Python
tool registry so the frontend, docs, and CI see exactly the tool surface the
model does. It is derived, never authored: run this after any tool change.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

PROTOCOL_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = PROTOCOL_ROOT.parent
if str(PROTOCOL_ROOT) not in sys.path:
    sys.path.insert(0, str(PROTOCOL_ROOT))

from hushh_mcp.one_voice.tools import registry  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Fail instead of writing stale files.")
    args = parser.parse_args()
    problems = registry.validate_gateway_binding()
    if problems:
        for problem in problems:
            print(f"gateway binding: {problem}", file=sys.stderr)
        return 1
    rendered = registry.render_projection()
    stale: list[Path] = []
    for path in registry.projection_paths(REPO_ROOT):
        if not path.exists() or path.read_text(encoding="utf-8") != rendered:
            stale.append(path)
            if not args.check:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(rendered, encoding="utf-8")
    if args.check and stale:
        print(
            "One voice tool projection is stale: "
            + ", ".join(str(p) for p in stale)
            + " (run scripts/generate_one_voice_tool_projection.py)",
            file=sys.stderr,
        )
        return 1
    print(
        f"one-voice-live-tools.v1.json: {len(registry.all_tools())} tools, {'current' if not stale else 'written'}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
