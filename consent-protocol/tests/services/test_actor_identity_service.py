from __future__ import annotations

import asyncio
import copy
import logging
import sys
import types
from datetime import datetime, timezone
from unittest.mock import AsyncMock

import pytest

import hushh_mcp.services.actor_identity_service as actor_identity_service
from hushh_mcp.services.actor_identity_service import (
    ActorIdentityAliasError,
    ActorIdentityPhoneClaimConflictError,
    ActorIdentityService,
    ActorIdentitySyncUnavailableError,
)


async def test_contact_sync_keeps_verified_phone_for_short_firebase_uid(monkeypatch) -> None:
    service = ActorIdentityService()
    cached = {"user_id": "imported", "phone_verified": True, "phone_number": "+919000000001"}
    monkeypatch.setattr(service, "get_many", AsyncMock(return_value={"imported": cached}))
    provider = AsyncMock(side_effect=RuntimeError("provider unavailable"))
    monkeypatch.setattr(service, "_get_firebase_user_record", provider)

    assert await service.sync_contact_sync_requester_from_firebase("imported") is None
    provider.assert_not_awaited()


class _AliasFakeAcquire:
    def __init__(self, conn):
        self.conn = conn

    async def __aenter__(self):
        return self.conn

    async def __aexit__(self, *args: object) -> None:
        return None


async def test_missing_phone_backfill_continues_past_phone_less_batches(monkeypatch):
    from scripts import backfill_actor_identity_cache as backfill

    user_ids = ["synthetic-001", "synthetic-002", "synthetic-003"]

    class Rows:
        async def fetch(self, query, limit, cursor):
            return [{"user_id": uid} for uid in user_ids if uid > cursor][:limit]

    repair = AsyncMock(return_value={"phone_verified": True, "phone_number": "+919000000001"})
    monkeypatch.setattr(backfill, "get_pool", AsyncMock(return_value=_AliasFakePool(Rows())))
    monkeypatch.setattr(
        backfill,
        "ActorIdentityService",
        lambda: types.SimpleNamespace(sync_verified_phone_from_firebase=repair),
    )
    monkeypatch.setattr(backfill, "get_firebase_auth_app", lambda: object())
    monkeypatch.setattr(
        backfill.auth,
        "get_users",
        lambda ids, **kwargs: types.SimpleNamespace(
            users=[
                types.SimpleNamespace(
                    uid=identifier.uid,
                    disabled=False,
                    phone_number="+919000000001" if identifier.uid == user_ids[-1] else None,
                )
                for identifier in ids
            ]
        ),
    )
    await backfill.run_batches(missing_phones_only=True, execute=False, limit=2, all_batches=True)
    repair.assert_not_awaited()
    await backfill.run_batches(missing_phones_only=True, execute=True, limit=2, all_batches=True)
    repair.assert_awaited_once_with("synthetic-003", missing_only=True)


class _AliasFakePool:
    def __init__(self, conn):
        self.conn = conn

    def acquire(self):
        return _AliasFakeAcquire(self.conn)


class _AliasFakeConnection:
    def __init__(self) -> None:
        self.rows: list[dict[str, object]] = []

    async def fetch(self, query: str, *args):
        normalized = " ".join(query.lower().split())
        if "from actor_verified_email_aliases" in normalized and "where user_id = $1" in normalized:
            user_id = args[0]
            return [row for row in self.rows if row["user_id"] == user_id]
        return []

    async def fetchrow(self, query: str, *args):
        normalized = " ".join(query.lower().split())
        if (
            "from actor_verified_email_aliases" in normalized
            and "email_normalized = $1" in normalized
            and "user_id <> $2" in normalized
        ):
            email_normalized, user_id = args
            return next(
                (
                    row
                    for row in self.rows
                    if row["email_normalized"] == email_normalized
                    and row["user_id"] != user_id
                    and row["verification_status"] == "verified"
                    and row["revoked_at"] is None
                ),
                None,
            )
        if (
            "from actor_verified_email_aliases" in normalized
            and "where user_id = $1" in normalized
            and "email_normalized = $2" in normalized
        ):
            user_id, email_normalized = args
            return next(
                (
                    row
                    for row in self.rows
                    if row["user_id"] == user_id and row["email_normalized"] == email_normalized
                ),
                None,
            )
        if "insert into actor_verified_email_aliases" in normalized:
            user_id, email, email_normalized, source, source_ref, code_hash = args
            existing = next(
                (
                    row
                    for row in self.rows
                    if row["user_id"] == user_id and row["email_normalized"] == email_normalized
                ),
                None,
            )
            if existing is None:
                existing = {
                    "alias_id": f"alias_{len(self.rows) + 1}",
                    "created_at": datetime.now(timezone.utc),
                    "last_matched_at": None,
                }
                self.rows.append(existing)
            existing.update(
                {
                    "user_id": user_id,
                    "email": email,
                    "email_normalized": email_normalized,
                    "verification_status": "pending",
                    "verification_source": source,
                    "source_ref": source_ref,
                    "verification_code_hash": code_hash,
                    "verification_requested_at": datetime.now(timezone.utc),
                    "verified_at": None,
                    "revoked_at": None,
                    "updated_at": datetime.now(timezone.utc),
                }
            )
            return existing
        if "update actor_verified_email_aliases" in normalized:
            user_id, email_normalized = args
            row = next(
                row
                for row in self.rows
                if row["user_id"] == user_id and row["email_normalized"] == email_normalized
            )
            row.update(
                {
                    "verification_status": "verified",
                    "verified_at": datetime.now(timezone.utc),
                    "revoked_at": None,
                    "verification_code_hash": None,
                    "updated_at": datetime.now(timezone.utc),
                }
            )
            return row
        return None


def _stub_referral_resync(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Replace the referral re-sync hook with a recorder.

    Keeps tests that aren't about referral qualification hermetic against
    `hushh_mcp.services.one_referral_service`'s real (blocking, DB-backed)
    call, which `upsert_identity`/`claim_verified_phone` now invoke best-effort
    whenever a write asserts `phone_verified=True`.
    """
    calls: list[str] = []

    async def fake(user_id: str) -> None:
        calls.append(user_id)

    monkeypatch.setattr(
        ActorIdentityService, "_sync_referral_qualification_best_effort", staticmethod(fake)
    )
    return calls


class _PhoneClaimFakeConnection:
    def __init__(self) -> None:
        now = datetime.now(timezone.utc)
        self.rows: dict[str, dict[str, object]] = {
            "other-firebase-user-1234567890": {
                "user_id": "other-firebase-user-1234567890",
                "display_name": "Other User",
                "email": "other@example.com",
                "phone_number": "+16505550101",
                "photo_url": None,
                "email_verified": True,
                "phone_verified": True,
                "source": "firebase_phone_claim",
                "last_synced_at": now,
                "created_at": now,
                "updated_at": now,
            },
            "firebase-user-123456789012": {
                "user_id": "firebase-user-123456789012",
                "display_name": "Kai User",
                "email": "kai@example.com",
                "phone_number": None,
                "photo_url": None,
                "email_verified": True,
                "phone_verified": False,
                "source": "firebase_auth",
                "last_synced_at": now,
                "created_at": now,
                "updated_at": now,
            },
        }
        self.fail_claim = False
        self.statement_order: list[str] = []

    class _Transaction:
        def __init__(self, conn: "_PhoneClaimFakeConnection") -> None:
            self.conn = conn
            self.snapshot: dict[str, dict[str, object]] | None = None

        async def __aenter__(self) -> None:
            self.snapshot = copy.deepcopy(self.conn.rows)
            return None

        async def __aexit__(self, exc_type, *args: object) -> bool:
            if exc_type is not None and self.snapshot is not None:
                self.conn.rows = self.snapshot
            return False

    def transaction(self) -> "_PhoneClaimFakeConnection._Transaction":
        return self._Transaction(self)

    async def execute(self, query: str, *args):
        normalized = " ".join(query.lower().split())
        if "insert into vault_keys" in normalized:
            self.statement_order.append("vault")
            return "INSERT 0 1"
        if "insert into actor_profiles" in normalized:
            self.statement_order.append("profile")
            return "INSERT 0 1"
        if "pg_advisory_xact_lock" in normalized:
            self.statement_order.append("phone_lock")
            assert query.count("$1") == 1
            assert args == ("actor_identity_phone_claim:+16505550101",)
            assert "+16505550101" not in query
            return "SELECT 1"
        if "update actor_identity_cache" not in normalized:
            return "UPDATE 0"
        self.statement_order.append("clear_duplicate")
        assert "order by user_id" in normalized
        assert "for update" in normalized
        user_id, phone_number = args
        cleared = 0
        for row in self.rows.values():
            if row["user_id"] != user_id and row["phone_number"] == phone_number:
                row["phone_number"] = None
                row["phone_verified"] = False
                row["updated_at"] = datetime.now(timezone.utc)
                cleared += 1
        return f"UPDATE {cleared}"

    async def fetchrow(self, query: str, *args):
        normalized = " ".join(query.lower().split())
        if "insert into actor_identity_cache" not in normalized:
            return None
        self.statement_order.append("claim")
        if self.fail_claim:
            raise RuntimeError("simulated identity insert failure")
        preserve_phone = len(args) == 9 and args[8]
        if len(args) in (8, 9):
            (
                user_id,
                display_name,
                email,
                phone_number,
                photo_url,
                email_verified,
                verified,
                source,
            ) = args[:8]
        else:
            user_id, phone_number, source = args
            display_name = email = photo_url = email_verified = None
            verified = True
        now = datetime.now(timezone.utc)
        row = self.rows.setdefault(
            user_id,
            {
                "user_id": user_id,
                "display_name": None,
                "email": None,
                "photo_url": None,
                "email_verified": False,
                "created_at": now,
            },
        )
        if preserve_phone and row.get("phone_verified") is True and row.get("phone_number"):
            phone_number = verified = None
        for key, value in (
            ("display_name", display_name),
            ("email", email),
            ("photo_url", photo_url),
            ("email_verified", email_verified),
            ("phone_number", phone_number),
            ("phone_verified", verified),
        ):
            if value is not None:
                row[key] = value
        row.update(source=source, last_synced_at=now, updated_at=now)
        return row

    async def fetch(self, query: str, *args):
        assert "FOR UPDATE" in query
        user_id, phone_number = args
        return [
            row.copy()
            for row in self.rows.values()
            if row["user_id"] == user_id or row["phone_number"] == phone_number
        ]


@pytest.mark.parametrize("concurrent_claim", [False, True])
async def test_missing_phone_repair_preserves_a_claim_committed_during_provider_lookup(
    monkeypatch, concurrent_claim
):
    service = ActorIdentityService()
    conn = _PhoneClaimFakeConnection()
    uid = "firebase-user-123456789012"
    conn.rows.pop("other-firebase-user-1234567890", None)
    initial = dict(conn.rows[uid])
    monkeypatch.setattr(service, "get_many", AsyncMock(return_value={uid: initial}))

    async def provider(*args, **kwargs):
        if concurrent_claim:
            conn.rows[uid].update(phone_number="+14155550199", phone_verified=True)
        return types.SimpleNamespace(phone_number="+16505550101", disabled=False)

    monkeypatch.setattr(service, "_get_firebase_user_record", provider)
    monkeypatch.setattr(
        actor_identity_service, "get_pool", AsyncMock(return_value=_AliasFakePool(conn))
    )
    referral = AsyncMock()
    monkeypatch.setattr(service, "_sync_referral_qualification_best_effort", referral)

    result = await service.sync_verified_phone_from_firebase(uid, missing_only=True)
    assert result["phone_verified"] is True
    assert result["phone_number"] == ("+14155550199" if concurrent_claim else "+16505550101")
    assert result["display_name"] == initial["display_name"]
    referral.assert_not_awaited()


async def test_missing_phone_repair_skips_complete_backend_claim_even_if_stale(monkeypatch):
    service = ActorIdentityService()
    current = {"user_id": "short", "phone_verified": True, "phone_number": "+14155550199"}
    monkeypatch.setattr(service, "get_many", AsyncMock(return_value={"short": current}))
    provider = AsyncMock(side_effect=AssertionError("Must not replace an existing claim"))
    monkeypatch.setattr(service, "_get_firebase_user_record", provider)
    assert await service.sync_verified_phone_from_firebase("short", missing_only=True) == current
    provider.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("conflicting_owner", [True, False])
@pytest.mark.parametrize("source", ["firebase_auth", "unknown"])
async def test_provider_refresh_cannot_displace_a_verified_phone_owner(
    monkeypatch: pytest.MonkeyPatch,
    conflicting_owner: bool,
    source: str,
) -> None:
    _stub_referral_resync(monkeypatch)
    conn = _PhoneClaimFakeConnection()
    if not conflicting_owner:
        conn.rows.pop("other-firebase-user-1234567890")
        # A legitimate native replacement must still reach this account.
        conn.rows["firebase-user-123456789012"].update(
            phone_number="+16505550202",
            phone_verified=True,
        )
    monkeypatch.setattr(
        actor_identity_service, "get_pool", AsyncMock(return_value=_AliasFakePool(conn))
    )

    identity = await ActorIdentityService().upsert_identity(
        user_id="firebase-user-123456789012",
        display_name="Updated Name",
        phone_number="+16505550101",
        phone_verified=True,
        source=source,
    )

    assert identity is not None
    assert identity["display_name"] == "Updated Name"
    if conflicting_owner:
        assert identity["phone_verified"] is False
        assert identity["phone_number"] is None
        assert conn.rows["other-firebase-user-1234567890"]["phone_number"] == "+16505550101"
        assert conn.rows["other-firebase-user-1234567890"]["phone_verified"] is True
    else:
        assert identity["phone_number"] == "+16505550101"
        assert identity["phone_verified"] is True


@pytest.mark.parametrize("claim_during_lookup", [False, True])
async def test_passive_provider_refresh_preserves_newer_verified_phone(
    monkeypatch, claim_during_lookup
):
    """A stale provider read must not reverse a saved country-coded number."""
    _stub_referral_resync(monkeypatch)
    uid = "firebase-user-123456789012"
    conn = _PhoneClaimFakeConnection()
    conn.rows.pop("other-firebase-user-1234567890")
    conn.rows[uid].update(
        phone_number="+16505550101" if claim_during_lookup else "+919000000001", phone_verified=True
    )
    service = ActorIdentityService()
    cached = copy.deepcopy(conn.rows[uid])
    monkeypatch.setattr(service, "get_many", AsyncMock(return_value={uid: cached}))
    monkeypatch.setattr(
        actor_identity_service, "get_pool", AsyncMock(return_value=_AliasFakePool(conn))
    )

    async def provider(*args, **kwargs):
        if claim_during_lookup:
            conn.rows[uid].update(phone_number="+919000000001", phone_verified=True)
        return types.SimpleNamespace(
            uid=uid, display_name="Updated Name", phone_number="+16505550101"
        )

    monkeypatch.setattr(service, "_get_firebase_user_record", provider)
    identity = await service.sync_from_firebase(uid, force=True, require_success=True)
    assert identity["phone_number"] == "+919000000001"
    assert identity["phone_verified"] is True
    assert identity["display_name"] == "Updated Name"


@pytest.mark.parametrize("conflicting_owner", [False, True])
async def test_explicit_native_phone_finalize_keeps_owner_protection(
    monkeypatch, conflicting_owner
):
    _stub_referral_resync(monkeypatch)
    uid = "firebase-user-123456789012"
    conn = _PhoneClaimFakeConnection()
    if not conflicting_owner:
        conn.rows.pop("other-firebase-user-1234567890")
    conn.rows[uid].update(phone_number="+919000000001", phone_verified=True)
    monkeypatch.setattr(
        actor_identity_service, "get_pool", AsyncMock(return_value=_AliasFakePool(conn))
    )
    service = ActorIdentityService()
    monkeypatch.setattr(
        service,
        "_get_firebase_user_record",
        AsyncMock(return_value=types.SimpleNamespace(uid=uid, phone_number="+16505550101")),
    )
    if conflicting_owner:
        with pytest.raises(ActorIdentityPhoneClaimConflictError):
            await service.finalize_verified_phone_from_firebase(uid, "+16505550101")
        assert conn.rows[uid]["phone_number"] == "+919000000001"
        assert conn.rows["other-firebase-user-1234567890"]["phone_number"] == "+16505550101"
    else:
        identity = await service.finalize_verified_phone_from_firebase(uid, "+16505550101")
        assert identity["phone_number"] == "+16505550101"
        assert identity["phone_verified"] is True


@pytest.mark.parametrize("uid,phone", [("other", "+16505550101"), ("owner", "+919000000001")])
async def test_native_phone_finalize_rejects_mismatched_provider_proof(monkeypatch, uid, phone):
    service = ActorIdentityService()
    monkeypatch.setattr(
        service,
        "_get_firebase_user_record",
        AsyncMock(return_value=types.SimpleNamespace(uid=uid, phone_number=phone)),
    )
    claim = AsyncMock()
    monkeypatch.setattr(service, "claim_verified_phone", claim)
    with pytest.raises(ValueError):
        await service.finalize_verified_phone_from_firebase("owner", "+16505550101")
    claim.assert_not_awaited()


@pytest.mark.asyncio
async def test_verified_phone_owner_transfer_uses_parameterized_lock_and_ordered_rows() -> None:
    statements: list[tuple[str, tuple[object, ...]]] = []

    class FakeConnection:
        async def execute(self, query: str, *args: object) -> str:
            statements.append((query, args))
            return "OK"

    await ActorIdentityService._lock_and_clear_verified_phone_binding(
        FakeConnection(),  # type: ignore[arg-type]
        user_id="firebase-user-123456789012",
        phone_number="+16505550101",
    )

    assert len(statements) == 2
    lock_sql, lock_args = statements[0]
    assert "pg_advisory_xact_lock(hashtextextended($1, 0))" in lock_sql
    assert lock_args == ("actor_identity_phone_claim:+16505550101",)
    assert "+16505550101" not in lock_sql
    clear_sql, clear_args = statements[1]
    assert "WITH locked_bindings AS MATERIALIZED" in clear_sql
    assert clear_sql.index("ORDER BY user_id") < clear_sql.index("FOR UPDATE")
    assert clear_args == ("firebase-user-123456789012", "+16505550101")


@pytest.mark.asyncio
@pytest.mark.parametrize("firebase_uid", ["firebase-user-123456789012", "custom"])
async def test_sync_from_firebase_mirrors_phone_number(
    monkeypatch: pytest.MonkeyPatch, firebase_uid: str
) -> None:
    service = ActorIdentityService()

    async def fake_get_many(user_ids: list[str]) -> dict[str, dict]:
        assert user_ids == [firebase_uid]
        return {}

    captured: dict[str, object] = {}

    async def fake_upsert_identity(**kwargs):
        captured.update(kwargs)
        return {"user_id": kwargs["user_id"]}

    monkeypatch.setattr(service, "get_many", fake_get_many)
    monkeypatch.setattr(service, "upsert_identity", fake_upsert_identity)
    monkeypatch.setattr(actor_identity_service, "get_firebase_auth_app", lambda: object())

    fake_user_record = types.SimpleNamespace(
        display_name="Kai User",
        email="kai@example.com",
        phone_number="+16505550101",
        photo_url="https://example.com/avatar.png",
        email_verified=True,
    )
    fake_auth = types.SimpleNamespace(get_user=lambda uid, app=None: fake_user_record)
    monkeypatch.setitem(sys.modules, "firebase_admin", types.SimpleNamespace(auth=fake_auth))

    await service.sync_from_firebase(firebase_uid, force=True, require_success=True)

    assert captured["user_id"] == firebase_uid
    assert captured["email"] == "kai@example.com"
    assert captured["phone_number"] == "+16505550101"
    assert captured["phone_verified"] is True
    assert captured["source"] == "firebase_auth"


@pytest.mark.asyncio
async def test_sync_from_firebase_preserves_backend_phone_claim_when_firebase_has_no_phone(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = ActorIdentityService()

    async def fake_get_many(user_ids: list[str]) -> dict[str, dict]:
        assert user_ids == ["firebase-user-123456789012"]
        return {
            "firebase-user-123456789012": {
                "user_id": "firebase-user-123456789012",
                "phone_number": "+16505550101",
                "phone_verified": True,
                "last_synced_at": datetime.now(timezone.utc),
            }
        }

    captured: dict[str, object] = {}

    async def fake_upsert_identity(**kwargs):
        captured.update(kwargs)
        return {"user_id": kwargs["user_id"], "phone_verified": True}

    monkeypatch.setattr(service, "get_many", fake_get_many)
    monkeypatch.setattr(service, "upsert_identity", fake_upsert_identity)
    monkeypatch.setattr(actor_identity_service, "get_firebase_auth_app", lambda: object())

    fake_user_record = types.SimpleNamespace(
        display_name="Kai User",
        email="kai@example.com",
        phone_number=None,
        photo_url=None,
        email_verified=True,
    )
    fake_auth = types.SimpleNamespace(get_user=lambda uid, app=None: fake_user_record)
    monkeypatch.setitem(sys.modules, "firebase_admin", types.SimpleNamespace(auth=fake_auth))

    await service.sync_from_firebase("firebase-user-123456789012", force=True)

    assert captured["phone_number"] is None
    assert captured["phone_verified"] is None


@pytest.mark.asyncio
@pytest.mark.parametrize("failure_stage", ["provider", "persistence"])
async def test_firebase_sync_failure_never_logs_identity_or_phone_details(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    failure_stage: str,
) -> None:
    service = ActorIdentityService()
    firebase_uid = "firebase-user-123456789012"
    phone_number = "+16505550101"
    cached = {"user_id": firebase_uid, "phone_number": phone_number, "phone_verified": True}

    async def fake_get_many(user_ids: list[str]) -> dict[str, dict]:
        assert user_ids == [firebase_uid]
        return {firebase_uid: cached}

    def fail_get_user(uid: str, *, app: object):
        assert uid == firebase_uid
        if failure_stage == "provider":
            raise RuntimeError(f"provider rejected phone {phone_number}")
        return types.SimpleNamespace(phone_number=phone_number, disabled=False)

    monkeypatch.setattr(service, "get_many", fake_get_many)
    monkeypatch.setattr(service, "upsert_identity", AsyncMock(return_value=None))
    monkeypatch.setattr(actor_identity_service, "get_firebase_auth_app", lambda: object())
    monkeypatch.setitem(
        sys.modules,
        "firebase_admin",
        types.SimpleNamespace(auth=types.SimpleNamespace(get_user=fail_get_user)),
    )
    caplog.set_level(logging.DEBUG, logger=actor_identity_service.__name__)

    result = await service.sync_from_firebase(firebase_uid, force=True)

    assert result == cached
    with pytest.raises(ActorIdentitySyncUnavailableError):
        await service.sync_from_firebase(firebase_uid, force=True, require_success=True)
    messages = "\n".join(record.getMessage() for record in caplog.records)
    if failure_stage == "provider":
        assert "error=RuntimeError" in messages
    assert firebase_uid not in messages
    assert phone_number not in messages
    assert not any(character.isdigit() for character in messages)
    assert all(record.exc_info is None for record in caplog.records)


@pytest.mark.asyncio
async def test_claim_verified_phone_moves_duplicate_shadow_to_current_actor(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _stub_referral_resync(monkeypatch)
    service = ActorIdentityService()
    conn = _PhoneClaimFakeConnection()
    conn.rows.pop("firebase-user-123456789012")

    async def fake_get_pool() -> _AliasFakePool:
        return _AliasFakePool(conn)

    monkeypatch.setattr(actor_identity_service, "get_pool", fake_get_pool)

    identity = await service.claim_verified_phone(
        user_id="firebase-user-123456789012",
        phone_number="+16505550101",
    )

    assert identity is not None
    assert identity["phone_number"] == "+16505550101"
    assert identity["phone_verified"] is True
    assert identity["source"] == "firebase_phone_claim"
    previous_owner = conn.rows["other-firebase-user-1234567890"]
    assert previous_owner["phone_number"] is None
    assert previous_owner["phone_verified"] is False
    assert conn.statement_order == ["vault", "profile", "phone_lock", "clear_duplicate", "claim"]


@pytest.mark.asyncio
async def test_test_phone_claim_cannot_displace_owner_but_same_owner_can_retry(monkeypatch):
    _stub_referral_resync(monkeypatch)
    conn = _PhoneClaimFakeConnection()
    conn.rows["firebase-user-123456789012"].update(phone_number="+16505550202", phone_verified=True)
    monkeypatch.setattr(
        actor_identity_service, "get_pool", AsyncMock(return_value=_AliasFakePool(conn))
    )
    service = ActorIdentityService()
    before = copy.deepcopy(conn.rows)
    with pytest.raises(ActorIdentityPhoneClaimConflictError):
        await service.claim_verified_phone(
            user_id="firebase-user-123456789012",
            phone_number="+16505550101",
            source="uat_test_phone_claim",
        )
    assert conn.rows == before
    retried = await service.claim_verified_phone(
        user_id="other-firebase-user-1234567890",
        phone_number="+16505550101",
        source="uat_test_phone_claim",
    )
    assert retried["phone_verified"] is True
    assert retried["phone_number"] == "+16505550101"


@pytest.mark.asyncio
async def test_claim_verified_phone_rolls_back_duplicate_clear_when_claim_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = ActorIdentityService()
    conn = _PhoneClaimFakeConnection()
    conn.rows.pop("firebase-user-123456789012")
    conn.fail_claim = True

    async def fake_get_pool() -> _AliasFakePool:
        return _AliasFakePool(conn)

    monkeypatch.setattr(actor_identity_service, "get_pool", fake_get_pool)

    identity = await service.claim_verified_phone(
        user_id="firebase-user-123456789012",
        phone_number="+16505550101",
    )

    assert identity is None
    previous_owner = conn.rows["other-firebase-user-1234567890"]
    assert previous_owner["phone_number"] == "+16505550101"
    assert previous_owner["phone_verified"] is True
    assert "firebase-user-123456789012" not in conn.rows
    assert conn.statement_order == ["vault", "profile", "phone_lock", "clear_duplicate", "claim"]


@pytest.mark.asyncio
@pytest.mark.parametrize("writer", ["upsert", "claim"])
async def test_verified_phone_writer_never_logs_exception_phone_details(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    writer: str,
) -> None:
    phone_number = "+16505550101"
    database_error = RuntimeError(
        "duplicate key value violates unique constraint; "
        f"Key (phone_number)=({phone_number}) already exists"
    )

    class FailingAcquire:
        async def __aenter__(self) -> None:
            raise database_error

        async def __aexit__(self, *args: object) -> None:
            return None

    class FailingPool:
        def acquire(self) -> FailingAcquire:
            return FailingAcquire()

    async def fake_get_pool() -> FailingPool:
        return FailingPool()

    monkeypatch.setattr(actor_identity_service, "get_pool", fake_get_pool)
    caplog.set_level(logging.DEBUG, logger=actor_identity_service.__name__)

    service = ActorIdentityService()
    if writer == "upsert":
        result = await service.upsert_identity(
            user_id="firebase-user-alpha",
            phone_number=phone_number,
            phone_verified=True,
        )
    else:
        result = await service.claim_verified_phone(
            user_id="firebase-user-alpha",
            phone_number=phone_number,
        )

    assert result is None
    messages = "\n".join(record.getMessage() for record in caplog.records)
    assert "error=RuntimeError" in messages
    assert phone_number not in messages
    assert not any(character.isdigit() for character in messages)
    assert all(record.exc_info is None for record in caplog.records)


@pytest.mark.asyncio
async def test_upsert_identity_asserting_phone_verified_retriggers_referral_qualification(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Closes the ordering gap: `sync_referral_qualification_from_onboarding`
    was previously only re-invoked when onboarding itself completed, so a
    referred user whose phone verification lands late (e.g. the background
    `sync_from_firebase` resync) could stay stuck at `phone_not_verified`
    forever -- nothing ever checked again. The write that actually asserts
    `phone_verified=True` must re-check qualification."""
    import hushh_mcp.services.one_referral_service as one_referral_service

    calls: list[str] = []
    monkeypatch.setattr(
        one_referral_service,
        "sync_referral_qualification_from_onboarding",
        lambda user_id: calls.append(user_id),
    )

    class FakeTx:
        async def __aenter__(self) -> None:
            return None

        async def __aexit__(self, *args: object) -> None:
            return None

    class FakeConn:
        def transaction(self) -> FakeTx:
            return FakeTx()

        async def execute(self, query: str, *args: object) -> str:
            return "INSERT 0 1"

        async def fetch(self, query: str, *args: object) -> list[object]:
            return []

        async def fetchrow(self, query: str, *args: object) -> dict[str, object]:
            now = datetime.now(timezone.utc)
            return {
                "user_id": args[0],
                "display_name": args[1],
                "email": args[2],
                "phone_number": args[3],
                "photo_url": args[4],
                "email_verified": bool(args[5]),
                "phone_verified": bool(args[6]),
                "source": args[7],
                "last_synced_at": now,
                "created_at": now,
                "updated_at": now,
            }

    class FakeAcquire:
        async def __aenter__(self) -> FakeConn:
            return FakeConn()

        async def __aexit__(self, *args: object) -> None:
            return None

    class FakePool:
        def acquire(self) -> FakeAcquire:
            return FakeAcquire()

    async def fake_get_pool() -> FakePool:
        return FakePool()

    monkeypatch.setattr(actor_identity_service, "get_pool", fake_get_pool)

    service = ActorIdentityService()
    identity = await service.upsert_identity(
        user_id="late-phone-verify-user-0001",
        phone_number="+15551230000",
        phone_verified=True,
    )

    assert identity is not None
    assert calls == ["late-phone-verify-user-0001"]


@pytest.mark.asyncio
async def test_upsert_identity_without_asserting_phone_verified_skips_referral_resync(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import hushh_mcp.services.one_referral_service as one_referral_service

    calls: list[str] = []
    monkeypatch.setattr(
        one_referral_service,
        "sync_referral_qualification_from_onboarding",
        lambda user_id: calls.append(user_id),
    )

    class FakeTx:
        async def __aenter__(self) -> None:
            return None

        async def __aexit__(self, *args: object) -> None:
            return None

    class FakeConn:
        def transaction(self) -> FakeTx:
            return FakeTx()

        async def execute(self, query: str, *args: object) -> str:
            return "INSERT 0 1"

        async def fetchrow(self, query: str, *args: object) -> dict[str, object]:
            now = datetime.now(timezone.utc)
            return {
                "user_id": args[0],
                "display_name": args[1],
                "email": args[2],
                "phone_number": args[3],
                "photo_url": args[4],
                "email_verified": bool(args[5]),
                "phone_verified": bool(args[6]),
                "source": args[7],
                "last_synced_at": now,
                "created_at": now,
                "updated_at": now,
            }

    class FakeAcquire:
        async def __aenter__(self) -> FakeConn:
            return FakeConn()

        async def __aexit__(self, *args: object) -> None:
            return None

    class FakePool:
        def acquire(self) -> FakeAcquire:
            return FakeAcquire()

    async def fake_get_pool() -> FakePool:
        return FakePool()

    monkeypatch.setattr(actor_identity_service, "get_pool", fake_get_pool)

    service = ActorIdentityService()
    await service.upsert_identity(
        user_id="no-phone-change-user-0002",
        display_name="Someone",
    )

    assert calls == []


@pytest.mark.asyncio
async def test_claim_verified_phone_retriggers_referral_qualification(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import hushh_mcp.services.one_referral_service as one_referral_service

    calls: list[str] = []
    monkeypatch.setattr(
        one_referral_service,
        "sync_referral_qualification_from_onboarding",
        lambda user_id: calls.append(user_id),
    )

    service = ActorIdentityService()
    conn = _PhoneClaimFakeConnection()

    async def fake_get_pool() -> _AliasFakePool:
        return _AliasFakePool(conn)

    monkeypatch.setattr(actor_identity_service, "get_pool", fake_get_pool)

    identity = await service.claim_verified_phone(
        user_id="firebase-user-123456789012",
        phone_number="+16505550101",
    )

    assert identity is not None
    assert calls == ["firebase-user-123456789012"]


@pytest.mark.asyncio
async def test_referral_qualification_resync_failure_does_not_fail_phone_write(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Referral qualification is a side effect of phone verification, never a
    precondition for it: a bug or outage in the referral pipeline must not be
    able to fail someone's own phone-claim write."""
    import hushh_mcp.services.one_referral_service as one_referral_service

    def boom(user_id: str) -> None:
        raise RuntimeError("referral service unreachable")

    monkeypatch.setattr(one_referral_service, "sync_referral_qualification_from_onboarding", boom)
    caplog.set_level(logging.ERROR, logger=actor_identity_service.__name__)

    service = ActorIdentityService()
    conn = _PhoneClaimFakeConnection()

    async def fake_get_pool() -> _AliasFakePool:
        return _AliasFakePool(conn)

    monkeypatch.setattr(actor_identity_service, "get_pool", fake_get_pool)

    identity = await service.claim_verified_phone(
        user_id="firebase-user-123456789012",
        phone_number="+16505550101",
    )

    assert identity is not None
    assert identity["phone_verified"] is True
    assert any(
        "referral_qualification_sync_failed" in record.getMessage() for record in caplog.records
    )


@pytest.mark.asyncio
async def test_get_many_tolerates_pre_phone_shadow_schema(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = ActorIdentityService()

    class FakeConnection:
        def __init__(self) -> None:
            self.calls = 0

        async def fetch(self, query: str, user_ids: list[str], **kwargs) -> list[dict[str, object]]:
            self.calls += 1
            assert user_ids == ["firebase-user-123456789012"]
            if self.calls == 1:
                raise actor_identity_service.asyncpg.UndefinedColumnError(
                    'column "phone_number" does not exist'
                )
            assert "NULL::TEXT AS phone_number" in query
            return [
                {
                    "user_id": "firebase-user-123456789012",
                    "display_name": "Kai User",
                    "email": "kai@example.com",
                    "phone_number": None,
                    "photo_url": None,
                    "email_verified": True,
                    "phone_verified": False,
                    "source": "firebase_auth",
                    "last_synced_at": None,
                    "created_at": None,
                    "updated_at": None,
                }
            ]

    class FakeAcquire:
        def __init__(self, conn: FakeConnection) -> None:
            self.conn = conn

        async def __aenter__(self) -> FakeConnection:
            return self.conn

        async def __aexit__(self, *args: object) -> None:
            return None

    class FakePool:
        def __init__(self, conn: FakeConnection) -> None:
            self.conn = conn

        def acquire(self) -> FakeAcquire:
            return FakeAcquire(self.conn)

    conn = FakeConnection()

    async def fake_get_pool() -> FakePool:
        return FakePool(conn)

    monkeypatch.setattr(actor_identity_service, "get_pool", fake_get_pool)

    identities = await service.get_many(["firebase-user-123456789012"])

    identity = identities["firebase-user-123456789012"]
    assert identity["display_name"] == "Kai User"
    assert identity["phone_number"] is None
    assert identity["phone_verified"] is False
    assert conn.calls == 2


@pytest.mark.asyncio
async def test_list_account_identifiers_uses_verified_account_aliases(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = ActorIdentityService()

    async def fake_sync_from_firebase(user_id: str):
        assert user_id == "firebase-user-123456789012"
        return {
            "email": "Primary@Example.com",
            "email_verified": True,
            "phone_number": "+16505550101",
            "phone_verified": True,
        }

    async def fake_list_aliases(user_id: str):
        assert user_id == "firebase-user-123456789012"
        return [
            {
                "email_normalized": "relay@privaterelay.appleid.com",
                "verification_status": "verified",
                "revoked_at": None,
            },
            {
                "email_normalized": "pending@example.com",
                "verification_status": "pending",
                "revoked_at": None,
            },
        ]

    monkeypatch.setattr(service, "sync_from_firebase", fake_sync_from_firebase)
    monkeypatch.setattr(service, "list_verified_email_aliases", fake_list_aliases)

    identifiers = await service.list_account_identifiers("firebase-user-123456789012")

    assert identifiers == [
        "firebase-user-123456789012",
        "primary@example.com",
        "+16505550101",
        "relay@privaterelay.appleid.com",
    ]


@pytest.mark.asyncio
async def test_email_alias_verification_flow_returns_code_only_in_uat_review_path(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = ActorIdentityService()
    conn = _AliasFakeConnection()

    async def fake_get_pool() -> _AliasFakePool:
        return _AliasFakePool(conn)

    monkeypatch.setattr(actor_identity_service, "get_pool", fake_get_pool)
    monkeypatch.setenv("ENVIRONMENT", "uat")

    requested = await service.request_email_alias_verification(
        user_id="firebase-user-123456789012",
        email="Original@Example.com",
    )

    assert requested["alias"]["email_normalized"] == "original@example.com"
    assert requested["alias"]["verification_status"] == "pending"
    assert requested["review_verification_code"]

    verified = await service.confirm_email_alias_verification(
        user_id="firebase-user-123456789012",
        email="original@example.com",
        verification_code=requested["review_verification_code"],
    )

    assert verified["verification_status"] == "verified"
    assert verified["verified_at"] is not None
    assert "verification_code_hash" not in verified

    aliases = await service.list_verified_email_aliases("firebase-user-123456789012")
    assert aliases[0]["email_normalized"] == "original@example.com"


@pytest.mark.asyncio
async def test_email_alias_verification_blocks_existing_verified_owner(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = ActorIdentityService()
    conn = _AliasFakeConnection()
    now = datetime.now(timezone.utc)
    conn.rows.append(
        {
            "alias_id": "alias_existing",
            "user_id": "other-user-1234567890123",
            "email": "original@example.com",
            "email_normalized": "original@example.com",
            "verification_status": "verified",
            "verification_source": "user_verified",
            "source_ref": None,
            "verification_code_hash": None,
            "verification_requested_at": now,
            "verified_at": now,
            "revoked_at": None,
            "last_matched_at": None,
            "created_at": now,
            "updated_at": now,
        }
    )

    async def fake_get_pool() -> _AliasFakePool:
        return _AliasFakePool(conn)

    monkeypatch.setattr(actor_identity_service, "get_pool", fake_get_pool)

    with pytest.raises(ActorIdentityAliasError) as exc:
        await service.request_email_alias_verification(
            user_id="firebase-user-123456789012",
            email="original@example.com",
        )

    assert exc.value.code == "EMAIL_ALIAS_ALREADY_VERIFIED"


@pytest.mark.asyncio
async def test_upsert_identity_ensures_actor_profile_spine_row(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _stub_referral_resync(monkeypatch)
    executed_statements: list[tuple[str, tuple[object, ...]]] = []

    class FakeTx:
        async def __aenter__(self) -> None:
            return None

        async def __aexit__(self, *args: object) -> None:
            return None

    class FakeConn:
        def transaction(self) -> FakeTx:
            return FakeTx()

        async def execute(self, query: str, *args: object) -> str:
            executed_statements.append((query, args))
            return "INSERT 0 1"

        async def fetch(self, query: str, *args: object) -> list[dict[str, object]]:
            return []

        async def fetchrow(self, query: str, *args: object) -> dict[str, object]:
            executed_statements.append((query, args))
            now = datetime.now(timezone.utc)
            return {
                "user_id": args[0],
                "display_name": args[1],
                "email": args[2],
                "phone_number": args[3],
                "photo_url": args[4],
                "email_verified": bool(args[5]),
                "phone_verified": bool(args[6]),
                "source": args[7],
                "last_synced_at": now,
                "created_at": now,
                "updated_at": now,
            }

    class FakeAcquire:
        async def __aenter__(self) -> FakeConn:
            return FakeConn()

        async def __aexit__(self, *args: object) -> None:
            return None

    class FakePool:
        def acquire(self) -> FakeAcquire:
            return FakeAcquire()

    async def fake_get_pool() -> FakePool:
        return FakePool()

    monkeypatch.setattr(actor_identity_service, "get_pool", fake_get_pool)

    service = ActorIdentityService()
    identity = await service.upsert_identity(
        user_id="new-signup-user-9999",
        display_name="New Signup User",
        email="newuser@example.com",
        phone_number="+15559990000",
        phone_verified=True,
    )

    assert identity is not None
    assert identity["user_id"] == "new-signup-user-9999"
    assert identity["phone_verified"] is True
    assert len(executed_statements) == 5
    assert "INSERT INTO vault_keys" in executed_statements[0][0]
    assert "'placeholder'" in executed_statements[0][0]
    assert "INSERT INTO actor_profiles" in executed_statements[1][0]
    lock_sql, lock_args = executed_statements[2]
    assert "pg_advisory_xact_lock(hashtextextended($1, 0))" in lock_sql
    assert lock_args == ("actor_identity_phone_claim:+15559990000",)
    assert "+15559990000" not in lock_sql
    clear_sql, clear_args = executed_statements[3]
    assert "ORDER BY user_id" in clear_sql
    assert "FOR UPDATE" in clear_sql
    assert clear_args == ("new-signup-user-9999", "+15559990000")
    assert "INSERT INTO actor_identity_cache" in executed_statements[4][0]


@pytest.mark.asyncio
async def test_awaited_sync_coalesces_concurrent_callers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = ActorIdentityService()
    user_id = "firebase-user-coalesced-1234567890"
    actor_identity_service._IDENTITY_SYNC_TASKS.clear()
    actor_identity_service._IDENTITY_SYNC_IN_FLIGHT.clear()
    actor_identity_service._IDENTITY_SYNC_COOLDOWN_UNTIL.clear()
    started = asyncio.Event()
    release = asyncio.Event()
    calls = 0

    async def slow_sync(_user_id: str, *, force: bool = False):
        nonlocal calls
        assert _user_id == user_id
        assert force is False
        calls += 1
        started.set()
        await release.wait()
        return {"user_id": _user_id}

    monkeypatch.setattr(service, "sync_from_firebase", slow_sync)

    first = asyncio.create_task(service.sync_from_firebase_if_due(user_id))
    await started.wait()
    second = asyncio.create_task(service.sync_from_firebase_if_due(user_id))
    await asyncio.sleep(0)

    assert calls == 1
    release.set()
    assert await asyncio.gather(first, second) == [
        {"user_id": user_id},
        {"user_id": user_id},
    ]
    assert user_id not in actor_identity_service._IDENTITY_SYNC_IN_FLIGHT
    assert user_id in actor_identity_service._IDENTITY_SYNC_COOLDOWN_UNTIL
    actor_identity_service._IDENTITY_SYNC_COOLDOWN_UNTIL.clear()


@pytest.mark.asyncio
async def test_awaited_sync_success_cooldown_skips_underlying_cache_query(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = ActorIdentityService()
    user_id = "firebase-user-cooldown-1234567890"
    actor_identity_service._IDENTITY_SYNC_TASKS.clear()
    actor_identity_service._IDENTITY_SYNC_IN_FLIGHT.clear()
    actor_identity_service._IDENTITY_SYNC_COOLDOWN_UNTIL.clear()
    calls = 0

    async def successful_sync(_user_id: str, *, force: bool = False):
        nonlocal calls
        calls += 1
        return {"user_id": _user_id}

    monkeypatch.setattr(service, "sync_from_firebase", successful_sync)

    assert await service.sync_from_firebase_if_due(user_id) == {"user_id": user_id}
    assert await service.sync_from_firebase_if_due(user_id) is None
    assert calls == 1
    actor_identity_service._IDENTITY_SYNC_COOLDOWN_UNTIL.clear()


@pytest.mark.asyncio
@pytest.mark.parametrize("failure_mode", ["none", "exception"])
async def test_awaited_sync_failure_clears_cooldown_for_retry(
    monkeypatch: pytest.MonkeyPatch,
    failure_mode: str,
) -> None:
    service = ActorIdentityService()
    user_id = "firebase-user-awaited-retry-1234567890"
    actor_identity_service._IDENTITY_SYNC_TASKS.clear()
    actor_identity_service._IDENTITY_SYNC_IN_FLIGHT.clear()
    actor_identity_service._IDENTITY_SYNC_COOLDOWN_UNTIL.clear()
    calls = 0

    async def failed_sync(_user_id: str, *, force: bool = False):
        nonlocal calls
        calls += 1
        if failure_mode == "exception":
            raise RuntimeError("simulated sync failure")
        return None

    monkeypatch.setattr(service, "sync_from_firebase", failed_sync)

    if failure_mode == "exception":
        with pytest.raises(RuntimeError, match="simulated sync failure"):
            await service.sync_from_firebase_if_due(user_id)
    else:
        assert await service.sync_from_firebase_if_due(user_id) is None

    assert user_id not in actor_identity_service._IDENTITY_SYNC_COOLDOWN_UNTIL
    if failure_mode == "exception":
        with pytest.raises(RuntimeError, match="simulated sync failure"):
            await service.sync_from_firebase_if_due(user_id)
    else:
        assert await service.sync_from_firebase_if_due(user_id) is None
    assert calls == 2
    actor_identity_service._IDENTITY_SYNC_IN_FLIGHT.clear()
    actor_identity_service._IDENTITY_SYNC_COOLDOWN_UNTIL.clear()


@pytest.mark.asyncio
@pytest.mark.parametrize("failure_mode", ["none", "exception"])
async def test_failed_scheduled_sync_clears_cooldown_for_immediate_retry(
    monkeypatch: pytest.MonkeyPatch,
    failure_mode: str,
) -> None:
    service = ActorIdentityService()
    user_id = "firebase-user-retry-1234567890"
    actor_identity_service._IDENTITY_SYNC_TASKS.clear()
    actor_identity_service._IDENTITY_SYNC_IN_FLIGHT.clear()
    actor_identity_service._IDENTITY_SYNC_COOLDOWN_UNTIL.clear()

    async def failed_sync(_user_id: str, *, force: bool = False):
        assert _user_id == user_id
        assert force is False
        if failure_mode == "exception":
            raise RuntimeError("simulated sync failure")
        return None

    monkeypatch.setattr(service, "sync_from_firebase", failed_sync)

    assert service.schedule_sync_from_firebase(user_id) is True
    first = actor_identity_service._IDENTITY_SYNC_TASKS[user_id]
    await asyncio.gather(first, return_exceptions=True)
    await asyncio.sleep(0)

    assert user_id not in actor_identity_service._IDENTITY_SYNC_COOLDOWN_UNTIL
    assert service.schedule_sync_from_firebase(user_id) is True
    second = actor_identity_service._IDENTITY_SYNC_TASKS[user_id]
    await asyncio.gather(second, return_exceptions=True)
    await asyncio.sleep(0)
    actor_identity_service._IDENTITY_SYNC_TASKS.clear()
    actor_identity_service._IDENTITY_SYNC_IN_FLIGHT.clear()
    actor_identity_service._IDENTITY_SYNC_COOLDOWN_UNTIL.clear()


@pytest.mark.asyncio
async def test_successful_scheduled_sync_keeps_cooldown(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = ActorIdentityService()
    user_id = "firebase-user-success-1234567890"
    actor_identity_service._IDENTITY_SYNC_TASKS.clear()
    actor_identity_service._IDENTITY_SYNC_IN_FLIGHT.clear()
    actor_identity_service._IDENTITY_SYNC_COOLDOWN_UNTIL.clear()

    async def successful_sync(_user_id: str, *, force: bool = False):
        assert _user_id == user_id
        assert force is False
        return {"user_id": _user_id}

    monkeypatch.setattr(service, "sync_from_firebase", successful_sync)

    assert service.schedule_sync_from_firebase(user_id) is True
    first = actor_identity_service._IDENTITY_SYNC_TASKS[user_id]
    await first
    await asyncio.sleep(0)

    assert user_id in actor_identity_service._IDENTITY_SYNC_COOLDOWN_UNTIL
    assert service.schedule_sync_from_firebase(user_id) is False
    actor_identity_service._IDENTITY_SYNC_TASKS.clear()
    actor_identity_service._IDENTITY_SYNC_IN_FLIGHT.clear()
    actor_identity_service._IDENTITY_SYNC_COOLDOWN_UNTIL.clear()


# -- update_display_name: provider commit vs shadow sync ----------------------


async def test_update_display_name_never_reports_cached_old_name_after_provider_commit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = ActorIdentityService()
    uid = "firebase-user-123456789012"
    calls = _firebase_update_ok(monkeypatch)
    monkeypatch.setattr(
        service,
        "get_many",
        AsyncMock(
            return_value={
                uid: {"user_id": uid, "display_name": "Previous Name"},
            }
        ),
    )

    def unavailable_read(*args, **kwargs):
        raise ConnectionError("synthetic provider read unavailable")

    # Exercise the actual sync/get-user fallback, not a mock of the method
    # whose non-strict cached return caused the regression.
    monkeypatch.setattr(
        sys.modules["firebase_admin"].auth, "get_user", unavailable_read, raising=False
    )
    result = await service.update_display_name(uid, "Confirmed Name")
    assert calls == [{"uid": uid, "display_name": "Confirmed Name"}]
    assert result == {"user_id": uid, "display_name": "Confirmed Name", "shadow_sync": "pending"}


def _firebase_update_ok(monkeypatch: pytest.MonkeyPatch) -> list[dict]:
    """Stub the provider so ``update_user`` succeeds and records the call."""
    import sys
    import types

    async def admitted_mutation(owner_id, *, operation, **_):
        return actor_identity_service.account_firebase_mutations.FirebaseMutationResult(
            operation(owner_id), settled=True
        )

    monkeypatch.setattr(actor_identity_service.account_firebase_mutations, "run", admitted_mutation)
    calls: list[dict] = []

    def fake_update_user(uid, *, display_name=None, app=None, **_):
        calls.append({"uid": uid, "display_name": display_name})

    monkeypatch.setattr(
        actor_identity_service.account_firebase_mutations,
        "set_display_name",
        lambda app, uid, value: fake_update_user(uid, display_name=value, app=app),
    )
    monkeypatch.setattr(actor_identity_service, "get_firebase_auth_app", lambda: object())
    monkeypatch.setitem(
        sys.modules,
        "firebase_admin",
        types.SimpleNamespace(auth=types.SimpleNamespace(update_user=fake_update_user)),
    )
    return calls


async def test_update_display_name_reports_synced_when_shadow_write_succeeds(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = ActorIdentityService()
    uid = "firebase-user-123456789012"
    calls = _firebase_update_ok(monkeypatch)

    async def fake_sync(user_id, *, force=False, require_success=False):
        assert force and require_success
        return {"user_id": user_id, "display_name": "Ayesha S", "email": "a@example.com"}

    monkeypatch.setattr(service, "sync_from_firebase", fake_sync)

    result = await service.update_display_name(uid, "  Ayesha   S ")

    assert calls == [{"uid": uid, "display_name": "Ayesha S"}]
    assert result["display_name"] == "Ayesha S"
    assert result["email"] == "a@example.com"
    assert result["shadow_sync"] == "synced"


async def test_update_display_name_reports_pending_when_shadow_sync_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Graph observation 2: Firebase accepts the name, then the shadow write
    fails. The provider now holds the new name; raising here made every caller
    say "your name wasn't changed" about a committed write."""
    service = ActorIdentityService()
    uid = "firebase-user-123456789012"
    calls = _firebase_update_ok(monkeypatch)

    async def failing_sync(user_id, *, force=False, require_success=False):
        assert force and require_success
        raise ConnectionError("shadow db unreachable")

    monkeypatch.setattr(service, "sync_from_firebase", failing_sync)

    result = await service.update_display_name(uid, "Ayesha S")

    assert calls == [{"uid": uid, "display_name": "Ayesha S"}]
    assert result["user_id"] == uid
    assert result["display_name"] == "Ayesha S"
    assert result["shadow_sync"] == "pending"


async def test_update_display_name_reports_pending_when_fallback_upsert_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = ActorIdentityService()
    uid = "firebase-user-123456789012"
    _firebase_update_ok(monkeypatch)

    async def sync_returns_nothing(user_id, *, force=False, require_success=False):
        assert force and require_success
        return None

    async def failing_upsert(**kwargs):
        raise RuntimeError("shadow write failed")

    monkeypatch.setattr(service, "sync_from_firebase", sync_returns_nothing)
    monkeypatch.setattr(service, "upsert_identity", failing_upsert)

    result = await service.update_display_name(uid, "Ayesha S")

    assert result["display_name"] == "Ayesha S"
    assert result["shadow_sync"] == "pending"


async def test_update_display_name_provider_failure_still_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Nothing is committed when the provider itself refuses, so the error
    must keep propagating -- only the post-commit path is fail-soft."""
    import sys
    import types

    _firebase_update_ok(monkeypatch)
    service = ActorIdentityService()

    def failing_update_user(uid, *, display_name=None, app=None, **_):
        raise ConnectionError("firebase unreachable")

    monkeypatch.setattr(actor_identity_service, "get_firebase_auth_app", lambda: object())
    monkeypatch.setitem(
        sys.modules,
        "firebase_admin",
        types.SimpleNamespace(auth=types.SimpleNamespace(update_user=failing_update_user)),
    )
    monkeypatch.setattr(
        actor_identity_service.account_firebase_mutations,
        "set_display_name",
        lambda app, uid, value: failing_update_user(uid, display_name=value, app=app),
    )
    sync_called = False

    async def fake_sync(user_id, *, force=False):
        nonlocal sync_called
        sync_called = True
        return None

    monkeypatch.setattr(service, "sync_from_firebase", fake_sync)

    with pytest.raises(ConnectionError):
        await service.update_display_name("firebase-user-123456789012", "Ayesha S")
    assert sync_called is False


@pytest.mark.parametrize("matches", [True, False])
async def test_replacement_phone_finalize_uses_external_proof_and_application_owner(
    monkeypatch, matches
):
    from firebase_admin import auth as firebase_auth

    owner, identity = "acct_" + "c" * 32, "external-firebase-uid"
    monkeypatch.setattr(actor_identity_service, "get_firebase_auth_app", lambda: object())
    monkeypatch.setattr(
        actor_identity_service.AccountGenerationService,
        "firebase_identity_for_owner",
        lambda captured: identity if captured == owner else None,
    )
    reads = []

    def get_user(uid, **_):
        reads.append(uid)
        return types.SimpleNamespace(
            uid=uid if matches else "different-identity",
            phone_number="+16505550101",
            disabled=False,
        )

    monkeypatch.setattr(firebase_auth, "get_user", get_user)
    service = ActorIdentityService()
    claim = AsyncMock(
        return_value={"user_id": owner, "phone_verified": True, "phone_number": "+16505550101"}
    )
    monkeypatch.setattr(service, "claim_verified_phone", claim)
    if matches:
        assert (await service.finalize_verified_phone_from_firebase(owner, "+16505550101"))[
            "user_id"
        ] == owner
        claim.assert_awaited_once_with(
            user_id=owner, phone_number="+16505550101", source="firebase_auth"
        )
    else:
        with pytest.raises(ValueError):
            await service.finalize_verified_phone_from_firebase(owner, "+16505550101")
        claim.assert_not_awaited()
    assert reads == [identity]
