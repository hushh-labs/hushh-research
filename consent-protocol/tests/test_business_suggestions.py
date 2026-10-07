from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from firebase_admin import auth as firebase_auth
from slowapi.errors import RateLimitExceeded

from api.middleware import require_vault_owner_token
from api.middlewares.rate_limit import limiter, rate_limit_exceeded_handler
from api.routes.one import business_suggestions as routes
from hushh_mcp import runtime_settings
from hushh_mcp.services import business_suggestion_service as service


@pytest.fixture
def fixture_identity(monkeypatch):
    monkeypatch.delenv("ONE_BUSINESS_DIRECTORY_ENABLED", raising=False)
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.setenv("ONE_BUSINESS_UAT_FIXTURE_ENABLED", "true")
    monkeypatch.delenv("HUSHH_DEPLOY_ENV", raising=False)
    monkeypatch.delenv("APP_RUNTIME_PROFILE", raising=False)
    monkeypatch.setattr(service, "get_firebase_auth_app", lambda: object())
    monkeypatch.setattr(service, "_setup_resolved", lambda uid: True)
    record = SimpleNamespace(
        uid="owner", disabled=False, email="person@hushh.ai", email_verified=True
    )
    calls = []

    def get_user(uid, *, app):
        calls.append(uid)
        return record

    monkeypatch.setattr(firebase_auth, "get_user", get_user)
    return record, calls


@pytest.mark.asyncio
async def test_verified_uat_owner_gets_only_synthetic_candidate(fixture_identity):
    _, calls = fixture_identity
    result = await service.get_business_suggestion("owner")
    candidate = result["candidates"][0]
    assert calls == ["owner"]
    assert result["status"] == "suggestion_available"
    assert result["pkm_written"] is False
    assert candidate["synthetic"] is True
    assert candidate["ownership_verified"] is False
    assert candidate["claim_created"] is False
    assert candidate["business_uid"] != "owner"
    assert "person@" not in str(result)
    assert candidate["draft"]["category"] == "Software company · Private intelligence"
    assert candidate["draft"]["phone"] == "+1 202-555-0147"
    assert "UAT fixture" in candidate["draft"]["hours"]


@pytest.mark.asyncio
async def test_unfinished_setup_never_offers_candidate(fixture_identity, monkeypatch):
    monkeypatch.setattr(service, "_setup_resolved", lambda uid: False)
    result = await service.get_business_suggestion("owner")
    assert result["status"] == "no_match"
    assert result["candidates"] == []


@pytest.mark.asyncio
async def test_setup_read_failure_is_unavailable_not_no_match(fixture_identity, monkeypatch):
    def unavailable(uid):
        raise RuntimeError("synthetic database unavailable")

    monkeypatch.setattr(service, "_setup_resolved", unavailable)
    with pytest.raises(service.BusinessSuggestionUnavailable):
        await service.get_business_suggestion("owner")


@pytest.mark.asyncio
async def test_local_rehearsal_is_peer_reviewer_and_uat_resource_bound(fixture_identity, monkeypatch):
    _, calls = fixture_identity
    configured = {
        "ENVIRONMENT": "development", "APP_RUNTIME_PROFILE": "local", "APP_REVIEW_MODE": "true",
        "ONE_BUSINESS_LOCAL_REHEARSAL_ENABLED": "true", "REVIEWER_UID": "owner",
        "GOOGLE_CLOUD_PROJECT": "hushh-pda-uat", "DB_HOST": "127.0.0.1",
        "CLOUDSQL_INSTANCE_CONNECTION_NAME": "hushh-pda-uat:us-central1:hushh-uat-pg",
    }
    monkeypatch.delenv("K_SERVICE", raising=False)
    for key, value in configured.items():
        monkeypatch.setenv(key, value)
    assert (await service.get_business_suggestion("owner", local_loopback=True))["status"] == "suggestion_available"
    calls.clear()
    assert (await service.get_business_suggestion("owner"))["status"] == "disabled"
    assert (await service.get_business_suggestion("other", local_loopback=True))["status"] == "disabled"
    for key, wrong in {
        "ENVIRONMENT": "production", "APP_RUNTIME_PROFILE": "uat", "APP_REVIEW_MODE": "false",
        "ONE_BUSINESS_LOCAL_REHEARSAL_ENABLED": "false", "REVIEWER_UID": "other",
        "GOOGLE_CLOUD_PROJECT": "hushh-pda", "DB_HOST": "remote.example.test",
        "CLOUDSQL_INSTANCE_CONNECTION_NAME": "hushh-pda:us-central1:production",
        "K_SERVICE": "hosted", "HUSHH_DEPLOY_ENV": "uat",
    }.items():
        monkeypatch.setenv(key, wrong)
        assert (await service.get_business_suggestion("owner", local_loopback=True))["status"] == "disabled"
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
        ("ONE_BUSINESS_UAT_FIXTURE_ENABLED", "false"),
    ],
)
@pytest.mark.asyncio
async def test_non_uat_and_conflicting_labels_never_read_identity(
    fixture_identity, monkeypatch, label, value
):
    _, calls = fixture_identity
    monkeypatch.setenv(label, value)
    assert (await service.get_business_suggestion("owner"))["status"] == "disabled"
    assert calls == []


@pytest.mark.parametrize(
    "email,verified",
    [
        ("person@hushh.ai", False),
        (None, True),
        ("", True),
        ("person@sub.hushh.ai", True),
        ("person@hushh.ai.evil.test", True),
        ("person@not-hushh.ai", True),
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
        service, "build_uat_business_candidate", lambda: pytest.fail("ineligible candidate")
    )
    result = await service.get_business_suggestion("owner")
    assert result["status"] == "no_match"
    assert result["candidates"] == []


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


def test_runtime_config_hydrates_default_off_switch(monkeypatch):
    monkeypatch.delenv("ONE_BUSINESS_UAT_FIXTURE_ENABLED", raising=False)
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.delenv("HUSHH_DEPLOY_ENV", raising=False)
    monkeypatch.delenv("APP_RUNTIME_PROFILE", raising=False)
    assert runtime_settings.one_business_uat_fixture_enabled() is False
    monkeypatch.setenv("BACKEND_RUNTIME_CONFIG_JSON", '{"one_business_uat_fixture_enabled":true}')
    runtime_settings.hydrate_runtime_environment()
    assert runtime_settings.one_business_uat_fixture_enabled() is True


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
    rows = [{"vertical": "hotel", "canonical_table": "hotels", "native_identity": {"id": key},
             "name": "Example branch", "ownership_verified": False,
             "draft": {"website": "https://example.test", "phone": "202-555-0123"},
             "evidence": {"exact_phone_match": True, "exact_website_domain_match": True}}
            for key in ["1", "2"]]
    payload = {"contract_version": "b2b-onboarding.v1", "scope": "b2b", "status": "needs_selection",
               "ownership_verified": False, "claim_created": False, "warnings": [],
               "truncated": False, "candidates": rows}
    args = {"email": "person@example.test", "phone": "+12025550123"}
    result = project_directory_response(payload, **args)
    assert len({row["business_uid"] for row in result["candidates"]}) == 2
    assert all(row["synthetic"] is False and row["ownership_verified"] is False for row in result["candidates"])
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
async def test_real_phone_uses_only_owner_bound_verified_account_claim(fixture_identity, monkeypatch):
    from hushh_mcp.services.actor_identity_service import ActorIdentityService
    record, _ = fixture_identity
    record.email_verified = False
    monkeypatch.setenv("ONE_BUSINESS_DIRECTORY_ENABLED", "true")
    calls = []
    verified = True

    async def identities(ids):
        assert ids == ["owner"]
        return {"owner": {"phone_verified": verified, "phone_number": "+12025550123"},
                "another-owner": {"phone_verified": True, "phone_number": "+12025550456"}}

    async def lookup(email, phone, *, local):
        calls.append((email, phone))
        return {"status": "no_match", "candidates": []}

    monkeypatch.setattr(ActorIdentityService, "get_many", lambda self, ids: identities(ids))
    monkeypatch.setattr(service, "lookup_directory", lookup)
    assert (await service.get_business_suggestion("owner"))["contract_version"] == "b2b-profile-suggestion.v2"
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
    monkeypatch.setattr(adapter.httpx, "AsyncClient", lambda **kwargs: original_client(
        **kwargs, transport=httpx.MockTransport(transport)))
    result = await adapter.lookup_directory("person@example.test", None, local=False)
    assert result["status"] == "insufficient_signals"
    assert result["coverage_incomplete"] is True
    assert str(requests[0].url) == adapter.DIRECTORY_ORIGIN + "/api/v1/businesses/onboarding/lookup"
    assert requests[0].headers["authorization"] == "Bearer test-invocation-token"
    assert b'"phone"' not in requests[0].content
