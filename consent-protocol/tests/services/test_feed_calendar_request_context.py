"""The Feed names which meeting files were asked for or are missing, from the sealed request only."""

import base64
from types import SimpleNamespace
from uuid import uuid4

import pytest

from hushh_mcp.services.drive_sharing_contract import DriveSharingCipher
from hushh_mcp.services.feed_calendar_context import with_calendar_request_context
from hushh_mcp.services.feed_service import FeedService

OWNER, REQUESTER = "organizer-user", "requester-user"


@pytest.fixture
def cipher(monkeypatch):
    monkeypatch.setenv("DRIVE_SHARING_KEY_V1", base64.b64encode(b"s" * 32).decode())
    return DriveSharingCipher()


def _service(envelopes):
    calls = []

    class Db:
        def execute_raw(self, sql, params=None):
            calls.append((sql, params))
            return SimpleNamespace(data=envelopes)

    return Db, calls


def _enrich(service, user_id, rows):
    return with_calendar_request_context(lambda: service(), user_id, rows)


def _row(event_type, request_id, **metadata):
    return {"id": 1, "event_type": event_type, "metadata": {"request_id": request_id, **metadata}}


def _sealed(cipher, request_id, private):
    return {
        "request_id": request_id,
        "user_id": OWNER,
        "request_envelope": cipher.seal(
            private, user_id=OWNER, resource_id=request_id, purpose="request"
        ),
    }


def _meeting(**calendar):
    return {
        "request_type": "calendar_meeting",
        "calendar": {
            "title": "Private title",
            "organizer_email": "organizer@example.invalid",
            "requested_types": ["notes", "recording"],
            **calendar,
        },
    }


def test_rows_carry_only_the_closed_meeting_file_vocabulary(cipher):
    request_id = str(uuid4())
    db, calls = _service([_sealed(cipher, request_id, _meeting(not_available_types=["recording"]))])
    rows = [
        _row("document_share_decided", request_id, user_facing_status="pending"),
        _row("document_share_request", request_id),
        _row("document_share_outcome", request_id),
    ]
    out = _enrich(db, REQUESTER, rows)
    for row in out[:2]:
        assert row["metadata"]["calendar_meeting"] is True
        assert row["metadata"]["calendar_requested_types"] == "recording,notes"
        assert row["metadata"]["not_available_types"] == "recording"
        assert "Private title" not in str(row) and "example.invalid" not in str(row)
    assert out[2] == rows[2]  # events that do not need it are untouched
    # One scoped read, for this participant and these request ids only.
    assert len(calls) == 1 and calls[0][1]["user_id"] == REQUESTER
    assert calls[0][1]["ids"] == f'["{request_id}"]'


def test_other_requests_and_unreadable_envelopes_are_left_exactly_as_they_were(cipher):
    plain, broken = str(uuid4()), str(uuid4())
    db, _ = _service(
        [
            _sealed(cipher, plain, {"request_type": "document", "purpose": {}}),
            {"request_id": broken, "user_id": OWNER, "request_envelope": {"v": 1, "bad": True}},
        ]
    )
    rows = [_row("document_share_decided", plain), _row("document_share_decided", broken)]
    assert _enrich(db, REQUESTER, rows) == rows


def test_one_unreadable_request_does_not_hide_the_others_context(cipher):
    good, broken = str(uuid4()), str(uuid4())
    db, _ = _service(
        [
            {"request_id": broken, "user_id": OWNER, "request_envelope": {"v": 1, "bad": True}},
            _sealed(cipher, good, _meeting()),
        ]
    )
    rows = [_row("document_share_decided", broken), _row("document_share_decided", good)]
    out = _enrich(db, REQUESTER, rows)
    assert out[0] == rows[0]
    assert out[1]["metadata"]["calendar_requested_types"] == "recording,notes"


def test_an_unavailable_database_never_breaks_the_feed(cipher):
    class Down:
        def execute_raw(self, *_args, **_kwargs):
            raise OSError("down")

    rows = [_row("document_share_decided", str(uuid4()))]
    assert _enrich(Down, REQUESTER, rows) == rows


def test_nothing_is_read_when_no_row_needs_it(cipher):
    db, calls = _service([])
    rows = [_row("document_share_outcome", str(uuid4())), {"event_type": "x", "metadata": None}]
    assert _enrich(db, REQUESTER, rows) == rows
    assert calls == []


def test_the_feed_list_carries_the_context_through_its_metadata_whitelist(cipher):
    """FeedService wires the context in, and only the three closed keys survive to the client."""
    request_id = str(uuid4())
    envelopes = [_sealed(cipher, request_id, _meeting(not_available_types=["notes"]))]

    class ListDb:
        def execute_raw(self, sql, params=None):
            if "request_envelope" in sql:
                return SimpleNamespace(data=envelopes)
            if "AS history_revision" in sql:
                return SimpleNamespace(data=[])
            row = {"id": 7, "feed_id": 7, "event_type": "document_share_decided", "read_at": None}
            return SimpleNamespace(
                data=[{**row, "metadata": {"request_id": request_id, "private": "never shown"}}]
            )

    service = FeedService()
    service._db = ListDb()  # type: ignore[assignment]
    service.unread_count = lambda _user: 0  # type: ignore[method-assign]
    metadata = service.list_feed(REQUESTER, cursor=None, limit=5)["items"][0]["metadata"]
    assert metadata["calendar_meeting"] is True
    # Feed metadata is scalar-only, so the closed types travel as one compact string.
    assert metadata["calendar_requested_types"] == "recording,notes"
    assert metadata["not_available_types"] == "notes"
    assert "private" not in metadata and "Private title" not in str(metadata)
