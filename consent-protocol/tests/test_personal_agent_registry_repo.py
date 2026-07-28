"""Hermetic tests for the personal-agent registry adapter.

A tiny in-memory fake stands in for the Supabase client and implements just the
fluent operations the repo uses (table/upsert/select/eq/limit/insert/delete/
execute), with real semantics, so a full provision -> read -> teardown round-trip
is exercised without a database.
"""

from __future__ import annotations

from types import SimpleNamespace

from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo

_UID = "firebase_uid_test_123"


class _Query:
    def __init__(self, db, table):
        self._db = db
        self._table = table
        self._mode = None
        self._payload = None
        self._conflict = "user_id"
        self._eq = None
        self._limit = None

    def upsert(self, data, on_conflict="user_id"):
        self._mode, self._payload, self._conflict = "upsert", data, on_conflict
        return self

    def insert(self, data):
        self._mode, self._payload = "insert", data
        return self

    def select(self, _cols="*"):
        self._mode = "select"
        return self

    def delete(self):
        self._mode = "delete"
        return self

    def eq(self, col, val):
        self._eq = (col, val)
        return self

    def limit(self, n):
        self._limit = n
        return self

    def execute(self):
        rows = self._db.tables.setdefault(self._table, [])
        if self._mode == "upsert":
            key = self._conflict
            rows[:] = [r for r in rows if r.get(key) != self._payload.get(key)]
            rows.append(dict(self._payload))
            return SimpleNamespace(data=[dict(self._payload)])
        if self._mode == "insert":
            rows.append(dict(self._payload))
            return SimpleNamespace(data=[dict(self._payload)])
        if self._mode == "select":
            out = [r for r in rows if not self._eq or r.get(self._eq[0]) == self._eq[1]]
            if self._limit is not None:
                out = out[: self._limit]
            return SimpleNamespace(data=out)
        if self._mode == "delete":
            if self._eq:
                rows[:] = [r for r in rows if r.get(self._eq[0]) != self._eq[1]]
            return SimpleNamespace(data=[])
        return SimpleNamespace(data=[])


class FakeDB:
    def __init__(self):
        self.tables: dict[str, list[dict]] = {}

    def table(self, name):
        return _Query(self, name)


def _repo_and_db():
    db = FakeDB()
    return PersonalAgentRegistryRepo(client=db), db


async def _upsert(repo, *, status="provisioned"):
    await repo.upsert(
        user_id=_UID,
        hushh_id="ha1_abc",
        phone_e164_hash="deadbeef",
        pod_pubkey="cG9kcHVi",
        pod_key_id="pod-1",
        pod_key_wrapping_alg="X25519-AES256-GCM",  # gitleaks:allow -- algorithm name, not key material
        status=status,
    )


async def test_upsert_then_get():
    repo, db = _repo_and_db()
    await _upsert(repo)
    row = await repo.get(_UID)
    assert row is not None
    assert row["user_id"] == _UID
    assert row["hushh_id"] == "ha1_abc"
    assert row["pod_pubkey"] == "cG9kcHVi"
    assert row["status"] == "provisioned"
    assert len(db.tables["personal_agent_registry"]) == 1


async def test_get_missing_returns_none():
    repo, _ = _repo_and_db()
    assert await repo.get("nobody") is None


async def test_upsert_is_idempotent_by_user():
    repo, db = _repo_and_db()
    await _upsert(repo, status="provisioned")
    await _upsert(repo, status="active")
    rows = db.tables["personal_agent_registry"]
    assert len(rows) == 1
    assert rows[0]["status"] == "active"


async def test_tombstone_records_retained_row():
    repo, db = _repo_and_db()
    await repo.tombstone(hushh_id="ha1_abc", external_agent_id=None, status="deprovision_requested")
    tombstones = db.tables["personal_agent_deletion_tombstones"]
    assert len(tombstones) == 1
    assert tombstones[0]["hushh_id"] == "ha1_abc"
    assert tombstones[0]["status"] == "deprovision_requested"
    assert "external_agent_id" not in tombstones[0]  # None dropped


async def test_tombstone_exists_lookup():
    repo, _ = _repo_and_db()
    assert await repo.tombstone_exists("ha1_abc") is False
    await repo.tombstone(hushh_id="ha1_abc", external_agent_id=None, status="deprovision_requested")
    assert await repo.tombstone_exists("ha1_abc") is True
    assert await repo.tombstone_exists("ha1_other") is False
    assert await repo.tombstone_exists("") is False


async def test_tombstone_skips_empty_hushh_id():
    repo, db = _repo_and_db()
    # A missing-row / retried teardown carries no identity; nothing is recorded.
    await repo.tombstone(hushh_id=None, external_agent_id=None, status="deprovision_requested")
    await repo.tombstone(hushh_id="   ", external_agent_id="a", status="deprovision_requested")
    assert db.tables.get("personal_agent_deletion_tombstones", []) == []


async def test_delete_removes_row():
    repo, _ = _repo_and_db()
    await _upsert(repo)
    assert await repo.get(_UID) is not None
    await repo.delete(_UID)
    assert await repo.get(_UID) is None


async def test_full_lifecycle_roundtrip():
    repo, db = _repo_and_db()
    await _upsert(repo)
    await repo.tombstone(hushh_id="ha1_abc", external_agent_id=None, status="deprovision_requested")
    await repo.delete(_UID)
    assert await repo.get(_UID) is None
    # the tombstone is retained even after the registry row is gone
    assert len(db.tables["personal_agent_deletion_tombstones"]) == 1
