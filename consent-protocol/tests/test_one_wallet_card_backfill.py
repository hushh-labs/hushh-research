"""Existing-account provisioning must respect removal and account erasure."""

import hashlib
import sqlite3
from types import SimpleNamespace

import pytest

from scripts.backfill_one_wallet_cards import run_backfill


@pytest.fixture
def db():
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    connection.create_function(
        "digest", 2, lambda value, _: hashlib.sha256(value.encode()).digest()
    )
    connection.create_function("encode", 2, lambda value, _: value.hex())
    connection.executescript("""
        CREATE TABLE actor_profiles (user_id TEXT PRIMARY KEY);
        CREATE TABLE one_wallet_cards (user_id TEXT PRIMARY KEY, status TEXT);
        CREATE TABLE account_deletion_tombstones (user_id_hash TEXT PRIMARY KEY);
        INSERT INTO actor_profiles VALUES ('active'), ('deleted'), ('missing-a'),
          ('missing-b'), ('paused'), ('revoked');
        INSERT INTO one_wallet_cards VALUES ('active', 'active'), ('paused', 'paused'),
          ('revoked', 'revoked');
    """)
    connection.execute(
        "INSERT INTO account_deletion_tombstones VALUES (?)",
        ("sha256:" + hashlib.sha256(b"deleted").hexdigest(),),
    )
    yield SimpleNamespace(
        execute_raw=lambda sql, params: SimpleNamespace(
            data=[dict(row) for row in connection.execute(sql, params).fetchall()]
        ),
    )
    connection.close()


def test_backfill_selects_only_missing_live_accounts_and_dry_run_never_writes(db):
    seen = []
    service = SimpleNamespace(ensure_card=lambda **kwargs: seen.append(kwargs["user_id"]))
    result = run_backfill(db=db, service=service, apply=False, batch_size=1, max_users=10)
    assert result["processed"] == 2
    assert seen == []
    result = run_backfill(db=db, service=service, apply=True, batch_size=1, max_users=10)
    assert result["processed"] == 2
    assert result["limitReached"] is False
    assert seen == ["missing-a", "missing-b"]


@pytest.mark.parametrize("deletion_fence", [True, False])
def test_backfill_skips_only_the_authoritative_deletion_race(db, deletion_fence):
    seen = []
    driver_error = RuntimeError("private database detail")
    driver_error.diag = SimpleNamespace(
        constraint_name="account_deletion_tombstone_guard" if deletion_fence else "other_constraint"
    )
    sqlalchemy_error = RuntimeError("wrapped database detail")
    sqlalchemy_error.orig = driver_error

    def ensure_card(*, user_id):
        seen.append(user_id)
        if user_id == "missing-a":
            raise RuntimeError("database failure") from sqlalchemy_error

    service = SimpleNamespace(ensure_card=ensure_card)
    if deletion_fence:
        result = run_backfill(db=db, service=service, apply=True, batch_size=1, max_users=10)
        assert result["skippedDeleted"] == 1
        assert seen == ["missing-a", "missing-b"]
    else:
        with pytest.raises(RuntimeError, match="database failure"):
            run_backfill(db=db, service=service, apply=True, batch_size=1, max_users=10)
        assert seen == ["missing-a"]
