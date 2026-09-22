"""Contract tests for least-privilege A2A specialist scopes."""

from __future__ import annotations

from dataclasses import replace

import pytest

from hushh_mcp.adk_bridge import contract
from hushh_mcp.adk_bridge.contract import (
    A2AAuthorityContext,
    A2AAuthorityRequired,
    A2ATask,
    require_attenuated_authority,
)
from hushh_mcp.adk_bridge.delegation import (
    SPECIALIST_A2A_SCOPE_MAP,
    get_a2a_required_scope,
    validate_a2a_consent_token,
)
from hushh_mcp.consent.token import issue_token
from hushh_mcp.constants import ConsentScope


def test_specialist_a2a_scope_map_uses_least_privilege_scopes() -> None:
    assert SPECIALIST_A2A_SCOPE_MAP == {
        "agent_one": ConsentScope.CAP_ONE_INVOKE,
        "agent_kai": ConsentScope.AGENT_KAI_ANALYZE,
        "agent_nav": ConsentScope.AGENT_NAV_REVIEW,
        "agent_kyc": ConsentScope.AGENT_KYC_PROCESS,
        "agent_personal_information": ConsentScope.CAP_PKM_MARKETPLACE_VIEW,
    }
    assert ConsentScope.VAULT_OWNER not in SPECIALIST_A2A_SCOPE_MAP.values()


def test_get_a2a_required_scope_rejects_unknown_specialist() -> None:
    with pytest.raises(ValueError, match="Unknown A2A specialist"):
        get_a2a_required_scope("agent_unknown")


def test_validate_a2a_consent_token_accepts_matching_scope() -> None:
    token = issue_token(
        "user_a2a",
        "agent_one",
        ConsentScope.AGENT_KYC_PROCESS,
    )

    validation = validate_a2a_consent_token("agent_kyc", token.token)

    assert validation.ok is True
    assert validation.user_id == "user_a2a"
    assert validation.required_scope == ConsentScope.AGENT_KYC_PROCESS


def test_validate_a2a_consent_token_rejects_wrong_specialist_scope() -> None:
    token = issue_token(
        "user_a2a",
        "agent_one",
        ConsentScope.AGENT_KAI_ANALYZE,
    )

    validation = validate_a2a_consent_token("agent_kyc", token.token)

    assert validation.ok is False
    assert validation.user_id is None
    assert validation.required_scope == ConsentScope.AGENT_KYC_PROCESS


def test_agent_email_requires_dynamic_authority_contract() -> None:
    with pytest.raises(ValueError, match="Unknown A2A specialist"):
        get_a2a_required_scope("agent_email")


def test_agent_connections_requires_dynamic_authority_contract() -> None:
    with pytest.raises(ValueError, match="Unknown A2A specialist"):
        get_a2a_required_scope("agent_connections")


@pytest.fixture
def invocation_task(monkeypatch):
    monkeypatch.setattr(contract.time, "time", lambda: 1000.0)
    return A2ATask(
        user_id="owner",
        consent_token="not-validated-by-this-helper",  # noqa: S106 - inert contract fixture
        conversation_id="session",
        authority=A2AAuthorityContext(
            subject_user_id="owner",
            tenant_id="tenant",
            task_id="hop",
            caller_kind="first_party",
            invocation_capabilities=("agent.connections.invoke",),
            expires_at_ms=1_001_000,
        ),
    )


def _require_invocation(task, **overrides):
    kwargs = dict(
        required_invocation="agent.connections.invoke",
        expected_tenant_id="tenant",
        expected_task_id="hop",
        expected_caller_kind="first_party",
    )
    kwargs.update(overrides)
    return require_attenuated_authority(task, **kwargs)


def test_exact_invocation_admits_only_bound_read_propose_authority(invocation_task):
    assert _require_invocation(invocation_task) is invocation_task.authority
    assert invocation_task.authority.action_capabilities == ()
    assert invocation_task.authority.information_grant_refs == ()


@pytest.mark.parametrize(
    "change",
    [
        {"subject_user_id": "other"},
        {"tenant_id": "other"},
        {"task_id": "other"},
        {"caller_kind": "developer"},
        {"caller_kind": "a2a"},
        {"caller_kind": "invalid"},
        {"developer_app_id": "developer"},
        {"invocation_capabilities": ()},
        {"invocation_capabilities": ("agent.nav.invoke",)},
        {"invocation_capabilities": ("agent.connections.invoke.extra",)},
        {"invocation_capabilities": "agent.connections.invoke"},
        {"invocation_capabilities": (None,)},
        {"expires_at_ms": None},
        {"expires_at_ms": 1_000_000},
        {"expires_at_ms": 999_999},
        {"expires_at_ms": True},
        {"expires_at_ms": "1001000"},
        {"expires_at_ms": float("inf")},
    ],
)
def test_invocation_rejects_wrong_or_malformed_authority(invocation_task, change):
    task = replace(invocation_task, authority=replace(invocation_task.authority, **change))
    with pytest.raises(A2AAuthorityRequired, match="^EXACT_AUTHORITY_REQUIRED$"):
        _require_invocation(task)


@pytest.mark.parametrize(
    "bindings",
    [
        {"expected_tenant_id": None},
        {"expected_tenant_id": ""},
        {"expected_task_id": None},
        {"expected_task_id": " "},
        {"expected_task_id": "other"},
        {"expected_caller_kind": "invalid"},
        {"expected_caller_kind": []},
        {"required_invocation": ""},
        {"required_invocation": " "},
    ],
)
def test_invocation_requires_independent_valid_bindings(invocation_task, bindings):
    with pytest.raises(A2AAuthorityRequired, match="^EXACT_AUTHORITY_REQUIRED$"):
        _require_invocation(invocation_task, **bindings)


def test_invocation_rejects_missing_authority_and_empty_owner(invocation_task):
    for task in (replace(invocation_task, authority=None), replace(invocation_task, user_id="")):
        with pytest.raises(A2AAuthorityRequired):
            _require_invocation(task)


def test_invocation_does_not_weaken_information_or_action_guards(invocation_task):
    with pytest.raises(A2AAuthorityRequired, match="^EXACT_AUTHORITY_REQUIRED$"):
        _require_invocation(invocation_task, information=True)
    with pytest.raises(A2AAuthorityRequired, match="^ACTION_AUTHORITY_REQUIRED$"):
        _require_invocation(invocation_task, action=True)
    scoped = replace(
        invocation_task,
        authority=replace(
            invocation_task.authority,
            information_grant_refs=("grant",),
            encrypted_export_refs=("export",),
            action_capabilities=("connect.accept_request",),
            confirmation_receipt="receipt",
        ),
    )
    assert _require_invocation(scoped, information=True, action=True) is scoped.authority


def test_unmigrated_authority_keeps_existing_contract(invocation_task):
    assert invocation_task.expected_tenant_id is None
    assert invocation_task.expected_task_id is None
    assert invocation_task.specialist_target is None
    legacy = replace(
        invocation_task,
        authority=replace(
            invocation_task.authority,
            expires_at_ms=None,
            invocation_capabilities=(),
        ),
    )
    assert require_attenuated_authority(legacy) is legacy.authority
    with pytest.raises(A2AAuthorityRequired, match="ACTION_AUTHORITY_REQUIRED"):
        require_attenuated_authority(legacy, action=True)


@pytest.fixture
def owner_grant_db(monkeypatch):
    from unittest.mock import AsyncMock

    from hushh_mcp.services.consent_db import ConsentDBService

    active = AsyncMock(return_value=True)
    monkeypatch.setattr(ConsentDBService, "is_token_active", active)
    return active


@pytest.mark.asyncio
async def test_first_party_owner_requires_exact_active_token(owner_grant_db):
    from hushh_mcp.adk_bridge.delegation import validate_first_party_owner_token

    token = issue_token("owner", "self", ConsentScope.VAULT_OWNER)
    validated = await validate_first_party_owner_token("owner", token.token)
    assert validated == token
    owner_grant_db.assert_awaited_once_with("owner", "vault.owner", "self", token_id=token.token)


@pytest.mark.asyncio
@pytest.mark.parametrize("active", [False, None, 1, "true"])
async def test_first_party_owner_rejects_unconfirmed_grant(owner_grant_db, active):
    from hushh_mcp.adk_bridge.delegation import validate_first_party_owner_token

    token = issue_token("owner", "self", ConsentScope.VAULT_OWNER)
    owner_grant_db.return_value = active
    assert await validate_first_party_owner_token("owner", token.token) is None


@pytest.mark.asyncio
async def test_first_party_owner_has_no_database_outage_grace(owner_grant_db):
    from hushh_mcp.adk_bridge.delegation import validate_first_party_owner_token

    token = issue_token("owner", "self", ConsentScope.VAULT_OWNER)
    owner_grant_db.side_effect = RuntimeError("database unavailable")
    assert await validate_first_party_owner_token("owner", token.token) is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "owner, agent, scope, commercial, expires_in_ms",
    [
        ("other", "self", ConsentScope.VAULT_OWNER, False, 60_000),
        ("owner", "agent_one", ConsentScope.VAULT_OWNER, False, 60_000),
        ("owner", "device:fixture", ConsentScope.VAULT_OWNER, False, 60_000),
        ("owner", "self", ConsentScope.AGENT_NAV_REVIEW, False, 60_000),
        ("owner", "self", ConsentScope.VAULT_OWNER, True, 60_000),
        ("owner", "self", ConsentScope.VAULT_OWNER, False, -1),
    ],
)
async def test_first_party_owner_rejects_other_principals_before_db(
    owner_grant_db, owner, agent, scope, commercial, expires_in_ms
):
    from hushh_mcp.adk_bridge.delegation import validate_first_party_owner_token

    token = issue_token(owner, agent, scope, commercial=commercial, expires_in_ms=expires_in_ms)
    assert await validate_first_party_owner_token("owner", token.token) is None
    owner_grant_db.assert_not_awaited()


@pytest.mark.asyncio
async def test_first_party_owner_invalid_signature_and_empty_identity(owner_grant_db):
    from hushh_mcp.adk_bridge.delegation import validate_first_party_owner_token

    token = issue_token("owner", "self", ConsentScope.VAULT_OWNER)
    assert await validate_first_party_owner_token("owner", token.token + "tampered") is None
    assert await validate_first_party_owner_token("", token.token) is None
    assert await validate_first_party_owner_token("owner", "") is None
    owner_grant_db.assert_not_awaited()


@pytest.mark.asyncio
async def test_first_party_owner_cancellation_propagates(owner_grant_db):
    import asyncio

    from hushh_mcp.adk_bridge.delegation import validate_first_party_owner_token

    token = issue_token("owner", "self", ConsentScope.VAULT_OWNER)
    owner_grant_db.side_effect = asyncio.CancelledError
    with pytest.raises(asyncio.CancelledError):
        await validate_first_party_owner_token("owner", token.token)


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["missing", "wrong_exact_scope", "exception"])
async def test_first_party_owner_validation_fails_closed(owner_grant_db, monkeypatch, failure):
    from hushh_mcp.adk_bridge import delegation

    token = issue_token("owner", "self", ConsentScope.VAULT_OWNER)

    def validate(value, scope, *, require_commercial):
        assert value == token.token
        assert scope == ConsentScope.VAULT_OWNER
        assert require_commercial is False
        if failure == "exception":
            raise ValueError("malformed validator result")
        if failure == "missing":
            return True, None, None
        return True, None, token.model_copy(update={"scope_str": "vault.*"})

    monkeypatch.setattr(delegation, "validate_token", validate)
    assert await delegation.validate_first_party_owner_token("owner", token.token) is None
    owner_grant_db.assert_not_awaited()
