import json
from types import SimpleNamespace

from api.routes.one.agent_chat import _event_text, _safe_agent_history_metadata


def _event(response: dict) -> SimpleNamespace:
    return SimpleNamespace(
        id="event-discovery-1",
        content=SimpleNamespace(
            parts=[
                SimpleNamespace(
                    function_response=SimpleNamespace(
                        name="discover_person_information",
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
    assert "must-not-leave-the-server" not in json.dumps(metadata)


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
    first.content.parts += second.content.parts * 2
    metadata = _safe_agent_history_metadata(first)
    assert [card["id"] for card in metadata["structuredExperiences"]] == [
        "invocation-a",
        "invocation-b",
    ]
    assert metadata["structuredExperiences"][1]["content"]["domainFilter"] == "professional"


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
