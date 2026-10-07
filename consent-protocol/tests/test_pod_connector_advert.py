"""The connectors advert carries one word per connector, and nothing else.

The pod reports its connector states on the heartbeat; the hub keeps them only in
this exact shape. A malformed advert reads as no advert, never a partial one, so a
pod (or anything pretending to be one) can never smuggle an account, a scope or a
token into the hub's registry through this field. The words also never appear on
the anonymous ``/pod/info``.
"""

from __future__ import annotations

import pytest

from api.routes.one.pod_capabilities import (
    connectors_advert,
    connectors_capability,
    pod_capabilities,
)
from hushh_mcp.services import pod_connector_credentials as store

GOOD = {
    "version": 1,
    "states": {
        "gmail": "connected",
        "calendar": "needs_reauth",
        "drive": "absent",
        "contacts": "absent",
    },
}


def test_a_well_formed_advert_is_kept_exactly():
    assert connectors_advert(GOOD) == GOOD
    assert connectors_advert({**GOOD, "accountEmail": "a@b.c"}) == GOOD, "extra keys dropped"


@pytest.mark.parametrize(
    "bad",
    [
        None,
        [],
        {"version": 0, "states": GOOD["states"]},
        {"version": True, "states": GOOD["states"]},
        {"version": 1, "states": {**GOOD["states"], "photos": "absent"}},
        {"version": 1, "states": {"gmail": "connected"}},
        {"version": 1, "states": {**GOOD["states"], "gmail": "ya29.token"}},
        {"version": 1, "states": {**GOOD["states"], "gmail": {"status": "connected"}}},
    ],
    ids=[
        "none",
        "list",
        "zero_version",
        "bool_version",
        "extra_connector",
        "missing_connectors",
        "token_as_word",
        "object_as_word",
    ],
)
def test_anything_else_reads_as_no_advert(bad):
    assert connectors_advert(bad) is None


def test_the_pod_reports_its_own_states_only_while_readable():
    store.set_active_connector_credentials({})
    reported = connectors_capability()
    assert reported == {
        "version": 1,
        "states": {name: "absent" for name in ("gmail", "calendar", "drive", "contacts")},
    }
    assert connectors_advert(reported) == reported, "what the pod says, the hub keeps"
    assert "connectors" not in pod_capabilities(), "never on the anonymous /pod/info"


async def test_an_unreadable_store_sends_no_advert(monkeypatch):
    monkeypatch.setenv("HUSSH_ID", "ha1_advert_owner")

    class _Broken:
        async def replay(self):
            raise OSError("down")

    await store.load_connector_credentials(_Broken())
    try:
        assert connectors_capability() is None
    finally:
        store.set_active_connector_credentials({})
