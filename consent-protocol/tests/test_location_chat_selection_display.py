"""TDD tests for Task 3: location service selection-turn display metadata.

Verifies:
  1. _selection_display_text() helper — prefers frontend display, safe fallbacks
  2. _handle_selection_result() persists metadata={"kind": "selection", "display": ...}
     on the user message, while keeping content = seed (for the LLM).
"""

from __future__ import annotations

from types import SimpleNamespace

from hushh_mcp.services.location_chat_service import (
    LocationChatService,
    _selection_display_text,
)

# ---------------------------------------------------------------------------
# Unit tests for _selection_display_text helper
# ---------------------------------------------------------------------------


def test_display_text_prefers_frontend_display():
    assert _selection_display_text({"display": "Abdul Zalil · 8 hours"}) == "Abdul Zalil · 8 hours"


def test_display_text_strips_whitespace_from_frontend_display():
    assert _selection_display_text({"display": "  Mom · 1 hour  "}) == "Mom · 1 hour"


def test_display_text_fallback_is_coordinate_free_and_not_raw_seed():
    text = _selection_display_text(
        {"selected": [{"recipientUserId": "5dM8", "recipientKeyId": "WlUg"}]}
    )
    assert "recipientUserId" not in text
    assert "recipientKeyId" not in text
    assert "do not guess" not in text
    assert "latitude" not in text
    assert "longitude" not in text


def test_display_text_shows_non_id_values_from_selected():
    text = _selection_display_text({"selected": [{"label": "Alice", "recipientUserId": "abc123"}]})
    assert "Alice" in text
    assert "abc123" not in text


def test_cancelled_display():
    assert _selection_display_text({"status": "cancelled"}) == "Cancelled"


def test_confirm_confirmed():
    assert _selection_display_text({"kind": "confirm", "confirmed": True}) == "Confirmed"


def test_confirm_declined():
    assert _selection_display_text({"kind": "confirm", "confirmed": False}) == "Declined"


def test_free_text_used_when_no_display():
    assert _selection_display_text({"free_text": "Custom note"}) == "Custom note"


def test_freeText_camel_case_fallback():
    assert _selection_display_text({"freeText": "camelCase fallback"}) == "camelCase fallback"


def test_empty_selected_falls_back_to_your_selection():
    assert _selection_display_text({"selected": []}) == "Your selection"


def test_no_keys_at_all_falls_back_to_your_selection():
    assert _selection_display_text({}) == "Your selection"


# ---------------------------------------------------------------------------
# Integration test: _handle_selection_result persists metadata
# ---------------------------------------------------------------------------


class _FakeTypes:
    """Minimal stand-in for google.genai.types so we don't need the real SDK."""

    @staticmethod
    def Content(role, parts):
        return SimpleNamespace(role=role, parts=parts)

    @staticmethod
    def Part(text):
        return SimpleNamespace(text=text)


async def test_selection_turn_persists_display_metadata():
    """The user message must be persisted with metadata carrying the display label."""
    persisted: list[dict] = []

    class FakeStore:
        async def get_recent_messages(self, *a, **k):
            return []

        async def add_message(self, **kwargs):
            persisted.append(kwargs)

    service = LocationChatService.__new__(LocationChatService)
    service._chat_store = FakeStore()
    service._types = _FakeTypes()  # non-None so the guard passes
    service._ready = lambda: True

    async def fake_loop(**kwargs):
        return ("Sharing set up.", False, True, [], [])

    service._run_tool_loop = fake_loop
    service._build_client_prompt = lambda prompts: None
    service._build_client_action = lambda directives: None

    await service._handle_selection_result(
        user_id="u1",
        consent_token="tok",  # noqa: S106
        conversation_id="c1",
        selection_result={
            "id": "p1",
            "kind": "select",
            "selected": [{"recipientUserId": "5dM8", "recipientKeyId": "WlUg"}],
            "display": "Abdul Zalil",
            "status": "answered",
        },
    )

    user_msgs = [m for m in persisted if m.get("role") == "user"]
    assert user_msgs, "selection turn must persist a user message"
    msg = user_msgs[0]
    assert msg["content"].startswith("I selected:"), (
        f"seed content must start with 'I selected:' for the LLM; got: {msg['content']!r}"
    )
    assert msg["metadata"] == {"kind": "selection", "display": "Abdul Zalil"}, (
        f"metadata must carry UI display label; got: {msg.get('metadata')!r}"
    )


async def test_selection_turn_seed_contains_ids_for_llm():
    """content (LLM seed) must still contain the raw ids — do not touch that."""
    persisted: list[dict] = []

    class FakeStore:
        async def get_recent_messages(self, *a, **k):
            return []

        async def add_message(self, **kwargs):
            persisted.append(kwargs)

    service = LocationChatService.__new__(LocationChatService)
    service._chat_store = FakeStore()
    service._types = _FakeTypes()
    service._ready = lambda: True

    async def fake_loop(**kwargs):
        return ("Done.", False, False, [], [])

    service._run_tool_loop = fake_loop
    service._build_client_prompt = lambda prompts: None
    service._build_client_action = lambda directives: None

    await service._handle_selection_result(
        user_id="u1",
        consent_token="tok",  # noqa: S106
        conversation_id="c1",
        selection_result={
            "kind": "select",
            "selected": [{"recipientUserId": "uid-xyz", "recipientKeyId": "key-abc"}],
            "status": "answered",
        },
    )

    user_msgs = [m for m in persisted if m.get("role") == "user"]
    assert user_msgs
    seed = user_msgs[0]["content"]
    # Raw ids stay in the seed so the LLM can act on them
    assert "uid-xyz" in seed
    assert "key-abc" in seed


async def test_cancelled_selection_persists_cancelled_display():
    """A cancelled selection should persist display='Cancelled'."""
    persisted: list[dict] = []

    class FakeStore:
        async def get_recent_messages(self, *a, **k):
            return []

        async def add_message(self, **kwargs):
            persisted.append(kwargs)

    service = LocationChatService.__new__(LocationChatService)
    service._chat_store = FakeStore()
    service._types = _FakeTypes()
    service._ready = lambda: True

    async def fake_loop(**kwargs):
        return ("Cancelled.", False, False, [], [])

    service._run_tool_loop = fake_loop
    service._build_client_prompt = lambda prompts: None
    service._build_client_action = lambda directives: None

    await service._handle_selection_result(
        user_id="u1",
        consent_token="tok",  # noqa: S106
        conversation_id="c1",
        selection_result={"status": "cancelled"},
    )

    user_msgs = [m for m in persisted if m.get("role") == "user"]
    assert user_msgs
    assert user_msgs[0]["metadata"]["display"] == "Cancelled"
