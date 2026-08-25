"""Every status a query looks for must be a status something actually writes.

`_STALLED_POD_STATUSES` contained `"failed"`. Nothing has ever written that string --
the provisioning service writes `"provisioning_failed"` -- so the retry sweep queried
for a status that does not exist in the table and has never retried a single failed pod.

It stayed invisible because a sweep that finds nothing and a sweep looking for the wrong
string log identically: `stalled=0` either way. No test could catch it, because every
test asserted one side or the other. This asserts the JOIN between them.

That is the general shape worth guarding, not the one typo: a reader and a writer of the
same vocabulary living in two files, with nothing comparing them.
"""

from __future__ import annotations

import re
from pathlib import Path

from hushh_mcp.services.personal_agent_registry_repo import (
    _ACTIVE_POD_STATUSES,
    _STALLED_POD_STATUSES,
)

_BACKEND = Path(__file__).resolve().parents[1]
_SERVICE = _BACKEND / "hushh_mcp" / "services" / "personal_agent_provisioning_service.py"

#: Statuses the provisioning service can put on a row. Extracted from the source rather
#: than written down here, so this cannot drift the way the two constants did.
_STATUS_WRITE = re.compile(r'status\s*=\s*"([a-z_]+)"')


def _written_statuses() -> set[str]:
    source = _SERVICE.read_text(encoding="utf-8")
    written = set(_STATUS_WRITE.findall(source))
    # `_record("provisioning")` and friends pass the status positionally through a
    # closure, so pick those up too.
    written |= set(re.findall(r'_record\(\s*"([a-z_]+)"', source))
    written |= set(re.findall(r'await record\(\s*"([a-z_]+)"', source))
    # The REGISTRY REPO is a writer too -- `mark_needs_reinit`,
    # `mark_provisioning_failed`, `begin_migration`, `end_migration` all write a
    # status through a dict payload rather than a keyword.
    #
    # This extension used to live inline in the CHECK-constraint test only, so
    # two of the three tests here compared their tuples against a NARROWER set of
    # writers than the third. The first status written solely by the repo and
    # named in `_ACTIVE_POD_STATUSES` therefore failed as "nothing ever writes
    # it" -- a false alarm from the guard, which is how a guard gets weakened
    # rather than fixed. Shared here so all three ask the same question.
    repo = _BACKEND / "hushh_mcp" / "services" / "personal_agent_registry_repo.py"
    written |= set(re.findall(r'"status":\s*"([a-z_]+)"', repo.read_text(encoding="utf-8")))
    # The tombstone TABLE's own lifecycle status, written by the same module; it
    # never touches personal_agent_registry.status. Excluded by name so a
    # registry writer of the same string would still be caught.
    written -= {"deprovision_requested"}
    return written


def test_every_stalled_status_is_a_status_something_writes() -> None:
    """The assertion that would have caught it.

    Broken on purpose: put `"failed"` back into `_STALLED_POD_STATUSES` and this names
    it as a status no writer produces.
    """
    written = _written_statuses()
    assert written, "no status writes found -- the extractor has drifted from the source"

    unwritable = set(_STALLED_POD_STATUSES) - written
    assert not unwritable, (
        f"the retry sweep queries for {sorted(unwritable)}, which nothing ever writes. "
        "It will silently find zero rows forever, and the log is indistinguishable from "
        "a healthy fleet."
    )


def test_every_active_status_is_a_status_something_writes() -> None:
    """The same join on the other query -- this one guards the fleet cost ceiling.

    `_ACTIVE_POD_STATUSES` is what `count_active_pods` uses to enforce
    PERSONAL_AGENT_MAX_PODS. A status missing from it under-counts, and under-counting a
    cost ceiling spends money.
    """
    written = _written_statuses()
    unwritable = set(_ACTIVE_POD_STATUSES) - written
    assert not unwritable, f"the fleet cap counts {sorted(unwritable)}, which nothing ever writes"


def test_the_failed_status_is_spelled_one_way_everywhere() -> None:
    """The specific defect, pinned so it cannot come back by either spelling."""
    written = _written_statuses()
    assert "provisioning_failed" in written
    assert "failed" not in written, (
        "a bare 'failed' status appeared. The vocabulary is 'provisioning_failed'; two "
        "spellings of one state is how the sweep lost track of it the first time."
    )
    assert "provisioning_failed" in _STALLED_POD_STATUSES


def test_the_database_check_admits_every_status_code_writes() -> None:
    """The same defect class, third file: the CHECK constraint is a vocabulary
    READER living in SQL. Migration 907 enumerated the statuses without
    `needs_reinit` while `mark_needs_reinit` wrote it -- so on dev the
    reachability gate detected a gone host, the wake path tried to record the
    verdict, and Postgres refused (observed 2026-08-25). The row stayed `active`
    with a dead host and the recovery affordance never rendered.

    Reads the LATEST personal_agent_registry_status_check definition from the
    parked lane and asserts it admits every status any writer produces.
    """
    # `_written_statuses` now includes the repo's dict-payload writers and drops
    # the tombstone table's own vocabulary; that extension used to live here, and
    # keeping it here meant the other two tests in this file asked a narrower
    # question than this one.
    written = _written_statuses()

    parked = sorted((_BACKEND / "db" / "migrations" / "parked").glob("*.sql"))
    latest_check: str | None = None
    for migration in parked:  # ascending: the last definition wins, like replay
        source = migration.read_text(encoding="utf-8")
        for match in re.finditer(
            r"personal_agent_registry_status_check\s*.*?CHECK \(status IN \((.*?)\)\)",
            source,
            re.S,
        ):
            latest_check = match.group(1)
    assert latest_check, "no personal_agent_registry_status_check found in the parked lane"
    admitted = set(re.findall(r"'([a-z_]+)'", latest_check))

    missing = written - admitted
    assert not missing, (
        f"code writes registry status(es) {sorted(missing)} that the LATEST database "
        "CHECK refuses -- the write will fail at runtime exactly the way needs_reinit "
        "did on dev, and the row will silently keep its stale status"
    )
