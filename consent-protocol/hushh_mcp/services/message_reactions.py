"""The shared picker catalogue is the authority for message reaction sequences."""

import json
from pathlib import Path

REACTION_EMOJIS = frozenset(
    entry[0]
    for category in json.loads(
        (Path(__file__).resolve().parents[1] / "data/emoji-reactions.v1.json").read_text(
            encoding="utf-8"
        )
    )["categories"]
    for entry in category["entries"]
)
