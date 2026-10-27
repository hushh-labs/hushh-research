"""Replayed identity backfills must skip owners with a deletion tombstone.

UAT 2026-10-27: replaying migration 135 re-inserted an in-flight deletion's
Circle edge, migration 201's write guard rejected it, the release failed and
the retained account-deletion fence paused every deletion for hours. Every
replayed backfill therefore goes through the checksum-pinned tombstone filter
in db/account_cleanup_replay.py.
"""

from __future__ import annotations

import json
import re

from tests.test_migrations_are_replay_safe import MIGRATIONS_DIR

_DOLLAR_QUOTE = re.compile(r"\$[A-Za-z_0-9]*\$")
_INSERT_SELECT = re.compile(
    r"\bINSERT\s+INTO\s+[\w.\"]+[^;]*?\bSELECT\b[^;]*;", re.IGNORECASE | re.DOTALL
)
_IDENTITY_COLUMN = re.compile(
    r"\b(?:user_id|firebase_uid|[a-z0-9_]+_user_id|subject_id)\b", re.IGNORECASE
)
# Unproven historical backfills. Burn down by enrolling them; never extend.
_UNFILTERED_IDENTITY_BACKFILLS = frozenset({"030", "127", "129"})


def _replays_identity_backfill(sql: str) -> bool:
    """Whether replay executes an INSERT..SELECT that copies an account identity.

    Top-level SQL and anonymous DO bodies run on every deploy; stored function
    bodies only run later behind migration 201's per-row write guards.
    """
    text = re.sub(r"--[^\n]*", "", sql)
    executed, position = [], 0
    while (opening := _DOLLAR_QUOTE.search(text, position)) is not None:
        closing = text.find(opening[0], opening.end())
        if closing < 0:
            break
        before = text[position : opening.start()]
        executed.append(before)
        if re.search(r"\bDO\s*$", before, re.IGNORECASE):
            executed.append(text[opening.end() : closing])
        position = closing + len(opening[0])
    executed.append(text[position:])
    return any(
        _IDENTITY_COLUMN.search(statement[0])
        for statement in _INSERT_SELECT.finditer("\n".join(executed))
    )


def test_replayed_identity_backfills_skip_tombstoned_owners() -> None:
    from db.account_cleanup_replay import SOURCES

    manifest = json.loads(
        (MIGRATIONS_DIR.parent / "release_migration_manifest.json").read_text(encoding="utf-8")
    )
    names = [
        *manifest["ordered_migrations"],
        *(name for overlay in manifest["environment_overlays"].values() for name in overlay),
    ]
    enrolled = {version for version, _filename in SOURCES}
    unfiltered = sorted(
        name
        for name in names
        if name[:3] not in enrolled | _UNFILTERED_IDENTITY_BACKFILLS
        and _replays_identity_backfill((MIGRATIONS_DIR / name).read_text(encoding="utf-8"))
    )
    assert not unfiltered, (
        "These migrations replay an identity INSERT..SELECT without the "
        "tombstone filter, so a deploy during an account deletion fails:\n  "
        + "\n  ".join(unfiltered)
        + "\n\nEnroll each in db/account_cleanup_replay.py (_BOOTSTRAP_SOURCES "
        "plus an _eligible(...) anchor rule)."
    )
