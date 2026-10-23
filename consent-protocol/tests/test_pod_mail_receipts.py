"""Selected mailbox receipt custody, admission and cancellation boundaries."""

# ruff: noqa: S106 -- synthetic credentials only.
from __future__ import annotations

import asyncio
import json
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from starlette.requests import Request

from api.routes.one import pod_commands
from api.routes.one import pod_mail_receipts as route
from hushh_mcp.services import pod_connector_credentials as store
from hushh_mcp.services import pod_mail_receipts as service
from hushh_mcp.services.gmail_receipts_service import GmailApiError
from hushh_mcp.services.pod_connector_tokens import ConnectorTokenError
from hushh_mcp.services.pod_mail_accounts import public_account_id
from tests.pod_connector_harness import SCOPES, credential


@pytest.fixture
def mail(monkeypatch):
    first = credential("gmail", SCOPES["gmail"])
    second = replace(
        first,
        account_id="b" * 32,
        account_subject="other-subject",
        credential_id="22222222-2222-4333-8444-555555555555",
    )
    held = {"gmail": first, "gmail:" + second.account_id: second}
    store.set_active_connector_credentials(held)
    tokens = SimpleNamespace(
        access_token=AsyncMock(return_value="synthetic-access"), forget=lambda *a, **k: None
    )
    monkeypatch.setattr(service, "google_token_source", lambda: tokens)
    authority = SimpleNamespace(require_held=AsyncMock())
    claims = {"user_id": "owner", "role": "app", "scopes": ["pkm.read"]}

    def verified(auth, *, role, scope):
        if auth != "Bearer owner" or role != "app" or scope != "pkm.read":
            raise HTTPException(403, detail="owner session required")
        return authority, claims

    for module in (route, pod_commands):
        monkeypatch.setattr(module, "verified_session", verified)
    monkeypatch.setattr(route, "_require_enabled", lambda: None)
    permit = SimpleNamespace(release=AsyncMock())
    monkeypatch.setattr(
        pod_commands, "ADMISSION", SimpleNamespace(acquire_turn=AsyncMock(return_value=permit))
    )
    monkeypatch.setattr(pod_commands, "pod_incarnation", lambda: "synthetic-incarnation")

    # Test the real account adapter and route; replace only model/extraction I/O.
    def factory(connection, require_access):
        async def current():
            await require_access()
            connection.current()

        async def scan(**kwargs):
            await kwargs["require_access"]()
            await connection.get_read_access_token(user_id="owner")
            assert kwargs["expected_account"] == public_account_id(second)
            return {"items": []}

        return SimpleNamespace(_scan_page=scan), current

    monkeypatch.setattr(route, "owner_receipt_service", factory)
    app = FastAPI()
    app.include_router(route.router)
    client = TestClient(app, raise_server_exceptions=False)
    yield SimpleNamespace(
        first=first, second=second, held=held, tokens=tokens, client=client, permit=permit
    )
    store.set_active_connector_credentials({})


def target(mail):
    return "/connectors/gmail/accounts/" + public_account_id(mail.second) + "/receipts/scan"


def test_streamed_body_is_admitted_once_and_only_the_selected_token_is_used(mail):
    body = json.dumps({"credential_id": mail.second.credential_id})
    denied = mail.client.post(target(mail), content=body, headers={"Authorization": "Bearer hub"})
    assert denied.status_code == 403
    mail.tokens.access_token.assert_not_awaited()
    response = mail.client.post(
        target(mail),
        content=iter([body[:20].encode(), body[20:].encode()]),
        headers={"Authorization": "Bearer owner"},
    )
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    mail.tokens.access_token.assert_awaited_once_with(
        "gmail", "read", account_id=mail.second.account_id
    )
    mail.permit.release.assert_awaited_once()
    stale = mail.client.post(
        target(mail),
        json={"credential_id": mail.first.credential_id},
        headers={"Authorization": "Bearer owner"},
    )
    assert stale.status_code == 409 and stale.json()["code"] == "GMAIL_CONNECTION_CHANGED"


def test_revoked_refresh_is_a_typed_reauth_result_and_never_a_server_error(mail):
    mail.tokens.access_token.side_effect = ConnectorTokenError("NEEDS_REAUTH")
    response = mail.client.post(
        target(mail),
        json={"credential_id": mail.second.credential_id},
        headers={"Authorization": "Bearer owner"},
    )
    assert response.status_code == 409 and response.json() == {"code": "GMAIL_CONNECTION_CHANGED"}
    assert (
        mail.client.post(
            target(mail), content=b"x" * 20001, headers={"Authorization": "Bearer owner"}
        ).status_code
        == 413
    )


async def test_reconnect_and_owner_ai_revision_fence_extraction(mail, monkeypatch):
    from hushh_mcp.agents.email import runtime
    from hushh_mcp.services import pod_ai_selection

    revision = [1]
    monkeypatch.setattr(pod_ai_selection, "ai_selection_revision", lambda: revision[0])
    model = object()
    monkeypatch.setattr(service, "owner_receipt_model", lambda: model)
    monkeypatch.setattr(service, "receipt_source_key", lambda: b"x" * 32)
    runner = AsyncMock(return_value={"is_receipt": False})
    monkeypatch.setattr(runtime, "run_email_gene", runner)
    connection = service.PodReceiptConnection(
        "owner", public_account_id(mail.second), mail.second.credential_id
    )
    receipts, current = service.owner_receipt_service(connection, AsyncMock())
    await current()
    await receipts._extractor({}, "owner", "invocation-label")
    assert runner.await_args.kwargs["model"] is model
    revision[0] += 1
    with pytest.raises(GmailApiError, match="model changed"):
        await current()
    revision[0] -= 1
    store.set_active_connector_credentials({"gmail": mail.first})
    with pytest.raises(GmailApiError, match="Reconnect"):
        await current()
    assert receipts._gmail is connection
    with pytest.raises(RuntimeError, match="hub tables"):
        _ = connection.db


def test_ephemeral_key_and_managed_model_are_refused(monkeypatch):
    from api.routes.one import pod_turn
    from hushh_mcp.services import pod_self_registration

    monkeypatch.setattr(pod_self_registration, "pod_key_is_durable", lambda: False)
    with pytest.raises(GmailApiError) as refused:
        service.receipt_source_key()
    assert refused.value.code == "GMAIL_RECEIPT_STORE_UNAVAILABLE"
    monkeypatch.setattr(pod_turn, "_resolve_model", lambda request: ("gemini", "synthetic-model"))
    monkeypatch.setattr(
        pod_turn,
        "_resolve_owner_target",
        lambda request, *args: (request, ("gemini", "synthetic-model", "hushh_managed_vertex")),
    )
    with pytest.raises(GmailApiError) as refused:
        service.owner_receipt_model()
    assert refused.value.code == "GMAIL_OWNER_MODEL_REQUIRED"


async def test_disconnect_cancels_extraction_and_releases_admission_and_scan_lock(
    mail, monkeypatch
):
    started = asyncio.Event()
    disconnected = asyncio.Event()

    def factory(connection, require_access):
        async def scan(**kwargs):
            started.set()
            await asyncio.Event().wait()

        return SimpleNamespace(_scan_page=scan), require_access

    monkeypatch.setattr(route, "owner_receipt_service", factory)
    body_sent = False

    async def receive():
        nonlocal body_sent
        if not body_sent:
            body_sent = True
            return {
                "type": "http.request",
                "body": json.dumps({"credential_id": mail.second.credential_id}).encode(),
                "more_body": False,
            }
        await disconnected.wait()
        return {"type": "http.disconnect"}

    request = Request(
        {"type": "http", "method": "POST", "path": target(mail), "headers": []}, receive
    )
    task = asyncio.create_task(
        route.receipt_read(public_account_id(mail.second), "scan", request, "Bearer owner")
    )
    await asyncio.wait_for(started.wait(), 2)
    disconnected.set()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, 2)
    assert not route._SCANS.locked()
    mail.permit.release.assert_awaited_once()
