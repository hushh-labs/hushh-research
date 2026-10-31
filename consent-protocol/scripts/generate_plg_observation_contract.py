"""Project closed frontend observability identifiers into all three build contexts."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "hushh-webapp/lib/observability/events.ts"
ACTIONS = SOURCE.with_name("actions.ts")


def compile_contract(source: str, *, actions_source: str = "") -> dict:
    # Only authored literal identifiers are admitted. Unsupported syntax fails
    # generation; this parser never evaluates TypeScript or accepts payloads.
    authored = source + ("\n" + actions_source if actions_source else "")
    arrays = {}
    for name, body in re.findall(
        r"export const (\w+_ACTIONS)\s*=\s*\[([\s\S]*?)\]\s*as const", authored
    ):
        without_comments = re.sub(r"/\*[\s\S]*?\*/|//[^\n]*", "", body)
        values = re.findall(r'"([a-z][a-z0-9_]*)"', without_comments)
        if re.sub(r'"[a-z][a-z0-9_]*"|[\s,]', "", without_comments):
            raise ValueError("Observation action identifiers must remain literal enums")
        arrays[name] = values
    categories = source.split("const EVENT_CATEGORY_BY_NAME", 1)[1].split("};", 1)[0]
    names = re.findall(r'^  ([a-z][a-z0-9_]*): "(feature|funnel)"', categories, re.M)
    payloads = source.split("export interface EventPayloadMap", 1)[1]
    action_aliases = dict(
        re.findall(r"export type (\w+)\s*=\s*\(typeof (\w+_ACTIONS)\)\[number\]", authored)
    )
    events = {}
    for name, _ in names:
        body = re.search(r"^  " + re.escape(name) + r": \{([\s\S]*?)^  \};", payloads, re.M)
        action_values = []
        if body:
            referenced = re.search(r"action:\s*\(typeof (\w+_ACTIONS)\)\[number\]", body[1])
            if referenced:
                action_values = arrays[referenced[1]]
            else:
                alias = re.search(r"action:\s*(\w+)\s*;", body[1])
                if alias and alias[1] in action_aliases:
                    action_values = arrays[action_aliases[alias[1]]]
                literals = re.search(r"action:\s*((?:\"[a-z][a-z0-9_]*\"\s*\|?\s*)+);", body[1])
                if literals:
                    action_values = re.findall(r'"([a-z][a-z0-9_]*)"', literals[1])
        events[name] = action_values
    if not events or not arrays:
        raise ValueError("Observation source contract could not be compiled")
    return {
        "version": 1,
        "sourceDigest": hashlib.sha256(authored.encode()).hexdigest(),
        "events": events,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    content = (
        json.dumps(
            compile_contract(
                SOURCE.read_text(encoding="utf-8"),
                actions_source=ACTIONS.read_text(encoding="utf-8"),
            ),
            indent=2,
            sort_keys=True,
        )
        + "\n"
    )
    for context in (ROOT, ROOT / "consent-protocol", ROOT / "hushh-webapp"):
        path = context / "contracts/plg/observability-actions.v1.json"
        if args.check:
            if not path.is_file() or path.read_text(encoding="utf-8") != content:
                raise SystemExit("Regenerate the PLG observability identifier projection")
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8", newline="\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
