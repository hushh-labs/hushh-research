"""Rules that keep the Save my Soul email from becoming a mailer.

The coordinates in this flow arrive from the sender's client and live outside
the envelope's encryption for the length of one send. That is a deliberate
product decision for the emergency case, and these tests are the fence around
it: who may be mailed, for how long, and what must never leak into a log.
"""

from __future__ import annotations

import logging

import pytest

from hushh_mcp.services.one_location_sos_email_service import (
    MAX_SOS_EMAIL_RECIPIENTS,
    OneLocationSosEmailService,
    SosEmailOutcome,
    select_emailable_recipients,
    summarize,
)

NOW = 1_760_000_000.0


def grant_row(**overrides):
    row = {
        "grant_id": "g-1",
        "owner_user_id": "owner-1",
        "recipient_user_id": "friend-1",
        "status": "active",
        "share_kind": "sos",
        "created_at_epoch": NOW - 5,
        "recipient_email": "friend@example.com",
        "recipient_display_name": "Parth Kumar",
    }
    row.update(overrides)
    return row


class TestWhoMayBeMailed:
    def test_accepts_a_fresh_live_sos_grant_with_an_address(self):
        selected = select_emailable_recipients(
            [grant_row()], owner_user_id="owner-1", now_epoch_seconds=NOW
        )
        assert [row["recipient_user_id"] for row in selected] == ["friend-1"]

    def test_rejects_a_grant_belonging_to_someone_else(self):
        # Without this, a caller could mail the contacts of any grant id they
        # could guess or observe.
        selected = select_emailable_recipients(
            [grant_row(owner_user_id="someone-else")],
            owner_user_id="owner-1",
            now_epoch_seconds=NOW,
        )
        assert selected == []

    @pytest.mark.parametrize("kind", ["check_in", "share", "drive_to", ""])
    def test_rejects_a_grant_that_is_not_an_sos(self, kind):
        # A routine check-in share must never trigger an emergency email.
        selected = select_emailable_recipients(
            [grant_row(share_kind=kind)],
            owner_user_id="owner-1",
            now_epoch_seconds=NOW,
        )
        assert selected == []

    @pytest.mark.parametrize("status", ["revoked", "expired"])
    def test_rejects_a_grant_that_is_no_longer_active(self, status):
        selected = select_emailable_recipients(
            [grant_row(status=status)],
            owner_user_id="owner-1",
            now_epoch_seconds=NOW,
        )
        assert selected == []

    def test_rejects_a_grant_that_is_not_from_this_moment(self):
        # An SOS grant lives 8 hours. Freshness is what stops the rest of that
        # window being usable to send more mail.
        stale = grant_row(created_at_epoch=NOW - (16 * 60))
        assert (
            select_emailable_recipients([stale], owner_user_id="owner-1", now_epoch_seconds=NOW)
            == []
        )

    def test_accepts_a_grant_created_moments_ago(self):
        recent = grant_row(created_at_epoch=NOW - (14 * 60))
        assert (
            len(
                select_emailable_recipients(
                    [recent], owner_user_id="owner-1", now_epoch_seconds=NOW
                )
            )
            == 1
        )

    @pytest.mark.parametrize("email", ["", None, "   ", "not-an-address"])
    def test_skips_a_contact_with_no_usable_address(self, email):
        selected = select_emailable_recipients(
            [grant_row(recipient_email=email)],
            owner_user_id="owner-1",
            now_epoch_seconds=NOW,
        )
        assert selected == []

    def test_mails_each_person_once_even_with_duplicate_grants(self):
        rows = [grant_row(grant_id="g-1"), grant_row(grant_id="g-2")]
        selected = select_emailable_recipients(rows, owner_user_id="owner-1", now_epoch_seconds=NOW)
        assert len(selected) == 1

    def test_caps_the_recipient_count(self):
        rows = [
            grant_row(grant_id=f"g-{index}", recipient_user_id=f"friend-{index}")
            for index in range(MAX_SOS_EMAIL_RECIPIENTS + 10)
        ]
        selected = select_emailable_recipients(rows, owner_user_id="owner-1", now_epoch_seconds=NOW)
        assert len(selected) == MAX_SOS_EMAIL_RECIPIENTS


class _Response:
    def __init__(self, status_code=200):
        self.status_code = status_code


class _Session:
    def __init__(self, status_code=200, raises=False):
        self.status_code = status_code
        self.raises = raises
        self.sent = []

    def post(self, url, json=None, timeout=None):
        if self.raises:
            raise RuntimeError("network is down")
        self.sent.append(json)
        return _Response(self.status_code)


def build_service(monkeypatch, *, delivery_mode="live", test_to=None):
    service = OneLocationSosEmailService()

    class _Config:
        configured = True
        from_email = "one@hushh.ai"
        test_to_email = test_to

    _Config.delivery_mode = delivery_mode
    service._config = _Config()
    return service


def send(service, session, **overrides):
    kwargs = {
        "session": session,
        "recipient_user_id": "friend-1",
        "recipient_email": "friend@example.com",
        "recipient_display_name": "Parth Kumar",
        "owner_display_name": "Ankit",
        "note": "I'm not safe",
        "latitude": 12.935200,
        "longitude": 77.624500,
        "accuracy_m": 14.0,
        "sent_at_label": "15:42 UTC on 14 Aug 2026",
        "expires_at_label": "23:42 UTC on 14 Aug",
        "open_in_one_url": "https://uat.one.hushh.ai/one/location?section=shared",
        "emergency_number": "112",
    }
    kwargs.update(overrides)
    return service.send_one(**kwargs)


class TestTheMessage:
    def test_carries_the_coordinates_the_sender_supplied(self, monkeypatch):
        service = build_service(monkeypatch)
        session = _Session()
        outcome = send(service, session)

        assert outcome == SosEmailOutcome("friend-1", True)
        body = service._build_message(
            recipient_email="friend@example.com",
            recipient_display_name="Parth Kumar",
            owner_display_name="Ankit",
            note="I'm not safe",
            latitude=12.9352,
            longitude=77.6245,
            accuracy_m=14.0,
            sent_at_label="15:42 UTC on 14 Aug 2026",
            expires_at_label="23:42 UTC on 14 Aug",
            open_in_one_url="https://uat.one.hushh.ai/one/location?section=shared",
            emergency_number="112",
        ).as_string()

        assert "12.935200, 77.624500" in body
        assert "maps" in body
        assert "Ankit" in body
        assert "112" in body

    def test_escapes_the_note_instead_of_trusting_it(self, monkeypatch):
        # The note is user input and lands in an HTML mail.
        service = build_service(monkeypatch)
        message = service._build_message(
            recipient_email="friend@example.com",
            recipient_display_name=None,
            owner_display_name="Ankit",
            note="<img src=x onerror=alert(1)>",
            latitude=1.0,
            longitude=2.0,
            accuracy_m=None,
            sent_at_label="now",
            expires_at_label=None,
            open_in_one_url="https://example.com",
            emergency_number=None,
        )
        html = message.get_payload()[1].get_payload(decode=True).decode()
        assert "<img src=x" not in html
        assert "&lt;img" in html

    def test_a_non_production_send_goes_to_the_test_inbox(self, monkeypatch):
        # Verifying an emergency mail must not mean mailing a real contact.
        service = build_service(monkeypatch, delivery_mode="test", test_to="qa@hushh.ai")
        message = service._build_message(
            recipient_email="friend@example.com",
            recipient_display_name="Parth",
            owner_display_name="Ankit",
            note=None,
            latitude=1.0,
            longitude=2.0,
            accuracy_m=None,
            sent_at_label="now",
            expires_at_label=None,
            open_in_one_url="https://example.com",
            emergency_number=None,
        )
        assert message["To"] == "qa@hushh.ai"
        assert "friend@example.com" in message["Subject"]
        assert message["Subject"].startswith("[TEST")


class TestFailuresNeverBreakTheAlert:
    def test_a_transport_error_is_reported_not_raised(self, monkeypatch):
        service = build_service(monkeypatch)
        outcome = send(service, _Session(raises=True))
        assert outcome == SosEmailOutcome("friend-1", False, "transport_failed")

    def test_a_rejected_send_is_reported_not_raised(self, monkeypatch):
        service = build_service(monkeypatch)
        outcome = send(service, _Session(status_code=403))
        assert outcome == SosEmailOutcome("friend-1", False, "send_failed")

    def test_summary_counts_only_real_sends(self):
        summary = summarize(
            [
                SosEmailOutcome("a", True),
                SosEmailOutcome("b", False, "send_failed"),
            ]
        )
        assert summary["emailed"] == 1
        assert summary["attempted"] == 2


class TestCoordinatesNeverReachTheLogs:
    def test_no_log_line_carries_a_coordinate(self, monkeypatch, caplog):
        service = build_service(monkeypatch)
        with caplog.at_level(logging.DEBUG):
            send(service, _Session())
            send(service, _Session(status_code=500))
            send(service, _Session(raises=True))

        logged = " ".join(record.getMessage() for record in caplog.records)
        assert "12.9352" not in logged
        assert "77.6245" not in logged
        # The note is what the sender typed; it does not belong in a log either.
        assert "I'm not safe" not in logged
        assert "friend@example.com" not in logged
