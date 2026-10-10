import base64
from contextlib import nullcontext
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from hushh_mcp.services import wallet_card_access_service as module
from hushh_mcp.services.direct_messages_service import DirectMessagesError
from hushh_mcp.services.wallet_card_access_service import (
    WalletCardAccessCipher,
    WalletCardAccessError,
    WalletCardAccessService,
)


@pytest.fixture
def grant_service(monkeypatch):
    conn = MagicMock()
    service = WalletCardAccessService(
        db=SimpleNamespace(engine=SimpleNamespace(begin=lambda: nullcontext(conn))),
        cipher=MagicMock(),
    )
    monkeypatch.setattr(service, "require_available", lambda c: None)
    monkeypatch.setattr(service, "_registration_lock", lambda *args, **kwargs: None)
    monkeypatch.setattr(service, "_card", lambda *args: {"last4": "4242"})
    monkeypatch.setattr(module, "lock_connection_graph_users", lambda *args, **kwargs: None)
    monkeypatch.setattr(
        module,
        "DirectMessagesService",
        lambda **kwargs: SimpleNamespace(require_active_connection=lambda *args: None),
    )
    now = datetime.now(timezone.utc)
    row = {
        "owner_user_id": "owner",
        "card_id": "card",
        "expires_at": now + timedelta(minutes=5),
        "revoked_at": None,
        "verification_required": False,
        "verified_at": None,
        "verification_started_at": None,
        "sender_name": "Alex",
    }
    state = {"row": row, "now": now, "trusted": True, "locator": True}

    def query(c, sql, values=None):
        if "SELECT owner_user_id,card_id" in sql:
            assert values["recipient"] == "recipient"
            return {"owner_user_id": "owner", "card_id": "card"} if state["locator"] else None
        if "SELECT g.*" in sql:
            assert values["recipient"] == "recipient"
            return state["row"]
        if "SELECT clock_timestamp()" in sql:
            return {"now": state["now"]}
        if " AS trusted" in sql:
            return {"trusted": state["trusted"]}
        if "RETURNING verification_started_at" in sql:
            return {"verification_started_at": state["now"]}
        raise AssertionError(sql)

    monkeypatch.setattr(module, "one", query)
    service.cipher.open.return_value = (
        '{"brand":"visa","last4":"4242","expiryMonth":4,"expiryYear":2030,"issuingRegion":"US"}'
    )
    return service, state, conn


@pytest.mark.parametrize("status", ["expired", "revoked", "forwarded"])
def test_denied_grant_never_decrypts(grant_service, status):
    service, state, _ = grant_service
    if status == "expired":
        state["row"]["expires_at"] = state["now"]
    if status == "revoked":
        state["row"]["revoked_at"] = state["now"]
    if status == "forwarded":
        state["locator"] = False
        with pytest.raises(WalletCardAccessError, match="NOT_FOUND"):
            service.view_grant("recipient", "grant")
    else:
        result = service.view_grant("recipient", "grant")
        assert result["status"] == status and "card" not in result
    service.cipher.open.assert_not_called()


def test_ordinary_connection_requires_fresh_post_challenge_verification(grant_service):
    service, state, _ = grant_service
    state["trusted"] = False
    started = state["now"] - timedelta(seconds=10)
    state["row"]["verification_started_at"] = started
    result = service.view_grant(
        "recipient", "grant", verified_auth_time=(started - timedelta(seconds=1)).timestamp()
    )
    assert result["status"] == "verification_required" and "card" not in result
    service.cipher.open.assert_not_called()
    result = service.view_grant("recipient", "grant", verified_auth_time=state["now"].timestamp())
    assert result["card"]["last4"] == "4242"


def test_prior_login_and_boolean_auth_time_cannot_verify(grant_service):
    service, state, _ = grant_service
    state["row"]["verification_required"] = True
    for proof in [None, True, state["now"].timestamp() - 301, state["now"].timestamp() + 31]:
        assert (
            service.view_grant("recipient", "grant", verified_auth_time=proof)["status"]
            == "verification_required"
        )
    service.cipher.open.assert_not_called()


def test_permitted_projection_excludes_arbitrary_decrypted_fields(grant_service):
    service, _, _ = grant_service
    service.cipher.open.return_value = '{"pan":"4242424242424242"}'
    with pytest.raises(WalletCardAccessError, match="CONTENT_UNAVAILABLE"):
        service.view_grant("recipient", "grant")


def test_unknown_manual_default_or_foreign_card_is_ineligible(monkeypatch):
    monkeypatch.setattr(module, "one", lambda *args: None)
    for card_id in [
        "card_legacy",
        "agent-one-profile",
        "agent-one-referral",
        "agent-one-net-worth",
        "foreign-card",
    ]:
        with pytest.raises(WalletCardAccessError, match="INELIGIBLE"):
            WalletCardAccessService._card(None, "owner", card_id)


def test_masked_projection_is_bounded_by_validation(monkeypatch):
    from hushh_mcp.services.wallet_card_access_projection import masked_card_projection
    entry = {
        "card_id": "card_11111111-1111-4111-8111-111111111111",
        "brand": "visa",
        "last4": "4242",
        "expiry_month": 4,
        "expiry_year": 2030,
        "issuing_region": "US",
        "nickname": "PRIVATE",
    }
    result = masked_card_projection(entry)
    assert set(result) == {"brand", "last4", "expiryMonth", "expiryYear", "issuingRegion"}
    entry["issuing_region"] = "US4242424242424242"
    assert masked_card_projection(entry)["issuingRegion"] == "US"
    entry["last4"] = "4242424242424242"
    with pytest.raises(ValueError):
        masked_card_projection(entry)


def test_cipher_binds_owner_recipient_grant_and_separate_purpose(monkeypatch):
    monkeypatch.setenv(
        "DIRECT_MESSAGE_ENCRYPTION_KEY_V1", base64.urlsafe_b64encode(b"x" * 32).decode()
    )
    cipher = WalletCardAccessCipher()
    sealed = cipher.seal(
        '{"last4":"4242"}', conversation_id="recipient", message_id="grant", sender_user_id="owner"
    )
    row = {**sealed, "conversation_id": "recipient", "id": "grant", "sender_user_id": "owner"}
    assert cipher.open(row) == '{"last4":"4242"}'
    for field in ["conversation_id", "id", "sender_user_id"]:
        with pytest.raises(DirectMessagesError):
            cipher.open({**row, field: "other"})
    monkeypatch.delenv("DIRECT_MESSAGE_ENCRYPTION_KEY_V1")
    with pytest.raises(DirectMessagesError):
        cipher.seal("x", conversation_id="r", message_id="g", sender_user_id="o")


def test_disabled_registration_does_not_open_database(monkeypatch):
    monkeypatch.delenv("WALLET_CARD_ACCESS_ENABLED", raising=False)
    db = MagicMock()
    assert WalletCardAccessService(db=db).reserve("owner", "request") == {
        "enabled": False,
        "cardId": None,
    }
    db.engine.begin.assert_not_called()
