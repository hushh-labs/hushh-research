import json
from types import SimpleNamespace
from uuid import UUID

import pytest
from fastapi import HTTPException
from google.adk.events import Event
from google.adk.flows.llm_flows.contents import _get_contents
from google.adk.sessions import Session
from google.genai import types

from api.routes.one import agent_chat
from api.routes.one.agent_chat import _event_text, _safe_agent_history_metadata
from hushh_mcp.services.information_request_service import InformationRequestError


def _event(response: dict, *, tool_name: str = "discover_person_information") -> SimpleNamespace:
    return SimpleNamespace(
        id="event-discovery-1",
        content=SimpleNamespace(
            parts=[
                SimpleNamespace(
                    function_response=SimpleNamespace(
                        name=tool_name,
                        response=response,
                    )
                )
            ]
        ),
    )


def test_history_descriptor_keeps_discovery_card_metadata_but_not_values() -> None:
    metadata = _safe_agent_history_metadata(
        _event(
            {
                "status": "ok",
                "person": {
                    "displayName": "Alex Morgan",
                    "personRef": "1234567890abcdef",
                    "profilePath": "/people/1234567890abcdef",
                    "relationship": "connected",
                },
                "requestableScopes": [
                    {
                        "scopeRef": "attr.professional.role",
                        "label": "Professional role",
                        "description": "Current role",
                        "domain": "professional",
                        "sensitivity": "standard",
                        "value": "must-not-leave-the-server",
                    }
                ],
            }
        )
    )

    assert metadata is not None
    assert metadata["kind"] == "structured_experience"
    assert metadata["structuredExperienceId"] == "event-discovery-1"
    descriptor = metadata["structuredExperience"]
    assert isinstance(descriptor, dict)
    assert descriptor["activityType"] == "one.scope_discovery.v1"
    assert descriptor["content"]["person"]["personRef"] == "1234567890abcdef"
    assert "must-not-leave-the-server" not in json.dumps(metadata)


def test_history_descriptor_retains_safe_catalog_pagination_metadata() -> None:
    metadata = _safe_agent_history_metadata(
        _event(
            {
                "status": "ok",
                "person": {
                    "displayName": "Alex Morgan",
                    "personRef": "1234567890abcdef",
                    "profilePath": "/people/1234567890abcdef",
                },
                "requestableScopes": [
                    {
                        "scopeRef": "psr_professional_role",
                        "label": "Professional role",
                        "domain": "professional",
                    }
                ],
                "scopeCatalog": {
                    "page": 2,
                    "nextPage": 3,
                    "totalCount": 601,
                    "limit": 100,
                    "hasMore": True,
                    "catalogRevision": "a" * 64,
                    "paginationReset": False,
                    "domains": [{"domain": "professional", "count": 601}],
                    "items": [{"scopeRef": "must-not-be-copied"}],
                },
            }
        )
    )

    assert metadata is not None
    content = metadata["structuredExperience"]["content"]
    assert content["person"]["personRef"] == "1234567890abcdef"
    assert content["scopeCatalog"] == {
        "page": 2,
        "nextPage": 3,
        "totalCount": 601,
        "limit": 100,
        "hasMore": True,
        "catalogRevision": "a" * 64,
        "paginationReset": False,
        "domains": [{"domain": "professional", "count": 601}],
    }
    assert content["catalogIncomplete"] is True
    assert "must-not-be-copied" not in json.dumps(metadata)


def test_history_descriptor_restores_non_actionable_information_request_review() -> None:
    metadata = _safe_agent_history_metadata(
        _event(
            {
                "status": "proposal_ready",
                "proposalId": "must-not-be-retained",
                "person": {"displayName": "Alex Morgan"},
                "fields": ["Employment status", "Company name"],
                "purpose": "Complete the onboarding review.",
                "durationHours": 48,
                "connectorReady": True,
            },
            tool_name="propose_information_request",
        )
    )

    assert metadata is not None
    assert metadata["structuredExperience"]["activityType"] == "one.information_request_review.v1"
    content = metadata["structuredExperience"]["content"]
    assert content == {
        "direction": "outgoing",
        "phase": "draft",
        "personName": "Alex Morgan",
        "purpose": "Complete the onboarding review.",
        "durationLabel": "2 days",
        "status": "awaiting_review",
        "fields": [
            {"label": "Employment status", "domain": "Information", "sensitivity": "standard"},
            {"label": "Company name", "domain": "Information", "sensitivity": "standard"},
        ],
    }
    assert "must-not-be-retained" not in json.dumps(metadata)


def test_history_descriptor_restores_safe_submitted_request_settlement() -> None:
    metadata = _safe_agent_history_metadata(
        _event(
            {
                "status": "succeeded",
                "data": {
                    "consentCard": {
                        "schemaVersion": 1,
                        "activityType": "one.information_request_review.v1",
                        "direction": "outgoing",
                        "phase": "submitted",
                        "status": "pending",
                        "personName": "Alex Morgan",
                        "purpose": "Complete the onboarding review.",
                        "durationLabel": "2 days",
                        "subjectRef": "1234567890abcdef",
                        "bundleId": "bundle_12345678",
                        "requestId": None,
                        "fields": [
                            {
                                "label": "Employment status",
                                "domain": "Professional",
                                "sensitivity": "standard",
                                "requestId": "request_12345678",
                                "status": "pending",
                            }
                        ],
                    }
                },
            },
            tool_name="run_app_action",
        )
    )

    assert metadata is not None
    content = metadata["structuredExperience"]["content"]
    assert content["phase"] == "submitted"
    assert content["status"] == "pending"
    assert content["subjectRef"] == "1234567890abcdef"
    assert content["bundleId"] == "bundle_12345678"
    assert content["fields"][0]["status"] == "pending"
    assert content["fields"][0]["requestId"] == "request_12345678"
    assert "schemaVersion" not in json.dumps(metadata)


@pytest.mark.asyncio
async def test_inline_submission_receipt_restores_one_card_without_model_replay(
    monkeypatch,
) -> None:
    bundle_id = "11111111-1111-1111-1111-111111111111"
    person_ref = "12345678-1234-1234-1234-123456789abc"
    source = Event(
        id="discovery-event",
        author="one",
        invocation_id="discovery-run",
        content=types.Content(
            role="user",
            parts=[
                types.Part(
                    function_response=types.FunctionResponse(
                        id="discover-call",
                        name="discover_person_information",
                        response={
                            "status": "ok",
                            "person": {
                                "displayName": "Synthetic Recipient",
                                "personRef": person_ref,
                                "profilePath": f"/people/{person_ref}",
                            },
                            "requestableScopes": [
                                {
                                    "scopeRef": "opaque-scope",
                                    "label": "Professional Domain",
                                    "domain": "professional",
                                }
                            ],
                        },
                    )
                )
            ],
        ),
    )
    session = Session(
        id="thread", app_name=agent_chat.ONE_APP_NAME, user_id="owner", events=[source]
    )

    class SessionStore:
        async def get_session(self, *, app_name, user_id, session_id):
            return (
                session
                if (app_name, user_id, session_id) == (agent_chat.ONE_APP_NAME, "owner", "thread")
                else None
            )

        async def append_event_once(self, *, app_name, user_id, session_id, event):
            assert (app_name, user_id, session_id) == (agent_chat.ONE_APP_NAME, "owner", "thread")
            existing = next((item for item in session.events if item.id == event.id), None)
            if existing:
                return existing
            session.events.append(event)
            return event

    class RequestStore:
        async def verify_submission_receipt(self, *, requester_user_id, bundle_id, idempotency_key):
            if (requester_user_id, bundle_id, idempotency_key) != (
                "owner",
                "11111111-1111-1111-1111-111111111111",
                "synthetic-receipt-key",
            ):
                raise InformationRequestError("Request receipt was not found.", status_code=404)
            return {
                "bundleId": bundle_id,
                "personRef": person_ref,
                "purpose": "Synthetic professional review",
                "durationSeconds": 86400,
                "items": [
                    {
                        "requestId": "request_12345678",
                        "scopeRef": "opaque-scope",
                        "label": "Professional Domain",
                        "sensitivity": "standard",
                        "status": "pending",
                    }
                ],
            }

    monkeypatch.setattr(agent_chat, "_session_service", SessionStore())
    monkeypatch.setattr(agent_chat, "InformationRequestService", RequestStore)
    payload = agent_chat.RecordInformationRequestSubmission(
        source_activity_id="discover-call",
        bundle_id=UUID(bundle_id),
        idempotency_key="synthetic-receipt-key",
    )
    result = await agent_chat.record_information_request_submission(
        "thread", payload, {"user_id": "owner"}
    )
    assert result["descriptor"]["content"]["bundleId"] == bundle_id
    assert len(session.events) == 2
    receipt_event = session.events[1]
    assert receipt_event.content is None
    assert "receipt-key" not in json.dumps(receipt_event.custom_metadata)
    assert "opaque-scope" not in json.dumps(receipt_event.custom_metadata)
    assert (
        await agent_chat.record_information_request_submission(
            "thread", payload, {"user_id": "owner"}
        )
        == result
    )
    assert len(session.events) == 2

    history = await agent_chat.conversation_history("thread", limit=50, token={"user_id": "owner"})
    cards = [
        entry
        for message in history["messages"]
        for entry in (message["metadata"] or {}).get("structuredExperiences", [])
    ]
    assert len(cards) == 1
    assert cards[0]["activityType"] == "one.information_request_review.v1"
    assert cards[0]["content"]["subjectRef"] == person_ref
    assert cards[0]["content"]["bundleId"] == bundle_id
    next_user = Event(
        author="user", content=types.Content(role="user", parts=[types.Part(text="Next question")])
    )
    assert _get_contents(
        None, [source, receipt_event, next_user], agent_name="one"
    ) == _get_contents(None, [source, next_user], agent_name="one")

    with pytest.raises(HTTPException) as wrong_owner:
        await agent_chat.record_information_request_submission(
            "thread", payload, {"user_id": "other"}
        )
    assert wrong_owner.value.status_code == 404
    with pytest.raises(HTTPException) as wrong_receipt:
        await agent_chat.record_information_request_submission(
            "thread",
            payload.model_copy(update={"idempotency_key": "different-synthetic-receipt-key"}),
            {"user_id": "owner"},
        )
    assert wrong_receipt.value.status_code == 404


def test_history_descriptor_discards_invalid_catalog_metadata() -> None:
    metadata = _safe_agent_history_metadata(
        _event(
            {
                "status": "ok",
                "person": {
                    "displayName": "Alex Morgan",
                    "profilePath": "/people/1234567890abcdef",
                },
                "requestableScopes": [],
                "scopeCatalog": {
                    "page": 1,
                    "nextPage": 4,
                    "totalCount": 4,
                    "limit": 100,
                    "hasMore": True,
                    "catalogRevision": "not-a-revision",
                },
            }
        )
    )

    assert metadata is not None
    content = metadata["structuredExperience"]["content"]
    assert "scopeCatalog" not in content
    assert content["catalogIncomplete"] is False


def test_history_descriptor_rejects_unusable_profile_paths() -> None:
    metadata = _safe_agent_history_metadata(
        _event(
            {
                "status": "ok",
                "person": {
                    "displayName": "Alex Morgan",
                    "profilePath": "https://example.test/people/1234567890abcdef",
                },
                "requestableScopes": [],
            }
        )
    )

    assert metadata is None


def test_history_preserves_distinct_cards_and_deduplicates_same_invocation():
    result = {
        "status": "ok",
        "person": {"displayName": "Synthetic Person", "profilePath": "/people/1234567890abcdef"},
        "requestableScopes": [],
    }
    first = _event(result)
    second = _event({**result, "domainFilter": "professional"})
    first.content.parts[0].function_response.id = "invocation-a"
    second.content.parts[0].function_response.id = "invocation-b"
    second.id = "event-discovery-2"
    first.content.parts += second.content.parts * 2
    metadata = _safe_agent_history_metadata(first)
    assert [card["id"] for card in metadata["structuredExperiences"]] == [
        "event-discovery-1:invocation-a",
        "event-discovery-1:invocation-b",
    ]
    assert metadata["structuredExperiences"][1]["content"]["domainFilter"] == "professional"


def test_history_card_identity_is_scoped_to_its_turn():
    first = _event(
        {
            "status": "ok",
            "person": {"displayName": "Alex Morgan", "profilePath": "/people/1234567890abcdef"},
            "requestableScopes": [],
        }
    )
    second = _event(
        {
            "status": "ok",
            "person": {"displayName": "Alex Morgan", "profilePath": "/people/1234567890abcdef"},
            "requestableScopes": [],
        }
    )
    first.content.parts[0].function_response.id = "reused-invocation"
    second.content.parts[0].function_response.id = "reused-invocation"
    second.id = "event-discovery-2"

    first_metadata = _safe_agent_history_metadata(first)
    second_metadata = _safe_agent_history_metadata(second)

    assert first_metadata["structuredExperiences"][0]["id"] == "event-discovery-1:reused-invocation"
    assert (
        second_metadata["structuredExperiences"][0]["id"] == "event-discovery-2:reused-invocation"
    )


def test_history_answer_does_not_include_provider_thinking():
    event = SimpleNamespace(
        content=SimpleNamespace(
            parts=[
                SimpleNamespace(text="Internal reasoning", thought=True),
                SimpleNamespace(text="The answer", thought=False),
            ]
        )
    )
    assert _event_text(event) == "The answer"
