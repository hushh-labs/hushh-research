"""Security boundary of the server-only pilot projection; no live information."""

import hashlib
import hmac
import json
import time
from datetime import datetime, timezone
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes.one import plg
from hushh_mcp.services import plg_evidence as evidence

SECRET = "test-only-plg-export-signature-key-with-32-characters"
NOW = datetime.now(timezone.utc)
ACCOUNT = {"accountId": "pilot-account", "journey": "memory", "since": NOW.isoformat()}
PLAN = "pkm_plan_abcdefghijkl"
COMMIT = evidence.derive_pkm_mutation_commit_id(
    user_id=ACCOUNT["accountId"], domain="home_projects", plan_id=PLAN
)


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("ONE_PLG_EXPORT_ENABLED", "true")
    monkeypatch.setenv("ONE_PLG_EXPORT_SECRET", SECRET)
    monkeypatch.setenv("ONE_PLG_EXPORT_ACCOUNT_IDS", ACCOUNT["accountId"])
    monkeypatch.setenv("ENVIRONMENT", "production")
    app = FastAPI()
    app.include_router(plg.router)
    with TestClient(app) as value:
        yield value


def post(client, payload=None, purpose="snapshot", secret=SECRET):
    body = json.dumps(payload or {"accounts": [ACCOUNT]})
    timestamp = str(int(time.time() * 1000))
    signature = hmac.new(
        secret.encode(), f"{purpose}\n{timestamp}\n{body}".encode(), hashlib.sha256
    ).hexdigest()
    return client.post(
        "/api/one/plg/snapshot",
        content=body,
        headers={
            "Content-Type": "application/json",
            "X-PLG-Timestamp": timestamp,
            "X-PLG-Signature": signature,
        },
    )


def test_export_rejects_wrong_signature_purpose_and_nonproduction(client, monkeypatch):
    source = AsyncMock(return_value={"version": 1})
    monkeypatch.setattr(plg, "snapshot", source)
    assert post(client, secret=SECRET + "-tampered").status_code == 401
    assert post(client, purpose="events").status_code == 401
    assert not source.called
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.delenv("APP_RUNTIME_PROFILE", raising=False)
    assert post(client).status_code == 404
    monkeypatch.setenv("ENVIRONMENT", "production")
    assert (
        post(client).status_code == 200
    )  # Negative control: correct authority reaches the source.
    assert source.call_count == 1


def test_validation_and_provider_errors_never_echo_identifiers_or_private_details(
    client, monkeypatch
):
    result = post(client, {"accounts": [{**ACCOUNT, "accountId": "private/invalid-uid"}]})
    assert result.status_code == 400
    assert "private/invalid-uid" not in result.text
    monkeypatch.setattr(plg, "snapshot", AsyncMock(side_effect=RuntimeError("PRIVATE_DB_CONTENT")))
    result = post(client)
    assert result.status_code == 503
    assert "PRIVATE_DB_CONTENT" not in result.text
    assert result.headers["cache-control"] == "private, no-store"


@pytest.mark.asyncio
async def test_projection_bounds_owner_and_window_and_carries_deletion_without_content(monkeypatch):
    class Connection:
        async def fetch(self, query, *args, **kwargs):
            assert args == (ACCOUNT["accountId"], NOW, NOW)
            return [
                {
                    "action_id": COMMIT,
                    "occurred_at": NOW,
                    "private_content": "PRIVATE_CONTENT",
                    "domain": "home_projects",
                    "plan_id": PLAN,
                    "authorization_mode": "owner_confirmed",
                }
            ]

    class Acquire:
        async def __aenter__(self):
            return Connection()

        async def __aexit__(self, *_):
            pass

    class Pool:
        def acquire(self, **kwargs):
            return Acquire()

    monkeypatch.setattr(evidence, "get_pool", AsyncMock(return_value=Pool()))
    monkeypatch.setattr(evidence.AccountDeletionLifecycleService, "is_tombstoned", lambda _: False)
    request = evidence.PilotRequest.model_validate({"accounts": [ACCOUNT]})
    result = await evidence.snapshot(request, {ACCOUNT["accountId"]}, NOW)
    assert result["retainedOnly"] is True
    assert len(result["accounts"][0]["tasks"]) == 1
    assert "PRIVATE_CONTENT" not in json.dumps(result)
    assert "committed-action" not in json.dumps(result)
    assert COMMIT not in json.dumps(result)
    with pytest.raises(ValueError):
        await evidence.snapshot(request, {"another-owner"}, NOW)
    monkeypatch.setattr(evidence.AccountDeletionLifecycleService, "is_tombstoned", lambda _: True)
    result = await evidence.snapshot(request, {ACCOUNT["accountId"]}, NOW)
    assert result["accounts"][0]["deleted"] is True
    assert result["accounts"][0]["tasks"] == []


def test_memory_requires_exact_plan_commit_and_explicit_owner_confirmation():
    row = {
        "action_id": COMMIT,
        "domain": "home_projects",
        "plan_id": PLAN,
        "authorization_mode": "owner_confirmed",
    }
    assert evidence.confirmed_memory(row, ACCOUNT["accountId"])
    assert not evidence.confirmed_memory(
        {**row, "authorization_mode": "owner_auto_save_policy"}, ACCOUNT["accountId"]
    )
    assert not evidence.confirmed_memory(
        {**row, "plan_id": "pkm_another_plan_abcdefghijkl"}, ACCOUNT["accountId"]
    )
    assert not evidence.confirmed_memory(row, "different-owner")
