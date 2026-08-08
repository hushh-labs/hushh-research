"""The token a pod turn actually runs on, and why there wasn't one.

`issue_standing_pkm_read` mints a 24-hour `pkm.read` grant at provisioning and hands
it to that caller. The registry deliberately never stores the token string. Nothing
re-issued it. So the grant expires after a day and **every pod older than 24 hours
holds nothing** -- while the only token still in hand anywhere is `vault.owner`, the
master grant.

Forwarding that one to a pod would give every pod full owner authority over its
person's holdings: the exact opposite of the least-privilege property the whole
per-user-pod architecture rests on. The fix is a grant that renews, and the
properties worth pinning are which scope it is, when it renews, and that a REVOKED
grant is never handed back.
"""

from __future__ import annotations

# ruff: noqa: S105, S106, S107 -- `token_id="tok"` and friends are fixtures for arguments
# genuinely named token; no real credential appears in this file.
import time

import pytest

from hushh_mcp.constants import ConsentScope
from hushh_mcp.services.personal_agent_grant_service import (
    DEFAULT_STANDING_READ_EXPIRY_MS,
    PERSONAL_AGENT_ID,
    PersonalAgentDisabledError,
    PersonalAgentGrantService,
)

DAY_MS = 24 * 60 * 60 * 1000


class _Ledger:
    def __init__(self) -> None:
        self.events: list[dict] = []

    async def insert_event(self, **kwargs):
        self.events.append(kwargs)
        return 1


def _rows(*, expires_in_ms: int, token_id: str = "live-token"):
    async def _lookup(_user_id, agent_id=None, scope=None):
        _lookup.calls.append({"agent_id": agent_id, "scope": scope})
        return [{"token_id": token_id, "expires_at": int(time.time() * 1000) + expires_in_ms}]

    _lookup.calls = []
    return _lookup


async def _no_rows(_user_id, agent_id=None, scope=None):
    return []


def _validates(ok: bool):
    async def _validator(_token, _scope):
        return (ok, "ok" if ok else "revoked", {"user_id": "u1"} if ok else None)

    return _validator


@pytest.fixture(autouse=True)
def _enabled(monkeypatch):
    import hushh_mcp.services.personal_agent_grant_service as mod

    monkeypatch.setattr(mod, "personal_agent_enabled", lambda: True)


async def _reissue(**kwargs):
    defaults = {
        "lookup": _no_rows,
        "validator": _validates(True),
        "ledger": _Ledger(),
    }
    defaults.update(kwargs)
    return await PersonalAgentGrantService().issue_or_reuse_standing_pkm_read("u1", **defaults)


# -- the scope is the whole point --------------------------------------------------


async def test_it_is_always_a_pkm_read_grant_never_the_master_token():
    """The only token in hand before this was `vault.owner`. Handing that to a pod
    would give it full owner authority over its person's holdings."""
    result = await _reissue()
    assert result["scope"] == ConsentScope.PKM_READ.value
    assert result["scope"] != ConsentScope.VAULT_OWNER.value


async def test_the_grant_is_bound_to_the_personal_agent_identity():
    """Not `self`, not `agent_one`, not a specialist -- so this standing read can
    never be presented by anything except the person's own pod."""
    result = await _reissue()
    assert result["agentId"] == PERSONAL_AGENT_ID


# -- when it renews ----------------------------------------------------------------


async def test_a_healthy_grant_is_reused():
    """Minting on every turn would bury the person's consent history under one row
    per message, which makes the ledger useless exactly where it matters most."""
    ledger = _Ledger()
    result = await _reissue(lookup=_rows(expires_in_ms=20 * 60 * 60 * 1000), ledger=ledger)

    assert result["reused"] is True
    assert result["token"] == "live-token"
    assert ledger.events == [], "reuse must not write a new grant event"


async def test_a_grant_inside_its_last_quarter_is_re_issued():
    """Handing back a token with minutes left is technically valid and practically
    useless -- the turn it was fetched for can outlive it."""
    result = await _reissue(lookup=_rows(expires_in_ms=10 * 60 * 1000))
    assert result["reused"] is False


@pytest.mark.parametrize(
    ("remaining_ms", "reused"),
    [
        (59 * 60 * 1000, False),  # inside the last hour -> renew
        (61 * 60 * 1000, True),  # past it -> keep
    ],
)
async def test_the_renewal_floor_is_an_hour_for_a_day_long_grant(remaining_ms, reused):
    result = await _reissue(lookup=_rows(expires_in_ms=remaining_ms))
    assert result["reused"] is reused


async def test_a_short_grant_is_not_stale_the_moment_it_is_minted():
    """The floor is min(1h, lifetime/4). Without the min(), a 30-minute grant would
    be born inside its own renewal window and re-mint on every single call."""
    result = await _reissue(
        lookup=_rows(expires_in_ms=25 * 60 * 1000), expires_in_ms=30 * 60 * 1000
    )
    assert result["reused"] is True


# -- what must never be handed back ------------------------------------------------


async def test_a_revoked_grant_is_never_reused():
    """The ledger says a grant was ISSUED; only validation says it is still live.
    Revocation is the entire reason that distinction exists."""
    result = await _reissue(
        lookup=_rows(expires_in_ms=20 * 60 * 60 * 1000), validator=_validates(False)
    )
    assert result["reused"] is False


async def test_a_row_with_no_token_is_skipped_rather_than_returned_empty():
    async def _blank(_user_id, agent_id=None, scope=None):
        return [{"token_id": "", "expires_at": int(time.time() * 1000) + DAY_MS}]

    result = await _reissue(lookup=_blank)
    assert result["reused"] is False
    assert result["token"]


async def test_a_lookup_failure_mints_rather_than_failing_the_turn():
    """A ledger read that errors must not mean "your agent cannot know you". Minting
    is the safe direction: it is a fresh least-privilege grant, fully logged."""

    async def _boom(_user_id, agent_id=None, scope=None):
        raise RuntimeError("ledger unreachable")

    result = await _reissue(lookup=_boom)
    assert result["reused"] is False
    assert result["scope"] == ConsentScope.PKM_READ.value


# -- where it looks ----------------------------------------------------------------


async def test_reuse_is_checked_against_the_grant_that_was_actually_written():
    """`issue_standing_pkm_read` writes to the VISIBLE ledger. Looking in the
    internal one would find nothing, mint on every turn, and never say why."""
    lookup = _rows(expires_in_ms=20 * 60 * 60 * 1000)
    await _reissue(lookup=lookup)

    assert lookup.calls[0] == {
        "agent_id": PERSONAL_AGENT_ID,
        "scope": ConsentScope.PKM_READ.value,
    }


async def test_a_fresh_mint_is_logged_to_the_visible_ledger():
    """The owner must be able to see -- and revoke -- what their pod may read."""
    ledger = _Ledger()
    await _reissue(ledger=ledger)

    assert len(ledger.events) == 1
    assert ledger.events[0]["action"] == "CONSENT_GRANTED"
    assert ledger.events[0]["scope"] == ConsentScope.PKM_READ.value


# -- the kill switch ---------------------------------------------------------------


async def test_the_feature_flag_still_governs(monkeypatch):
    import hushh_mcp.services.personal_agent_grant_service as mod

    monkeypatch.setattr(mod, "personal_agent_enabled", lambda: False)
    with pytest.raises(PersonalAgentDisabledError):
        await _reissue()


async def test_the_default_lifetime_matches_the_mint_path():
    """Two different lifetimes for one grant would make the renewal window mean
    different things depending on which code path last touched it."""
    assert DEFAULT_STANDING_READ_EXPIRY_MS == DAY_MS
