from hushh_mcp.services.connections_chat_service import ConnectionsChatService
from hushh_mcp.services.trusted_connections_service import IdentityUnresolvedError


class _FakeService:
    def __init__(self):
        self.added = []
        self.removed = []
        self.list_rows = []
        self.raise_unresolved = None

    def add_connection(self, owner_user_id, *, trusted_user_id=None, query=None, label=None):
        if self.raise_unresolved is not None:
            raise self.raise_unresolved
        self.added.append((owner_user_id, query, trusted_user_id))
        return {"trustedUserId": trusted_user_id or "resolved", "resolvedVia": "directory"}

    def remove_connection(self, owner_user_id, trusted_user_id):
        self.removed.append((owner_user_id, trusted_user_id))
        return {"removed": 1, "trustedUserId": trusted_user_id}

    def list_connections(self, owner_user_id):
        return self.list_rows

    def _resolve_query(self, owner_user_id, query):
        # Return a DISTINCT user id (not the raw name) so the two-step
        # resolve -> remove flow is actually proven. Tests that need
        # IdentityUnresolvedError on the remove path override this.
        return f"uid-of-{query.strip().lower()}"


def _two_candidates():
    return [
        {"userId": "u1", "displayName": "Alice Rivera"},
        {"userId": "u2", "displayName": "Alice Tan"},
    ]


async def _turn(svc, message):
    chat = ConnectionsChatService(service=svc)
    return await chat.handle_turn(user_id="owner1", message=message, conversation_id="c1")


async def _selection_turn(svc, selection_result):
    chat = ConnectionsChatService(service=svc)
    return await chat.handle_turn(
        user_id="owner1", message="", conversation_id="c1", selection_result=selection_result
    )


async def test_add_intent_calls_add_with_query():
    svc = _FakeService()
    out = await _turn(svc, "add Alice to my trusted connections")
    assert svc.added and svc.added[0][1] == "Alice"
    assert "added" in out["response"].lower()
    assert out["stateChanged"] is True


async def test_add_ambiguous_returns_select_prompt():
    svc = _FakeService()
    svc.raise_unresolved = IdentityUnresolvedError("ambiguous", candidates=_two_candidates())
    out = await _turn(svc, "add Alice to my trusted connections")

    # No write happened; a selection prompt is returned instead of plain text.
    assert svc.added == []
    assert out["stateChanged"] is False
    assert out["isComplete"] is False
    prompt = out["clientPrompt"]
    assert prompt["kind"] == "select"
    assert prompt["purpose"] == "add_trusted_connection"
    assert prompt["id"].startswith("prm-")
    refs = [o["ref"] for o in prompt["options"]]
    assert refs == [
        {"trustedUserId": "u1", "label": "Alice Rivera", "op": "add"},
        {"trustedUserId": "u2", "label": "Alice Tan", "op": "add"},
    ]


async def test_add_no_match_is_plain_text_no_prompt():
    svc = _FakeService()
    svc.raise_unresolved = IdentityUnresolvedError("none", candidates=[])
    out = await _turn(svc, "add Zzz to my trusted connections")
    assert svc.added == []
    assert "clientPrompt" not in out
    assert "couldn't find" in out["response"].lower()


async def test_selection_completes_add():
    svc = _FakeService()
    out = await _selection_turn(
        svc,
        {
            "status": "answered",
            "selected": [{"trustedUserId": "u1", "label": "Alice Rivera", "op": "add"}],
        },
    )
    assert svc.added == [("owner1", None, "u1")]
    assert out["response"] == "Added Alice Rivera to your trusted connections."
    assert out["stateChanged"] is True


async def test_selection_completes_remove():
    svc = _FakeService()
    out = await _selection_turn(
        svc,
        {
            "status": "answered",
            "selected": [{"trustedUserId": "u2", "label": "Alice Tan", "op": "remove"}],
        },
    )
    assert svc.removed == [("owner1", "u2")]
    assert out["response"] == "Removed Alice Tan from your trusted connections."
    assert out["stateChanged"] is True


async def test_selection_cancelled_changes_nothing():
    svc = _FakeService()
    out = await _selection_turn(svc, {"status": "cancelled", "selected": []})
    assert svc.added == [] and svc.removed == []
    assert out["stateChanged"] is False


async def test_remove_intent_calls_remove():
    svc = _FakeService()
    out = await _turn(svc, "remove Bob from my trusted connections")
    # The resolved id (not the raw name) must be what gets passed to remove.
    assert svc.removed == [("owner1", "uid-of-bob")]
    assert "removed" in out["response"].lower()


async def test_remove_ambiguous_returns_select_prompt():
    svc = _FakeService()

    def _raise(owner_user_id, query):
        raise IdentityUnresolvedError("ambiguous", candidates=_two_candidates())

    svc._resolve_query = _raise
    out = await _turn(svc, "remove Alice from my trusted connections")
    assert svc.removed == []
    assert out["stateChanged"] is False
    prompt = out["clientPrompt"]
    assert prompt["kind"] == "select"
    assert prompt["purpose"] == "remove_trusted_connection"
    assert all(o["ref"]["op"] == "remove" for o in prompt["options"])


async def test_list_intent_lists_names():
    svc = _FakeService()
    svc.list_rows = [{"trustedUserId": "u1", "displayName": "Alice", "label": None}]
    out = await _turn(svc, "who do I trust")
    assert "Alice" in out["response"]
    assert out["stateChanged"] is False


async def test_list_intent_empty():
    svc = _FakeService()
    out = await _turn(svc, "my trusted connections")
    assert "no" in out["response"].lower() or "don't" in out["response"].lower()


async def test_list_intent_people_i_trust():
    svc = _FakeService()
    svc.list_rows = [{"trustedUserId": "u2", "displayName": "Bob", "label": None}]
    out = await _turn(svc, "people I trust")
    assert "Bob" in out["response"]
    assert out["stateChanged"] is False


async def test_unrecognized_message_is_gentle_help():
    svc = _FakeService()
    out = await _turn(svc, "hello there")
    assert out["isComplete"] is True
    assert "trusted connection" in out["response"].lower()
