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

    def update(self, data):
        self._mode, self._payload = "update", data
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
        if self._mode == "update":
            # Real UPDATE semantics: touch only matching rows, and report exactly the
            # rows touched -- so "no such row" is distinguishable from "row updated",
            # which is what set_user_cloud's return value depends on.
            touched = []
            for row in rows:
                if self._eq and row.get(self._eq[0]) != self._eq[1]:
                    continue
                row.update(dict(self._payload))
                touched.append(dict(row))
            return SimpleNamespace(data=touched)
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


# -- the person's own cloud (migration 906) ------------------------------------


async def test_set_user_cloud_records_coordinates_without_a_status_transition():
    """Naming a cloud must not move the pod's lifecycle state.

    A person names their project while onboarding, long before a pod exists. If this
    writer moved `status`, naming a cloud would look like provisioning progress on every
    surface that reads it.
    """
    repo, db = _repo_and_db()
    await _upsert(repo, status="pending")

    wrote = await repo.set_user_cloud(
        user_id=_UID,
        project="their-own-project",
        region="us-central1",
        bootstrap_sa="one-bootstrap@their-own-project.iam.gserviceaccount.com",
        authorized=True,
        deployment_target="user_gcp",
        model_credential_mode="user_adc",
    )

    assert wrote is True
    row = await repo.get(_UID)
    assert row["user_cloud_project"] == "their-own-project"
    assert row["user_cloud_region"] == "us-central1"
    assert row["deployment_target"] == "user_gcp"
    assert row["model_credential_mode"] == "user_adc"
    assert row["user_cloud_authorized_at"]
    assert row["status"] == "pending"
    assert row["hushh_id"] == "ha1_abc"


async def test_a_named_but_unauthorized_cloud_is_recorded_without_the_proof():
    """ "They typed a name" and "hushh can act there" are different facts.

    Provisioning refuses the second state. If this writer stamped `authorized_at`
    whenever a project was recorded, that refusal would never fire and a person who never
    ran the grant would be silently provisioned onto hushh's own cloud instead.

    Broken on purpose: stamp the timestamp unconditionally and this fails.
    """
    repo, _ = _repo_and_db()
    await _upsert(repo, status="pending")

    await repo.set_user_cloud(
        user_id=_UID,
        project="named-not-granted",
        deployment_target="user_gcp",
        model_credential_mode="user_adc",
    )

    row = await repo.get(_UID)
    assert row["user_cloud_project"] == "named-not-granted"
    assert row.get("user_cloud_authorized_at") is None


async def test_set_user_cloud_never_creates_a_row():
    """Row creation belongs to register_pending, which alone has the HusshID.

    A row invented here would carry no hushh_id and no phone hash, and every reader
    downstream assumes both.

    Broken on purpose: switch the writer to upsert and this returns True with a
    half-built row in the table.
    """
    repo, db = _repo_and_db()

    wrote = await repo.set_user_cloud(
        user_id="nobody-has-this-id",
        project="some-project",
        deployment_target="user_gcp",
        model_credential_mode="user_adc",
    )

    assert wrote is False
    assert db.tables.get("personal_agent_registry", []) == []


async def test_a_cloud_without_a_project_is_refused():
    """The empty-project row is exactly the single-tenant bug's shape.

    It is the row that would fall back to the process-wide HUSSH_USER_GCP_PROJECT and put
    this person's pod inside somebody else's project. Migration 906 refuses it in the
    schema; this refuses it before the query is built.
    """
    repo, _ = _repo_and_db()
    await _upsert(repo, status="pending")

    for empty in ("", "   ", None):
        try:
            await repo.set_user_cloud(
                user_id=_UID,
                project=empty,  # type: ignore[arg-type]
                deployment_target="user_gcp",
                model_credential_mode="user_adc",
            )
        except ValueError:
            continue
        raise AssertionError(f"a cloud with project={empty!r} should have been refused")


async def test_upsert_carries_the_deployment_axes_when_given_them():
    """The axes must survive onto the row the provision actually used.

    Without this the registry records what happened to a pod but not which backend was
    asked to build it, and teardown has nothing to route on.
    """
    repo, _ = _repo_and_db()
    await repo.upsert(
        user_id=_UID,
        hushh_id="ha1_abc",
        phone_e164_hash="deadbeef",
        status="provisioned",
        deployment_target="user_gcp",
        model_credential_mode="user_adc",
    )

    row = await repo.get(_UID)
    assert row["deployment_target"] == "user_gcp"
    assert row["model_credential_mode"] == "user_adc"


async def test_upsert_leaves_the_axes_null_when_not_given_them():
    """NULL honestly means "the deployment default", which is every pre-906 row."""
    repo, _ = _repo_and_db()
    await _upsert(repo)

    row = await repo.get(_UID)
    assert "deployment_target" not in row
    assert "model_credential_mode" not in row
