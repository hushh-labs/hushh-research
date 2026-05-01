from hushh_mcp.services.voice_app_knowledge import (
    get_kai_voice_identity_context,
    resolve_global_concept,
    resolve_voice_explain_knowledge,
)


def test_resolve_voice_explain_knowledge_prioritizes_control_over_section() -> None:
    resolution = resolve_voice_explain_knowledge(
        transcript="What does Save receipts memory to PKM do?",
        screen="profile_receipts",
        pathname="/profile/receipts",
        active_section="Receipt memory preview",
        available_actions=["Save receipts memory to PKM", "Refresh receipt memory"],
        screen_metadata={
            "connector_badge_label": "Connected",
            "receipt_count": 12,
            "preview_available": True,
            "preview_stale": False,
        },
    )

    assert resolution.tier == "control"
    assert resolution.key == "save_receipts_memory_to_pkm"
    assert "writes the current receipts-memory preview" in resolution.summary.lower()


def test_resolve_voice_explain_knowledge_section_uses_receipts_metadata() -> None:
    resolution = resolve_voice_explain_knowledge(
        transcript="What is on my screen?",
        screen="profile_receipts",
        pathname="/profile/receipts",
        active_section="Receipt memory preview",
        available_actions=["Refresh receipt memory", "Save receipts memory to PKM"],
        screen_metadata={
            "connector_badge_label": "Connected",
            "receipt_count": 12,
            "preview_available": True,
            "preview_stale": False,
        },
    )

    assert resolution.tier == "section"
    assert "12 stored receipts" in resolution.summary
    assert "preview is ready" in resolution.summary.lower()


def test_resolve_voice_explain_knowledge_resolves_local_concept() -> None:
    resolution = resolve_voice_explain_knowledge(
        transcript="Explain merchant affinity",
        screen="profile_receipts",
        pathname="/profile/receipts",
    )

    assert resolution.tier == "local_concept"
    assert resolution.key == "merchant_affinity"
    assert "merchant affinity" in resolution.summary.lower()


def test_resolve_voice_explain_knowledge_resolves_global_concept() -> None:
    resolution = resolve_voice_explain_knowledge(
        transcript="What is PKM?",
        screen="",
        pathname="/kai",
        allow_surface_overview=False,
    )

    assert resolution.tier == "global_concept"
    assert resolution.key == "pkm"
    assert "structured personal memory layer" in resolution.summary.lower()


def test_resolve_global_concept_describes_kai_as_app_with_in_app_voice_interface() -> None:
    message = resolve_global_concept("What is Kai?")

    assert message is not None
    assert "Kai is the investor app" in message
    assert "voice assistant" in message.lower()


def test_resolve_global_concept_describes_voice_assistant_identity() -> None:
    message = resolve_global_concept("Who are you?")

    assert message is not None
    assert "voice assistant" in message.lower()
    assert "Kai app" in message


def test_get_kai_voice_identity_context_exposes_app_and_role() -> None:
    identity = get_kai_voice_identity_context()

    assert identity["app_name"] == "One"
    assert identity["assistant_role"] == "in_app_voice_interface"
    assert "One is the top personal agent" in identity["role_summary"]
    assert "Kai is the finance specialist" in identity["role_summary"]
