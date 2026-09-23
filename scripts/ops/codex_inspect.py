#!/usr/bin/env python3
"""Read-only queries over Hussh's generated runtime topology."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
INDEX_PATH = REPO_ROOT / "contracts/architecture/runtime-topology-index.v1.json"


def load_index() -> dict[str, Any]:
    return json.loads(INDEX_PATH.read_text(encoding="utf-8"))


def exact(items: list[dict[str, Any]], key: str, value: str) -> dict[str, Any]:
    for item in items:
        if item.get(key) == value:
            return item
    raise ValueError(f"No {key} entry matches {value!r}.")


def query(index: dict[str, Any], args: argparse.Namespace) -> Any:
    if args.query == "summary":
        return index["summary"]
    if args.query == "route":
        return exact(index["routes"], "pathname", args.value)
    if args.query == "agent":
        return exact(index["agents"], "id", args.value)
    if args.query == "table-family":
        return exact(index["database_families"], "id", args.value)
    if args.query == "compatibility":
        return index["compatibility_surfaces"]
    if args.query == "action":
        matches = [route for route in index["routes"] if args.value in route.get("voice", {}).get("action_ids", [])]
        if not matches:
            raise ValueError(f"No route declares action {args.value!r}.")
        return {"action_id": args.value, "routes": matches}
    if args.query == "impact":
        relative = args.value.removeprefix("hushh-webapp/")
        return {
            "changed_path": args.value,
            "matched_routes": [route for route in index["routes"] if route.get("page_file") == relative],
            "next_step": "Use `./bin/hushh codex impact <workflow-id> --path <path>` for workflow-specific checks.",
        }
    raise AssertionError(args.query)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("query", choices=("summary", "route", "action", "agent", "table-family", "compatibility", "impact"))
    parser.add_argument("value", nargs="?")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--text", action="store_true")
    args = parser.parse_args()
    if args.query not in {"summary", "compatibility"} and not args.value:
        parser.error(f"{args.query} requires a value")
    try:
        result = query(load_index(), args)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"codex inspect: {exc}", file=sys.stderr)
        return 1
    if args.text and isinstance(result, dict):
        for key, value in result.items():
            print(f"{key}: {json.dumps(value, ensure_ascii=False)}")
    else:
        print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
