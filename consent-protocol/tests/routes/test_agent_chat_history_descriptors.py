import json
from types import SimpleNamespace

from api.routes.one.agent_chat import _safe_agent_history_metadata


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
