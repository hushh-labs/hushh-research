"""Profile drafts use real ADK task completion and never write owner memory."""

from types import SimpleNamespace

import pytest
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.genai import types
from pydantic import PrivateAttr, ValidationError

from hushh_mcp.one_adk.profile_research import ProfileReport, run_profile_research
from hushh_mcp.services import profile_research_service as service

SOURCE = "https://example.test/team/alex"
OWNER_TOKEN = "fixture-owner-token"  # A fixture label, never a credential.
REPORT = {
    "match_status": "matched",
    "name": "Alex Example",
    "summary": "A public engineering profile.",
    "sections": [
        {
            "kind": "career",
            "facts": [
                {
                    "statement": "I work in engineering.",
                    "confidence": "supported",
                    "sources": [{"title": "Team", "url": SOURCE}],
                }
            ],
        }
    ],
}


class ProfileModel(BaseLlm):
    _calls: int = PrivateAttr(default=0)
    _requests: list = PrivateAttr(default_factory=list)
    _cited_url: str = PrivateAttr(default=SOURCE)
    _no_match: bool = PrivateAttr(default=False)
    _search_evidence: bool = PrivateAttr(default=True)

    def __init__(self, cited_url=SOURCE, *, no_match=False, search_evidence=True):
        super().__init__(model="gemini-fixture")
        self._cited_url = cited_url
        self._no_match = no_match
        self._search_evidence = search_evidence

    async def generate_content_async(self, llm_request, stream=False):
        self._requests.append(llm_request)
        self._calls += 1
        if self._calls == 1:
            yield LlmResponse(
                content=types.Content(
                    role="model",
                    parts=[
                        types.Part(
                            function_call=types.FunctionCall(
                                name="google_search",
                                args={"request": "Research this synthetic profile"},
                            )
                        )
                    ],
                )
            )
        elif self._calls == 2:
            yield LlmResponse(
                content=types.Content(
                    role="model",
                    parts=[
                        types.Part.from_text(
                            text="No reliable match."
                            if self._no_match
                            else "Engineering profile [1]."
                        )
                    ],
                ),
                grounding_metadata=types.GroundingMetadata(
                    web_search_queries=["Synthetic Alex Example profile"]
                    if self._search_evidence
                    else [],
                    grounding_chunks=[
                        types.GroundingChunk(web=types.GroundingChunkWeb(uri=SOURCE, title="Team"))
                    ]
                    if not self._no_match
                    else [],
                ),
            )
        else:
            report = {
                **REPORT,
                "sections": [
                    {
                        "kind": "career",
                        "facts": [
                            {
                                **REPORT["sections"][0]["facts"][0],
                                "sources": [{"title": "Team", "url": self._cited_url}],
                            }
                        ],
                    }
                ],
            }
            if self._no_match:
                report = {
                    **REPORT,
                    "match_status": "no_match",
                    "summary": "No reliable match.",
                    "sections": [],
                }
            yield LlmResponse(
                content=types.Content(
                    role="model",
                    parts=[
                        types.Part(
                            function_call=types.FunctionCall(name="finish_task", args=report)
                        )
                    ],
                )
            )


@pytest.mark.parametrize("invented", [False, True])
async def test_real_task_runner_uses_structured_output_and_grounded_sources(monkeypatch, invented):
    model = ProfileModel("https://invented.test/profile" if invented else SOURCE)
    monkeypatch.setattr(
        "hushh_mcp.runtime_providers.build_managed_regional_gemini_adk_model", lambda *args: model
    )
    checks = []

    async def require_access():
        checks.append(True)

    async def run():
        return await run_profile_research(
            identity={"full_name": "Alex Example", "email": None, "phone_number": None},
            user_id="owner",
            consent_token=OWNER_TOKEN,
            require_access=require_access,
        )

    if invented:
        with pytest.raises(ValueError, match="grounding receipt"):
            await run()
    else:
        result = await run()
        assert result["report"] == REPORT
        assert result["search_suggestions"] == []
    assert model._calls == 3 and len(checks) >= 7
    assert "fixture-owner-token" not in repr(model._requests)
    responses = [
        part.function_response
        for content in model._requests[-1].contents or []
        for part in content.parts or []
        if part.function_response
    ]
    assert any(
        row.name == "google_search"
        and row.response.get("sources") == [{"title": "Team", "url": SOURCE}]
        for row in responses
    )


@pytest.mark.parametrize("search_evidence", [True, False])
async def test_empty_search_is_valid_but_refusal_without_search_is_not_absence(
    monkeypatch, search_evidence
):
    model = ProfileModel(no_match=True, search_evidence=search_evidence)
    monkeypatch.setattr(
        "hushh_mcp.runtime_providers.build_managed_regional_gemini_adk_model", lambda *args: model
    )

    async def admitted():
        return None

    invoke = run_profile_research(
        identity={"full_name": "Alex Example", "email": None, "phone_number": None},
        user_id="owner",
        consent_token=OWNER_TOKEN,
        require_access=admitted,
    )
    if search_evidence:
        result = await invoke
        assert result["report"]["match_status"] == "no_match"
        assert result["report"]["sections"] == []
    else:
        with pytest.raises(ValueError, match="Search execution receipt"):
            await invoke


async def test_current_owner_identifiers_only_and_no_persistence(monkeypatch, caplog):
    monkeypatch.setenv("ONE_PROFILE_RESEARCH_ENABLED", "true")
    calls = []

    async def researcher(**kwargs):
        calls.append(kwargs)
        await kwargs["require_access"]()
        return {"report": REPORT, "search_suggestions": []}

    async def admitted(*args):
        return object()

    async def complete(*args):
        return True

    identity = SimpleNamespace(
        uid="owner",
        disabled=False,
        display_name="Alex Example",
        email="alex@example.test",
        email_verified=True,
        phone_number="+15555550123",
    )
    result = await service.offer_profile_research(
        user_id="owner",
        consent_token=OWNER_TOKEN,
        researcher=researcher,
        owner_check=admitted,
        setup_check=complete,
        identity_lookup=lambda uid: identity,
    )
    assert result["pkm_written"] is False and result["status"] == "offered"
    assert calls[0]["identity"] == {
        "full_name": identity.display_name,
        "email": identity.email,
        "phone_number": identity.phone_number,
    }
    assert identity.email not in caplog.text and identity.phone_number not in caplog.text
    # Unverified email does not leave ingress, even when the UI has a value.
    identity.email_verified = False
    await service.offer_profile_research(
        user_id="owner",
        consent_token=OWNER_TOKEN,
        researcher=researcher,
        owner_check=admitted,
        setup_check=complete,
        identity_lookup=lambda uid: identity,
    )
    assert calls[1]["identity"]["email"] is None


@pytest.mark.parametrize(
    "condition", ["disabled", "not_ready", "wrong_owner", "revoked", "kill_inflight"]
)
async def test_no_draft_crosses_an_ineligible_or_changed_owner_boundary(monkeypatch, condition):
    monkeypatch.setenv(
        "ONE_PROFILE_RESEARCH_ENABLED", "false" if condition == "disabled" else "true"
    )
    live = True
    calls = []

    async def admitted(*args):
        return object() if live else None

    async def complete(*args):
        return condition != "not_ready"

    def identity(uid):
        calls.append("identity")
        return SimpleNamespace(
            uid="other" if condition == "wrong_owner" else uid,
            disabled=False,
            display_name="Alex Example",
            email_verified=False,
            phone_number="+15555550123",
        )

    async def researcher(**kwargs):
        nonlocal live
        calls.append("research")
        if condition == "revoked":
            live = False
        if condition == "kill_inflight":
            monkeypatch.setenv("ONE_PROFILE_RESEARCH_ENABLED", "false")
        return {"report": REPORT, "search_suggestions": []}

    invoke = service.offer_profile_research(
        user_id="owner",
        consent_token=OWNER_TOKEN,
        researcher=researcher,
        owner_check=admitted,
        setup_check=complete,
        identity_lookup=identity,
    )
    if condition in {"wrong_owner", "revoked"}:
        with pytest.raises(PermissionError):
            await invoke
    else:
        result = await invoke
        assert result == {
            "status": "not_ready" if condition == "not_ready" else "disabled",
            "pkm_written": False,
        }
    if condition in {"disabled", "not_ready", "wrong_owner"}:
        assert "research" not in calls
    if condition == "disabled":
        assert "identity" not in calls


def test_report_rejects_duplicate_sections_no_match_findings_and_unsafe_sources():
    for report in (
        {**REPORT, "sections": REPORT["sections"] * 2},
        {**REPORT, "match_status": "no_match"},
        {
            **REPORT,
            "sections": [
                {
                    "kind": "personal",
                    "facts": [
                        {
                            **REPORT["sections"][0]["facts"][0],
                            "sources": [{"title": "Unsafe", "url": "javascript:alert(1)"}],
                        }
                    ],
                }
            ],
        },
    ):
        with pytest.raises(ValidationError):
            ProfileReport.model_validate(report)


def test_route_ignores_client_identity_and_denies_before_research(monkeypatch):
    from fastapi import FastAPI, HTTPException
    from fastapi.testclient import TestClient

    from api.middlewares.chat_key import require_vault_owner_chat_key
    from api.middlewares.rate_limit import limiter
    from api.routes.one import profile_research as routes

    app = FastAPI()
    app.include_router(routes.router)
    monkeypatch.setattr(limiter, "enabled", False)
    app.dependency_overrides[require_vault_owner_chat_key] = lambda: {
        "user_id": "owner",
        "token": "fixture-token",
    }
    seen = []

    async def research(**kwargs):
        seen.append(kwargs)
        return {
            "status": "offered",
            "pkm_written": False,
            "report": REPORT,
            "search_suggestions": [],
        }

    monkeypatch.setattr(routes, "offer_profile_research", research)
    response = TestClient(app).post(
        "/api/one/profile-research", json={"user_id": "other", "full_name": "Wrong Person"}
    )
    assert response.status_code == 200 and seen == [
        {"user_id": "owner", "consent_token": "fixture-token"}
    ]
    assert response.headers["cache-control"] == "private, no-store"

    def denied():
        raise HTTPException(status_code=401, detail="Sign in")

    app.dependency_overrides[require_vault_owner_chat_key] = denied
    response = TestClient(app).post("/api/one/profile-research")
    assert response.status_code == 401 and len(seen) == 1
    assert response.headers["cache-control"] == "private, no-store"


def test_route_hides_provider_errors_and_owner_revocation(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from api.middlewares.chat_key import require_vault_owner_chat_key
    from api.middlewares.rate_limit import limiter
    from api.routes.one import profile_research as routes

    app = FastAPI()
    app.include_router(routes.router)
    monkeypatch.setattr(limiter, "enabled", False)
    app.dependency_overrides[require_vault_owner_chat_key] = lambda: {
        "user_id": "owner",
        "token": "fixture-token",
    }

    async def fails(**kwargs):
        raise RuntimeError("private-provider-details")

    monkeypatch.setattr(routes, "offer_profile_research", fails)
    response = TestClient(app).post("/api/one/profile-research")
    assert response.json() == {"status": "unavailable", "pkm_written": False}
    assert (
        "private-provider" not in response.text
        and response.headers["cache-control"] == "private, no-store"
    )

    async def revoked(**kwargs):
        raise PermissionError("private-owner-details")

    monkeypatch.setattr(routes, "offer_profile_research", revoked)
    response = TestClient(app).post("/api/one/profile-research")
    assert response.status_code == 403 and "private-owner" not in response.text


def test_rate_limit_is_private_and_does_not_start_a_fourth_research(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from slowapi.errors import RateLimitExceeded

    from api.middlewares.chat_key import require_vault_owner_chat_key
    from api.middlewares.rate_limit import limiter, rate_limit_exceeded_handler
    from api.routes.one import profile_research as routes

    app = FastAPI()
    app.include_router(routes.router)
    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, rate_limit_exceeded_handler)
    app.dependency_overrides[require_vault_owner_chat_key] = lambda: {
        "user_id": "owner",
        "token": "fixture-token",
    }
    calls = []

    async def research(**kwargs):
        calls.append(kwargs)
        return {"status": "disabled", "pkm_written": False}

    monkeypatch.setattr(routes, "offer_profile_research", research)
    monkeypatch.setattr(limiter, "enabled", True)
    limiter.reset()
    try:
        with TestClient(app) as client:
            responses = [client.post("/api/one/profile-research") for _ in range(4)]
        assert [response.status_code for response in responses] == [200, 200, 200, 429]
        assert len(calls) == 3
        assert all(
            response.headers["cache-control"] == "private, no-store" for response in responses
        )
        assert responses[-1].json()["detail"]["code"] == "RATE_LIMITED"
    finally:
        limiter.reset()
