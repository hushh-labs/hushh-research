"""Project the canonical Unicode reaction catalogue into the web picker.

To update the pinned catalogue, download the official emoji-test.txt and pass
--unicode-source PATH. Normal generation/checks are offline and dependency-free.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CATALOGUE = ROOT / "hushh_mcp/data/emoji-reactions.v1.json"
WEB = ROOT.parent / "hushh-webapp/lib/circle-chat/emoji-reactions.generated.json"
SOURCE = "https://www.unicode.org/Public/17.0.0/emoji/emoji-test.txt"
GROUPS = {
    "Smileys & Emotion": ("smileys", "Smileys and emotion", "🙂"),
    "People & Body": ("people", "People and body", "👋"),
    "Animals & Nature": ("animals", "Animals and nature", "🐶"),
    "Food & Drink": ("food", "Food and drink", "🍔"),
    "Travel & Places": ("travel", "Travel and places", "🚗"),
    "Activities": ("activities", "Activities", "⚽"),
    "Objects": ("objects", "Objects", "💡"),
    "Symbols": ("symbols", "Symbols", "❤️"),
    "Flags": ("flags", "Flags", "🏳️"),
}


def build(source: Path) -> dict:
    raw = source.read_bytes()
    if "# Version: 17.0\n" not in raw.decode():
        raise ValueError("Expected the pinned Unicode Emoji 17.0 source")
    categories = []
    category = None
    for line in raw.decode().splitlines():
        if line.startswith("# group:"):
            group = line.removeprefix("# group:").strip()
            if group not in GROUPS:
                category = None  # Standalone components are not complete emoji.
                continue
            key, label, icon = GROUPS[group]
            category = {"id": key, "label": label, "icon": icon, "entries": []}
            categories.append(category)
        elif category is not None and (
            match := re.match(r"^([0-9A-F ]+)\s*; fully-qualified\s*# \S+ E[\d.]+ (.+)$", line)
        ):
            emoji = "".join(chr(int(code, 16)) for code in match[1].split())
            category["entries"].append([emoji, match[2]])
    return {
        "unicodeVersion": "17.0",
        "source": SOURCE,
        "sourceSha256": hashlib.sha256(raw).hexdigest(),
        "copyright": "© 2025 Unicode, Inc. See emoji-reactions.LICENSE.txt (Unicode-3.0).",
        "license": CATALOGUE.with_name("emoji-reactions.LICENSE.txt").read_text(),
        "categories": categories,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--unicode-source", type=Path)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    catalogue = (
        build(args.unicode_source) if args.unicode_source else json.loads(CATALOGUE.read_text())
    )
    encoded = json.dumps(catalogue, ensure_ascii=False, separators=(",", ":")) + "\n"
    values = [entry[0] for category in catalogue["categories"] for entry in category["entries"]]
    if len(values) != 3944 or len(set(values)) != 3944 or max(map(len, values)) > 16:
        raise ValueError("Unexpected Unicode Emoji 17.0 catalogue shape")
    paths = [CATALOGUE, WEB] if WEB.parent.exists() else [CATALOGUE]
    for path in paths:
        if args.check:
            if path.read_text() != encoded:
                raise SystemExit(f"Stale emoji catalogue projection: {path}")
        else:
            path.write_text(encoded)
    print(f"Unicode {catalogue['unicodeVersion']}: {len(values)} emoji; projections verified")


if __name__ == "__main__":
    main()
