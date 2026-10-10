from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from firebase_admin import auth as firebase_auth
from slowapi.errors import RateLimitExceeded

from api.middleware import require_vault_owner_token
from api.middlewares.rate_limit import limiter, rate_limit_exceeded_handler
from api.routes.one import business_suggestions as routes
from hushh_mcp.services import business_suggestion_service as service


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "row,expected",
    [
        (None, False),
        ({"setup_completed": False, "vault_status": "active"}, False),
        ({"setup_completed": True, "vault_status": "inactive"}, False),
        ({"setup_completed": True, "vault_status": "active"}, True),
    ],
)
async def test_setup_admission_reads_fresh_canonical_async_state(monkeypatch, row, expected):
    connection = SimpleNamespace(fetchrow=AsyncMock(return_value=row))
    lease = MagicMock()
    lease.__aenter__ = AsyncMock(return_value=connection)
    lease.__aexit__ = AsyncMock(return_value=None)
    monkeypatch.setattr(
        service, "get_pool", AsyncMock(return_value=SimpleNamespace(acquire=lambda: lease))
    )
    assert await service._setup_resolved("synthetic-owner") is expected
    connection.fetchrow.assert_awaited_once_with(
        "SELECT setup_completed, vault_status FROM vault_keys WHERE user_id = $1 LIMIT 1",
        "synthetic-owner",
    )


@pytest.mark.asyncio
async def test_setup_admission_does_not_disguise_database_failure_as_incomplete(monkeypatch):
    monkeypatch.setattr(service, "get_pool", AsyncMock(side_effect=RuntimeError("unavailable")))
    with pytest.raises(RuntimeError, match="unavailable"):
        await service._setup_resolved("synthetic-owner")


def test_live_local_directory_uses_explicit_cli_identity(monkeypatch):
    from hushh_mcp.services import business_directory_suggestions as adapter

    monkeypatch.setenv("HUSHH_LOCAL_GCLOUD_ACCOUNT", "operator@hushh.ai")
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("APP_RUNTIME_PROFILE", "local")
    monkeypatch.delenv("HUSHH_DEPLOY_ENV", raising=False)
    monkeypatch.delenv("K_SERVICE", raising=False)
    monkeypatch.setattr(adapter.shutil, "which", lambda name: "gcloud.cmd")
    calls = []

    def run(command, **kwargs):
        calls.append(command)
        return SimpleNamespace(stdout="test-token")

    monkeypatch.setattr(adapter.subprocess, "run", run)
    assert adapter._invocation_token(local=False) == "test-token"
    assert "--account=operator@hushh.ai" in calls[0]


@pytest.mark.parametrize(
    "override",
    [
        {"ENVIRONMENT": "uat"},
        {"APP_RUNTIME_PROFILE": "hosted"},
        {"HUSHH_DEPLOY_ENV": "uat"},
        {"K_SERVICE": "backend"},
        {"HUSHH_LOCAL_GCLOUD_ACCOUNT": "unapproved@gmail.com"},
    ],
)
def test_directory_cli_identity_cannot_escape_local_runtime(monkeypatch, override):
    from hushh_mcp.services import business_directory_suggestions as adapter

    monkeypatch.setenv("HUSHH_LOCAL_GCLOUD_ACCOUNT", "operator@hushh.ai")
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("APP_RUNTIME_PROFILE", "local")
    monkeypatch.delenv("HUSHH_DEPLOY_ENV", raising=False)
    monkeypatch.delenv("K_SERVICE", raising=False)
    for key, value in override.items():
        monkeypatch.setenv(key, value)
    monkeypatch.setattr(
        adapter.subprocess, "run", lambda *args, **kwargs: pytest.fail("CLI must not run")
    )
    with pytest.raises(adapter.DirectoryUnavailable):
        adapter._invocation_token(local=True)


@pytest.fixture
def fixture_identity(monkeypatch):
    from hushh_mcp.services.actor_identity_service import ActorIdentityService

    async def no_phone_claim(self, user_ids):
        return {}

    monkeypatch.setattr(ActorIdentityService, "get_many", no_phone_claim)
    monkeypatch.setenv("ONE_BUSINESS_DIRECTORY_ENABLED", "true")
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.delenv("ONE_BUSINESS_UAT_FIXTURE_ENABLED", raising=False)
    monkeypatch.delenv("HUSHH_DEPLOY_ENV", raising=False)
    monkeypatch.delenv("APP_RUNTIME_PROFILE", raising=False)
    monkeypatch.setattr(service, "get_firebase_auth_app", lambda: object())
    monkeypatch.setattr(service, "_setup_resolved", AsyncMock(return_value=True))
    record = SimpleNamespace(
        uid="owner", disabled=False, email="person@hushh.ai", email_verified=True
    )
    calls = []

    def get_user(uid, *, app):
        calls.append(uid)
        return record

    monkeypatch.setattr(firebase_auth, "get_user", get_user)

    async def directory_candidate(*args, **kwargs):
        return {
            "status": "suggestion_available",
            "candidates": [
                {
                    "business_uid": "urn:hushh:business:directory:business:owner-row",
                    "synthetic": False,
                    "source_identity": {"source": "directory_seed", "source_key": "owner-row"},
                    "match_evidence": [
                        {"kind": "verified_email_identity", "email": "person@hushh.ai"}
                    ],
                    "draft": {"name": "Owner business", "website": "https://owner.example"},
                    "ownership_verified": False,
                    "claim_created": False,
                    "verification_required": ["business_authority"],
                }
            ],
            "coverage_incomplete": False,
        }

    monkeypatch.setattr(service, "lookup_directory", directory_candidate)
    return record, calls


@pytest.mark.asyncio
async def test_verified_owner_uses_directory_candidate_not_synthetic_fixture(
    fixture_identity, monkeypatch
):
    _, calls = fixture_identity
    # The candidate is returned by the normal directory adapter contract.
    # This test's adapter is mocked so it remains independent of Cloud Run.
    result = await service.get_business_suggestion("owner")
    candidate = result["candidates"][0]
    assert calls == ["owner"]
    assert result["status"] == "suggestion_available"
    assert result["pkm_written"] is False
    assert candidate["synthetic"] is False
    assert candidate["ownership_verified"] is False
    assert candidate["claim_created"] is False
    assert candidate["business_uid"] != "owner"
    assert candidate["source_identity"]["source"] == "directory_seed"


@pytest.mark.asyncio
async def test_unfinished_setup_never_offers_candidate(fixture_identity, monkeypatch):
    monkeypatch.setattr(service, "_setup_resolved", AsyncMock(return_value=False))
    result = await service.get_business_suggestion("owner")
    assert result["status"] == "no_match"
    assert result["candidates"] == []


@pytest.mark.asyncio
async def test_setup_read_failure_is_unavailable_not_no_match(fixture_identity, monkeypatch):
    async def unavailable(uid):
        raise RuntimeError("synthetic database unavailable")

    monkeypatch.setattr(service, "_setup_resolved", unavailable)
    with pytest.raises(service.BusinessSuggestionUnavailable):
        await service.get_business_suggestion("owner")


@pytest.mark.asyncio
async def test_local_rehearsal_is_peer_reviewer_and_uat_resource_bound(
    fixture_identity, monkeypatch
):
    _, calls = fixture_identity
    monkeypatch.setenv("ONE_BUSINESS_DIRECTORY_ENABLED", "false")
    configured = {
        "ENVIRONMENT": "development",
        "APP_RUNTIME_PROFILE": "local",
        "APP_REVIEW_MODE": "true",
        "ONE_BUSINESS_LOCAL_REHEARSAL_ENABLED": "true",
        "REVIEWER_UID": "owner",
        "GOOGLE_CLOUD_PROJECT": "hushh-pda-uat",
        "DB_HOST": "127.0.0.1",
        "CLOUDSQL_INSTANCE_CONNECTION_NAME": "hushh-pda-uat:us-central1:hushh-uat-pg",
    }
    monkeypatch.delenv("K_SERVICE", raising=False)
    for key, value in configured.items():
        monkeypatch.setenv(key, value)
    assert (await service.get_business_suggestion("owner", local_loopback=True))[
        "status"
    ] == "suggestion_available"
    calls.clear()
    assert (await service.get_business_suggestion("owner"))["status"] == "disabled"
    assert (await service.get_business_suggestion("other", local_loopback=True))[
        "status"
    ] == "disabled"
    for key, wrong in {
        "ENVIRONMENT": "production",
        "APP_RUNTIME_PROFILE": "uat",
        "APP_REVIEW_MODE": "false",
        "ONE_BUSINESS_LOCAL_REHEARSAL_ENABLED": "false",
        "REVIEWER_UID": "other",
        "GOOGLE_CLOUD_PROJECT": "hushh-pda",
        "DB_HOST": "remote.example.test",
        "CLOUDSQL_INSTANCE_CONNECTION_NAME": "hushh-pda:us-central1:production",
        "K_SERVICE": "hosted",
        "HUSHH_DEPLOY_ENV": "uat",
    }.items():
        monkeypatch.setenv(key, wrong)
        assert (await service.get_business_suggestion("owner", local_loopback=True))[
            "status"
        ] == "disabled"
        if key in configured:
            monkeypatch.setenv(key, configured[key])
        else:
            monkeypatch.delenv(key)
    assert calls == []


@pytest.mark.parametrize(
    "label,value",
    [
        ("ENVIRONMENT", "production"),
        ("ENVIRONMENT", "prod"),
        ("ENVIRONMENT", "dev"),
        ("ENVIRONMENT", ""),
        ("HUSHH_DEPLOY_ENV", "production"),
        ("HUSHH_DEPLOY_ENV", "prod"),
        ("HUSHH_DEPLOY_ENV", "dev"),
        ("APP_RUNTIME_PROFILE", "production"),
        ("APP_RUNTIME_PROFILE", "dev"),
        ("APP_RUNTIME_PROFILE", "unknown"),
    ],
)
@pytest.mark.asyncio
async def test_non_uat_and_conflicting_labels_never_read_identity(
    fixture_identity, monkeypatch, label, value
):
    _, calls = fixture_identity
    monkeypatch.delenv("ONE_BUSINESS_DIRECTORY_ENABLED", raising=False)
    monkeypatch.setenv(label, value)
    assert (await service.get_business_suggestion("owner"))["status"] == "disabled"
    assert calls == []


@pytest.mark.parametrize(
    "email,verified",
    [
        ("person@hushh.ai", False),
        (None, True),
        ("", True),
        ("@hushh.ai", True),
        ("a@b@hushh.ai", True),
        ("person @hushh.ai", True),
    ],
)
@pytest.mark.asyncio
async def test_ineligible_email_never_builds_candidate(
    fixture_identity, monkeypatch, email, verified
):
    record, _ = fixture_identity
    record.email, record.email_verified = email, verified
    monkeypatch.setattr(
        service, "lookup_directory", lambda *args, **kwargs: pytest.fail("ineligible lookup")
    )
    result = await service.get_business_suggestion("owner")
    assert result["status"] == "insufficient_signals"
    assert result["candidates"] == []


@pytest.mark.asyncio
async def test_verified_consumer_email_uses_normal_directory_lookup(fixture_identity, monkeypatch):
    record, _ = fixture_identity
    record.email = "owner@gmail.com"
    received = []

    async def lookup(email, phone, *, local):
        received.append((email, phone))
        return {"status": "no_match", "candidates": [], "coverage_incomplete": False}

    monkeypatch.setattr(service, "lookup_directory", lookup)
    result = await service.get_business_suggestion("owner")
    assert received == [("owner@gmail.com", None)]
    assert result["status"] == "no_match"


@pytest.mark.asyncio
async def test_lookup_outage_cannot_use_cached_identity(fixture_identity, monkeypatch):
    def failed(*args, **kwargs):
        raise RuntimeError("private-provider-diagnostic")

    monkeypatch.setattr(firebase_auth, "get_user", failed)
    with pytest.raises(service.BusinessSuggestionUnavailable) as error:
        await service.get_business_suggestion("owner")
    assert "private-provider" not in str(error.value)


@pytest.mark.parametrize("field,value", [("disabled", True), ("uid", "other-owner")])
@pytest.mark.asyncio
async def test_disabled_or_mismatched_identity_fails_closed(fixture_identity, field, value):
    record, _ = fixture_identity
    setattr(record, field, value)
    with pytest.raises(service.BusinessSuggestionUnavailable):
        await service.get_business_suggestion("owner")


def test_route_uses_authenticated_subject_not_query_identity(fixture_identity):
    app = FastAPI()
    app.include_router(routes.router)
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "owner"}
    response = TestClient(app).get(
        "/api/one/business/suggestion?user_id=other&email=other@hushh.ai"
    )
    assert response.status_code == 200
    assert fixture_identity[1] == ["owner"]
    assert response.headers["cache-control"] == "private, no-store"


def test_route_denied_auth_never_calls_service(monkeypatch):
    app = FastAPI()
    app.include_router(routes.router)

    def denied():
        raise HTTPException(status_code=401, detail="Invalid token")

    app.dependency_overrides[require_vault_owner_token] = denied
    monkeypatch.setattr(routes, "get_business_suggestion", lambda uid: pytest.fail("auth bypass"))
    response = TestClient(app).get("/api/one/business/suggestion")
    assert response.status_code == 401
    assert response.headers["cache-control"] == "private, no-store"


def test_rate_limit_response_is_private_with_production_handler(fixture_identity, monkeypatch):
    app = FastAPI()
    app.include_router(routes.router)
    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, rate_limit_exceeded_handler)
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "owner"}
    monkeypatch.setattr(limiter, "enabled", True)
    limiter.reset()
    try:
        with TestClient(app) as client:
            responses = [client.get("/api/one/business/suggestion") for _ in range(11)]
        assert all(response.status_code == 200 for response in responses[:10])
        assert responses[-1].status_code == 429
        assert responses[-1].headers["cache-control"] == "private, no-store"
        assert len(fixture_identity[1]) == 10
    finally:
        limiter.reset()


def test_provider_failure_is_retryable_not_empty_and_has_no_diagnostic(
    fixture_identity, monkeypatch
):
    def failed(*args, **kwargs):
        raise RuntimeError("private-provider-diagnostic")

    monkeypatch.setattr(firebase_auth, "get_user", failed)
    app = FastAPI()
    app.include_router(routes.router)
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "owner"}
    response = TestClient(app).get("/api/one/business/suggestion")
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "BUSINESS_IDENTITY_UNAVAILABLE"
    assert "private-provider" not in response.text
    assert response.headers["cache-control"] == "private, no-store"


@pytest.mark.asyncio
async def test_missing_admin_never_reads_provider(fixture_identity, monkeypatch):
    monkeypatch.setattr(service, "get_firebase_auth_app", lambda: None)
    with pytest.raises(service.BusinessSuggestionUnavailable):
        await service.get_business_suggestion("owner")
    assert fixture_identity[1] == []


@pytest.mark.asyncio
async def test_real_lookup_only_uses_fresh_verified_primary_contacts(fixture_identity, monkeypatch):
    from hushh_mcp.services.actor_identity_service import ActorIdentityService

    async def empty_phone(*args):
        return {}

    monkeypatch.setattr(ActorIdentityService, "get_many", empty_phone)
    record, _ = fixture_identity
    monkeypatch.setenv("ONE_BUSINESS_DIRECTORY_ENABLED", "true")
    record.email = "person@company.test"
    record.phone_number = "+12025550123"
    received = []

    async def lookup(email, phone, *, local):
        received.append((email, phone, local))
        return {"status": "no_match", "candidates": [], "coverage_incomplete": False}

    monkeypatch.setattr(service, "lookup_directory", lookup)
    assert (await service.get_business_suggestion("owner"))["status"] == "no_match"
    assert received == [("person@company.test", "+12025550123", False)]
    for phone in [None, "+919876543210", "2025550123"]:
        record.phone_number = phone
        assert (await service.get_business_suggestion("owner"))["status"] == "no_match"
    record.phone_number = "+12025550123"
    record.email_verified = False
    assert (await service.get_business_suggestion("owner"))["status"] == "no_match"
    assert received[1:4] == [("person@company.test", None, False)] * 3
    assert received[-1] == (None, "+12025550123", False)
    record.phone_number = None
    assert (await service.get_business_suggestion("owner"))["status"] == "insufficient_signals"
    assert len(received) == 5  # No fixture fallback and no invented contact control.


def test_real_projection_preserves_branches_and_refuses_false_match_evidence():
    from hushh_mcp.services.business_directory_suggestions import (
        DirectoryUnavailable,
        project_directory_response,
    )

    rows = [
        {
            "vertical": "hotel",
            "canonical_table": "hotels",
            "native_identity": {"id": key},
            "name": "Example branch",
            "ownership_verified": False,
            "draft": {"website": "https://example.test", "phone": "202-555-0123"},
            "evidence": {"exact_phone_match": True, "exact_website_domain_match": True},
        }
        for key in ["1", "2"]
    ]
    payload = {
        "contract_version": "b2b-onboarding.v1",
        "scope": "b2b",
        "status": "needs_selection",
        "ownership_verified": False,
        "claim_created": False,
        "warnings": [],
        "truncated": False,
        "candidates": rows,
    }
    args = {"email": "person@example.test", "phone": "+12025550123"}
    result = project_directory_response(payload, **args)
    assert len({row["business_uid"] for row in result["candidates"]}) == 2
    assert all(
        row["synthetic"] is False and row["ownership_verified"] is False
        for row in result["candidates"]
    )
    payload["truncated"] = True
    assert project_directory_response(payload, **args)["coverage_incomplete"] is True
    rows[0]["draft"]["website"] = "https://unrelated.test"
    with pytest.raises(DirectoryUnavailable):
        project_directory_response(payload, **args)


@pytest.mark.asyncio
async def test_real_outage_never_becomes_no_match_or_fixture(fixture_identity, monkeypatch):
    from hushh_mcp.services.business_directory_suggestions import DirectoryUnavailable

    record, _ = fixture_identity
    record.phone_number = "+12025550123"
    monkeypatch.setenv("ONE_BUSINESS_DIRECTORY_ENABLED", "true")

    async def unavailable(*args, **kwargs):
        raise DirectoryUnavailable()

    monkeypatch.setattr(service, "lookup_directory", unavailable)
    with pytest.raises(service.BusinessSuggestionUnavailable):
        await service.get_business_suggestion("owner")


@pytest.mark.asyncio
async def test_real_phone_uses_only_owner_bound_verified_account_claim(
    fixture_identity, monkeypatch
):
    from hushh_mcp.services.actor_identity_service import ActorIdentityService

    record, _ = fixture_identity
    record.email_verified = False
    monkeypatch.setenv("ONE_BUSINESS_DIRECTORY_ENABLED", "true")
    calls = []
    verified = True

    async def identities(ids):
        assert ids == ["owner"]
        return {
            "owner": {"phone_verified": verified, "phone_number": "+12025550123"},
            "another-owner": {"phone_verified": True, "phone_number": "+12025550456"},
        }

    async def lookup(email, phone, *, local):
        calls.append((email, phone))
        return {"status": "no_match", "candidates": []}

    monkeypatch.setattr(ActorIdentityService, "get_many", lambda self, ids: identities(ids))
    monkeypatch.setattr(service, "lookup_directory", lookup)
    assert (await service.get_business_suggestion("owner"))[
        "contract_version"
    ] == "b2b-profile-suggestion.v2"
    assert calls == [(None, "+12025550123")]
    verified = False
    assert (await service.get_business_suggestion("owner"))["status"] == "insufficient_signals"
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_directory_transport_is_pinned_and_unsupported_contact_is_not_no_match(monkeypatch):
    import httpx

    from hushh_mcp.services import business_directory_suggestions as adapter

    original_client = httpx.AsyncClient
    requests = []

    def transport(request):
        requests.append(request)
        return httpx.Response(422, json={"detail": "unsupported optional contact"})

    monkeypatch.setattr(adapter, "_invocation_token", lambda **kwargs: "test-invocation-token")
    monkeypatch.setattr(
        adapter.httpx,
        "AsyncClient",
        lambda **kwargs: original_client(**kwargs, transport=httpx.MockTransport(transport)),
    )
    result = await adapter.lookup_directory("person@example.test", None, local=False)
    assert result["status"] == "insufficient_signals"
    assert result["coverage_incomplete"] is True
    assert str(requests[0].url) == adapter.DIRECTORY_ORIGIN + "/api/v1/businesses/onboarding/lookup"
    assert requests[0].headers["authorization"] == "Bearer test-invocation-token"
    assert b'"phone"' not in requests[0].content
