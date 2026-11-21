"""UAT directory authority and current-owner isolation; no live providers."""

import hashlib
import hmac
import json
import time
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes.one import plg
from hushh_mcp.services import plg_audience as audience
from hushh_mcp.services import plg_audience_index as index

KEY = "fixture-only-uat-directory-key-distinct-32-characters"
NOW = datetime.now(timezone.utc)


@pytest.fixture
def uat(monkeypatch):
    for name, value in {
        "ENVIRONMENT": "uat",
        "GOOGLE_CLOUD_PROJECT": "hushh-pda-uat",
        "ONE_PLG_ACTIVITY_ENABLED": "true",
        "ONE_PLG_ACTIVITY_UAT_ENABLED": "true",
        "ONE_PLG_ACTIVITY_ALL_REGISTERED": "false",
        "ONE_PLG_UAT_AUDIENCE_ENABLED": "true",
        "ONE_PLG_UAT_AUDIENCE_SECRET": KEY,
    }.items():
        monkeypatch.setenv(name, value)


def test_uat_directory_has_separate_authority_and_no_owner_override(uat, monkeypatch):
    app = FastAPI()
    app.include_router(plg.router)
    source = AsyncMock(return_value={"rows": [], "environment": "uat"})
    monkeypatch.setattr(plg, "audience_page", source)

    def call(client, purpose="audience-uat", key=KEY, body=None):
        raw = json.dumps(body or {"agentId": "agent_one"})
        timestamp = str(int(time.time() * 1000))
        signature = hmac.new(
            key.encode(), f"{purpose}\n{timestamp}\n{raw}".encode(), hashlib.sha256
        ).hexdigest()
        return client.post(
            "/api/one/plg/audience-uat",
            content=raw,
            headers={
                "Content-Type": "application/json",
                "X-PLG-Timestamp": timestamp,
                "X-PLG-Signature": signature,
            },
        )

    with TestClient(app) as client:
        for purpose in ("audience", "owner-uat", "attempt-emails.uat.pull"):
            assert call(client, purpose).status_code == 401
        assert call(client, key="another-key").status_code == 401
        assert (
            call(client, body={"agentId": "agent_one", "environment": "production"}).status_code
            == 400
        )
        assert call(client, body={"agentId": "agent_one", "accountId": "other"}).status_code == 400
        source.assert_not_awaited()
        response = call(client)
        assert response.status_code == 200
        assert response.headers["cache-control"] == "private, no-store"
        assert source.await_args.kwargs == {"environment": "uat"}
        source.side_effect = RuntimeError("PRIVATE_EMAIL_PROVIDER_BODY")
        response = call(client)
        assert response.status_code == 503 and "PRIVATE_EMAIL" not in response.text
        for name, value in {
            "ENVIRONMENT": "production",
            "GOOGLE_CLOUD_PROJECT": "hushh-pda",
            "ONE_PLG_ACTIVITY_ENABLED": "false",
            "ONE_PLG_ACTIVITY_UAT_ENABLED": "false",
            "ONE_PLG_ACTIVITY_ALL_REGISTERED": "true",
            "ONE_PLG_UAT_AUDIENCE_ENABLED": "false",
            "ONE_PLG_UAT_AUDIENCE_SECRET": "short",
            "ONE_PLG_UAT_EXPORT_SECRET": KEY,
            "ONE_PLG_AUDIENCE_SECRET": KEY,
            "ONE_PLG_ATTEMPT_EMAIL_SECRET": KEY,
        }.items():
            with monkeypatch.context() as changed:
                changed.setenv(name, value)
                assert call(client).status_code == 404, name


def test_directory_key_never_authorizes_owner_read_or_email_worker(uat, monkeypatch):
    from fastapi import HTTPException

    from hushh_mcp.services import attempt_email

    monkeypatch.setenv("ONE_PLG_UAT_EXPORT_ENABLED", "true")
    monkeypatch.setenv("ONE_PLG_UAT_EXPORT_SECRET", KEY)
    with pytest.raises(HTTPException) as rejected:
        plg._nonproduction_export_scope("uat")
    assert rejected.value.status_code == 404
    monkeypatch.delenv("ONE_PLG_UAT_EXPORT_SECRET")
    monkeypatch.setenv("ONE_PLG_ATTEMPT_EMAIL_SECRET", KEY)
    with pytest.raises(PermissionError):
        attempt_email.worker_authority()


def test_cursors_cannot_cross_uat_and_production_even_with_same_key():
    request = audience.AudienceRequest()
    for project, other in (("hushh-pda-uat", "hushh-pda"), ("hushh-pda", "hushh-pda-uat")):
        cursor = audience._next_cursor("next-page", request, KEY, NOW, project)
        following = request.model_copy(update={"cursor": cursor})
        assert audience._cursor(following, KEY, NOW, project) == ("next-page", NOW)
        with pytest.raises(audience.AudienceCursorError):
            audience._cursor(following, KEY, NOW, other)


def test_uat_directory_and_index_refuse_production_firebase_before_query(monkeypatch):
    from firebase_admin import auth

    listing, lookup = Mock(), Mock()
    monkeypatch.setattr(auth, "list_users", listing)
    monkeypatch.setattr(auth, "get_users", lookup)

    def wrong():
        return SimpleNamespace(project_id="hushh-pda")

    monkeypatch.setattr(audience, "get_firebase_auth_app", wrong)
    monkeypatch.setattr(index, "get_firebase_auth_app", wrong)
    with pytest.raises(RuntimeError, match="unavailable"):
        audience._firebase_page(None, "hushh-pda-uat")
    with pytest.raises(RuntimeError, match="unavailable"):
        index.registered_records(["uat-owner"], "hushh-pda-uat")
    listing.assert_not_called()
    lookup.assert_not_called()


@pytest.mark.asyncio
async def test_uat_directory_uses_shared_sign_in_with_uat_catalog_and_cursor(uat, monkeypatch):
    from firebase_admin import auth

    app = SimpleNamespace(project_id="hushh-pda")
    monkeypatch.setattr(audience, "get_firebase_auth_app", lambda: app)
    listing = Mock(
        return_value=SimpleNamespace(users=[], **{"next_page_token": "next-identity-page"})
    )
    monkeypatch.setattr(auth, "list_users", listing)
    monkeypatch.setattr(
        audience, "reporting_policy", Mock(side_effect=AssertionError("No Production reporting"))
    )
    monkeypatch.setattr(
        audience, "get_pool", AsyncMock(side_effect=AssertionError("Empty page needs no data read"))
    )
    request = audience.AudienceRequest()
    result = await audience.audience_page(request, KEY, NOW, environment="uat")
    listing.assert_called_once_with(page_token=None, max_results=25, app=app)
    assert result["environment"] == "uat" and result["customerReporting"] is False
    assert result["deliveryAuthorized"] is False and result["rows"] == []
    available = {agent["id"]: agent["available"] for agent in result["catalog"]["agents"]}
    assert available["agent_documents"] is True and available["agent_files"] is False
    following = request.model_copy(update={"cursor": result["nextCursor"]})
    assert audience._cursor(following, KEY, NOW, "hushh-pda-uat")[0] == "next-identity-page"
    with pytest.raises(audience.AudienceCursorError):
        audience._cursor(following, KEY, NOW, "hushh-pda")


class Context:
    def __init__(self, value):
        self.value = value

    async def __aenter__(self):
        return self.value

    async def __aexit__(self, *_):
        pass


@pytest.mark.asyncio
async def test_uat_directory_includes_team_but_excludes_deleted_disabled_and_anonymous(
    uat, monkeypatch
):
    records = [
        SimpleNamespace(
            uid=uid,
            disabled=uid == "disabled",
            custom_claims={},
            provider_data=[],
            email=None if uid == "anonymous" else uid + "@hushh.ai",
            email_verified=True,
            phone_number=None,
            display_name=uid,
            user_metadata=None,
            **{"password_hash": "PRIVATE_HASH"},
        )
        for uid in ("team", "user", "deleted", "disabled", "anonymous")
    ]
    source = Mock(return_value=SimpleNamespace(users=records, **{"next_page_token": "next-page"}))
    monkeypatch.setattr(audience, "_firebase_page", source)
    policy = Mock(side_effect=AssertionError("Production reporting cannot run on UAT"))
    monkeypatch.setattr(audience, "reporting_policy", policy)
    conn = SimpleNamespace(execute=AsyncMock(), fetch=AsyncMock(return_value=[]))
    conn.transaction = lambda **_: Context(None)
    monkeypatch.setattr(
        audience,
        "get_pool",
        AsyncMock(return_value=SimpleNamespace(acquire=lambda **_: Context(conn))),
    )
    active = AsyncMock(return_value={"team", "user"})
    monkeypatch.setattr(
        audience.AccountDeletionLifecycleService, "active_projection_user_ids", active
    )
    monkeypatch.setattr(
        audience.ActorIdentityService, "read_provider_phone_fallbacks", AsyncMock(return_value={})
    )
    monkeypatch.setattr(audience.ActorIdentityService, "get_many", AsyncMock(return_value={}))
    monkeypatch.setattr(
        audience,
        "value_summaries",
        AsyncMock(return_value={uid: {"count": 0} for uid in ("team", "user")}),
    )
    result = await audience.audience_page(audience.AudienceRequest(), KEY, NOW, environment="uat")
    source.assert_called_once_with(None)
    assert set(active.await_args.kwargs["user_ids"]) == {"team", "user", "deleted"}
    assert result["environment"] == "uat" and result["version"] == 2
    assert result["customerReporting"] is False and result["deliveryAuthorized"] is False
    assert result["scanned"] == 5 and result["excluded"] == 3
    assert [row["accountId"] for row in result["rows"]] == ["team", "user"]
    assert all(row["activity"]["coverage"] == "not_started" for row in result["rows"])
    assert "PRIVATE_HASH" not in json.dumps(result) and result["campaignEnrollmentChanged"] is False
    policy.assert_not_called()
    filtered = AsyncMock(return_value=SimpleNamespace(users=[], next_page_token=None))
    monkeypatch.setattr(index, "source_page", filtered)
    await audience.audience_page(
        audience.AudienceRequest(segment="failed"), KEY, NOW, environment="uat"
    )
    assert filtered.await_args.kwargs == {}
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "hushh-pda")
    with pytest.raises(ValueError, match="unavailable"):
        await audience.audience_page(audience.AudienceRequest(), KEY, NOW, environment="uat")
    assert source.call_count == 1 and filtered.await_count == 1
