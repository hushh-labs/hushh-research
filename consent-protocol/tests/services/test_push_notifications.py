from unittest.mock import patch

from hushh_mcp.branding import BRAND_NAME
from hushh_mcp.services import push_notifications as push_module
from hushh_mcp.services.push_notifications import (
    _GENERIC_CONNECTION_REQUEST_BODY,
    _connection_accepted_body,
    _connection_request_body,
    send_connection_accepted_push,
    send_connection_request_push,
)
from hushh_mcp.services.requester_identity import (
    looks_technical_label,
    resolve_requester_label,
)


def test_connection_request_body_names_the_requester():
    assert _connection_request_body("Ankit") == "Ankit wants to connect with you on Hussh."


def test_connection_request_body_trims_whitespace_around_the_name():
    assert (
        _connection_request_body("  Ankit Sharma  ")
        == "Ankit Sharma wants to connect with you on Hussh."
    )


def test_connection_request_body_falls_back_when_name_is_missing():
    assert _connection_request_body(None) == _GENERIC_CONNECTION_REQUEST_BODY
    assert _connection_request_body("") == _GENERIC_CONNECTION_REQUEST_BODY
    assert _connection_request_body("   ") == _GENERIC_CONNECTION_REQUEST_BODY


def test_connection_request_body_never_emits_none_or_undefined():
    for value in (None, "", "   ", "Ankit"):
        body = _connection_request_body(value)
        assert "None" not in body
        assert "undefined" not in body


def test_connection_accepted_body_names_the_approver():
    assert _connection_accepted_body("Ankit") == "Ankit accepted your connection request on Hussh."


def test_connection_accepted_body_trims_whitespace_around_the_name():
    assert (
        _connection_accepted_body("  Ankit Sharma  ")
        == "Ankit Sharma accepted your connection request on Hussh."
    )


def test_connection_accepted_body_falls_back_when_name_is_missing():
    fallback = "Someone accepted your connection request on Hussh."
    assert _connection_accepted_body(None) == fallback
    assert _connection_accepted_body("") == fallback
    assert _connection_accepted_body("   ") == fallback


def test_connection_accepted_body_never_emits_none_or_undefined():
    for value in (None, "", "   ", "Ankit"):
        body = _connection_accepted_body(value)
        assert "None" not in body
        assert "undefined" not in body


def test_connection_accepted_body_spells_the_brand_correctly():
    for value in (None, "Ankit"):
        body = _connection_accepted_body(value)
        assert BRAND_NAME in body
        assert "hushh" not in body.lower()


def test_connection_request_body_spells_the_brand_correctly():
    """Regression guard for issue #5422.

    The banner said "on hushh." for the whole life of this surface. `hushh` is
    still a legitimate *identifier* elsewhere (bundle ids, domains, headers), so
    the assertion is on the sentence, not on the repo.
    """
    for value in (None, "Ankit"):
        body = _connection_request_body(value)
        assert BRAND_NAME in body
        assert "hushh" not in body.lower()


# ---------------------------------------------------------------------------
# The FCM data payload -- the actual cause of the "Someone" toast.
#
# The resolved name used to reach only `body` (which the OS banner renders) and
# never the `data` map (which the in-app toast reads), so the banner named the
# requester while the toast beneath it said "Someone".
# ---------------------------------------------------------------------------


def _capture_push(monkeypatch):
    captured: dict = {}

    def _fake_send(user_id, **kwargs):
        captured["user_id"] = user_id
        captured.update(kwargs)
        return 1

    monkeypatch.setattr(push_module, "send_user_data_push", _fake_send)
    return captured


def test_connection_request_push_puts_the_requester_label_in_the_data_map(monkeypatch):
    captured = _capture_push(monkeypatch)

    send_connection_request_push(
        "addressee-1",
        "requester-1",
        requester_display_name="Ankit Sharma",
        connection_request_id="req-42",
    )

    assert captured["data"]["requester_label"] == "Ankit Sharma"
    assert captured["data"]["requester_user_id"] == "requester-1"
    assert captured["body"] == "Ankit Sharma wants to connect with you on Hussh."


def test_connection_request_push_deep_links_to_the_review_sheet(monkeypatch):
    """The Consent Center opens the review sheet only from `?requestId`."""
    captured = _capture_push(monkeypatch)

    send_connection_request_push(
        "addressee-1",
        "requester-1",
        requester_display_name="Ankit",
        connection_request_id="req-42",
    )

    assert captured["deep_link"] == "/one/consent?tab=pending&requestId=req-42"
    assert captured["data"]["request_id"] == "req-42"


def test_connection_request_push_falls_back_to_the_list_without_an_id(monkeypatch):
    captured = _capture_push(monkeypatch)

    send_connection_request_push("addressee-1", "requester-1", requester_display_name="Ankit")

    assert captured["deep_link"] == "/one/consent?tab=connections"
    assert captured["data"]["request_id"] == ""


def test_connection_request_push_percent_encodes_the_request_id(monkeypatch):
    """An id is opaque; it must never be able to inject another query param."""
    captured = _capture_push(monkeypatch)

    send_connection_request_push(
        "addressee-1",
        "requester-1",
        requester_display_name="Ankit",
        connection_request_id="req 42&tab=evil",
    )

    assert captured["deep_link"] == ("/one/consent?tab=pending&requestId=req%2042%26tab%3Devil")


def test_connection_request_push_sends_an_empty_label_when_unresolved(monkeypatch):
    """An unresolved name must arrive empty, never as the placeholder word.

    `send_user_data_push` drops empty values from the data map, so the client can
    tell "the server could not name them" from "this field is not implemented"
    and apply its own fallback ladder. The old code sent the literal "Someone",
    which the client could not distinguish from a real name.
    """
    captured = _capture_push(monkeypatch)
    monkeypatch.setattr(
        "hushh_mcp.services.requester_identity.resolve_requester_label",
        lambda *_a, **_k: "",
    )

    send_connection_request_push("addressee-1", "requester-1", connection_request_id="r1")

    assert captured["data"]["requester_label"] == ""
    assert "Someone" not in captured["data"]["requester_label"]
    assert captured["body"] == _GENERIC_CONNECTION_REQUEST_BODY


def test_connection_request_push_prefers_the_caller_supplied_name(monkeypatch):
    """A name the caller already holds must not trigger a database read."""
    captured = _capture_push(monkeypatch)

    def _explode():
        raise AssertionError("must not query when the caller already has the name")

    monkeypatch.setattr("db.db_client.get_db", _explode)

    send_connection_request_push(
        "addressee-1",
        "requester-1",
        requester_display_name="Ankit",
        connection_request_id="r1",
    )

    assert captured["data"]["requester_label"] == "Ankit"


def test_connection_request_push_reaches_sse_from_a_sync_handler(monkeypatch):
    """The SSE lane must survive being called off the event loop.

    Both production callers are sync FastAPI handlers (`def
    create_connection_request`, `def request_nearby_connection`), which run on a
    threadpool worker where `asyncio.get_running_loop()` raises. The old code
    caught that RuntimeError and did nothing, so the SSE payload -- the only one
    that can reach a web client with no push subscription -- was silently
    discarded on every real request.
    """
    _capture_push(monkeypatch)
    scheduled: list = []
    monkeypatch.setattr(
        "api.consent_listener.push_to_consent_queue_threadsafe",
        lambda user_id, data: scheduled.append((user_id, data)) or True,
    )

    # This test body itself has no running loop -- same as the worker thread.
    send_connection_request_push(
        "addressee-1",
        "requester-1",
        requester_display_name="John Smith",
        connection_request_id="req-42",
    )

    assert len(scheduled) == 1, "the SSE payload was dropped instead of scheduled"
    user_id, payload = scheduled[0]
    assert user_id == "addressee-1"
    assert payload["type"] == "connection_request"
    assert payload["requester_label"] == "John Smith"
    assert payload["request_id"] == "req-42"
    assert payload["body"] == "John Smith wants to connect with you on Hussh."
    assert payload["deep_link"] == "/one/consent?tab=pending&requestId=req-42"


def test_threadsafe_enqueue_delivers_to_a_waiting_sse_consumer():
    """End-to-end across the thread boundary, with no mocks in between."""
    import asyncio
    import threading

    from api import consent_listener as cl

    async def scenario():
        queue = cl.get_consent_queue("addressee-e2e")
        outcome: dict = {}

        def worker():
            try:
                asyncio.get_running_loop()
                outcome["had_loop"] = True
            except RuntimeError:
                outcome["had_loop"] = False
            outcome["scheduled"] = cl.push_to_consent_queue_threadsafe(
                "addressee-e2e", {"type": "connection_request", "requester_label": "John Smith"}
            )

        thread = threading.Thread(target=worker)
        thread.start()
        thread.join()

        # Proves the worker really is off-loop, i.e. a faithful stand-in for the
        # FastAPI threadpool the production callers run on.
        assert outcome["had_loop"] is False
        assert outcome["scheduled"] is True
        return await asyncio.wait_for(queue.get(), timeout=5)

    delivered = asyncio.run(scenario())
    assert delivered["requester_label"] == "John Smith"


def test_threadsafe_enqueue_is_a_noop_without_a_consumer():
    """No SSE consumer in this process is not an error -- there is nobody to tell."""
    from api import consent_listener as cl

    original = cl._serving_loop
    cl._serving_loop = None
    try:
        assert (
            cl.push_to_consent_queue_threadsafe("nobody", {"type": "connection_request"}) is False
        )
    finally:
        cl._serving_loop = original


# ---------------------------------------------------------------------------
# Name resolution
# ---------------------------------------------------------------------------


def test_looks_technical_label_rejects_identifiers_not_names():
    # A raw Firebase uid is a legitimate value of actor_identity_cache.display_name
    # (migration 037 seeds it), and it must never reach the banner.
    assert looks_technical_label("RPNmQAmVdlNz84GVfXxta50wnYx1") is True
    assert looks_technical_label("123e4567-e89b-12d3-a456-426614174000") is True
    assert looks_technical_label("ria:abc") is True
    assert looks_technical_label("user-1", user_id="user-1") is True
    assert looks_technical_label("") is True
    assert looks_technical_label(None) is True
    assert looks_technical_label("   ") is True

    assert looks_technical_label("Ankit Sharma") is False
    assert looks_technical_label("Ankit") is False
    assert looks_technical_label("ankit@example.com") is False


def test_resolve_requester_label_uses_the_display_name():
    rows = [{"display_name": "Ankit Sharma", "email": "ankit@example.com"}]
    assert (
        resolve_requester_label("user-1", execute_one=lambda *_a, **_k: rows[0]) == "Ankit Sharma"
    )


def test_resolve_requester_label_falls_back_to_an_email_handle():
    """A phone-only Firebase account leaves display_name NULL on a row that exists."""
    row = {"display_name": None, "email": "ankit@example.com"}
    assert resolve_requester_label("user-1", execute_one=lambda *_a, **_k: row) == "ankit"


def test_resolve_requester_label_rejects_a_uid_shaped_display_name():
    """Migration 037 seeds display_name to the user id; that is not a name."""
    row = {"display_name": "RPNmQAmVdlNz84GVfXxta50wnYx1", "email": None}
    assert resolve_requester_label("user-1", execute_one=lambda *_a, **_k: row) == ""


def test_resolve_requester_label_never_returns_a_phone_number():
    """Notification labels carry no phone-derived data: banners show on a lock screen.

    Mirrors one_location_agent_service._identity_notification_label. The query
    does not even select the column, so this is a structural guarantee.
    """
    captured: dict = {}

    def _execute_one(sql, params):
        captured["sql"] = sql
        return {"display_name": None, "email": None}

    assert resolve_requester_label("user-1", execute_one=_execute_one) == ""
    assert "phone" not in captured["sql"].lower()


def test_resolve_requester_label_survives_a_database_failure():
    def _boom(*_args, **_kwargs):
        raise RuntimeError("db down")

    assert resolve_requester_label("user-1", execute_one=_boom) == ""


def test_resolve_requester_label_handles_a_missing_row():
    assert resolve_requester_label("user-1", execute_one=lambda *_a, **_k: None) == ""


def test_resolve_requester_label_is_not_gated_on_firebase():
    """Regression guard: the lookup used to return "" when Firebase was unconfigured.

    It is a Postgres read that also feeds in-app copy, so gating it on push
    credentials blanked a name the database held all along.
    """
    row = {"display_name": "Ankit", "email": None}
    with patch("api.utils.firebase_admin.ensure_firebase_admin", return_value=(False, None)):
        assert resolve_requester_label("user-1", execute_one=lambda *_a, **_k: row) == "Ankit"


def test_connection_accepted_push_puts_the_approver_label_in_the_data_map():
    """Same class of bug #5422 fixed for the request push: the in-app toast
    reads only the data map, never `body`."""
    captured: dict = {}

    def _fake_send(user_id, **kwargs):
        captured["user_id"] = user_id
        captured.update(kwargs)
        return 1

    with (
        patch(
            "hushh_mcp.services.push_notifications.send_user_data_push",
            _fake_send,
        ),
        patch(
            "hushh_mcp.services.push_notifications._lookup_display_name",
            return_value="Ankit Sharma",
        ),
    ):
        send_connection_accepted_push("requester-1", "approver-1")

    assert captured["user_id"] == "requester-1"
    assert captured["data"]["approver_label"] == "Ankit Sharma"
    assert captured["data"]["approver_user_id"] == "approver-1"
    assert captured["body"] == "Ankit Sharma accepted your connection request on Hussh."
