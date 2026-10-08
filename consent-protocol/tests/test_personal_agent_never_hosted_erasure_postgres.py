"""A never-hosted private agent can be erased (954), and nothing else can use that door.

Live, 2026-10-06 (dev registry): an owner finished Connect Google Cloud to
`recorded`, deleted their account before any agent was built, and was reserved for
erasure with a `pending` snapshot, no provisionAttempt and one `registry_row`
lifecycle event. The generic chain refused it at its first step ("erasure host
snapshot unavailable") on every sweep, and 935's completion could never be true.

These run the FULL dev chain (918..953, then 954) in a disposable PostgreSQL and
drive the real deprovision path, the real registry repo and the real bootstrap
release; only the cloud call itself is a fake. A negative control without 954
reproduces the live dead end.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from tests.pkm_conformance.postgres_harness import TempPostgres, find_pg_bin
from tests.test_byoc_setup_job_azure_admission_postgres import _Client, _server

ROOT = Path(__file__).resolve().parents[1]
PARKED = ROOT / "db/migrations/parked"
MIGRATION = PARKED / "954_personal_agent_never_hosted_erasure.sql"
ROLLBACK = ROOT / "db/migrations/rollback/954_personal_agent_never_hosted_erasure.rollback.sql"
OWNER = "synthetic-never-hosted"
HUSHH_ID = "ha1_abcdefghijklmnopqrstuvwxyz234567"
PROJECT = "hussh-one-abc123"
BOOTSTRAP = f"one-bootstrap@{PROJECT}.iam.gserviceaccount.com"
HUB = "hub-runtime@hub-project.iam.gserviceaccount.com"
MEMBER = f"serviceAccount:{HUB}"
_needs_pg = pytest.mark.skipif(find_pg_bin() is None, reason="local PostgreSQL unavailable")


# -- static shape -------------------------------------------------------------------


def _function(path: Path, signature: str) -> str:
    text = path.read_text()
    start = text.index(f"CREATE OR REPLACE FUNCTION public.{signature}")
    return text[start : text.index("$$;", start)]


def test_954_is_manifested_after_953_with_a_rollback():
    ordered = json.loads((ROOT / "db/dev_migration_manifest.json").read_text())[
        "ordered_migrations"
    ]
    assert ordered.index(MIGRATION.name) == (
        ordered.index("953_personal_agent_key_pull_during_attach.sql") + 1
    )
    release = json.loads((ROOT / "db/release_migration_manifest.json").read_text())
    assert MIGRATION.name not in json.dumps(release)
    assert ROLLBACK.is_file()


@pytest.mark.parametrize(
    ("source", "signature", "changed"),
    [
        ("949_personal_agent_owner_access_erasure.sql", "guard_personal_agent_erasure_registry()", 0),
        ("935_personal_agent_erasure_finalization.sql", "personal_agent_erasure_complete(", 4),
        ("941_personal_agent_files_erasure.sql", "personal_agent_erasure_archive(", 1),
        ("934_personal_agent_erasure_resource_coverage.sql", "expected_erasure_bootstrap_release(", 0),
    ],
)  # fmt: skip
def test_replaced_bodies_are_verbatim_except_where_marked(source, signature, changed):
    """Rewriting a guard by hand once dropped transitions (940). Only marked lines move."""
    previous = _function(PARKED / source, signature)
    composed = _function(MIGRATION, signature)
    assert _function(ROLLBACK, signature) == previous
    removed = [line for line in previous.splitlines() if line not in composed.splitlines()]
    assert len(removed) == changed
    assert "954" in composed


# -- routing, without a database ------------------------------------------------------


def _snapshot(**changes: object) -> dict:
    row = {
        "user_id": OWNER, "hushh_id": HUSHH_ID, "status": "pending", "backend": None,
        "external_agent_id": None, "backend_metadata": None, "deployment_target": "user_gcp",
        "user_cloud_project": PROJECT, "user_cloud_bootstrap_sa": BOOTSTRAP,
    }  # fmt: skip
    return {**row, **changes}


@pytest.mark.parametrize(
    ("changes", "expected"),
    [
        ({}, True),
        ({"backend_metadata": {}}, True),
        ({"backend_metadata": {"provisionAttempt": {"phase": "intent"}}}, False),
        ({"backend_metadata": {"serviceUid": "uid-1"}}, False),
        ({"backend": "user_gcp"}, False),
        ({"external_agent_id": "one-pod-x"}, False),
        ({"status": "provisioned"}, False),
        ({"status": "provisioning"}, False),
        ({"deployment_target": "gcp"}, False),
        ({"deployment_target": None}, False),
    ],
)
def test_only_a_pre_host_owner_cloud_snapshot_routes_to_never_hosted(changes, expected):
    from hushh_mcp.services.personal_agent_never_hosted_erasure import never_hosted_snapshot

    assert never_hosted_snapshot(_snapshot(**changes)) is expected


def test_cleanup_backend_resolves_from_target_only_when_nothing_was_built():
    from hushh_mcp.services.personal_agent_never_hosted_erasure import cleanup_backend_matches

    backend = SimpleNamespace(backend_id="user_gcp")
    assert cleanup_backend_matches(_snapshot(), backend, True) is True
    assert cleanup_backend_matches(_snapshot(), SimpleNamespace(backend_id=None), True) is False
    # Only the grant release may resolve from the target; destructive helpers never do.
    assert cleanup_backend_matches(_snapshot(), backend) is False
    # A recorded backend always decides; a hosted snapshot with none still mismatches.
    assert cleanup_backend_matches(_snapshot(backend="user_gcp"), backend) is True
    assert cleanup_backend_matches(_snapshot(backend="other"), backend) is False
    hosted = _snapshot(status="provisioned", backend_metadata={"serviceUid": "uid-1"})
    assert cleanup_backend_matches(hosted, backend, True) is False
    assert cleanup_backend_matches(_snapshot(deployment_target="gcp"), backend, True) is False


# -- against PostgreSQL -----------------------------------------------------------------


def _repo(client: _Client):
    """The real registry repo; ``get`` reads through execute_raw like the rest."""
    from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo

    class Repo(PersonalAgentRegistryRepo):
        async def get(self, user_id: str):
            rows = client.execute_raw(
                "SELECT to_jsonb(r) AS row FROM personal_agent_registry r WHERE user_id=:o",
                {"o": user_id},
            ).data
            return rows[0]["row"] if rows else None

    return Repo(client=client)


class _Backend:
    """Releases the bootstrap grant only; it has no way to delete anything else."""

    backend_id = "user_gcp"

    def __init__(self) -> None:
        self.released: list[str] = []

    def bootstrap_release_member(self) -> str:
        return MEMBER

    async def erase_bootstrap_grant(self, *, evidence, state, retain_receipt) -> None:
        self.released.append(evidence["bootstrapIdentity"]["uniqueId"])
        for stage, status in (("admission", "admitted"), ("deletion", "observed_absent")):
            if stage not in state:
                assert await asyncio.to_thread(
                    retain_receipt, stage, {**evidence, "status": status}
                )


@pytest.fixture
def pg(monkeypatch):
    server = _server(monkeypatch, last=953)
    try:
        server.apply_file(MIGRATION)
        yield server
    finally:
        server.stop()


def _seed_owner(
    pg: TempPostgres, *, target: str = "user_gcp", metadata: dict | None = None
) -> None:
    pg.execute(
        "INSERT INTO personal_agent_registry(user_id,hushh_id,phone_e164_hash,status,"
        "deployment_target,model_credential_mode,user_cloud_project,user_cloud_region,"
        "user_cloud_bootstrap_sa,user_cloud_authorized_at,backend_metadata) VALUES "
        "(%s,%s,'sha256:phone','pending',%s,'user_adc',%s,'us-central1',%s,now(),%s::jsonb)",
        (OWNER, HUSHH_ID, target, PROJECT, BOOTSTRAP, json.dumps(metadata) if metadata else None),
    )
    history = {
        "job-1": {
            "intent": {
                "jobId": "job-1", "ownerId": OWNER, "project": PROJECT,
                "callerEmail": HUB, "bootstrapEmail": BOOTSTRAP,
            },
            "receipt": {
                "bootstrapIdentity": {
                    "name": f"projects/{PROJECT}/serviceAccounts/{BOOTSTRAP}",
                    "email": BOOTSTRAP, "uniqueId": "100147202419652465065", "projectId": PROJECT,
                },
                "bindingObservation": {
                    "role": "roles/iam.serviceAccountTokenCreator",
                    "step": "authorize_bootstrap_impersonation", "member": MEMBER,
                    "afterEtag": "BwZbiTlcVP0=", "beforeEtag": "ACAB", "disposition": "added",
                    "policyResource": "https://iam.googleapis.com/v1/projects/"
                    f"{PROJECT}/serviceAccounts/{BOOTSTRAP}:getIamPolicy",
                },
            },
        }
    }  # fmt: skip
    # Fixture state the setup guards would only reach through a full setup run.
    pg.execute("ALTER TABLE byoc_setup_jobs DISABLE TRIGGER USER")
    pg.execute(
        "INSERT INTO byoc_setup_jobs(user_id,job_id,project_id,status,stage,authorization_attempts)"
        " VALUES (%s,'job-1',%s,'recorded','recorded',%s::jsonb)",
        (OWNER, PROJECT, json.dumps(history)),
    )
    pg.execute("ALTER TABLE byoc_setup_jobs ENABLE TRIGGER USER")
    _event(pg, 1, "stage", "registry_row")


def _event(pg: TempPostgres, seq: int, event: str, stage: str, step: str | None = None) -> None:
    pg.execute(
        "INSERT INTO pod_lifecycle_events(user_id,seq,hushh_id,event,stage,registry_status,"
        "substrate_step) VALUES (%s,%s,%s,%s,%s,'pending',%s)",
        (OWNER, seq, HUSHH_ID, event, stage, step),
    )


def _erasure(pg: TempPostgres) -> dict:
    [[row]] = pg.execute(
        "SELECT backend_metadata->'erasure' FROM personal_agent_registry WHERE user_id=%s",
        (OWNER,),
    )
    return row


def _reserve(pg: TempPostgres) -> dict:
    return pg.execute("SELECT reserve_personal_agent_erasure(%s,%s)", (OWNER, "a" * 32))[0][0]


def _retain(pg: TempPostgres) -> bool:
    return pg.execute(
        "SELECT retain_erasure_never_hosted(%s,%s,%s::jsonb)",
        (OWNER, "a" * 32, json.dumps(_erasure(pg))),
    )[0][0]


def _complete(pg: TempPostgres) -> bool:
    return pg.execute("SELECT personal_agent_erasure_complete(%s)", (OWNER,))[0][0]


def _service(pg: TempPostgres, monkeypatch) -> tuple:
    from hushh_mcp.services import account_service
    from hushh_mcp.services.personal_agent_provisioning_service import (
        PersonalAgentProvisioningService,
    )

    client = _Client(pg)

    def guard(self, user_id: str) -> None:
        [row] = client.execute_raw(
            "SELECT public.personal_agent_erasure_complete(:o) AS done", {"o": user_id}
        ).data
        if row["done"] is not True:
            raise account_service.PersonalAgentDeprovisioningRequiredError("required")

    monkeypatch.setattr(
        account_service.AccountService, "assert_personal_agent_external_resources_absent", guard
    )
    monkeypatch.setenv("PERSONAL_AGENT_SUBSTRATE_TEARDOWN_ENABLED", "true")
    backend = _Backend()
    service = PersonalAgentProvisioningService(registry=_repo(client), grant=object())
    monkeypatch.setattr(service, "_backend_for", lambda spec: backend)
    return service, backend


def _forged(pg: TempPostgres) -> None:
    """Append a well-formed never-hosted receipt directly; the guard must decide."""
    receipt = {
        "version": 1, "ownerId": OWNER, "attemptId": "a" * 32, "hushhId": HUSHH_ID,
        "status": "never_hosted", "project": PROJECT,
        "remainsWithPerson": [f"projects/{PROJECT}", f"projects/{PROJECT}/serviceAccounts/{BOOTSTRAP}"],
        "deletedByHussh": [], "husshReleases": "bootstrapGrantRelease",
    }  # fmt: skip
    fence = {"ownerId": OWNER, "attemptId": "a" * 32, "project": PROJECT, "status": "reserved"}
    pg.execute(
        "UPDATE personal_agent_registry SET backend_metadata=jsonb_set(jsonb_set(backend_metadata,"
        "'{erasure,neverHosted}',%s::jsonb,true),'{erasure,grantRelease}',%s::jsonb,true)"
        " WHERE user_id=%s",
        (json.dumps(receipt), json.dumps(fence), OWNER),
    )


@_needs_pg
def test_a_never_hosted_owner_is_erased_end_to_end_and_hussh_deletes_nothing(pg, monkeypatch):
    psycopg2 = pytest.importorskip("psycopg2")
    _seed_owner(pg)
    service, backend = _service(pg, monkeypatch)

    outcome = asyncio.run(service.deprovision(user_id=OWNER))

    assert outcome == {"status": "unprovisioned", "noOp": False, "rowDeleteDeferred": True}
    assert backend.released == ["100147202419652465065"]  # the hub's own grant, only
    erasure = _erasure(pg)
    assert erasure["neverHosted"]["remainsWithPerson"] == [
        f"projects/{PROJECT}",
        f"projects/{PROJECT}/serviceAccounts/{BOOTSTRAP}",
    ]
    assert erasure["neverHosted"]["deletedByHussh"] == []
    assert erasure["grantRelease"]["project"] == PROJECT
    # The project stays fenced: no new setup can start on it while the grant is released.
    with pytest.raises(psycopg2.Error, match="project grant release reserved"):
        pg.execute("SELECT assert_project_grant_admission(%s)", (PROJECT,))
    # A retry is idempotent and reaches the same verdict.
    assert asyncio.run(service.deprovision(user_id=OWNER))["status"] == "unprovisioned"
    assert backend.released == ["100147202419652465065"]

    pg.execute(
        "INSERT INTO account_deletion_tombstones(user_id_hash,firebase_uid,cleanup_status) "
        "VALUES ('sha256:'||encode(sha256(convert_to(%s,'UTF8')),'hex'),%s,'pending')",
        (OWNER, OWNER),
    )
    assert pg.execute("SELECT finalize_personal_agent_erasure(%s)", (OWNER,))[0][0] is True
    for table in ("personal_agent_registry", "byoc_setup_jobs", "pod_lifecycle_events"):
        assert pg.execute(f"SELECT count(*) FROM {table} WHERE user_id=%s", (OWNER,))[0][0] == 0
    [[archive]] = pg.execute(
        "SELECT metadata FROM personal_agent_deletion_tombstones WHERE status='erasure_completed'"
    )
    assert archive["receipts"]["neverHosted"] == erasure["neverHosted"]


@_needs_pg
def test_a_snapshot_with_a_provision_attempt_cannot_use_the_branch(pg):
    psycopg2 = pytest.importorskip("psycopg2")
    _seed_owner(pg, metadata={"provisionAttempt": {"attemptId": "b" * 32, "phase": "intent"}})
    _reserve(pg)

    assert pg.execute(
        "SELECT expected_erasure_never_hosted(%s,%s::jsonb)", (OWNER, json.dumps(_erasure(pg)))
    ) == [(None,)]
    assert _retain(pg) is False
    with pytest.raises(psycopg2.errors.InsufficientPrivilege):
        _forged(pg)
    assert "neverHosted" not in _erasure(pg)
    assert _complete(pg) is False


@_needs_pg
@pytest.mark.parametrize(
    ("event", "stage", "step"),
    [("stage", "host_requested", None), ("substrate_step", "substrate", "create_bucket")],
)
def test_a_stray_host_or_substrate_event_blocks_it_even_after_retention(
    pg, monkeypatch, event, stage, step
):
    _seed_owner(pg)
    _event(pg, 2, event, stage, step)
    _reserve(pg)
    assert _retain(pg) is False

    # Evidence is re-derived at completion, not trusted from retention: erase a
    # clean twin fully, then let a late event appear.
    pg.execute("DELETE FROM pod_lifecycle_events WHERE user_id=%s AND seq=2", (OWNER,))
    service, _ = _service(pg, monkeypatch)
    asyncio.run(service.deprovision(user_id=OWNER))
    assert _complete(pg) is True
    _event(pg, 2, event, stage, step)
    assert _complete(pg) is False


@_needs_pg
def test_the_managed_tier_never_uses_it(pg, monkeypatch):
    from hushh_mcp.services.personal_agent_never_hosted_erasure import (
        erase_reserved_never_hosted,
    )

    psycopg2 = pytest.importorskip("psycopg2")
    _seed_owner(pg, target="gcp")
    reservation = _reserve(pg)

    assert _retain(pg) is False
    with pytest.raises(psycopg2.errors.InsufficientPrivilege):
        _forged(pg)
    service, backend = _service(pg, monkeypatch)
    assert (
        asyncio.run(erase_reserved_never_hosted(service, user_id=OWNER, reservation=reservation))
        is False
    )
    assert backend.released == []
    assert _complete(pg) is False


@_needs_pg
def test_without_954_a_never_hosted_reservation_can_never_complete(monkeypatch):
    """Negative control: the live dead end, on the chain as it stood before 954."""
    server = _server(monkeypatch, last=953)
    try:
        _seed_owner(server)
        _reserve(server)
        assert server.execute(
            "SELECT to_regprocedure('public.retain_erasure_never_hosted(text,text,jsonb)')"
        ) == [(None,)]
        assert (
            server.execute(
                "SELECT expected_erasure_bootstrap_release(%s,%s::jsonb,%s)",
                (OWNER, json.dumps(_erasure(server)), MEMBER),
            )[0][0]
            is None
        )
        assert _complete(server) is False
    finally:
        server.stop()


@_needs_pg
def test_rollback_leaves_a_retained_receipt_fail_closed_and_its_project_fenced(pg, monkeypatch):
    psycopg2 = pytest.importorskip("psycopg2")
    _seed_owner(pg)
    service, _ = _service(pg, monkeypatch)
    asyncio.run(service.deprovision(user_id=OWNER))
    assert _complete(pg) is True

    pg.apply_file(ROLLBACK)

    assert pg.execute(
        "SELECT to_regprocedure('public.retain_erasure_never_hosted(text,text,jsonb)')"
    ) == [(None,)]
    assert _complete(pg) is False
    with pytest.raises(psycopg2.Error, match="project grant release reserved"):
        pg.execute("SELECT assert_project_grant_admission(%s)", (PROJECT,))
    pg.apply_file(MIGRATION)
    assert _complete(pg) is True
