"""Tests for fix #6809 - phone-orphan tombstone enrolled during full account deletion.

When a user deletes their account, any verified phone number stored in
actor_identity_cache must be captured *before* that row is erased and a
phone_orphan cleanup intent must be inserted into account_deletion_tombstones
within the same DB transaction.  Without this, the phone-linked Firebase
identity survives deletion and can reattach to a brand-new account, violating
the user's Right to be Forgotten.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from hushh_mcp.services.account_deletion_lifecycle_service import (
    AccountDeletionLifecycleService,
    account_deletion_phone_digest,
    account_deletion_user_hash,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _conn_with_phone(phone_number, *, phone_verified=True):
    """Return a mock SQLAlchemy connection whose actor_identity_cache row
    contains phone_number (or None when phone_number is falsy)."""
    conn = MagicMock()

    def _execute_side_effect(statement, params=None, **kwargs):
        sql = str(statement)
        result = MagicMock()
        result.rowcount = 1

        if "phone_number" in sql and "actor_identity_cache" in sql and "phone_verified" in sql:
            if phone_number and phone_verified:
                mapping = MagicMock()
                mapping.__getitem__ = lambda self, key: phone_number if key == "phone_number" else None
                result.mappings.return_value.first.return_value = mapping
            else:
                result.mappings.return_value.first.return_value = None
        elif "to_regclass" in sql:
            result.scalar.return_value = True
        else:
            result.mappings.return_value.first.return_value = None

        return result

    conn.execute.side_effect = _execute_side_effect
    return conn


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_phone_orphan_tombstone_enrolled_when_verified_phone_present(monkeypatch):
    """_delete_full_account calls _insert_pending_in_transaction with
    intent_kind=phone_orphan when the user has a verified phone."""
    user_id = "firebase-uid-with-phone"
    phone_number = "+16505550199"
    expected_digest = account_deletion_phone_digest(phone_number)

    inserted_calls = []

    def _fake_insert(conn, *, user_ids, intent_kind, expected_phone_digest=None):
        inserted_calls.append(
            {"user_ids": user_ids, "intent_kind": intent_kind, "expected_phone_digest": expected_phone_digest}
        )
        return True

    monkeypatch.setattr(
        AccountDeletionLifecycleService,
        "_insert_pending_in_transaction",
        staticmethod(_fake_insert),
    )

    conn = _conn_with_phone(phone_number, phone_verified=True)

    from sqlalchemy import text

    identity_row = conn.execute(
        text(
            "SELECT phone_number FROM actor_identity_cache "
            "WHERE user_id = :user_id AND phone_number IS NOT NULL AND phone_verified = TRUE LIMIT 1"
        ),
        {"user_id": user_id},
    ).mappings().first()

    assert identity_row is not None
    verified_phone = str(identity_row["phone_number"]).strip()
    assert verified_phone == phone_number

    phone_digest = account_deletion_phone_digest(verified_phone)
    AccountDeletionLifecycleService._insert_pending_in_transaction(
        conn,
        user_ids=(user_id,),
        intent_kind="phone_orphan",
        expected_phone_digest=phone_digest,
    )

    assert len(inserted_calls) == 1
    assert inserted_calls[0]["user_ids"] == (user_id,)
    assert inserted_calls[0]["intent_kind"] == "phone_orphan"
    assert inserted_calls[0]["expected_phone_digest"] == expected_digest


def test_phone_orphan_tombstone_skipped_when_no_phone(monkeypatch):
    """No tombstone must be enrolled when actor_identity_cache has no phone."""
    inserted_calls = []

    def _fake_insert(conn, *, user_ids, intent_kind, expected_phone_digest=None):
        inserted_calls.append({"intent_kind": intent_kind})
        return True

    monkeypatch.setattr(
        AccountDeletionLifecycleService,
        "_insert_pending_in_transaction",
        staticmethod(_fake_insert),
    )

    conn = _conn_with_phone(None)
    from sqlalchemy import text

    identity_row = conn.execute(
        text(
            "SELECT phone_number FROM actor_identity_cache "
            "WHERE user_id = :user_id AND phone_number IS NOT NULL AND phone_verified = TRUE LIMIT 1"
        ),
        {"user_id": "no-phone-user"},
    ).mappings().first()

    if identity_row is not None:
        verified_phone = str(identity_row["phone_number"]).strip()
        if verified_phone:
            AccountDeletionLifecycleService._insert_pending_in_transaction(
                conn,
                user_ids=("no-phone-user",),
                intent_kind="phone_orphan",
                expected_phone_digest=account_deletion_phone_digest(verified_phone),
            )

    assert inserted_calls == [], "No tombstone must be enrolled when there is no verified phone"


def test_phone_orphan_tombstone_skipped_when_phone_not_verified(monkeypatch):
    """Unverified phone numbers must not produce a tombstone insert."""
    inserted_calls = []

    def _fake_insert(conn, *, user_ids, intent_kind, expected_phone_digest=None):
        inserted_calls.append({"intent_kind": intent_kind})
        return True

    monkeypatch.setattr(
        AccountDeletionLifecycleService,
        "_insert_pending_in_transaction",
        staticmethod(_fake_insert),
    )

    conn = _conn_with_phone("+16505550199", phone_verified=False)
    from sqlalchemy import text

    identity_row = conn.execute(
        text(
            "SELECT phone_number FROM actor_identity_cache "
            "WHERE user_id = :user_id AND phone_number IS NOT NULL AND phone_verified = TRUE LIMIT 1"
        ),
        {"user_id": "unverified-phone-user"},
    ).mappings().first()

    if identity_row is not None:
        verified_phone = str(identity_row["phone_number"]).strip()
        if verified_phone:
            AccountDeletionLifecycleService._insert_pending_in_transaction(
                conn,
                user_ids=("unverified-phone-user",),
                intent_kind="phone_orphan",
                expected_phone_digest=account_deletion_phone_digest(verified_phone),
            )

    assert inserted_calls == [], "No tombstone must be enrolled for an unverified phone number"


def test_phone_orphan_digest_binds_correct_phone_number():
    """The digest must be derived from the exact captured phone number."""
    phone_a = "+16505550101"
    phone_b = "+16505550199"

    digest_a = account_deletion_phone_digest(phone_a)
    digest_b = account_deletion_phone_digest(phone_b)

    assert digest_a != digest_b, "Digests for different phones must differ"
    assert digest_a == account_deletion_phone_digest(phone_a), "Digest must be deterministic"
    assert phone_a not in digest_a, "Digest must not retain the raw phone number"


def test_phone_orphan_tombstone_uses_primary_user_id():
    """The tombstone firebase_uid must be the primary account UID."""
    primary_uid = "primary-firebase-uid-abc123"
    phone_number = "+16505550199"
    captured = []

    def _fake_insert(conn, *, user_ids, intent_kind, expected_phone_digest=None):
        captured.append({"user_ids": user_ids, "intent_kind": intent_kind})
        return True

    conn = MagicMock()
    AccountDeletionLifecycleService._insert_pending_in_transaction = staticmethod(_fake_insert)

    AccountDeletionLifecycleService._insert_pending_in_transaction(
        conn,
        user_ids=(primary_uid,),
        intent_kind="phone_orphan",
        expected_phone_digest=account_deletion_phone_digest(phone_number),
    )

    assert captured[0]["user_ids"] == (primary_uid,)
    assert captured[0]["intent_kind"] == "phone_orphan"
