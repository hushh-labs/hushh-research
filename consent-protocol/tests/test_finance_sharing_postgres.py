"""Actual PostgreSQL proof of encrypted Finance grant authority and recovery."""

import base64
import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from test_direct_message_feed_projection_postgres import _seed_people, projection_db  # noqa: F401

from hushh_mcp.services.finance_sharing_contract import CreateFinanceShare, RefreshFinanceShare
from hushh_mcp.services.finance_sharing_service import FinanceSharingError, FinanceSharingService


def envelope(key):
    return {
        "algorithm": "ECDH-P256-AES256-GCM",
        "recipientKeyId": key,
        "ciphertext": "A" * 64,
        "iv": "A" * 16,
        "senderEphemeralPublicKeyJwk": {"kty": "EC", "crv": "P-256", "x": "A" * 43, "y": "A" * 43},
    }


@pytest.fixture
def finance_db(projection_db, monkeypatch):  # noqa: F811
    db = projection_db
    _seed_people(db)
    monkeypatch.setenv(
        "DIRECT_MESSAGE_ENCRYPTION_KEY_V1", base64.urlsafe_b64encode(b"m" * 32).decode()
    )
    with db.engine.begin() as conn:
        conn.execute(
            text("""CREATE TABLE one_location_recipient_keys(user_id text,key_id text,status text,
          public_key_jwk jsonb,created_at timestamptz DEFAULT now());
          INSERT INTO one_location_recipient_keys(user_id,key_id,status,public_key_jwk)
            SELECT user_id,user_id||'-key','active','{}'::jsonb FROM actor_profiles;""")
        )
    db.apply_migrations(["433_finance_connection_sharing.sql"])
    db.apply_migrations(["433_finance_connection_sharing.sql"])
    return db, FinanceSharingService(db=db)


def body(db, mode="ongoing"):
    with db.engine.connect() as conn:
        people = (
            conn.execute(
                text(
                    "SELECT user_id,public_person_ref FROM actor_profiles WHERE user_id IN('bob','carol') ORDER BY user_id"
                )
            )
            .mappings()
            .all()
        )
    return CreateFinanceShare.model_validate(
        {
            "requestId": str(uuid.uuid4()),
            "policy": {
                "mode": mode,
                "sections": ["allocation"],
                "selectionHash": "a" * 64,
                "durationSeconds": None if mode == "ongoing" else 3600,
            },
            "ownerConfig": envelope("alice-key"),
            "recipients": [
                {
                    "grantId": str(uuid.uuid4()),
                    "personRef": str(p["public_person_ref"]),
                    "envelope": envelope(p["user_id"] + "-key"),
                    "ownerEnvelope": envelope("alice-key"),
                    "contentHash": "b" * 64,
                }
                for p in people
            ],
        }
    )


def refresh(revision=1):
    return RefreshFinanceShare(
        expectedRevision=revision,
        envelope=envelope("bob-key"),
        ownerEnvelope=envelope("alice-key"),
        contentHash="c" * 64,
    )


def test_recipient_binding_transactional_delivery_and_exact_idempotent_retry(finance_db):
    db, service = finance_db
    approved = body(db)
    created = service.create("alice", approved)["items"]
    assert [g["id"] for g in service.create("alice", approved)["items"]] == [
        g["id"] for g in created
    ]
    bob = next(g for g in created if g["recipientUserId"] == "bob")
    assert service.view("alice", bob["id"])["envelope"]["recipientKeyId"] == "alice-key"
    assert service.view("bob", bob["id"])["envelope"]["recipientKeyId"] == "bob-key"
    assert service.view("alice", bob["id"])["recipientKeyId"] == "bob-key"
    with pytest.raises(FinanceSharingError, match="NOT_FOUND"):
        service.view("carol", bob["id"])
    different = approved.model_copy(
        update={"policy": approved.policy.model_copy(update={"showAmounts": True})}
    )
    with pytest.raises(FinanceSharingError, match="RETRY_CONFLICT"):
        service.create("alice", different)
    with db.engine.connect() as conn:
        assert conn.execute(text("SELECT count(*) FROM messages")).scalar_one() == 2
        assert conn.execute(text("SELECT count(*) FROM finance_access_grants")).scalar_one() == 2


def test_refresh_cas_and_per_recipient_stop_cannot_resurrect(finance_db):
    db, service = finance_db
    created = service.create("alice", body(db))["items"]
    bob = next(g for g in created if g["recipientUserId"] == "bob")
    carol = next(g for g in created if g["recipientUserId"] == "carol")
    assert service.refresh("alice", bob["id"], refresh())["revision"] == 2
    with pytest.raises(FinanceSharingError, match="REVISION_CHANGED"):
        service.refresh("alice", bob["id"], refresh())
    service.revoke("alice", bob["id"])
    assert service.view("bob", bob["id"])["status"] == "stopped"
    assert "envelope" not in service.view("bob", bob["id"])
    with pytest.raises(FinanceSharingError, match="ENDED"):
        service.refresh("alice", bob["id"], refresh(2))
    assert service.view("carol", carol["id"])["status"] == "active"


def test_snapshot_is_immutable_in_service_and_database(finance_db):
    db, service = finance_db
    created = service.create("alice", body(db, "snapshot"))["items"]
    bob = next(g for g in created if g["recipientUserId"] == "bob")
    with pytest.raises(FinanceSharingError, match="ENDED"):
        service.refresh("alice", bob["id"], refresh())
    with pytest.raises(DBAPIError), db.engine.begin() as conn:
        conn.execute(
            text(
                "UPDATE finance_access_grants SET revision=revision+1,content_hash=:hash WHERE id=CAST(:id AS uuid)"
            ),
            {"id": bob["id"], "hash": "d" * 64},
        )


@pytest.mark.parametrize("mechanism", ["disconnect", "block"])
def test_reconnect_and_unblock_never_restore_a_previous_grant(finance_db, mechanism):
    db, service = finance_db
    created = service.create("alice", body(db))["items"]
    bob = next(g for g in created if g["recipientUserId"] == "bob")
    with db.engine.begin() as conn:
        if mechanism == "disconnect":
            conn.execute(
                text(
                    "UPDATE connections SET status='removed' WHERE user_a_id='alice' AND user_b_id='bob'"
                )
            )
            conn.execute(
                text(
                    "UPDATE connections SET status='active' WHERE user_a_id='alice' AND user_b_id='bob'"
                )
            )
        else:
            conn.execute(
                text(
                    "INSERT INTO direct_message_blocks(blocker_user_id,blocked_user_id) VALUES('alice','bob')"
                )
            )
            conn.execute(
                text(
                    "DELETE FROM direct_message_blocks WHERE blocker_user_id='alice' AND blocked_user_id='bob'"
                )
            )
    assert service.view("bob", bob["id"])["status"] == "stopped"
    with pytest.raises(FinanceSharingError, match="ENDED"):
        service.refresh("alice", bob["id"], refresh())


def test_key_rotation_denies_ciphertext(finance_db):
    db, service = finance_db
    created = service.create("alice", body(db))["items"]
    bob = next(g for g in created if g["recipientUserId"] == "bob")
    with db.engine.begin() as conn:
        conn.execute(
            text("UPDATE one_location_recipient_keys SET key_id='changed' WHERE user_id='bob'")
        )
    with pytest.raises(FinanceSharingError, match="KEY_CHANGED"):
        service.view("bob", bob["id"])
    with pytest.raises(FinanceSharingError, match="KEY_CHANGED"):
        service.refresh("alice", bob["id"], refresh())


def test_expiry_during_key_validation_is_rechecked_before_ciphertext_release(
    finance_db, monkeypatch
):
    from datetime import timedelta

    from hushh_mcp.services import finance_sharing_service as module

    db, service = finance_db
    created = service.create("alice", body(db, "snapshot"))["items"]
    bob = next(g for g in created if g["recipientUserId"] == "bob")
    original = module.one

    def delayed(conn, sql, params=None):
        row = original(conn, sql, params)
        if sql == "SELECT clock_timestamp() AS now":
            row["now"] += timedelta(hours=2)
        return row

    monkeypatch.setattr(module, "one", delayed)
    result = service.view("bob", bob["id"])
    assert result["status"] == "expired"
    assert "envelope" not in result


@pytest.mark.parametrize("erased", ["alice", "bob"])
def test_explicit_account_cleanup_erases_both_participants(finance_db, erased):
    from hushh_mcp.services.account_service import AccountService

    db, service = finance_db
    created = service.create("alice", body(db))["items"]
    account = AccountService()
    with db.engine.begin() as conn:
        for table in ("finance_access_grants", "finance_share_requests"):
            account._delete_user_rows_if_table_exists(
                conn, table_name=table, params={"user_id": erased}
            )
        assert (
            conn.execute(
                text(
                    "SELECT count(*) FROM finance_access_grants WHERE owner_user_id=:uid OR recipient_user_id=:uid"
                ),
                {"uid": erased},
            ).scalar_one()
            == 0
        )
    if erased == "alice":
        assert service.history("alice")["items"] == []
    else:
        carol = next(g for g in created if g["recipientUserId"] == "carol")
        assert service.view("carol", carol["id"])["status"] == "active"
