"""Default QR authority and transactional replacement on disposable PostgreSQL."""

from contextlib import contextmanager

import pytest
from sqlalchemy import text
from test_wallet_card_access_postgres import (  # noqa: F401
    cards_db,
    legacy_cards_db,
    projection_db,
)

from hushh_mcp.services import one_referral_service as referrals
from hushh_mcp.services import one_wallet_card_service as profiles
from hushh_mcp.services.one_wallet_card_service import OneWalletCardService

BROWSER_USER_AGENT = "Mozilla/5.0 Chrome/130.0 Safari/537.36"


def test_profile_and_nws_old_qr_is_rejected_and_new_scans_start_at_zero(cards_db, monkeypatch):  # noqa: F811
    db, _ = cards_db
    db.apply_migrations(["285_one_wallet_card_auto_provision.sql"])
    monkeypatch.setattr(profiles, "get_db", lambda: db)
    service = OneWalletCardService()
    original = service.upsert_card(user_id="alice", card_payload={"full_name": "Synthetic owner"})
    old_token = original["shareToken"]
    service.record_scan(share_token=old_token)
    service.record_scan(share_token=old_token)
    replacement = service.rotate_share_token(user_id="alice")
    assert replacement["card"]["scanCount"] == 0
    assert replacement["card"]["lastScannedAt"] is None
    assert replacement["card"]["passSerial"] == original["card"]["passSerial"]
    assert replacement["card"]["cardPayload"] == original["card"]["cardPayload"]
    for variant in ("profile", "nws"):
        assert (
            service.resolve_pass_material(share_token=old_token, variant=variant)["status"]
            == "not_found"
        )
        assert (
            service.resolve_pass_material(share_token=replacement["shareToken"], variant=variant)[
                "status"
            ]
            == "active"
        )
    service.record_scan(share_token=old_token)
    assert service.get_card(user_id="alice")["scanCount"] == 0
    service.record_scan(share_token=replacement["shareToken"])
    assert service.get_card(user_id="alice")["scanCount"] == 1


@pytest.fixture
def referral_db(cards_db, monkeypatch):  # noqa: F811
    db, _ = cards_db
    db.apply_migrations(["165_one_referral_program.sql", "273_one_referral_display_handles.sql"])

    @contextmanager
    def connection():
        with db.engine.begin() as conn:
            yield conn

    monkeypatch.setattr(referrals, "get_db_connection", connection)
    return db


def test_referral_replacement_resets_only_current_link_opens_and_retries_safely(referral_db):
    original = referrals.get_referral_summary("alice")
    attribution = referrals.resolve_slug_for_attribution(
        original["slug"], user_agent=BROWSER_USER_AGENT
    )
    assert attribution["status"] == "created"
    with referral_db.engine.begin() as conn:
        conn.execute(
            text("""
            INSERT INTO one_referral_relationships
              (attribution_id,referrer_user_id,referred_user_id,policy_version,status,qualified_at)
            VALUES (CAST(:attribution AS uuid),'alice','bob',1,'qualified',NOW())
        """),
            {"attribution": attribution["attribution_id"]},
        )
    assert referrals.get_referral_summary("alice")["link_open_count"] == 1
    replacement = referrals.rotate_referral_code("alice", expected_slug=original["slug"])
    summary = referrals.get_referral_summary("alice")
    assert summary["slug"] == replacement["slug"] != original["slug"]
    assert summary["link_open_count"] == 0
    assert summary["last_opened_at"] is None
    assert summary["qualified_count"] == 1
    assert referrals.resolve_slug_for_attribution(
        original["slug"], user_agent=BROWSER_USER_AGENT
    ) == {"status": "unavailable"}
    assert (
        referrals.rotate_referral_code("alice", expected_slug=original["slug"])["slug"]
        == replacement["slug"]
    )
    assert (
        referrals.resolve_slug_for_attribution(replacement["slug"], user_agent=BROWSER_USER_AGENT)[
            "status"
        ]
        == "created"
    )
    assert referrals.get_referral_summary("alice")["link_open_count"] == 1


def test_referral_allocation_failure_rolls_back_revocation(referral_db, monkeypatch):
    original = referrals.get_referral_summary("alice")
    # The already allocated slug cannot be reused even after disabling it.
    monkeypatch.setattr(referrals, "generate_slug", lambda _: original["slug"])
    with pytest.raises(referrals.ReferralServiceError):
        referrals.rotate_referral_code("alice", expected_slug=original["slug"])
    assert referrals.get_referral_summary("alice")["slug"] == original["slug"]
    assert (
        referrals.resolve_slug_for_attribution(original["slug"], user_agent=BROWSER_USER_AGENT)[
            "status"
        ]
        == "created"
    )
