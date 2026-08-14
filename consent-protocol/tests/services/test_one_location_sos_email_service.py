"""Rules that keep the Save my Soul email from becoming an open mailer.

The coordinates in this flow arrive from the sender's client and live outside
the envelope's encryption for the length of one send. That is a deliberate
product decision for the emergency case, and these tests are the fence around
it: who may be mailed, for how long, and what must never leak into a log.
"""

from __future__ import annotations

import pytest

from hushh_mcp.services.one_location_sos_email_service import (
    MAX_SOS_EMAIL_RECIPIENTS,
    select_emailable_recipients,
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
