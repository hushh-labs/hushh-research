"""Native SDK evidence and identity regressions; no live provider calls."""

import copy
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.one_adk import world_model as pwm
from hushh_mcp.one_adk.world_model_contracts import TOPICS, IdentityAssessment, WorldModelReport

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
async def test_real_adk_native_tools_charge_before_dispatch_and_checkpoint_receipts(monkeypatch):
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

    responses = [
        call("search_public_web", {"plan_json": json.dumps(PLAN)}),
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
        call("finish_task", report()),
    ]

    class FakeModel(BaseLlm):
        model: str = "gemini-3.6-flash"

        async def generate_content_async(self, llm_request, stream=False):
            assert responses, "Unexpected model dispatch"
            requests.append(llm_request.model_copy(deep=True))
            if len(responses) == 3:
                assert charges == [33, 1, 34]
                assert snapshots[-1]["attempts"]["1"]["state"] == "started"
            yield responses.pop(0)

    monkeypatch.setattr(
        providers, "build_managed_regional_gemini_adk_model", lambda *_: FakeModel()
    )

    async def charge(slots):
        charges.extend(slots)

    async def progress(value):
        snapshots.append(copy.deepcopy(value))

    decisions = {"confirmed": ["Builds software."], "rejected": ["Likes the color blue."]}
    result = await pwm.run_world_model(
        identity=IDENTITY,
        user_id="owner",
        consent_token="fixture",  # noqa: S106 - synthetic test authority
        require_access=AsyncMock(),
        on_attempts_start=charge,
        on_progress=progress,
        owner_decisions=decisions,
    )
    # Owner decisions reach the model as structured data, not filtered output.
    sent = json.loads(requests[0].contents[-1].parts[0].text)
    assert sent["owner_decisions"] == decisions
    assert result["status"] == "offered"
    assert result["research"]["source_use"] == "google_grounded_display_only"
    assert (
        result["report"]["sections"][0]["facts"][0]["sources"][0]["url"]
        == "https://example.test/alex"
    )
    assert charges == [33, 1, 34, 35, 36]
    assert snapshots[1]["attempts"]["1"]["state"] == "received"
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


def test_integration_endpoint_only_accepts_current_owner_identifiers(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

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
    app.dependency_overrides[routes.hub_content_chat_owner] = lambda: {
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
    for invalid in [
        {**body, "user_id": "other"},
        {"owner_decisions": {**decisions, "inferred": []}},
        {"owner_decisions": {"rejected": ["Likes blue."] * 51}},
        {"owner_decisions": {"rejected": ["x" * 601]}},
        {"owner_decisions": {"confirmed": [""]}},
    ]:
        for path in ("ensure", "jobs"):
            assert client.post(f"/api/one/world-model/{path}", json=invalid).status_code == 422
    assert ensure.await_count == 2 and start.await_count == 1


@pytest.mark.parametrize("source_use", ["google_grounded_display_only", "owner_supplied"])
def test_complete_refuses_display_only_google_research(monkeypatch, source_use):
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
    if source_use == "google_grounded_display_only":
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
