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

# Existing metadata-only feature events keep their analytics system category.
# This exact admission excludes unrelated authentication and diagnostics.
REVIEWED_SYSTEM_FEATURE_EVENTS = frozenset(
    {
        "gmail_connect_started",
        "gmail_connect_result",
        "gmail_disconnect_result",
        "gmail_sync_requested",
        "gmail_sync_result",
        "gmail_receipts_loaded",
        "import_upload_started",
        "import_parse_completed",
        "import_quality_gate_passed",
        "import_quality_gate_failed",
        "import_save_completed",
        "consent_action_submitted",
        "consent_action_result",
    }
)


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
    names = re.findall(r'^  ([a-z][a-z0-9_]*): "(feature|funnel|system)"', categories, re.M)
    payloads = source.split("export interface EventPayloadMap", 1)[1]
    action_aliases = dict(
        re.findall(r"export type (\w+)\s*=\s*\(typeof (\w+_ACTIONS)\)\[number\]", authored)
    )
    literal_aliases = {
        name: re.findall(r'"([a-z][a-z0-9_]*)"', values)
        for name, values in re.findall(
            r'export type (\w+)\s*=\s*((?:"[a-z][a-z0-9_]*"\s*\|?\s*)+);',
            authored,
        )
    }
    events = {}
    for name, category in names:
        if category == "system" and name not in REVIEWED_SYSTEM_FEATURE_EVENTS:
            continue
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
                elif (
                    alias and name in REVIEWED_SYSTEM_FEATURE_EVENTS and alias[1] in literal_aliases
                ):
                    action_values = literal_aliases[alias[1]]
                literals = re.search(r"action:\s*((?:\"[a-z][a-z0-9_]*\"\s*\|?\s*)+);", body[1])
                if literals:
                    action_values = re.findall(r'"([a-z][a-z0-9_]*)"', literals[1])
            if (
                name in REVIEWED_SYSTEM_FEATURE_EVENTS
                and re.search(r"\baction:", body[1])
                and not action_values
            ):
                raise ValueError("Reviewed feature actions require literal enums")
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
