"""Hermetic tests for the personal-agent standing pkm.read grant.

Verifies the kill-switch gate, that the grant is a valid pkm.read token bound to
the dedicated personal-agent id, that it is logged to the VISIBLE consent ledger
(so Nav can narrate and the owner can revoke it), and that its scope grants reads
across PKM domains but is not the vault master, so it cannot cross the delegation
boundary. No DB, no network: the ledger is injected.
"""

from __future__ import annotations

import pytest

from hushh_mcp.consent.scope_helpers import scope_matches
from hushh_mcp.consent.token import validate_token
from hushh_mcp.constants import ConsentScope
from hushh_mcp.runtime_settings import get_core_security_settings
from hushh_mcp.services import personal_agent_grant_service as grant
from hushh_mcp.services.personal_agent_grant_service import (
    PERSONAL_AGENT_ID,
    PersonalAgentDisabledError,
    PersonalAgentGrantService,
)

_UID = "firebase_uid_test_123"


class FakeLedger:
    def __init__(self):
        self.events: list[dict] = []

    async def insert_event(self, **kwargs):
        self.events.append(kwargs)
        return len(self.events)


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("APP_SIGNING_KEY", "test_secret_key_for_ci_only_32chars_min")
    monkeypatch.setenv("VAULT_DATA_KEY", "0" * 64)
    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "1")
    get_core_security_settings.cache_clear()
    yield
    get_core_security_settings.cache_clear()


async def test_disabled_flag_refuses(monkeypatch):
    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "0")
    with pytest.raises(PersonalAgentDisabledError):
        await PersonalAgentGrantService().issue_standing_pkm_read(_UID, ledger=FakeLedger())


async def test_missing_user_rejected():
    with pytest.raises(ValueError):
        await PersonalAgentGrantService().issue_standing_pkm_read("", ledger=FakeLedger())


async def test_issues_bound_pkm_read_token():
    ledger = FakeLedger()
    result = await PersonalAgentGrantService().issue_standing_pkm_read(_UID, ledger=ledger)

    assert result["scope"] == "pkm.read"
    assert result["agentId"] == PERSONAL_AGENT_ID
    assert result["token"].startswith("HCT:")
    assert result["expiresAt"] > 0

    # The minted token is a valid pkm.read token bound to (user, personal_agent).
    is_valid, reason, payload = validate_token(result["token"], ConsentScope.PKM_READ)
    assert is_valid, reason
    assert payload is not None
    assert payload.user_id == _UID
    assert payload.agent_id == PERSONAL_AGENT_ID


async def test_logged_to_visible_ledger_for_nav():
    ledger = FakeLedger()
    result = await PersonalAgentGrantService().issue_standing_pkm_read(_UID, ledger=ledger)

    assert len(ledger.events) == 1
    event = ledger.events[0]
    assert event["action"] == "CONSENT_GRANTED"
    assert event["scope"] == "pkm.read"
    assert event["user_id"] == _UID
    assert event["agent_id"] == PERSONAL_AGENT_ID
    assert event["token_id"] == result["token"]
    assert event["metadata"]["grant_kind"] == "personal_agent_standing_read"


async def test_scope_reads_across_domains_but_is_not_master():
    # pkm.read grants read across PKM domains ...
    assert scope_matches("pkm.read", "attr.financial.balance")
    assert scope_matches("pkm.read", "attr.health.summary")
    # ... but is NOT the vault master and does NOT grant capability/specialist scopes,
    # so it can never stand in for a specialist's per-hop attenuated authority.
    assert not scope_matches("pkm.read", "vault.owner")
    assert not scope_matches("pkm.read", "agent.kai.analyze")


async def test_personal_agent_id_is_distinct():
    # Exclusivity rests on a dedicated id, distinct from self / agent_one / specialists.
    assert PERSONAL_AGENT_ID not in {"self", "agent_one", "agent_kai", "agent_nav"}
    assert grant.PERSONAL_AGENT_ID == "personal_agent"


async def test_revoke_writes_revoked_event_to_visible_ledger():
    ledger = FakeLedger()
    result = await PersonalAgentGrantService().revoke_standing_pkm_read(_UID, ledger=ledger)

    assert result["revoked"] is True
    assert result["scope"] == "pkm.read"
    assert result["agentId"] == PERSONAL_AGENT_ID

    assert len(ledger.events) == 1
    event = ledger.events[0]
    assert event["action"] == "REVOKED"
    assert event["scope"] == "pkm.read"
    assert event["user_id"] == _UID
    assert event["agent_id"] == PERSONAL_AGENT_ID
    assert event["metadata"]["revoke_reason"] == "deprovision"


async def test_revoke_missing_user_rejected():
    with pytest.raises(ValueError):
        await PersonalAgentGrantService().revoke_standing_pkm_read("", ledger=FakeLedger())


async def test_revoke_not_blocked_when_flag_off(monkeypatch):
    # Revocation must always be allowed -- e.g. the feature was turned off after a
    # grant was live. Unlike issuing, revoking is never gated on the kill-switch.
    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "0")
    ledger = FakeLedger()
    result = await PersonalAgentGrantService().revoke_standing_pkm_read(_UID, ledger=ledger)
    assert result["revoked"] is True
    assert ledger.events[0]["action"] == "REVOKED"


# --- The standing location-view grant (Phase 5 data door) -----------------------
# The pod reads the owner's location-sharing state through the hub broker on this
# grant. It must be a real, owner-visible, revocable cap.location.live.view token
# bound to the personal agent -- and it must reuse a live grant rather than mint
# one per turn, so the Consent Center is not buried under a row per message.


async def test_location_view_issues_a_bound_location_scope_token():
    ledger = FakeLedger()
    result = await PersonalAgentGrantService().issue_or_reuse_standing_location_view(
        _UID, ledger=ledger, lookup=_no_active_tokens
    )

    assert result["scope"] == "cap.location.live.view"
    assert result["agentId"] == PERSONAL_AGENT_ID
    assert result["token"].startswith("HCT:")
    assert result["reused"] is False

    is_valid, reason, payload = validate_token(result["token"], ConsentScope.CAP_LOCATION_LIVE_VIEW)
    assert is_valid, reason
    assert payload is not None
    assert payload.user_id == _UID
    assert payload.agent_id == PERSONAL_AGENT_ID


async def test_location_view_is_owner_visible_and_revocable_in_the_ledger():
    ledger = FakeLedger()
    result = await PersonalAgentGrantService().issue_or_reuse_standing_location_view(
        _UID, ledger=ledger, lookup=_no_active_tokens
    )

    # Written to the VISIBLE ledger so Nav narrates it and the owner can revoke.
    assert len(ledger.events) == 1
    event = ledger.events[0]
    assert event["action"] == "CONSENT_GRANTED"
    assert event["scope"] == "cap.location.live.view"
    assert event["agent_id"] == PERSONAL_AGENT_ID
    assert event["token_id"] == result["token"]
    assert event["metadata"]["grant_kind"] == "personal_agent_location_view"


async def test_location_view_is_a_read_not_the_vault_master_or_a_write():
    # The location-view scope reads live-share state; it is NOT the vault master
    # and does NOT stand in for a write scope, so it can never mutate holdings.
    assert not scope_matches("cap.location.live.view", "vault.owner")
    assert not scope_matches("cap.location.live.view", "pkm.write")


async def test_location_view_reuses_a_live_grant_rather_than_minting_per_turn():
    """A live grant must be reused, so a pod that reads location every turn does
    not write a fresh visible ledger row every message."""
    import time as _time

    live_expiry = int(_time.time() * 1000) + 20 * 60 * 60 * 1000  # 20h out, well clear
    minted = await PersonalAgentGrantService().issue_or_reuse_standing_location_view(
        _UID, ledger=FakeLedger(), lookup=_no_active_tokens
    )

    async def _one_live_token(user_id, *, agent_id=None, scope=None):
        return [{"token_id": minted["token"], "expires_at": live_expiry}]

    async def _accepts(token, expected_scope):
        return (True, None, object())

    ledger = FakeLedger()
    reused = await PersonalAgentGrantService().issue_or_reuse_standing_location_view(
        _UID, ledger=ledger, lookup=_one_live_token, validator=_accepts
    )
    assert reused["reused"] is True
    assert reused["token"] == minted["token"]
    assert ledger.events == [], "reuse must not write a new consent event"


async def test_location_view_refuses_when_flag_off(monkeypatch):
    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "0")
    with pytest.raises(PersonalAgentDisabledError):
        await PersonalAgentGrantService().issue_or_reuse_standing_location_view(
            _UID, ledger=FakeLedger(), lookup=_no_active_tokens
        )


async def _no_active_tokens(user_id, *, agent_id=None, scope=None):
    return []
