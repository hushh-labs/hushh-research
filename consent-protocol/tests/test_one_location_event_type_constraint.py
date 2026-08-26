"""Every one_location_events event_type the service writes must be allowlisted.

This exists because of a real outage: `one_location_agent_service` emits
`location_share_shortened` when an owner shortens a live share, and no
migration ever added that value to `one_location_events_event_type_check`.

Nothing failed at write time -- the constraint was added `NOT VALID` by
migration 068, so existing rows are never re-checked and the INSERT went
through. The damage surfaced somewhere else entirely: migration 064 adds the
same constraint *validating*, and UAT replays the whole migration set on every
deploy. So the first person to use the Edit-duration action wrote two rows that
made 064 fail forever, and every UAT deploy after that rolled back with

    CheckViolationError: check constraint "one_location_events_event_type_check"
    of relation "one_location_events" is violated by some row

which names neither the value nor the feature that wrote it. Four consecutive
deploys from three different people died on it before it was traced back here.

A list in a migration and a string literal in a service cannot drift silently
again: this test reads both and compares them.
"""

from __future__ import annotations

import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS_DIR = REPO_ROOT / "db" / "migrations"
SERVICE_PATHS = (
    REPO_ROOT / "hushh_mcp" / "services" / "one_location_agent_service.py",
    REPO_ROOT / "hushh_mcp" / "services" / "one_location_circle_service.py",
)

# Every migration that replaces the constraint. Later declarations may add
# event types, but may never remove an earlier value. The last entry is the
# contract that reaches an environment which has already replayed the others.
CONSTRAINT_MIGRATIONS = (
    "064_one_location_public_invites.sql",
    "068_one_location_circle_invites.sql",
    "153_one_location_duration_changed_event.sql",
    "154_one_location_access_request_duration.sql",
    "169_one_location_auto_approve_preferences.sql",
    "180_one_location_circle_feed_durability.sql",
)

_CONSTRAINT_BLOCK = re.compile(
    r"ADD CONSTRAINT one_location_events_event_type_check CHECK \(\s*"
    r"event_type IN \((?P<values>.*?)\)",
    re.DOTALL,
)
_QUOTED = re.compile(r"'([a-z_]+)'")
# `event_type="location_share_shortened"` at an insert site.
_EMITTED = re.compile(r"""event_type\s*=\s*["']([a-z_]+)["']""")


def _allowed_types(filename: str) -> set[str]:
    sql = (MIGRATIONS_DIR / filename).read_text(encoding="utf-8")
    # Drop `--` comments first. A prose comment inside the list is allowed to
    # contain a closing paren, and one did -- which ended the match early and
    # made this test report the tail of the list as missing.
    sql = "\n".join(line.split("--", 1)[0] for line in sql.splitlines())
    match = _CONSTRAINT_BLOCK.search(sql)
    assert match is not None, f"{filename} no longer declares the event_type CHECK"
    values = set(_QUOTED.findall(match.group("values")))
    assert values, f"{filename} declares an empty event_type CHECK"
    return values


def test_constraint_migrations_never_remove_an_allowed_event_type() -> None:
    declared = {name: _allowed_types(name) for name in CONSTRAINT_MIGRATIONS}
    for older, newer in zip(
        CONSTRAINT_MIGRATIONS,
        CONSTRAINT_MIGRATIONS[1:],
        strict=False,
    ):
        assert declared[older] <= declared[newer], (
            "a later event-type constraint removed values that an earlier "
            f"migration accepted. Removed between {older} and {newer}: "
            f"{sorted(declared[older] - declared[newer])}"
        )


def test_the_newest_constraint_migration_is_the_one_that_ships() -> None:
    """A value added only to 064/068 never reaches a live database.

    Both are long since applied in UAT and production, where the runner only
    executes migration files it has not seen. Editing them is for a database
    built from scratch; the last entry here is what actually changes the
    constraint in an environment that already exists.
    """
    newest = CONSTRAINT_MIGRATIONS[-1]
    assert (MIGRATIONS_DIR / newest).exists(), f"{newest} is missing"
    older = {int(name.split("_", 1)[0]) for name in CONSTRAINT_MIGRATIONS[:-1]}
    assert int(newest.split("_", 1)[0]) > max(older)


def test_every_emitted_event_type_is_allowed_by_the_constraint() -> None:
    emitted = {
        event_type
        for path in SERVICE_PATHS
        for event_type in _EMITTED.findall(path.read_text(encoding="utf-8"))
    }
    # Guard the regex itself: if it silently matched nothing, the comparison
    # below would pass while proving nothing at all.
    assert "location_share_created" in emitted, (
        "could not read event types out of one_location_agent_service; the "
        "insert sites changed shape and this test needs updating"
    )

    allowed = _allowed_types(CONSTRAINT_MIGRATIONS[-1])
    missing = sorted(emitted - allowed)
    assert not missing, (
        f"{missing} are written to one_location_events but rejected by "
        "one_location_events_event_type_check. Add them to the CHECK list in "
        f"{CONSTRAINT_MIGRATIONS[-1]} -- otherwise the first row "
        "written in an environment permanently breaks that environment's "
        "migration replay, and the deploy failure names neither the value nor "
        "the feature that wrote it."
    )


def test_the_shortened_share_event_stays_allowed() -> None:
    # The specific value the outage was traced to, pinned so a careless revert
    # of the CHECK list fails here rather than in a UAT deploy.
    for name in CONSTRAINT_MIGRATIONS:
        assert "location_share_shortened" in _allowed_types(name)


def test_auto_approve_rule_changes_stay_allowed() -> None:
    for name in CONSTRAINT_MIGRATIONS:
        assert "location_auto_approve_rule_changed" in _allowed_types(name)
