"""Exercise trusted state extraction and runner selection together, without providers."""

from unittest.mock import AsyncMock, Mock

import pytest
from ag_ui.core import RunAgentInput
from fastapi import HTTPException
from starlette.requests import Request

from api.routes.one import agent_chat
from hushh_mcp.one_adk.agent_tree import STATE_CONSENT_TOKEN, STATE_PKM_CONTEXT, STATE_USER_ID


def request(headers=None):
    return Request(
        {
            "type": "http",
            "headers": [(k.encode(), v.encode()) for k, v in (headers or {}).items()],
            "client": ("127.0.0.1", 1),
        }
    )


def incoming(**kwargs):
    values = {
        "thread_id": "synthetic-thread",
        "run_id": "synthetic-run",
        "state": {},
        "messages": [],
        "tools": [],
        "context": [],
        "forwarded_props": {},
    }
    values.update(kwargs)
    return RunAgentInput(**values)


async def select(req, data):
    # ag_ui_adk.endpoint merges the trusted extraction before calling resolver.
    trusted = await agent_chat._extract_state(req, data)
    data.state.update(trusted)
    return await agent_chat._resolve_agent(req, data)


@pytest.fixture
def no_secret_storage(monkeypatch):
    store = Mock(side_effect=AssertionError("intro must never store private context"))
    monkeypatch.setattr(agent_chat, "store_request_secret", store)
    return store


@pytest.mark.parametrize("headers", [{}, {"authorization": "Bearer synthetic-firebase"}])
async def test_only_verified_intro_state_selects_intro(monkeypatch, no_secret_storage, headers):
    monkeypatch.setattr(agent_chat, "verify_firebase_bearer", lambda header: "synthetic-owner")
    data = incoming(
        state={STATE_CONSENT_TOKEN: "forged-reference", STATE_PKM_CONTEXT: "forged-private"}
    )
    assert await select(request(headers), data) is agent_chat._intro_agent
    assert data.state[STATE_CONSENT_TOKEN] == ""
    assert data.state[STATE_PKM_CONTEXT] == ""
    assert data.state[STATE_USER_ID] != "forged-owner"
    no_secret_storage.assert_not_called()


@pytest.mark.parametrize("code", [401, 403, 503])
@pytest.mark.parametrize("header", ["", "HCT:expired", "malformed"])
async def test_supplied_consent_failure_cannot_downgrade(
    monkeypatch, no_secret_storage, header, code
):
    monkeypatch.setattr(
        agent_chat,
        "require_vault_owner_token",
        AsyncMock(side_effect=HTTPException(code, "Credential unavailable")),
    )
    firebase = Mock(return_value="synthetic-owner")
    monkeypatch.setattr(agent_chat, "verify_firebase_bearer", firebase)
    with pytest.raises(HTTPException) as failure:
        await select(
            request({"x-hushh-consent": header, "authorization": "Bearer valid-firebase"}),
            incoming(),
        )
    assert failure.value.status_code == code
    firebase.assert_not_called()
    no_secret_storage.assert_not_called()


@pytest.mark.parametrize("code", [401, 503])
async def test_firebase_failure_cannot_become_anonymous(monkeypatch, no_secret_storage, code):
    monkeypatch.setattr(
        agent_chat,
        "verify_firebase_bearer",
        Mock(side_effect=HTTPException(code, "Credential unavailable")),
    )
    with pytest.raises(HTTPException) as failure:
        await select(request({"authorization": "Bearer synthetic"}), incoming())
    assert failure.value.status_code == code
    no_secret_storage.assert_not_called()


async def test_dual_credentials_must_name_same_owner(monkeypatch, no_secret_storage):
    monkeypatch.setattr(
        agent_chat,
        "require_vault_owner_token",
        AsyncMock(return_value={"user_id": "owner-a", "token": "synthetic-hct"}),
    )
    monkeypatch.setattr(agent_chat, "verify_firebase_bearer", lambda header: "owner-b")
    with pytest.raises(HTTPException) as failure:
        await select(
            request({"x-hushh-consent": "HCT:synthetic", "authorization": "Bearer synthetic"}),
            incoming(),
        )
    assert failure.value.status_code == 403
    no_secret_storage.assert_not_called()


@pytest.mark.parametrize(
    "payload",
    [
        {"forwarded_props": {"pkmContext": "synthetic-private"}},
        {"forwarded_props": {"runtimeCredential": "synthetic-private"}},
        {"tools": [{"name": "synthetic_tool", "description": "synthetic", "parameters": {}}]},
        {"context": [{"description": "synthetic", "value": "synthetic-private"}]},
    ],
)
async def test_intro_refuses_private_payload_and_client_tools(no_secret_storage, payload):
    with pytest.raises(HTTPException) as failure:
        await select(request(), incoming(**payload))
    assert failure.value.status_code == 400
    no_secret_storage.assert_not_called()


@pytest.mark.parametrize(
    "header", ["Bearer HCT:synthetic", "Bearer  HCT:synthetic", "  HCT:synthetic  "]
)
async def test_shared_compatibility_owner_requires_verified_hct(monkeypatch, header):
    monkeypatch.setattr(
        agent_chat,
        "require_vault_owner_token",
        AsyncMock(return_value={"user_id": "owner-a", "token": "synthetic-hct"}),
    )
    monkeypatch.setattr(
        agent_chat, "store_request_secret", lambda value: "synthetic-ref" if value else ""
    )
    data = incoming()
    assert await select(request({"authorization": header}), data) is agent_chat._agent
    assert data.state[STATE_USER_ID] == "owner-a"


async def test_two_supplied_owner_tokens_must_also_match(monkeypatch, no_secret_storage):
    monkeypatch.setattr(
        agent_chat,
        "require_vault_owner_token",
        AsyncMock(
            side_effect=[
                {"user_id": "owner-a", "token": "synthetic-a"},
                {"user_id": "owner-b", "token": "synthetic-b"},
            ]
        ),
    )
    with pytest.raises(HTTPException) as failure:
        await select(
            request({"x-hushh-consent": "HCT:a", "authorization": "Bearer HCT:b"}), incoming()
        )
    assert failure.value.status_code == 403
    no_secret_storage.assert_not_called()


async def test_empty_custom_consent_cannot_fall_back_to_bearer(monkeypatch, no_secret_storage):
    async def verifier(*, request, authorization, hushh_consent):
        assert authorization is None
        assert hushh_consent == ""
        raise HTTPException(401, "Missing Authorization header")

    monkeypatch.setattr(agent_chat, "require_vault_owner_token", verifier)
    with pytest.raises(HTTPException) as failure:
        await select(
            request({"x-hushh-consent": "", "authorization": "Bearer HCT:otherwise-valid"}),
            incoming(),
        )
    assert failure.value.status_code == 401


def test_http_ingress_preserves_verifier_failure_before_streaming(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    app = FastAPI()
    app.include_router(agent_chat.router)
    monkeypatch.setattr(
        agent_chat,
        "verify_firebase_bearer",
        Mock(side_effect=HTTPException(503, "Sign-in unavailable")),
    )
    with TestClient(app) as client:
        response = client.post(
            "/api/one/agent-chat",
            json=incoming().model_dump(by_alias=True),
            headers={"authorization": "Bearer synthetic"},
        )
    assert response.status_code == 503
    assert response.json() == {"detail": "Sign-in unavailable"}
