"""The email data door: a keyless pod reads an inbox SUMMARY through the hub.

Email is the second specialist wired through the pod data door (location was
first), and the first OAuth-backed one, so these tests pin the properties that
make that safe and useful:

  * the projection is FAIL-CLOSED -- no raw address, no Gmail resource handle, no
    live meeting link, and above all no message body can ever cross to the pod;
  * the reader answers the two EXPECTED "no live read" cases (not connected /
    needs reauth) with a helpful marker instead of raising to runtime_unavailable;
  * the scope, registry, and specialist map all agree on one name ("email").

Edge cases are the point, not the happy path.
"""

from __future__ import annotations

import pytest

from hushh_mcp.services import pod_data_door as door

# ruff: noqa: S105,S106 -- fixture strings, not credentials


def _nudge(**overrides):
    base = {
        "type": "meeting",
        "title": "Q3 planning sync",
        "sender": "Marisol",
        "sender_email": "marisol@corp.example",
        "thread_id": "thread_abc123",
        "message_id": "msg_xyz789",
        "received_at": "2026-09-01T10:00:00Z",
        "starts_at": "2026-09-02T09:00:00Z",
        "meeting_url": "https://meet.google.com/join-secret-token",
    }
    base.update(overrides)
    return base


def _raw(**overrides):
    base = {"user_id": "u-owner", "account_email": "owner@gmail.example", "nudges": [_nudge()]}
    base.update(overrides)
    return base


# -- projection: fail-closed egress ---------------------------------------------


def test_projection_drops_every_pii_handle_and_join_link() -> None:
    p = door.project_email_state(_raw())
    assert "account_email" not in p, "the owner's Gmail address must never cross"
    n = p["nudges"][0]
    assert n["sender"] == "Marisol"  # display name is kept
    for leaked in ("sender_email", "thread_id", "message_id", "meeting_url"):
        assert leaked not in n, f"{leaked} must be dropped by omission"
    # only the enumerated keep-list keys survive
    assert set(n) <= {"type", "title", "sender", "received_at", "starts_at"}


def test_projection_never_carries_a_body_even_if_upstream_adds_one() -> None:
    # A future upstream field (a body/snippet) is dropped because it is not on the
    # keep-list -- security by omission, the door's core invariant.
    p = door.project_email_state(_raw(nudges=[_nudge(snippet="secret body text", body="...")]))
    n = p["nudges"][0]
    assert "snippet" not in n and "body" not in n


def test_projection_connected_true_on_a_served_read() -> None:
    assert door.project_email_state(_raw())["connected"] is True


def test_projection_passes_through_the_not_connected_marker() -> None:
    p = door.project_email_state({"connected": False, "reason": "not_connected", "nudges": []})
    assert p == {"connected": False, "reason": "not_connected", "nudges": []}


def test_projection_fails_closed_on_garbage() -> None:
    assert door.project_email_state("nope") == {
        "connected": False,
        "reason": "unavailable",
        "nudges": [],
    }
    assert door.project_email_state({})["connected"] is True  # empty dict = served, no nudges


# -- reader: expected OAuth edge cases become markers, not exceptions -----------


class _FakeGmailApiError(RuntimeError):
    def __init__(self, message, status_code):
        super().__init__(message)
        self.status_code = status_code


def _install_fake_gmail(monkeypatch, *, result=None, raise_status=None, message="x"):
    import hushh_mcp.services.gmail_receipts_service as gmail

    class _Svc:
        async def list_nudges(self, *, user_id, limit=10):
            if raise_status is not None:
                raise _FakeGmailApiError(message, raise_status)
            return result

    monkeypatch.setattr(gmail, "GmailApiError", _FakeGmailApiError)
    monkeypatch.setattr(gmail, "get_gmail_receipts_service", lambda: _Svc())


async def test_reader_returns_not_connected_marker_on_404(monkeypatch) -> None:
    _install_fake_gmail(monkeypatch, raise_status=404, message="Gmail is not connected")
    out = await door._read_email("u-owner")
    assert out == {"connected": False, "reason": "not_connected", "nudges": []}


async def test_reader_returns_needs_reauth_marker_on_401(monkeypatch) -> None:
    _install_fake_gmail(monkeypatch, raise_status=401, message="needs reauthorization")
    out = await door._read_email("u-owner")
    assert out == {"connected": False, "reason": "needs_reauth", "nudges": []}


async def test_reader_reraises_an_unexpected_gmail_error(monkeypatch) -> None:
    # A 500/timeout is NOT an expected "no read" case; it must propagate so the
    # broker surfaces it and the pod falls through, never a false "not connected".
    _install_fake_gmail(monkeypatch, raise_status=502, message="upstream boom")
    with pytest.raises(_FakeGmailApiError):
        await door._read_email("u-owner")


async def test_reader_passes_a_successful_read_through_to_the_projection(monkeypatch) -> None:
    _install_fake_gmail(monkeypatch, result=_raw())
    out = await door.run_pod_data_door_read("email", owner_id="u-owner")
    assert out["connected"] is True and "account_email" not in out
    assert out["nudges"][0]["sender"] == "Marisol" and "sender_email" not in out["nudges"][0]


# -- deterministic summary: every branch answers, none crashes -----------------


def test_summary_renders_meeting_and_attention_lines() -> None:
    from hushh_mcp.one_adk.pod_data_door_specialist import _format_email_summary

    proj = door.project_email_state(
        _raw(
            nudges=[
                _nudge(type="meeting", title="Board review"),
                _nudge(type="important", sender="Dana", title="Contract"),
            ]
        )
    )
    text = _format_email_summary(proj)
    assert "Board review" in text
    assert "Dana" in text
    assert "@" not in text, "no raw address should ever appear in the summary"


@pytest.mark.parametrize(
    "proj,needle",
    [
        ({"connected": False, "reason": "not_connected", "nudges": []}, "isn't connected"),
        ({"connected": False, "reason": "needs_reauth", "nudges": []}, "reconnecting"),
        ({"connected": True, "reason": None, "nudges": []}, "nothing that needs your attention"),
        ("garbage", "could not read your email"),
    ],
)
def test_summary_answers_every_edge_case(proj, needle) -> None:
    from hushh_mcp.one_adk.pod_data_door_specialist import _format_email_summary

    assert needle in _format_email_summary(proj)


# -- one name across scope, registry, and specialist map ------------------------


def test_email_is_wired_consistently_across_the_three_maps() -> None:
    from api.routes.one.pod_specialist import _REQUIRED_SCOPE
    from hushh_mcp.one_adk.pod_data_door_specialist import _SPECIALIST_DOOR_NAMES, _SUMMARIZERS

    assert _REQUIRED_SCOPE["email"] == "cap.email.inbox.view"
    assert "email" in door.POD_DATA_DOOR_READS
    assert _SPECIALIST_DOOR_NAMES["agent_email"] == "email"
    assert "email" in _SUMMARIZERS
