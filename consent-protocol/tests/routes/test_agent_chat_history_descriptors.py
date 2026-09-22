import json
from types import SimpleNamespace

from api.routes.one.agent_chat import _event_text, _safe_agent_history_metadata


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
