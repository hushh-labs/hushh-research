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
SERVICE_PATH = REPO_ROOT / "hushh_mcp" / "services" / "one_location_agent_service.py"

# Both migrations declare the constraint; 064 validating, 068 NOT VALID. They
# have to agree, or a replay changes the answer depending on where it stops.
CONSTRAINT_MIGRATIONS = (
    "064_one_location_public_invites.sql",
    "068_one_location_circle_invites.sql",
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


def test_both_migrations_declare_the_same_allowed_event_types() -> None:
    declared = {name: _allowed_types(name) for name in CONSTRAINT_MIGRATIONS}
    first, second = CONSTRAINT_MIGRATIONS
    assert declared[first] == declared[second], (
        "the two constraint declarations disagree; a replay would then accept or "
        f"reject a row depending on where it stopped. Only in {first}: "
        f"{sorted(declared[first] - declared[second])}. Only in {second}: "
        f"{sorted(declared[second] - declared[first])}"
    )


def test_every_emitted_event_type_is_allowed_by_the_constraint() -> None:
    emitted = set(_EMITTED.findall(SERVICE_PATH.read_text(encoding="utf-8")))
    # Guard the regex itself: if it silently matched nothing, the comparison
    # below would pass while proving nothing at all.
    assert "location_share_created" in emitted, (
        "could not read event types out of one_location_agent_service; the "
        "insert sites changed shape and this test needs updating"
    )

    allowed = _allowed_types(CONSTRAINT_MIGRATIONS[0])
    missing = sorted(emitted - allowed)
    assert not missing, (
        f"{missing} are written to one_location_events but rejected by "
        "one_location_events_event_type_check. Add them to the CHECK list in "
        f"{' and '.join(CONSTRAINT_MIGRATIONS)} -- otherwise the first row "
        "written in an environment permanently breaks that environment's "
        "migration replay, and the deploy failure names neither the value nor "
        "the feature that wrote it."
    )


def test_the_shortened_share_event_stays_allowed() -> None:
    # The specific value the outage was traced to, pinned so a careless revert
    # of the CHECK list fails here rather than in a UAT deploy.
    for name in CONSTRAINT_MIGRATIONS:
        assert "location_share_shortened" in _allowed_types(name)
