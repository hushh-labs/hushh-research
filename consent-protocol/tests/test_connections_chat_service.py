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
        # Simple identity: return query string as the resolved user id.
        # Tests that need IdentityUnresolvedError on the remove path can override.
        return query


async def _turn(svc, message):
    chat = ConnectionsChatService(service=svc)
    return await chat.handle_turn(user_id="owner1", message=message, conversation_id="c1")


async def test_add_intent_calls_add_with_query():
    svc = _FakeService()
    out = await _turn(svc, "add Alice to my trusted connections")
    assert svc.added and svc.added[0][1] == "Alice"
    assert "added" in out["response"].lower()
    assert out["stateChanged"] is True


async def test_add_unresolved_asks_to_clarify_with_candidates():
    svc = _FakeService()
    svc.raise_unresolved = IdentityUnresolvedError(
        "ambiguous",
        candidates=[
            {"userId": "u1", "displayName": "Alice Rivera"},
            {"userId": "u2", "displayName": "Alice Tan"},
        ],
    )
    out = await _turn(svc, "add Alice to my trusted connections")
    assert "Alice Rivera" in out["response"] and "Alice Tan" in out["response"]
    assert out["stateChanged"] is False


async def test_remove_intent_calls_remove():
    svc = _FakeService()
    out = await _turn(svc, "remove Bob from my trusted connections")
    assert svc.removed and "removed" in out["response"].lower()


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


async def test_unrecognized_message_is_gentle_help():
    svc = _FakeService()
    out = await _turn(svc, "hello there")
    assert out["isComplete"] is True
    assert "trusted connection" in out["response"].lower()
