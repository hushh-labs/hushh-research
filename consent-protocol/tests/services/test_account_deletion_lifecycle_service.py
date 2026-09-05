from __future__ import annotations

import asyncio
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import MagicMock
from uuid import UUID

import pytest

from hushh_mcp.services import account_deletion_lifecycle_service as lifecycle_module
from hushh_mcp.services.account_deletion_lifecycle_service import (
    AccountDeletionInProgressError,
    AccountDeletionLifecycleService,
    ClaimedCleanupIntent,
    FirebaseCleanupAttempt,
    account_deletion_phone_digest,
    account_deletion_user_hash,
    drain_account_deletion_cleanup_intents,
)


@contextmanager
def _db(conn):
    yield conn


def _claim_lease_id() -> str:
    return str(UUID(int=1))


def _inventory_result(*rows: dict):
    result = MagicMock()
    result.mappings.return_value.all.return_value = list(rows)
    return result


def _write_result(*, rowcount: int = 1):
    result = MagicMock()
    result.rowcount = rowcount
    return result


def _guarded_inventory_row(table_name: str, *identity_columns: str) -> dict:
    return {
        "schema_name": "public",
        "table_name": table_name,
        "identity_columns": list(identity_columns),
        "identity_column_kinds": ["text"] * len(identity_columns),
        "insert_guard_installed": True,
        "update_guard_installed": True,
    }


def test_account_deletion_hash_is_stable_and_does_not_retain_uid():
    user_id = "firebase-sensitive-uid"

    first = account_deletion_user_hash(user_id)
    second = account_deletion_user_hash(user_id)

    assert first == second
    assert first.startswith("sha256:")
    assert len(first) == 71
    assert user_id not in first


def test_phone_cleanup_digest_is_keyed_stable_and_does_not_retain_phone():
    phone_number = "+16505550101"

    first = account_deletion_phone_digest(phone_number)
    second = account_deletion_phone_digest(phone_number)

    assert first == second
    assert first.startswith("hmac-sha256:")
    assert len(first) == 76
    assert phone_number not in first
    assert first != account_deletion_phone_digest("+16505550102")


def test_record_pending_uses_same_transaction_lock_and_persists_minimal_intent():
    conn = MagicMock()

    AccountDeletionLifecycleService.record_pending_in_transaction(
        conn,
        user_id="user_123",
    )

    assert conn.execute.call_count == 3
    lock_sql = str(conn.execute.call_args_list[0].args[0])
    second_lock_sql = str(conn.execute.call_args_list[1].args[0])
    insert_sql = str(conn.execute.call_args_list[2].args[0])
    insert_params = conn.execute.call_args_list[2].args[1]
    assert "pg_advisory_xact_lock" in lock_sql
    assert "pg_advisory_xact_lock" in second_lock_sql
    assert conn.execute.call_args_list[0].args[1]["lock_namespace"] == 171
    assert conn.execute.call_args_list[1].args[1]["lock_namespace"] == 198
    assert "INSERT INTO account_deletion_tombstones" in insert_sql
    assert insert_params["firebase_uid"] == "user_123"
    assert insert_params["user_id_hash"] == account_deletion_user_hash("user_123")
    assert insert_params["cleanup_intent_kind"] == "full_account"
    assert insert_params["expected_phone_digest"] is None
    assert "email" not in insert_params
    assert "token" not in insert_params


def test_record_pending_many_locks_all_uids_in_stable_order_before_inserting():
    conn = MagicMock()

    normalized = AccountDeletionLifecycleService.record_pending_many_in_transaction(
        conn,
        user_ids=("user_z", " user_a ", "user_z"),
    )

    assert normalized == ("user_a", "user_z")
    assert conn.execute.call_count == 6
    first_lock_params = conn.execute.call_args_list[0].args[1]
    second_lock_params = conn.execute.call_args_list[1].args[1]
    third_lock_params = conn.execute.call_args_list[2].args[1]
    fourth_lock_params = conn.execute.call_args_list[3].args[1]
    first_insert_sql = str(conn.execute.call_args_list[4].args[0])
    second_insert_sql = str(conn.execute.call_args_list[5].args[0])
    assert first_lock_params["user_id"] == "user_a"
    assert second_lock_params["user_id"] == "user_z"
    assert first_lock_params["lock_namespace"] == 171
    assert second_lock_params["lock_namespace"] == 171
    assert third_lock_params == {"user_id": "user_a", "lock_namespace": 198}
    assert fourth_lock_params == {"user_id": "user_z", "lock_namespace": 198}
    assert "INSERT INTO account_deletion_tombstones" in first_insert_sql
    assert "INSERT INTO account_deletion_tombstones" in second_insert_sql
    assert "cleanup_status = 'completed'" in first_insert_sql


def test_phone_session_intent_checks_indexed_presence_under_both_uid_locks(monkeypatch):
    conn = MagicMock()
    state_result = MagicMock()
    state_result.scalar_one.return_value = False
    conn.execute.side_effect = [
        MagicMock(),
        MagicMock(),
        MagicMock(),
        _inventory_result(
            _guarded_inventory_row("actor_identity_cache", "user_id"),
            _guarded_inventory_row("actor_profiles", "user_id"),
            _guarded_inventory_row("vault_keys", "user_id"),
        ),
        state_result,
        _write_result(),
    ]
    monkeypatch.setattr(lifecycle_module, "get_db_connection", lambda: _db(conn))

    persisted = AccountDeletionLifecycleService.record_pending_if_account_state_absent(
        user_id="phone-session-uid",
        expected_phone_digest=account_deletion_phone_digest("+16505550101"),
    )

    assert persisted is True
    assert conn.execute.call_count == 6
    timeout_sql = str(conn.execute.call_args_list[0].args[0])
    assert "statement_timeout" in timeout_sql
    assert "lock_timeout" in timeout_sql
    assert conn.execute.call_args_list[1].args[1] == {
        "user_id": "phone-session-uid",
        "lock_namespace": 171,
    }
    assert conn.execute.call_args_list[2].args[1] == {
        "user_id": "phone-session-uid",
        "lock_namespace": 198,
    }
    inventory_sql = str(conn.execute.call_args_list[3].args[0])
    assert "WITH guarded_tables AS" in inventory_sql
    assert "trg_reject_deleted_account_insert" in inventory_sql
    assert "trg_reject_deleted_account_reference_update" in inventory_sql
    assert "hushh.account-deletion-guard/v3/insert-presence:" in inventory_sql
    assert "hushh.account-deletion-guard/v3/update-bind-immutable:" in inventory_sql
    assert "insert_guard.tgtype = 7" in inventory_sql
    assert "update_guard.tgtype = 19" in inventory_sql
    assert "table_class.relname = 'consent_audit_receipts'" in inventory_sql
    assert "table_column.attname = 'subject_id'" in inventory_sql
    preflight_sql = str(conn.execute.call_args_list[4].args[0])
    assert "FROM account_identity_presence" in preflight_sql
    assert "WHERE user_id_hash = :user_id_hash" in preflight_sql
    assert "actor_profiles" not in preflight_sql
    assert "vault_keys" not in preflight_sql
    assert "actor_identity_cache" not in preflight_sql
    assert "UNION ALL" not in preflight_sql
    assert "BTRIM" not in preflight_sql
    assert conn.execute.call_args_list[4].args[1] == {
        "user_id_hash": account_deletion_user_hash("phone-session-uid")
    }
    assert "INSERT INTO account_deletion_tombstones" in str(conn.execute.call_args_list[5].args[0])
    insert_params = conn.execute.call_args_list[5].args[1]
    assert insert_params["cleanup_intent_kind"] == "phone_orphan"
    assert insert_params["expected_phone_digest"] == account_deletion_phone_digest("+16505550101")


def test_phone_session_intent_reports_conflict_when_pending_proof_was_not_persisted(
    monkeypatch,
):
    conn = MagicMock()
    state_result = MagicMock()
    state_result.scalar_one.return_value = False
    nonmatching_result = MagicMock()
    nonmatching_result.first.return_value = None
    conn.execute.side_effect = [
        MagicMock(),
        MagicMock(),
        MagicMock(),
        _inventory_result(_guarded_inventory_row("actor_profiles", "user_id")),
        state_result,
        _write_result(rowcount=0),
        nonmatching_result,
    ]
    monkeypatch.setattr(lifecycle_module, "get_db_connection", lambda: _db(conn))

    persisted = AccountDeletionLifecycleService.record_pending_if_account_state_absent(
        user_id="phone-session-uid",
        expected_phone_digest=account_deletion_phone_digest("+16505550101"),
    )

    assert persisted is False


def test_phone_session_intent_retry_accepts_only_the_same_durable_uid_proof(monkeypatch):
    conn = MagicMock()
    state_result = MagicMock()
    state_result.scalar_one.return_value = False
    matching_result = MagicMock()
    matching_result.first.return_value = (1,)
    expected_digest = account_deletion_phone_digest("+16505550101")
    conn.execute.side_effect = [
        MagicMock(),
        MagicMock(),
        MagicMock(),
        _inventory_result(_guarded_inventory_row("actor_profiles", "user_id")),
        state_result,
        _write_result(rowcount=0),
        matching_result,
    ]
    monkeypatch.setattr(lifecycle_module, "get_db_connection", lambda: _db(conn))

    persisted = AccountDeletionLifecycleService.record_pending_if_account_state_absent(
        user_id="phone-session-uid",
        expected_phone_digest=expected_digest,
    )

    assert persisted is True
    retry_sql = str(conn.execute.call_args_list[6].args[0])
    retry_params = conn.execute.call_args_list[6].args[1]
    assert "cleanup_intent_kind = 'phone_orphan'" in retry_sql
    assert "cleanup_status IN" in retry_sql
    assert "cleanup_status = 'completed'" not in retry_sql
    assert retry_params == {
        "user_id_hash": account_deletion_user_hash("phone-session-uid"),
        "firebase_uid": "phone-session-uid",
        "expected_phone_digest": expected_digest,
    }


def test_phone_session_intent_protects_existing_account_state(monkeypatch):
    conn = MagicMock()
    state_result = MagicMock()
    state_result.scalar_one.return_value = True
    conn.execute.side_effect = [
        MagicMock(),
        MagicMock(),
        MagicMock(),
        _inventory_result(_guarded_inventory_row("actor_profiles", "user_id")),
        state_result,
    ]
    monkeypatch.setattr(lifecycle_module, "get_db_connection", lambda: _db(conn))

    persisted = AccountDeletionLifecycleService.record_pending_if_account_state_absent(
        user_id="established-phone-only-account",
        expected_phone_digest=account_deletion_phone_digest("+16505550101"),
    )

    assert persisted is False
    assert conn.execute.call_count == 5
    assert all(
        "INSERT INTO account_deletion_tombstones" not in str(call.args[0])
        for call in conn.execute.call_args_list
    )


def test_phone_session_intent_protects_legacy_investor_only_state(monkeypatch):
    conn = MagicMock()
    state_result = MagicMock()
    state_result.scalar_one.return_value = True
    conn.execute.side_effect = [
        MagicMock(),
        MagicMock(),
        MagicMock(),
        _inventory_result(_guarded_inventory_row("pkm_data", "user_id")),
        state_result,
    ]
    monkeypatch.setattr(lifecycle_module, "get_db_connection", lambda: _db(conn))

    persisted = AccountDeletionLifecycleService.record_pending_if_account_state_absent(
        user_id="legacy-investor-without-account-roots",
        expected_phone_digest=account_deletion_phone_digest("+16505550101"),
    )

    assert persisted is False
    state_sql = str(conn.execute.call_args_list[4].args[0])
    assert "FROM account_identity_presence" in state_sql
    assert "pkm_data" not in state_sql
    assert "actor_profiles" not in state_sql
    assert all(
        "INSERT INTO account_deletion_tombstones" not in str(call.args[0])
        for call in conn.execute.call_args_list
    )


def test_phone_session_intent_fails_closed_when_guard_inventory_is_incomplete(monkeypatch):
    conn = MagicMock()
    incomplete_row = _guarded_inventory_row("pkm_data", "user_id")
    incomplete_row["update_guard_installed"] = False
    conn.execute.side_effect = [
        MagicMock(),
        MagicMock(),
        MagicMock(),
        _inventory_result(incomplete_row),
    ]
    monkeypatch.setattr(lifecycle_module, "get_db_connection", lambda: _db(conn))

    with pytest.raises(RuntimeError, match="guard inventory is incomplete"):
        AccountDeletionLifecycleService.record_pending_if_account_state_absent(
            user_id="phone-session-uid",
            expected_phone_digest=account_deletion_phone_digest("+16505550101"),
        )

    assert conn.execute.call_count == 4


def test_tombstone_status_linearizes_behind_both_shared_uid_locks(monkeypatch):
    conn = MagicMock()
    tombstone_result = MagicMock()
    tombstone_result.first.return_value = (1,)
    conn.execute.side_effect = [
        MagicMock(),
        MagicMock(),
        MagicMock(),
        MagicMock(),
        tombstone_result,
    ]
    monkeypatch.setattr(lifecycle_module, "get_db_connection", lambda: _db(conn))

    assert AccountDeletionLifecycleService.is_tombstoned(" user_123 ") is True

    assert conn.execute.call_count == 5
    assert "SET TRANSACTION ISOLATION LEVEL READ COMMITTED" in str(
        conn.execute.call_args_list[0].args[0]
    )
    timeout_sql = str(conn.execute.call_args_list[1].args[0])
    assert "statement_timeout" in timeout_sql
    assert "lock_timeout" in timeout_sql
    for call_index, expected_namespace in ((2, 171), (3, 198)):
        lock_sql = str(conn.execute.call_args_list[call_index].args[0])
        lock_params = conn.execute.call_args_list[call_index].args[1]
        assert "pg_advisory_xact_lock_shared" in lock_sql
        assert lock_params == {
            "user_id": "user_123",
            "lock_namespace": expected_namespace,
        }
    lookup_sql = str(conn.execute.call_args_list[4].args[0])
    assert "FROM account_deletion_tombstones" in lookup_sql
    assert conn.execute.call_args_list[4].args[1] == {
        "user_id_hash": account_deletion_user_hash("user_123")
    }


def test_tombstone_status_classifies_lifecycle_lock_timeout(monkeypatch):
    class _DriverLockTimeout(Exception):
        sqlstate = "55P03"

    class _SqlAlchemyWrapper(Exception):
        def __init__(self):
            super().__init__("redacted")
            self.orig = _DriverLockTimeout()

    conn = MagicMock()
    conn.execute.side_effect = [MagicMock(), MagicMock(), _SqlAlchemyWrapper()]
    monkeypatch.setattr(lifecycle_module, "get_db_connection", lambda: _db(conn))

    with pytest.raises(AccountDeletionInProgressError):
        AccountDeletionLifecycleService.is_tombstoned("user_123")

    assert conn.execute.call_count == 3
    assert "pg_advisory_xact_lock_shared" in str(conn.execute.call_args.args[0])


def test_completed_cleanup_scrubs_raw_firebase_uid(monkeypatch):
    conn = MagicMock()
    conn.execute.return_value.rowcount = 1
    monkeypatch.setattr(lifecycle_module, "get_db_connection", lambda: _db(conn))

    updated = AccountDeletionLifecycleService.record_cleanup_outcome(
        user_id="user_123",
        attempt=FirebaseCleanupAttempt("deleted"),
    )

    sql = str(conn.execute.call_args.args[0])
    params = conn.execute.call_args.args[1]
    assert "firebase_uid = CASE WHEN :completed THEN NULL" in sql
    assert "expected_phone_digest = CASE" in sql
    assert params["completed"] is True
    assert params["cleanup_status"] == "completed"
    assert params["cleanup_last_failure_class"] is None
    assert params["cleanup_last_classification"] is None
    assert updated is True
    assert "cleanup_status <> 'completed'" in sql
    assert "cleanup_claim_token = CAST(:cleanup_claim_token AS UUID)" in sql


def test_protected_phone_cleanup_cancels_only_its_provisional_intent(monkeypatch):
    conn = MagicMock()
    conn.execute.return_value.rowcount = 1
    monkeypatch.setattr(lifecycle_module, "get_db_connection", lambda: _db(conn))
    phone_digest = account_deletion_phone_digest("+16505550101")

    updated = AccountDeletionLifecycleService.record_cleanup_outcome(
        user_id="phone-session-uid",
        attempt=FirebaseCleanupAttempt(
            "protected",
            classification="firebase_identity_established",
        ),
        intent_kind="phone_orphan",
        expected_phone_digest=phone_digest,
    )

    sql = str(conn.execute.call_args.args[0])
    params = conn.execute.call_args.args[1]
    assert updated is True
    assert params["expected_phone_digest"] == phone_digest
    assert "DELETE FROM account_deletion_tombstones" in sql
    assert "cleanup_intent_kind = 'phone_orphan'" in sql
    assert "cleanup_status <> 'completed'" in sql
    assert "cleanup_claim_token = CAST(:cleanup_claim_token AS UUID)" in sql
    lock_calls = [
        call.args[1]
        for call in conn.execute.call_args_list
        if "pg_advisory_xact_lock(" in str(call.args[0])
    ]
    assert [call["lock_namespace"] for call in lock_calls] == [171, 198]


def test_protected_outcome_cannot_cancel_full_account_deletion():
    with pytest.raises(ValueError, match="only a provisional"):
        AccountDeletionLifecycleService.record_cleanup_outcome(
            user_id="full-account", attempt=FirebaseCleanupAttempt("protected")
        )


def test_phone_orphan_delete_failure_never_disables_a_potentially_established_identity(monkeypatch):
    from firebase_admin import auth as firebase_auth

    monkeypatch.setattr(
        firebase_auth,
        "get_user",
        lambda *_args, **_kwargs: SimpleNamespace(
            uid="phone-session-uid",
            phone_number="+16505550101",
            email=None,
            provider_data=[SimpleNamespace(provider_id="phone")],
        ),
    )
    monkeypatch.setattr(
        firebase_auth, "delete_user", MagicMock(side_effect=RuntimeError("transient"))
    )
    disable = MagicMock()
    revoke = MagicMock()
    monkeypatch.setattr(firebase_auth, "update_user", disable)
    monkeypatch.setattr(firebase_auth, "revoke_refresh_tokens", revoke)

    async def no_sleep(_delay):
        return None

    monkeypatch.setattr(lifecycle_module.asyncio, "sleep", no_sleep)
    result = asyncio.run(
        AccountDeletionLifecycleService().delete_or_quarantine_firebase_identity(
            "phone-session-uid",
            intent_kind="phone_orphan",
            expected_phone_digest=account_deletion_phone_digest("+16505550101"),
        )
    )
    assert result.outcome == "retry_pending"
    disable.assert_not_called()
    revoke.assert_not_called()


def test_phone_orphan_cleanup_revalidates_exact_uid_before_delete(monkeypatch):
    from firebase_admin import auth as firebase_auth

    firebase_app = object()
    events: list[tuple[str, str, object]] = []
    phone_number = "+16505550101"
    phone_digest = account_deletion_phone_digest(phone_number)
    user_record = SimpleNamespace(
        uid="phone-session-uid",
        phone_number=phone_number,
        email=None,
        provider_data=[SimpleNamespace(provider_id="phone")],
    )

    def _get_user(user_id: str, *, app: object):
        events.append(("get", user_id, app))
        return user_record

    def _delete_user(user_id: str, *, app: object):
        events.append(("delete", user_id, app))

    monkeypatch.setattr(lifecycle_module, "get_firebase_auth_app", lambda: firebase_app)
    monkeypatch.setattr(firebase_auth, "get_user", _get_user)
    monkeypatch.setattr(firebase_auth, "delete_user", _delete_user)

    attempt = asyncio.run(
        AccountDeletionLifecycleService().delete_or_quarantine_firebase_identity(
            "phone-session-uid",
            intent_kind="phone_orphan",
            expected_phone_digest=phone_digest,
        )
    )

    assert attempt == FirebaseCleanupAttempt(
        "deleted",
        classification="phone_orphan_revalidated",
    )
    assert events == [
        ("get", "phone-session-uid", firebase_app),
        ("delete", "phone-session-uid", firebase_app),
    ]


@pytest.mark.parametrize(
    ("user_record", "expected_classification"),
    [
        (
            SimpleNamespace(
                uid="phone-session-uid",
                phone_number="+16505550102",
                email=None,
                provider_data=[SimpleNamespace(provider_id="phone")],
            ),
            "phone_digest_mismatch",
        ),
        (
            SimpleNamespace(
                uid="phone-session-uid",
                phone_number="+16505550101",
                email="now-established@example.com",
                provider_data=[SimpleNamespace(provider_id="phone")],
            ),
            "firebase_identity_established",
        ),
        (
            SimpleNamespace(
                uid="phone-session-uid",
                phone_number=None,
                email=None,
                provider_data=[],
            ),
            "phone_number_missing",
        ),
        (
            SimpleNamespace(
                uid="different-uid",
                phone_number="+16505550101",
                email=None,
                provider_data=[SimpleNamespace(provider_id="phone")],
            ),
            "firebase_uid_mismatch",
        ),
    ],
)
def test_phone_orphan_cleanup_protects_changed_or_established_identity(
    monkeypatch,
    user_record,
    expected_classification,
):
    from firebase_admin import auth as firebase_auth

    delete_user = MagicMock()
    monkeypatch.setattr(firebase_auth, "get_user", lambda *_args, **_kwargs: user_record)
    monkeypatch.setattr(firebase_auth, "delete_user", delete_user)

    attempt = asyncio.run(
        AccountDeletionLifecycleService().delete_or_quarantine_firebase_identity(
            "phone-session-uid",
            intent_kind="phone_orphan",
            expected_phone_digest=account_deletion_phone_digest("+16505550101"),
        )
    )

    assert attempt.outcome == "protected"
    assert attempt.classification == expected_classification
    assert attempt.failure_class is None
    delete_user.assert_not_called()


def test_phone_orphan_cleanup_settles_missing_exact_uid_without_delete(monkeypatch):
    from firebase_admin import auth as firebase_auth

    class UserNotFoundError(Exception):
        pass

    def _missing_user(*_args, **_kwargs):
        raise UserNotFoundError()

    delete_user = MagicMock()
    monkeypatch.setattr(firebase_auth, "get_user", _missing_user)
    monkeypatch.setattr(firebase_auth, "delete_user", delete_user)

    attempt = asyncio.run(
        AccountDeletionLifecycleService().delete_or_quarantine_firebase_identity(
            "missing-phone-session-uid",
            intent_kind="phone_orphan",
            expected_phone_digest=account_deletion_phone_digest("+16505550101"),
        )
    )

    assert attempt == FirebaseCleanupAttempt(
        "not_found",
        classification="firebase_user_not_found",
    )
    delete_user.assert_not_called()


def test_phone_orphan_cleanup_revalidates_again_before_retry(monkeypatch):
    from firebase_admin import auth as firebase_auth

    phone_number = "+16505550101"
    phone_digest = account_deletion_phone_digest(phone_number)
    safe_record = SimpleNamespace(
        uid="phone-session-uid",
        phone_number=phone_number,
        email=None,
        provider_data=[SimpleNamespace(provider_id="phone")],
    )
    established_record = SimpleNamespace(
        uid="phone-session-uid",
        phone_number=phone_number,
        email="linked-after-preflight@example.com",
        provider_data=[SimpleNamespace(provider_id="phone")],
    )
    records = iter((safe_record, established_record))
    delete_user = MagicMock(side_effect=RuntimeError("temporary delete failure"))

    monkeypatch.setattr(firebase_auth, "get_user", lambda *_args, **_kwargs: next(records))
    monkeypatch.setattr(firebase_auth, "delete_user", delete_user)

    async def _no_sleep(_delay: float):
        return None

    monkeypatch.setattr(lifecycle_module.asyncio, "sleep", _no_sleep)

    attempt = asyncio.run(
        AccountDeletionLifecycleService().delete_or_quarantine_firebase_identity(
            "phone-session-uid",
            intent_kind="phone_orphan",
            expected_phone_digest=phone_digest,
        )
    )

    assert attempt.outcome == "protected"
    assert attempt.classification == "firebase_identity_established"
    assert delete_user.call_count == 1


def test_stale_cleanup_settlement_is_ignored(monkeypatch):
    conn = MagicMock()
    conn.execute.return_value.rowcount = 0
    monkeypatch.setattr(lifecycle_module, "get_db_connection", lambda: _db(conn))

    updated = AccountDeletionLifecycleService.record_cleanup_outcome(
        user_id="user_123",
        attempt=FirebaseCleanupAttempt("quarantine_incomplete", "TimeoutError"),
        claim_token=_claim_lease_id(),
    )

    assert updated is False
    params = conn.execute.call_args.args[1]
    assert params["cleanup_claim_token"] == _claim_lease_id()


def test_due_cleanup_claim_uses_skip_locked(monkeypatch):
    conn = MagicMock()
    phone_digest = account_deletion_phone_digest("+16505550101")
    conn.execute.return_value.mappings.return_value.all.return_value = [
        {
            "firebase_uid": "user_123",
            "cleanup_claim_token": _claim_lease_id(),
            "cleanup_intent_kind": "phone_orphan",
            "expected_phone_digest": phone_digest,
        }
    ]
    monkeypatch.setattr(lifecycle_module, "get_db_connection", lambda: _db(conn))

    claimed = AccountDeletionLifecycleService.claim_due_cleanup_intents(limit=5)

    assert claimed == [
        ClaimedCleanupIntent(
            firebase_uid="user_123",
            claim_token=_claim_lease_id(),
            intent_kind="phone_orphan",
            expected_phone_digest=phone_digest,
        )
    ]
    assert "FOR UPDATE SKIP LOCKED" in str(conn.execute.call_args.args[0])
    assert "cleanup_claim_token = gen_random_uuid()" in str(conn.execute.call_args.args[0])


def test_firebase_cleanup_has_whole_intent_deadline(monkeypatch):
    service = AccountDeletionLifecycleService()

    async def _never_finishes(_user_id: str, **_kwargs):
        await asyncio.sleep(60)

    monkeypatch.setattr(
        lifecycle_module,
        "_FIREBASE_CLEANUP_INTENT_TIMEOUT_SECONDS",
        0.01,
    )
    monkeypatch.setattr(service, "_delete_or_quarantine_firebase_identity", _never_finishes)

    attempt = asyncio.run(service.delete_or_quarantine_firebase_identity("user_123"))

    assert attempt.outcome == "quarantine_incomplete"
    assert attempt.failure_class == "TimeoutError"


def test_worker_ignores_stale_claim_settlement():
    phone_digest = account_deletion_phone_digest("+16505550101")
    claim = ClaimedCleanupIntent(
        firebase_uid="user_123",
        claim_token=_claim_lease_id(),
        intent_kind="phone_orphan",
        expected_phone_digest=phone_digest,
    )

    class _Lifecycle:
        def claim_due_cleanup_intents(self, *, limit: int):
            assert limit == 10
            return [claim]

        async def delete_or_quarantine_firebase_identity(
            self,
            user_id: str,
            *,
            intent_kind,
            expected_phone_digest,
        ):
            assert user_id == claim.firebase_uid
            assert intent_kind == "phone_orphan"
            assert expected_phone_digest == phone_digest
            return FirebaseCleanupAttempt("deleted")

        def record_cleanup_outcome(
            self,
            *,
            user_id,
            attempt,
            claim_token,
            intent_kind,
            expected_phone_digest,
        ):
            assert user_id == claim.firebase_uid
            assert attempt.outcome == "deleted"
            assert claim_token == claim.claim_token
            assert intent_kind == "phone_orphan"
            assert expected_phone_digest == phone_digest
            return False

    settled = asyncio.run(drain_account_deletion_cleanup_intents(service=_Lifecycle()))

    assert settled == 0
