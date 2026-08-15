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
