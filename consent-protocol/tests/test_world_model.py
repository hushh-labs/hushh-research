"""Native SDK evidence and identity regressions; no live provider calls."""

import copy
import hashlib
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.one_adk import world_model as pwm
from hushh_mcp.one_adk.world_model_contracts import (
    TOPICS,
    IdentityAssessment,
    WorldModelReport,
    validated_facts_from_work,
)

IDENTITY = {"full_name": "Alex Example", "email": "alex@example.test", "phone_number": None}
PLAN = {
    "purpose": "identity",
    "seed_fields": ["full_name", "email"],
    "anchor_ids": [],
    "candidate_id": None,
    "topics": ["career"],
    "question": "Find the supplied owner's public work.",
}


def assessment():
    return {
        "candidates": [
            {"id": "c1", "label": "Alex Example", "anchor_ids": ["a1"], "blocking_conflicts": []}
        ],
        "anchors": [
            {
                "id": "a1",
                "candidate_id": "c1",
                "kind": "verified_contact",
                "seed_field": "email",
                "assertion": "Publishes the supplied contact.",
                "source_refs": ["s1"],
                "temporal_context": "Current public bio",
            }
        ],
        "identity": {
            "state": "owner_linked",
            "reason": "Exact public contact matches",
            "probability": None,
            "selected_candidate_id": "c1",
            "supporting_anchor_ids": ["a1"],
            "next_step": "finish",
        },
    }


def report():
    return {
        "identity": assessment()["identity"],
        "match_status": "matched",
        "name": "Alex Example",
        "summary": "Public work",
        "sections": [
            {
                "kind": "career",
                "facts": [
                    {
                        "statement": "Builds software.",
                        "confidence": "supported",
                        "sources": [{"title": "Bio", "ref": "s1"}],
                    }
                ],
            }
        ],
        "coverage": [
            {
                "topic": topic,
                "status": "findings" if topic == "career" else "not_attempted",
                "attempt_ids": [1] if topic == "career" else [],
                "explanation": "Public bio" if topic == "career" else "No attempt in this fixture",
            }
            for topic in TOPICS
        ],
        "gaps": ["Other topics have not been researched."],
    }


@pytest.mark.asyncio
@pytest.mark.parametrize("resume_started", [False, True])
async def test_real_adk_native_tools_charge_before_dispatch_and_checkpoint_receipts(
    monkeypatch, resume_started
):
    from google.adk.models.base_llm import BaseLlm
    from google.adk.models.llm_response import LlmResponse
    from google.genai import types

    import hushh_mcp.runtime_providers as providers

    charges, snapshots, requests = [], [], []

    def call(name, args):
        return LlmResponse(
            content=types.Content(
                role="model",
                parts=[types.Part(function_call=types.FunctionCall(name=name, args=args))],
            )
        )

    search_plan = {**PLAN, "topics": ["career", "education"]}
    mistaken_report = report()
    mistaken_report["coverage"][TOPICS.index("career")]["attempt_ids"] = [2]
    repaired_coverage = copy.deepcopy(mistaken_report["coverage"])
    repaired_coverage[TOPICS.index("career")]["attempt_ids"] = [1]
    repaired_coverage[TOPICS.index("education")].update(
        status="unavailable", attempt_ids=[1], explanation="No reliable education finding."
    )
    responses = [
        call("search_public_web", {"plan_json": json.dumps(search_plan)}),
        LlmResponse(
            content=types.Content(
                role="model",
                parts=[types.Part(text="Builds software. Publishes alex@example.test.")],
            ),
            grounding_metadata=types.GroundingMetadata(
                web_search_queries=["Alex Example"],
                grounding_chunks=[{"web": {"title": "Bio", "uri": "https://example.test/alex"}}],
                search_entry_point={"rendered_content": "<div>Google Search</div>"},
            ),
        ),
        call("assess_identity", {"assessment_json": json.dumps(assessment())}),
        call(
            "record_findings",
            {
                "batch_json": json.dumps(
                    {
                        "candidate_id": "c1",
                        "attempt_id": 1,
                        "topic": "career",
                        "facts": [
                            {
                                "statement": "Builds software.",
                                "confidence": "supported",
                                "sources": [{"title": "Bio", "ref": "s1"}],
                            }
                        ],
                    }
                )
            },
        ),
        call("finish_task", mistaken_report),
        call("finish_task", {"coverage": repaired_coverage, "gaps": mistaken_report["gaps"]}),
    ]

    class FakeModel(BaseLlm):
        model: str = "gemini-3.6-flash"

        async def generate_content_async(self, llm_request, stream=False):
            assert responses, "Unexpected model dispatch"
            requests.append(llm_request.model_copy(deep=True))
            if len(responses) == 5:
                assert charges == ([33, 34] if resume_started else [33, 1, 34])
                assert snapshots[-1]["attempts"]["1"]["state"] == "started"
            if len(responses) == 1:
                repair_input = json.loads(llm_request.contents[-1].parts[0].text)
                assert repair_input["selected_candidate_id"] == "c1"
                assert repair_input["identity_state"] == "owner_linked"
            yield responses.pop(0)

    monkeypatch.setattr(
        providers, "build_managed_regional_gemini_adk_model", lambda *_: FakeModel()
    )

    async def charge(slots):
        charges.extend(slots)

    async def progress(value):
        snapshots.append(copy.deepcopy(value))

    decisions = {"confirmed": ["Builds software."], "rejected": ["Likes the color blue."]}
    request = {
        "exact_owner_fields": {"email": IDENTITY["email"], "full_name": IDENTITY["full_name"]},
        "evidenced_anchors": [],
        "research_question": search_plan["question"],
    }
    query_key = hashlib.sha256(json.dumps(request, sort_keys=True).encode()).hexdigest()
    prior_work = (
        {
            "sources": {},
            "search_suggestions": [],
            "attempts": {
                "1": {
                    "plan": search_plan,
                    "query_key": query_key,
                    "observed": False,
                    "answer": "",
                    "source_refs": [],
                    "state": "started",
                    "at": 1.0,
                }
            },
        }
        if resume_started
        else None
    )
    result = await pwm.run_world_model(
        identity=IDENTITY,
        user_id="owner",
        consent_token="fixture",  # noqa: S106 - synthetic test authority
        require_access=AsyncMock(),
        on_attempts_start=charge,
        on_progress=progress,
        owner_decisions=decisions,
        work=prior_work,
        attempts_used=(1,) if resume_started else (),
    )
    # Owner decisions reach the model as structured data, not filtered output.
    sent = json.loads(requests[0].contents[-1].parts[0].text)
    assert sent["owner_decisions"] == decisions
    assert "record_findings" in sent["finding_checkpoint_instruction"]
    assert "attempt_id" in sent["finding_batch_schema"]["properties"]
    assert result["status"] == "offered"
    assert result["research"]["source_use"] == "google_grounded_display_only"
    assert (
        result["report"]["sections"][0]["facts"][0]["sources"][0]["url"]
        == "https://example.test/alex"
    )
    assert result["research"]["coverage"][TOPICS.index("career")]["attempt_ids"] == [1]
    assert result["research"]["coverage"][TOPICS.index("education")]["status"] == "unavailable"
    assert result["research"]["coverage"][TOPICS.index("education")]["attempt_ids"] == [1]
    assert charges == ([33, 34, 35, 36, 37, 38] if resume_started else [33, 1, 34, 35, 36, 37, 38])
    assert snapshots[1]["attempts"]["1"]["state"] == "received"
    provisional = validated_facts_from_work(snapshots[-1])
    assert len(provisional) == 1 and provisional[0]["id"].startswith("p")
    assert [{key: value for key, value in fact.items() if key != "id"} for fact in provisional] == [
        {
            "topic": "career",
            "statement": "Builds software.",
            "confidence": "supported",
            "sources": [{"title": "Bio", "url": "https://example.test/alex"}],
            "identity_state": "owner_linked",
        }
    ]
    assert not responses


@pytest.mark.parametrize(
    "defect", ["missing_receipt", "wrong_candidate", "conflicting_contact", "empty_anchors"]
)
def test_candidate_gate_rejects_unsupported_linkage(defect):
    value = assessment()
    if defect == "missing_receipt":
        value["anchors"][0]["source_refs"] = ["s99"]
    if defect == "wrong_candidate":
        value["anchors"][0]["candidate_id"] = "c2"
    if defect == "conflicting_contact":
        value["candidates"][0]["blocking_conflicts"] = ["Different person"]
    if defect == "empty_anchors":
        value["candidates"][0]["anchor_ids"] = []
    with pytest.raises(ValueError):
        IdentityAssessment.model_validate(value).validate_evidence(
            identity=IDENTITY, source_refs={"s1"}
        )


@pytest.mark.parametrize("defect", ["failed_search", "namesake", "unknown_source", "fake_coverage"])
def test_report_requires_actual_candidate_and_topic_receipts(defect):
    value = report()
    attempts = {"1": {"plan": copy.deepcopy(PLAN), "observed": True, "source_refs": ["s1"]}}
    if defect == "failed_search":
        attempts["1"]["observed"] = False
    if defect == "namesake":
        attempts["1"]["plan"]["candidate_id"] = "c2"
    if defect == "unknown_source":
        value["sections"][0]["facts"][0]["sources"][0]["ref"] = "s99"
    if defect == "fake_coverage":
        attempts["1"]["plan"]["topics"] = []
    with pytest.raises(ValueError):
        WorldModelReport.model_validate(value).validate_receipts(
            IdentityAssessment.model_validate(assessment()), attempts, {"s1"}
        )


@pytest.mark.asyncio
async def test_model_budget_exhaustion_never_dispatches(monkeypatch):
    # Model construction does not send a request; the runner must remain unused.
    import hushh_mcp.hushh_adk.turn as turns

    monkeypatch.setattr(
        turns, "run_specialist_adk_turn", AsyncMock(side_effect=AssertionError("dispatched"))
    )
    result = await pwm.run_world_model(
        identity=IDENTITY,
        user_id="owner",
        consent_token="fixture",  # noqa: S106 - synthetic test authority
        require_access=AsyncMock(),
        on_attempts_start=AsyncMock(),
        attempts_used=tuple(range(33, 161)),
    )
    assert result["research_exhausted"] is True


@pytest.mark.asyncio
async def test_azure_pwm_dispatch_keeps_owner_authority_and_keyless_tokens(monkeypatch):
    from hushh_mcp.one_adk import azure_workload_identity, world_model_azure
    from hushh_mcp.services import world_model_service as service

    config = {
        "tenant_id": "00000000-0000-4000-8000-000000000001",
        "client_id": "00000000-0000-4000-8000-000000000002",
        "primary_endpoint": "https://synthetic.openai.azure.com/openai/v1/",
        "primary_deployment": "pwm-primary",
        "phi_endpoint": "https://synthetic.services.ai.azure.com/openai/v1/",
        "phi_deployment": "pwm-phi",
    }

    def token_supplier():
        return "synthetic-token"

    def azure_token_provider(**kwargs):
        return token_supplier

    azure_run = AsyncMock(return_value={"status": "unavailable", "pkm_written": False})
    monkeypatch.setattr(service, "POLICY", {"provider": "azure_openai_web_search", "azure": config})
    monkeypatch.setattr(service, "admission", AsyncMock(return_value=(None, "owner-binding")))
    monkeypatch.setattr(service, "owner_identity", AsyncMock(return_value=IDENTITY))
    monkeypatch.setattr(
        service,
        "preferences",
        AsyncMock(
            return_value={
                "enabled": True,
                "generation": "g1",
                "consent_version": "pwm-azure-bing-v1",
            }
        ),
    )
    monkeypatch.setattr(
        service, "validate_first_party_owner_token", AsyncMock(return_value=object())
    )
    monkeypatch.setattr(service, "one_profile_research_enabled", lambda: True)
    monkeypatch.setattr(
        service, "run_world_model", AsyncMock(side_effect=AssertionError("Vertex dispatched"))
    )
    monkeypatch.setattr(
        azure_workload_identity, "azure_openai_token_provider", azure_token_provider
    )
    monkeypatch.setattr(world_model_azure, "run_world_model_azure", azure_run)

    result = await service.offer(
        user_id="owner",
        consent_token="synthetic-owner-token",  # noqa: S106 - synthetic test authority
        on_attempts_start=AsyncMock(),
    )
    assert result == {"status": "unavailable", "pkm_written": False}
    azure_run.assert_awaited_once()
    kwargs = azure_run.await_args.kwargs
    assert kwargs["identity"] == IDENTITY
    assert kwargs["primary_deployment"] == "pwm-primary"
    assert kwargs["primary_token_supplier"] is token_supplier
    assert not any(key.startswith("phi_") for key in kwargs)
    await kwargs["require_access"]()


@pytest.mark.asyncio
async def test_azure_pwm_is_restricted_to_federated_uat_runtime(monkeypatch):
    from hushh_mcp.services import world_model_service as service

    owner_identity = AsyncMock()
    monkeypatch.setattr(service, "POLICY", {"provider": "azure_openai_web_search"})
    monkeypatch.setattr(
        service, "get_app_runtime_settings", lambda: SimpleNamespace(environment="production")
    )
    monkeypatch.setattr(service, "owner_identity", owner_identity)

    result, binding = await service.admission("owner", "synthetic-owner-token")  # noqa: S106
    assert result == {"status": "disabled", "pkm_written": False}
    assert binding == ""
    owner_identity.assert_not_awaited()


@pytest.mark.asyncio
async def test_azure_pwm_requires_new_owner_opt_in(monkeypatch):
    from hushh_mcp.services import world_model_service as service

    monkeypatch.setattr(service, "POLICY", {"provider": "azure_openai_web_search"})
    monkeypatch.setattr(
        service, "get_app_runtime_settings", lambda: SimpleNamespace(environment="uat")
    )
    monkeypatch.setattr(service, "owner_identity", AsyncMock(return_value=IDENTITY))
    monkeypatch.setattr(service, "one_profile_research_enabled", lambda: True)
    monkeypatch.setattr(
        service,
        "preferences",
        AsyncMock(
            return_value={
                "enabled": True,
                "generation": "g1",
                "consent_version": "pwm-default-v1",
            }
        ),
    )
    setup = AsyncMock(return_value=False)
    monkeypatch.setattr(service, "owner_setup_resolved", setup)

    result, binding = await service.admission("owner", "synthetic-owner-token")  # noqa: S106
    assert result == {"status": "consent_required", "pkm_written": False}
    assert binding == ""
    setup.assert_not_awaited()


def test_azure_public_preferences_do_not_reuse_vertex_default_consent(monkeypatch):
    from hushh_mcp.services import world_model_preferences as preferences

    monkeypatch.setattr(
        preferences, "load_pwm_policy", lambda: {"provider": "azure_openai_web_search"}
    )
    previous = {
        "enabled": True,
        "email_enabled": True,
        "consent_version": "pwm-default-v1",
    }
    assert preferences.public_preferences(previous)["enabled"] is False
    assert (
        preferences.public_preferences(previous)["research_provider"] == "azure_openai_web_search"
    )
    accepted = {**previous, "consent_version": "pwm-azure-bing-v1"}
    assert preferences.public_preferences(accepted)["enabled"] is True
    monkeypatch.setattr(
        preferences, "load_pwm_policy", lambda: {"provider": "vertex_google_search"}
    )
    assert preferences.public_preferences(previous)["research_provider"] == "vertex_google_search"


@pytest.mark.asyncio
async def test_azure_preferences_reject_legacy_client_consent_before_database_access(monkeypatch):
    from hushh_mcp.services import world_model_preferences as preferences

    monkeypatch.setattr(
        preferences, "load_pwm_policy", lambda: {"provider": "azure_openai_web_search"}
    )
    authority = AsyncMock()
    monkeypatch.setattr(preferences, "validate_first_party_owner_token", authority)
    with pytest.raises(ValueError, match="disclosure version"):
        await preferences.update_preferences(
            "owner",
            "synthetic-owner-token",  # noqa: S106
            enabled=True,
            email_enabled=True,
            consent_version="pwm-native-v1",
        )
    authority.assert_not_awaited()


def test_preferences_route_passes_azure_consent_version_and_rejects_mismatch(monkeypatch):
    client, routes = owner_client(monkeypatch, SimpleNamespace())
    update = AsyncMock(return_value={"enabled": True})
    monkeypatch.setattr(routes.preferences, "update_preferences", update)
    response = client.put(
        "/api/one/world-model/preferences",
        json={
            "enabled": True,
            "email_enabled": True,
            "consent_version": "pwm-azure-bing-v1",
        },
    )
    assert response.status_code == 200
    update.assert_awaited_once_with(
        "owner",
        "fixture",
        enabled=True,
        email_enabled=True,
        consent_version="pwm-azure-bing-v1",
    )
    update.side_effect = ValueError("disclosure version")
    response = client.put(
        "/api/one/world-model/preferences",
        json={"enabled": True, "email_enabled": True, "consent_version": "pwm-native-v1"},
    )
    assert response.status_code == 422


def test_integration_endpoint_only_accepts_current_owner_identifiers(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from api.middlewares.chat_key import require_vault_owner_chat_key
    from api.routes.one import world_model as routes
    from hushh_mcp.services import world_model_service

    start = AsyncMock(return_value={"status": "pending", "pkm_written": False})
    monkeypatch.setattr(routes, "world_model_jobs", SimpleNamespace(start=start))
    monkeypatch.setattr(
        world_model_service,
        "owner_identity",
        AsyncMock(
            return_value={
                "full_name": "Alex Example",
                "email": "alex@example.test",
                "phone_number": None,
            }
        ),
    )
    app = FastAPI()
    app.include_router(routes.router)
    app.dependency_overrides[require_vault_owner_chat_key] = lambda: {
        "user_id": "owner",
        "token": "fixture",
    }
    client = TestClient(app)
    body = {"name": "Alex Example", "email": "alex@example.test"}
    result = client.post("/api/one/world-model/research", json=body)
    assert result.status_code == 202
    assert result.headers["cache-control"] == "private, no-store"
    start.assert_awaited_once_with("owner", "fixture")
    for invalid in [{**body, "email": "other@example.test"}, {"name": "Alex Example"}]:
        assert client.post("/api/one/world-model/research", json=invalid).status_code == 403
    assert (
        client.post("/api/one/world-model/research", json={**body, "user_id": "other"}).status_code
        == 422
    )
    assert start.await_count == 1


def owner_client(monkeypatch, jobs):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from api.middlewares.chat_key import require_vault_owner_chat_key
    from api.routes.one import world_model as routes

    monkeypatch.setattr(routes, "world_model_jobs", jobs)
    app = FastAPI()
    app.include_router(routes.router)
    app.dependency_overrides[require_vault_owner_chat_key] = lambda: {
        "user_id": "owner",
        "token": "fixture",
    }
    return TestClient(app), routes


def test_numeric_usage_is_owner_only_and_keeps_json_and_stream_bodies_compatible(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from api.routes.one.world_model_stream import _frame

    usage = {
        "model_calls": 2,
        "recorded_calls": 2,
        "input_tokens": 120,
        "output_tokens": 35,
        "cached_input_tokens": 20,
        "provider_elapsed_ms": 1000,
        "bing_requests": 1,
    }
    public = {
        "status": "offered",
        "pkm_written": False,
        "research": {"provider": "azure_openai_web_search"},
    }
    internal = {**public, "_provider_usage": usage}
    jobs = SimpleNamespace(
        status=AsyncMock(return_value=internal),
        start=AsyncMock(return_value=internal),
        ensure=AsyncMock(return_value=internal),
    )
    client, routes = owner_client(monkeypatch, jobs)
    for method, path in [("get", "jobs"), ("post", "jobs"), ("post", "ensure")]:
        response = getattr(client, method)("/api/one/world-model/" + path)
        assert response.status_code == 200
        assert response.json() == public
        assert json.loads(response.headers["x-hussh-pwm-usage"]) == usage
        assert response.headers["cache-control"] == "private, no-store"
    assert json.loads(_frame("result", internal)["data"]) == public
    assert internal["_provider_usage"] == usage  # transport cannot mutate encrypted state
    unauthenticated = FastAPI()
    unauthenticated.include_router(routes.router)
    denied = TestClient(unauthenticated).get("/api/one/world-model/jobs")
    assert denied.status_code == 401
    assert "x-hussh-pwm-usage" not in denied.headers
    jobs.status.assert_awaited_once_with("owner", "fixture")
    internal["_provider_usage"] = {**usage, "prompt": "SYNTHETIC_PRIVATE_TEXT"}
    malformed = client.get("/api/one/world-model/jobs")
    assert malformed.status_code == 503
    assert "x-hussh-pwm-usage" not in malformed.headers
    assert "SYNTHETIC_PRIVATE_TEXT" not in malformed.text


def test_ensure_busy_or_unexpected_failure_is_a_retryable_503(monkeypatch):
    ensure = AsyncMock(side_effect=RuntimeError("Discovery capacity is temporarily busy"))
    client, _ = owner_client(monkeypatch, SimpleNamespace(ensure=ensure))
    response = client.post("/api/one/world-model/ensure")
    assert response.status_code == 503
    assert response.headers["retry-after"] == "60"
    assert "capacity" not in response.text
    ensure.side_effect = PermissionError("Owner session ended")
    assert client.post("/api/one/world-model/ensure").status_code == 403


def test_owner_decisions_body_is_optional_bounded_and_forwarded(monkeypatch):
    ensure = AsyncMock(return_value={"status": "pending", "pkm_written": False})
    start = AsyncMock(return_value={"status": "pending", "pkm_written": False})
    client, _ = owner_client(monkeypatch, SimpleNamespace(ensure=ensure, start=start))
    decisions = {"confirmed": ["Builds software."], "rejected": ["Likes the color blue."]}
    assert client.post("/api/one/world-model/ensure").status_code == 202
    ensure.assert_awaited_once_with("owner", "fixture", owner_decisions=None)
    body = {"owner_decisions": decisions}
    assert client.post("/api/one/world-model/ensure", json=body).status_code == 202
    assert ensure.await_args.kwargs == {"owner_decisions": decisions}
    assert client.post("/api/one/world-model/jobs", json=body).status_code == 202
    start.assert_awaited_once_with("owner", "fixture", inputs={"owner_decisions": decisions})
    assert (
        client.post("/api/one/world-model/jobs", json={**body, "refresh": True}).status_code == 202
    )
    assert start.await_args.kwargs == {
        "inputs": {"owner_decisions": decisions},
        "refresh_completed": True,
    }
    assert (
        client.post("/api/one/world-model/ensure", json={**body, "refresh": True}).status_code
        == 422
    )
    assert client.post("/api/one/world-model/jobs", json={"refresh": "true"}).status_code == 422
    for invalid in [
        {**body, "user_id": "other"},
        {"owner_decisions": {**decisions, "inferred": []}},
        {"owner_decisions": {"rejected": ["Likes blue."] * 270}},
        {"owner_decisions": {"rejected": ["x" * 601]}},
        {"owner_decisions": {"confirmed": [""]}},
    ]:
        for path in ("ensure", "jobs"):
            assert client.post(f"/api/one/world-model/{path}", json=invalid).status_code == 422
    assert ensure.await_count == 2 and start.await_count == 2


def test_public_profiles_require_explicit_permission_and_jobs_refresh(monkeypatch):
    from hushh_mcp.services.world_model_service import PublicProfilesChanged

    start = AsyncMock(return_value={"status": "pending", "pkm_written": False})
    client, _ = owner_client(monkeypatch, SimpleNamespace(start=start))
    profiles = {"urls": ["https://github.com/example"], "permitted_public_sources": True}
    response = client.post(
        "/api/one/world-model/jobs", json={"refresh": True, "public_profiles": profiles}
    )
    assert response.status_code == 202
    start.assert_awaited_once_with(
        "owner", "fixture", inputs={"public_profiles": profiles}, refresh_completed=True
    )
    assert (
        client.post("/api/one/world-model/ensure", json={"public_profiles": profiles}).status_code
        == 422
    )
    for bad in [False, "true", 1, None]:
        assert (
            client.post(
                "/api/one/world-model/jobs",
                json={
                    "refresh": True,
                    "public_profiles": {**profiles, "permitted_public_sources": bad},
                },
            ).status_code
            == 422
        )
    for url in [
        "http://example.test/me",
        "https://127.0.0.1/me",
        "https://user:secret@example.test/me",
        "https://example.test/me?token=secret",
        "https://example.internal/me",
    ]:
        assert (
            client.post(
                "/api/one/world-model/jobs",
                json={"refresh": True, "public_profiles": {**profiles, "urls": [url]}},
            ).status_code
            == 422
        )
    assert start.await_count == 1
    start.side_effect = PublicProfilesChanged("private diagnostic")
    conflict = client.post(
        "/api/one/world-model/jobs", json={"refresh": True, "public_profiles": profiles}
    )
    assert conflict.status_code == 409 and "private diagnostic" not in conflict.text


@pytest.mark.parametrize(
    "source_use",
    ["google_grounded_display_only", "azure_web_grounded_display_only", None, "owner_supplied"],
)
def test_complete_accepts_only_owner_supplied_research(monkeypatch, source_use):
    from uuid import uuid4

    jobs = SimpleNamespace(
        status=AsyncMock(
            return_value={"status": "offered", "research": {"source_use": source_use}}
        ),
        dismiss=AsyncMock(),
    )
    client, routes = owner_client(monkeypatch, jobs)
    commit = AsyncMock()
    monkeypatch.setattr(routes, "complete_magic_intelligence", commit)
    response = client.post(
        "/api/one/world-model/complete",
        json={"draft_id": str(uuid4()), "commits": [{"domain": "profile", "plan_id": "p1"}]},
    )
    if source_use != "owner_supplied":
        assert response.status_code == 409
        commit.assert_not_awaited()
        jobs.dismiss.assert_not_awaited()
    else:
        # Negative control: an eligible draft still completes through the same route.
        assert response.status_code == 200
        commit.assert_awaited_once()


@pytest.mark.parametrize("existing", [None, {"enabled": False, "email_enabled": True}])
def test_claim_research_consent_keeps_owner_email_choice(monkeypatch, existing):
    jobs = SimpleNamespace(ensure=AsyncMock(return_value={"status": "pending"}))
    client, routes = owner_client(monkeypatch, jobs)
    monkeypatch.setattr(routes.invitations, "claim", AsyncMock(return_value={"claimed": True}))
    monkeypatch.setattr(routes.preferences, "preferences", AsyncMock(return_value=existing))
    enroll, update = AsyncMock(), AsyncMock()
    monkeypatch.setattr(routes.preferences, "enroll_default", enroll)
    monkeypatch.setattr(routes.preferences, "update_preferences", update)
    response = client.post(
        "/api/one/world-model/claims",
        json={"token": "a" * 43, "consent": True, "research_consent": True},
    )
    assert response.json() == {"claimed": True, "research_started": True}
    if existing is None:
        enroll.assert_awaited_once_with("owner", "fixture")
        update.assert_not_awaited()
    else:
        update.assert_awaited_once_with("owner", "fixture", enabled=True, email_enabled=True)
        enroll.assert_not_awaited()


def test_invitation_claim_cannot_grant_azure_bing_consent(monkeypatch):
    client, routes = owner_client(monkeypatch, SimpleNamespace())
    claim = AsyncMock()
    monkeypatch.setattr(routes.invitations, "claim", claim)
    monkeypatch.setattr(routes, "load_pwm_policy", lambda: {"provider": "azure_openai_web_search"})
    response = client.post(
        "/api/one/world-model/claims",
        json={"token": "a" * 43, "consent": True, "research_consent": True},
    )
    assert response.status_code == 422
    claim.assert_not_awaited()


def checkpoint():
    """A live checkpoint as the runner seals it: answers, identity and receipts included."""
    return {
        "job_id": "11111111-1111-4111-8111-111111111111",
        "status": "pending",
        "started_at": 1_700_000_000.0,
        "discovery_started_at": 1_700_000_000.0,
        "starts": [1_700_000_000.0],
        "attempted_combinations": [33, 1, 34, 35, 2, 36],
        "identity_binding": "owner-bound-identity",
        "revision": 4,
        "fence": "sealed",
        "work": {
            "attempts": {
                "1": {
                    "plan": copy.deepcopy(PLAN),
                    "observed": True,
                    "answer": "Alex Example publishes alex@example.test and +15550001111.",
                    "source_refs": ["s1"],
                    "state": "received",
                    "at": 1_700_000_030.0,
                },
                "2": {
                    "plan": {**copy.deepcopy(PLAN), "purpose": "coverage", "candidate_id": "c1"},
                    "observed": False,
                    "answer": "",
                    "source_refs": [],
                    "state": "started",
                },
            },
            "sources": {
                "s1": {"title": "Bio", "url": "https://example.test/alex"},
                "s2": {"title": "Talk", "url": "https://example.test/talk"},
            },
            "assessment": assessment(),
        },
    }


def test_derive_progress_reports_counts_and_public_receipts_only():
    from hushh_mcp.services.world_model_progress import derive_progress

    now = 1_700_000_100.0
    progress = derive_progress(checkpoint(), now=now, revision_at=1_700_000_045.0)
    assert progress == {
        "stage": "coverage",
        "searches_used": 2,
        "searches_total": pwm.MAX_SEARCHES,
        "model_calls_used": 4,
        "model_calls_total": pwm.MAX_MODEL_CALLS,
        "topics_checked": ["career"],
        "sources_found": 2,
        "recent_sources": [
            {"title": "Bio", "url": "https://example.test/alex"},
            {"title": "Talk", "url": "https://example.test/talk"},
        ],
        "identity_state": "owner_linked",
        "candidates": 1,
        "started_at": "2023-11-14T22:13:20Z",
        "last_activity_at": "2023-11-14T22:14:05Z",
        "slice": 1,
    }
    serialized = json.dumps(progress)
    for secret in ("Alex", "alex@example.test", "+15550001111", "publishes", "Exact public"):
        assert secret not in serialized
    # Stage follows the checkpoint: nothing yet, identity unresolved, composing.
    assert derive_progress({"started_at": now}, now=now)["stage"] == "starting"
    unresolved = checkpoint()
    del unresolved["work"]["assessment"]
    assert derive_progress(unresolved, now=now)["identity_state"] is None
    assert derive_progress(unresolved, now=now)["stage"] == "identity"
    composing = checkpoint()
    composing["attempted_combinations"] += [37, 38, 39]
    assert derive_progress(composing, now=now)["stage"] == "report"
    # A clock ahead of the poller never reports activity in the future.
    assert derive_progress(checkpoint(), now=1_700_000_010.0)["last_activity_at"].endswith(
        "22:13:30Z"
    )
    # The ledger already holds the run in flight: a second paid start is part 2.
    continued = checkpoint()
    continued["starts"].append(1_700_000_090.0)
    assert derive_progress(continued, now=now)["slice"] == 2
    assert derive_progress({"started_at": now, "starts": []}, now=now)["slice"] == 1


class ProgressStore:
    def __init__(self, row):
        self.row = row

    async def get(self, owner):
        return copy.deepcopy(self.row)


@pytest.mark.asyncio
async def test_status_attaches_progress_only_while_research_is_live(monkeypatch):
    from hushh_mcp.services import profile_research_jobs as jobs
    from hushh_mcp.services import world_model_service as service

    monkeypatch.setattr(jobs, "validate_first_party_owner_token", AsyncMock(return_value=object()))
    monkeypatch.setattr(
        service, "validate_first_party_owner_token", AsyncMock(return_value=object())
    )
    monkeypatch.setattr(jobs, "one_profile_research_enabled", lambda: True)
    clock = lambda: 1_700_000_100.0  # noqa: E731 - fixed clock
    live = service.WorldModelJobs(
        store=ProgressStore(checkpoint()),
        offer=AsyncMock(),
        check=AsyncMock(return_value=(None, "owner-bound-identity")),
        clock=clock,
    )
    result = await live.status("owner", "fixture")
    assert result["status"] == "pending" and result["restart_required"] is False
    assert result["progress"]["searches_used"] == 2
    assert result["progress"]["last_activity_at"] == "2023-11-14T22:15:00Z"
    # The same revision keeps its first-seen time; a newer one moves it.
    live.clock = lambda: 1_700_000_160.0
    assert (await live.status("owner", "fixture"))["progress"]["last_activity_at"] == (
        "2023-11-14T22:15:00Z"
    )
    live.store.row["revision"] = 5
    assert (await live.status("owner", "fixture"))["progress"]["last_activity_at"] == (
        "2023-11-14T22:16:00Z"
    )
    offered = {
        **checkpoint(),
        "status": "offered",
        "finished_at": 1_700_000_090.0,
        "result": {"status": "offered", "pkm_written": False, "draft_id": "d1"},
    }
    done = service.WorldModelJobs(
        store=ProgressStore(offered),
        offer=AsyncMock(),
        check=AsyncMock(return_value=(None, "owner-bound-identity")),
        clock=clock,
    )
    assert await done.status("owner", "fixture") == offered["result"]


@pytest.mark.asyncio
async def test_progress_stream_emits_changes_pings_then_result_and_closes():
    from api.routes.one.world_model_stream import progress_events

    now = 0.0
    progress = {"stage": "identity", "searches_used": 1}
    pending = {"status": "pending", "pkm_written": False, "restart_required": False}
    scripted = [
        {**pending, "progress": progress},
        {**pending, "progress": progress},  # 8 s, unchanged: no frame
        {**pending, "progress": progress},  # 16 s, unchanged: heartbeat
        {**pending, "progress": {**progress, "searches_used": 2}},
        {"status": "offered", "pkm_written": False, "draft_id": "d1"},
        AssertionError("polled after close"),
    ]
    jobs = SimpleNamespace(status=AsyncMock(side_effect=scripted))

    async def sleep(seconds):
        nonlocal now
        now += seconds

    request = SimpleNamespace(is_disconnected=AsyncMock(return_value=False))
    stream = progress_events(
        jobs, "owner", "fixture", request, poll_seconds=8.0, clock=lambda: now, sleep=sleep
    )
    frames = [frame async for frame in stream]
    assert [frame["event"] for frame in frames] == ["progress", "ping", "progress", "result"]
    assert json.loads(frames[2]["data"]) == {**progress, "searches_used": 2}
    assert json.loads(frames[3]["data"]) == scripted[4]
    assert jobs.status.await_count == 5
    # A lifetime cap or a lost session also ends the stream; the cap hands back
    # the live state so the client reconnects at once.
    capped = progress_events(
        SimpleNamespace(status=AsyncMock(return_value=pending)),
        "owner",
        "fixture",
        request,
        lifetime_seconds=0.0,
        clock=lambda: 1.0,
        sleep=sleep,
    )
    assert [frame["event"] async for frame in capped] == ["result"]
    gone = progress_events(
        SimpleNamespace(status=AsyncMock(side_effect=PermissionError())),
        "owner",
        "fixture",
        request,
        sleep=sleep,
    )
    assert [frame async for frame in gone] == []


def test_progress_stream_route_is_owner_only_and_private(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from api.middlewares.chat_key import require_vault_owner_chat_key
    from api.routes.one import world_model_stream as routes

    terminal = {"status": "paused", "pkm_written": False, "restart_required": True}
    jobs = SimpleNamespace(status=AsyncMock(return_value=terminal))
    monkeypatch.setattr(routes, "world_model_jobs", jobs)
    app = FastAPI()
    app.include_router(routes.router)
    assert TestClient(app).get("/api/one/world-model/jobs/stream").status_code == 401
    jobs.status.assert_not_awaited()
    app.dependency_overrides[require_vault_owner_chat_key] = lambda: {
        "user_id": "owner",
        "token": "fixture",
    }
    response = TestClient(app).get("/api/one/world-model/jobs/stream")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    assert response.headers["cache-control"] == "private, no-store"
    assert "event: result" in response.text
    assert json.loads(response.text.split("data: ")[1].splitlines()[0]) == terminal
    jobs.status.assert_awaited_once_with("owner", "fixture")
    jobs.status.side_effect = PermissionError()
    assert TestClient(app).get("/api/one/world-model/jobs/stream").status_code == 403


def test_progress_stream_caps_open_streams_per_owner(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from api.middlewares.chat_key import require_vault_owner_chat_key
    from api.routes.one import world_model_stream as routes

    monkeypatch.setattr(routes, "open_streams", {})
    terminal = {"status": "paused", "pkm_written": False, "restart_required": True}
    jobs = SimpleNamespace(status=AsyncMock(return_value=terminal))
    monkeypatch.setattr(routes, "world_model_jobs", jobs)
    app = FastAPI()
    app.include_router(routes.router)
    app.dependency_overrides[require_vault_owner_chat_key] = lambda: {
        "user_id": "owner",
        "token": "fixture",
    }
    client = TestClient(app)
    # The owner already holds the allowed streams: a third is refused before
    # any read, takes no slot, and says when to come back.
    routes.open_streams["owner"] = routes.MAX_OPEN_STREAMS
    refused = client.get("/api/one/world-model/jobs/stream")
    assert refused.status_code == 429
    assert refused.headers["retry-after"] == "5"
    assert refused.headers["cache-control"] == "private, no-store"
    assert "tab" in refused.json()["detail"]
    jobs.status.assert_not_awaited()
    assert routes.open_streams == {"owner": routes.MAX_OPEN_STREAMS}
    # Another owner is not held back by this one's streams.
    app.dependency_overrides[require_vault_owner_chat_key] = lambda: {
        "user_id": "other",
        "token": "fixture",
    }
    assert client.get("/api/one/world-model/jobs/stream").status_code == 200
    jobs.status.assert_awaited_once_with("other", "fixture")
    app.dependency_overrides[require_vault_owner_chat_key] = lambda: {
        "user_id": "owner",
        "token": "fixture",
    }
    # A freed slot lets the stream open; it is given back once the stream closes.
    routes.open_streams["owner"] = routes.MAX_OPEN_STREAMS - 1
    opened = client.get("/api/one/world-model/jobs/stream")
    assert opened.status_code == 200 and "event: result" in opened.text
    assert routes.open_streams == {"owner": routes.MAX_OPEN_STREAMS - 1}
    # A refused handshake gives its slot back as well.
    routes.open_streams.clear()
    jobs.status.side_effect = PermissionError()
    assert client.get("/api/one/world-model/jobs/stream").status_code == 403
    jobs.status.side_effect = RuntimeError("backend")
    assert client.get("/api/one/world-model/jobs/stream").status_code == 503
    assert routes.open_streams == {}


@pytest.mark.asyncio
async def test_open_stream_slot_is_released_when_the_client_leaves(monkeypatch):
    from api.routes.one import world_model_stream as routes

    monkeypatch.setattr(routes, "open_streams", {})

    async def pings():
        while True:
            yield {"event": "ping", "data": "{}"}

    assert routes.acquire_stream("owner") and routes.acquire_stream("owner")
    assert not routes.acquire_stream("owner")
    relay = routes.counted("owner", pings())
    assert (await anext(relay))["event"] == "ping"
    # The client went away mid-stream: the slot comes back without a result.
    await relay.aclose()
    assert routes.open_streams == {"owner": 1}
    routes.release_stream("owner")
    assert routes.open_streams == {}
    # Releasing more than was taken never goes negative.
    routes.release_stream("owner")
    assert routes.acquire_stream("owner") and routes.open_streams == {"owner": 1}
