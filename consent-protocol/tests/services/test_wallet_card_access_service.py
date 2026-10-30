import base64
import json
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


def encrypted_card():
    key = {
        "algorithm": "ECDH-P256-AES256-GCM",
        "recipientKeyId": "key",
        "iv": "A" * 16,
        "ciphertext": "A" * 64,
        "senderEphemeralPublicKeyJwk": {"kty": "EC", "crv": "P-256", "x": "A" * 43, "y": "A" * 43},
    }
    return "hushh-wallet-card:v1:" + json.dumps(
        {
            "shareId": "11111111-1111-4111-8111-111111111111",
            "cardId": "card",
            "payload": {"ciphertext": "AAAA", "iv": "A" * 16, "tag": "A" * 22 + "=="},
            "senderKey": key,
            "recipientKey": key,
        }
    )


@pytest.mark.parametrize("trusted", [True, False])
def test_authorized_circles_receive_only_recipient_encrypted_number(grant_service, trusted):
    service, state, _ = grant_service
    state["trusted"] = trusted
    state["row"]["verification_started_at"] = state["now"]
    payload = json.loads(service.cipher.open.return_value)
    payload["encryptedCard"] = encrypted_card()
    service.cipher.open.return_value = json.dumps(payload)
    if not trusted:
        assert "encryptedCard" not in service.view_grant("recipient", "grant")
    result = service.view_grant("recipient", "grant", verified_auth_time=state["now"].timestamp())
    assert result["encryptedCard"] == payload["encryptedCard"]
    assert result["senderUserId"] == "owner"
    assert "pan" not in result["card"]


@pytest.mark.parametrize(
    "content",
    [
        "4242424242424242",
        '{"pan":"4242424242424242"}',
        encrypted_card().replace('"cardId": "card"', '"cardId": "other"'),
    ],
)
def test_grants_reject_plaintext_or_wrong_card_before_database(grant_service, content):
    service, _, conn = grant_service
    ref = "11111111-1111-4111-8111-111111111111"
    with pytest.raises(WalletCardAccessError, match="SHARE_INVALID"):
        service.create_grants("owner", "card", ref, [ref], 10, encrypted_cards={ref: content})
    conn.execute.assert_not_called()


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
        "id": "11111111-1111-4111-8111-111111111111",
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


def test_owner_history_page_is_bounded_and_includes_created_at(grant_service, monkeypatch):
    service, state, conn = grant_service
    rows = [
        dict(
            id=f"00000000-0000-4000-8000-{i:012d}",
            created_at=state["now"],
            expires_at=state["now"] + timedelta(minutes=5),
            revoked_at=None,
            display_name=f"Person {i}",
            server_now=state["now"],
        )
        for i in range(21)
    ]

    def query(c, sql, params):
        assert c is conn
        assert "g.owner_user_id=:owner AND g.card_id=:card" in sql
        assert "ORDER BY g.created_at DESC,g.id ASC LIMIT :limit" in sql
        assert params == {"owner": "owner", "card": "card", "limit": 21}
        return rows

    monkeypatch.setattr(module, "many", query)
    page = service.card_access("owner", "card")
    assert len(page["grants"]) == 20 and page["hasMore"] is True
    assert page["nextCursor"] == rows[19]["id"]
    assert page["grants"][0]["createdAt"] == state["now"].isoformat()


def test_history_cursor_uses_owner_card_and_id_tie_breaker(grant_service, monkeypatch):
    service, state, conn = grant_service
    cursor = "00000000-0000-4000-8000-000000000019"

    def anchor(c, sql, params):
        assert "owner_user_id=:owner AND card_id=:card AND id=CAST(:grant_id AS uuid)" in sql
        assert params == {"owner": "owner", "card": "card", "grant_id": cursor}
        return {"created_at": state["now"]}

    def query(c, sql, params):
        assert "g.created_at < :created" in sql
        assert "g.created_at=:created AND g.id>CAST(:grant_id AS uuid)" in sql
        assert params["created"] == state["now"] and params["grant_id"] == cursor
        return []

    monkeypatch.setattr(module, "one", anchor)
    monkeypatch.setattr(module, "many", query)
    assert service.card_access("owner", "card", cursor) == {
        "eligible": True,
        "grants": [],
        "hasMore": False,
        "nextCursor": None,
    }


@pytest.mark.parametrize("cursor", ["bad", "00000000-0000-4000-8000-000000000099"])
def test_invalid_or_foreign_history_cursor_fails_without_loading_rows(
    grant_service, monkeypatch, cursor
):
    service, _, _ = grant_service
    monkeypatch.setattr(module, "one", lambda *args: None)
    rows = MagicMock()
    monkeypatch.setattr(module, "many", rows)
    with pytest.raises(WalletCardAccessError) as error:
        service.card_access("owner", "card", cursor)
    assert error.value.status_code == 422
    rows.assert_not_called()


def test_readiness_distinguishes_disabled_schema_and_database_failure(monkeypatch):
    service = WalletCardAccessService(db=SimpleNamespace(), cipher=MagicMock())
    connection = MagicMock()
    monkeypatch.setenv("WALLET_CARD_ACCESS_ENABLED", "false")
    with pytest.raises(WalletCardAccessError, match="WALLET_CARD_ACCESS_DISABLED"):
        service.require_available(connection)
    connection.execute.assert_not_called()
    monkeypatch.setenv("WALLET_CARD_ACCESS_ENABLED", "true")
    monkeypatch.setattr(service, "available", lambda conn: False)
    with pytest.raises(WalletCardAccessError, match="WALLET_CARD_ACCESS_NOT_READY"):
        service.require_available(connection)

    def failed(conn):
        raise RuntimeError("storage failure")

    monkeypatch.setattr(service, "available", failed)
    with pytest.raises(RuntimeError, match="storage failure"):
        service.require_available(connection)
