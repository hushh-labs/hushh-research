"""Typed signed scopes must survive the hub-to-private-pod wire contract."""

from functools import partial
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from api.routes.one import pod_memory, pod_turn
from api.routes.one.pod_consent import PodConsentVerifyRequest, verify_consent_for_pod
from hushh_mcp.consent.token import issue_token, validate_token
from hushh_mcp.constants import ConsentScope
from hushh_mcp.services.pod_consent_client import ConsentVerdict, verify_consent
from hushh_mcp.services.pod_session_authority import LOCAL_TOKEN_PREFIX
from tests.test_pod_consent_authority import _Hub, _Registry, _Request, hub_enabled  # noqa: F401

pytestmark = pytest.mark.usefixtures("hub_enabled")


@pytest.mark.parametrize(
    "granted_scope",
    [
        ConsentScope.CAP_MEMORY_PROVIDER_PROCESS,
        ConsentScope.PKM_READ,
    ],
)
async def test_typed_grant_roundtrip_enforces_exact_processing_scope(monkeypatch, granted_scope):
    monkeypatch.setenv("HUSSH_ID", "hushh-abc")
    monkeypatch.setattr(pod_turn, "pod_mode", lambda: True)
    monkeypatch.setattr(pod_turn, "pod_turn_enabled", lambda: True)
    issued = issue_token(user_id="u1", agent_id="agent_personal", scope=granted_scope)
    scope = ConsentScope.CAP_MEMORY_PROVIDER_PROCESS.value
    payload = await verify_consent_for_pod(
        _Request(),
        "Bearer synthetic",
        PodConsentVerifyRequest(token=issued.token, expectedScope=scope),
        validator=validate_token,
        registry=_Registry(),
    )
    session = {"role": "app", "user_id": "u1", "hushh_id": "hushh-abc", "scopes": ["pkm.read"]}

    async def owner_verifier(_token, *, expected_scope):
        return ConsentVerdict.from_local_session(session, expected_scope=expected_scope)

    memory = AsyncMock()
    memory.set_provider_consent.return_value = 1
    memory.memory_status.return_value = {"provider": {"consent": "granted"}}
    call = partial(
        pod_memory.run_memory_provider_consent,
        payload=pod_memory.PodMemoryProviderConsentRequest(
            granted=True, providerConsentToken=issued.token
        ),
        consent_token=LOCAL_TOKEN_PREFIX + "synthetic",
        verifier=owner_verifier,
        session=session,
        memory_service=memory,
        provider_verifier=partial(verify_consent, client=_Hub(200, payload)),
    )
    if granted_scope == ConsentScope.CAP_MEMORY_PROVIDER_PROCESS:
        assert payload["scope"] == scope
        assert (await call())["granted"] is True
        memory.set_provider_consent.assert_awaited_once()
    else:
        assert payload["valid"] is False
        with pytest.raises(HTTPException) as refusal:
            await call()
        assert refusal.value.status_code == 403
        memory.set_provider_consent.assert_not_awaited()


async def test_dynamic_signed_scope_survives_the_legacy_enum_projection():
    scope = "attr.financial.holdings"
    issued = issue_token(user_id="u1", agent_id="agent_personal", scope=scope)
    valid, _, parsed = validate_token(issued.token, expected_scope=scope)
    assert valid and parsed.scope == ConsentScope.PKM_READ and parsed.scope_str == scope
    result = await verify_consent_for_pod(
        _Request(),
        "Bearer synthetic",
        PodConsentVerifyRequest(token=issued.token, expectedScope=scope),
        validator=validate_token,
        registry=_Registry(),
    )
    assert result["scope"] == scope
