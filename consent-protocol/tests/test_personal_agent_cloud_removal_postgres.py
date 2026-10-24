"""Cloud-only removal purpose, durable completion, and account-preserving HTTP boundaries."""

import json
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import psycopg2
import pytest

from api.middleware import require_firebase_auth
from api.routes.one import personal_agent as pa
from hushh_mcp.services import azure_entra_authorizer as entra
from hushh_mcp.services.azure_teardown_inventory import AzureTeardownRefused
from hushh_mcp.services.azure_teardown_store import AzureTeardownStore
from hushh_mcp.services.personal_agent_cloud_removal import CloudRemovalStore
from tests.standby_postgres_support import Db
from tests.test_azure_resource_teardown_postgres import (
    cleanup_connection as cleanup_connection,
)
from tests.test_azure_resource_teardown_postgres import (
    cleanup_pg as cleanup_pg,
)
from tests.test_azure_resource_teardown_postgres import (
    cleanup_state as cleanup_state,
)
from tests.test_azure_resource_teardown_postgres import (
    settled_cleanup as settled_cleanup,
)
from tests.test_byoc_azure_routes import (
    _COMPLETE,
    _OTHER_SUB,
    _SUB,
    _TENANT,
    _UID,
    _client,
)
from tests.test_byoc_azure_routes import (
    enabled_owner_cloud_setup as enabled_owner_cloud_setup,
)
from tests.test_byoc_azure_routes import (
    spawned as spawned,
)
from tests.test_personal_agent_routes import _build

pytestmark = pytest.mark.usefixtures("legacy_shared_files_absent")


def _value(pg, sql, *params):
    return pg.execute(sql, params or None)[0][0]


def _row(pg, owner):
    return _value(pg, "SELECT to_jsonb(p) FROM personal_agent_registry p WHERE user_id=%s", owner)


@contextmanager
def _store(pg):
    database = Db(pg)

    async def current_row(owner):
        return _row(pg, owner)

    try:
        yield CloudRemovalStore(SimpleNamespace(_db=lambda: database, get=current_row))
    finally:
        database.engine.dispose()


def _admit_cloud_removal(pg, owner, current):
    pg.apply_file(
        Path(__file__).resolve().parents[1]
        / "db/migrations/parked/972_personal_agent_cloud_removal.sql"
    )
    pg.apply_file(
        Path(__file__).resolve().parents[1] / "db/migrations/419_cloud_removal_recovery.sql"
    )
    digest = _value(
        pg,
        "SELECT encode(sha256(convert_to((backend_metadata->'erasure'->'registrySnapshot')::text,'UTF8')),'hex') FROM personal_agent_registry WHERE user_id=%s",
        owner,
    )
    assert _value(pg, "SELECT reserve_personal_agent_cloud_removal(%s,%s)", owner, "0" * 64) is None
    attempt = _value(pg, "SELECT reserve_personal_agent_cloud_removal(%s,%s)", owner, digest)[
        "attemptId"
    ]
    plan = _value(
        pg,
        "SELECT encode(sha256(convert_to(personal_agent_cloud_removal_review(backend_metadata->'erasure')::text,'UTF8')),'hex') FROM personal_agent_registry WHERE user_id=%s",
        owner,
    )
    assert (
        _value(pg, "SELECT finalize_personal_agent_cloud_removal(%s,%s,%s)", owner, attempt, plan)
        is False
    )
    assert (
        _value(pg, "SELECT personal_agent_cloud_removal_execute_ready(%s,%s)", owner, attempt)
        is False
    )
    assert (
        _value(pg, "SELECT azure_cleanup_cloud_purpose_authorized(%s,%s)", owner, attempt) is False
    )
    group = current["azureTeardown"]["plan"]["context"]
    confirmation = (
        f"/subscriptions/{group['subscriptionId']}/resourceGroups/{group['resourceGroup']}"
    )
    assert (
        _value(
            pg,
            "SELECT approve_personal_agent_cloud_removal(%s,%s,%s,%s)",
            owner,
            attempt,
            plan,
            confirmation,
        )
        is True
    )
    assert (
        _value(pg, "SELECT personal_agent_cloud_removal_execute_ready(%s,%s)", owner, attempt)
        is True
    )
    assert (
        _value(pg, "SELECT azure_cleanup_cloud_purpose_authorized(%s,%s)", owner, attempt) is True
    )
    return attempt, plan


def _refuse_stale_or_forged_proof(pg, owner, attempt, plan):
    pg.execute(
        "UPDATE personal_agent_cloud_removals SET approved_at=now()-interval '11 minutes' WHERE user_id=%s",
        (owner,),
    )
    assert (
        _value(pg, "SELECT personal_agent_cloud_removal_execute_ready(%s,%s)", owner, attempt)
        is False
    )
    pg.execute(
        "UPDATE personal_agent_cloud_removals SET approved_at=now() WHERE user_id=%s", (owner,)
    )
    pg.execute(
        "ALTER TABLE personal_agent_cloud_removals DISABLE TRIGGER zz_personal_agent_cloud_removal_history"
    )
    assert _value(pg, "SELECT personal_agent_cloud_removal_ready()") is False
    assert (
        _value(pg, "SELECT finalize_personal_agent_cloud_removal(%s,%s,%s)", owner, attempt, plan)
        is False
    )
    pg.execute(
        "ALTER TABLE personal_agent_cloud_removals ENABLE TRIGGER zz_personal_agent_cloud_removal_history"
    )
    for bad_owner, bad_attempt, bad_plan in (
        ("other-owner", attempt, plan),
        (owner, "old-attempt", plan),
        (owner, attempt, "0" * 64),
    ):
        assert (
            _value(
                pg,
                "SELECT finalize_personal_agent_cloud_removal(%s,%s,%s)",
                bad_owner,
                bad_attempt,
                bad_plan,
            )
            is False
        )
    with pytest.raises(psycopg2.errors.InsufficientPrivilege):
        pg.execute(
            "UPDATE personal_agent_cloud_removals SET completed_at=now(),archive='{}',released_identity='{}' WHERE user_id=%s",
            (owner,),
        )


def _verify_atomic_finalization(pg, owner, attempt, plan):
    saved = _row(pg, owner)
    pg.execute(
        "CREATE FUNCTION synthetic_removal_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic removal failure'; END $$"
    )
    pg.execute(
        "CREATE TRIGGER zzzz_synthetic_removal_failure BEFORE DELETE ON personal_agent_registry FOR EACH ROW EXECUTE FUNCTION synthetic_removal_failure()"
    )
    with pytest.raises(psycopg2.errors.RaiseException, match="synthetic removal failure"):
        pg.execute("SELECT finalize_personal_agent_cloud_removal(%s,%s,%s)", (owner, attempt, plan))
    assert (
        _value(pg, "SELECT completed_at FROM personal_agent_cloud_removals WHERE user_id=%s", owner)
        is None
    )
    assert _row(pg, owner) == saved
    pg.execute("DROP TRIGGER zzzz_synthetic_removal_failure ON personal_agent_registry")
    assert (
        _value(pg, "SELECT finalize_personal_agent_cloud_removal(%s,%s,%s)", owner, attempt, plan)
        is True
    )
    after = _row(pg, owner)
    assert (
        after["hushh_id"] == saved["hushh_id"]
        and after["placement_epoch"] == saved["placement_epoch"] + 1
    )
    assert after["status"] == "unprovisioned"
    assert (
        not after["deployment_target"]
        and not after["pod_pubkey"]
        and not after["pod_signing_pubkey"]
    )
    assert _value(pg, "SELECT count(*) FROM account_deletion_tombstones") == 0
    assert _value(pg, "SELECT personal_agent_cloud_removed(%s)", owner) is True
    return after


def _refuse_replay_on_next_placement(pg, owner, attempt, plan, after):
    desired = {
        "user_id": owner,
        "hushh_id": after["hushh_id"],
        "phone_e164_hash": after["phone_e164_hash"] or "f" * 64,
        "deployment_target": "user_gcp",
        "model_credential_mode": "user_adc",
        "user_cloud_project": "replacement-project",
        "user_cloud_region": "us-central1",
    }
    pg.execute("BEGIN")
    try:
        pg.execute(
            "SELECT claim_personal_agent_provision(%s,%s,%s::jsonb,%s::jsonb)",
            (owner, "b" * 32, json.dumps(after), json.dumps(desired)),
        )
        replacement = _row(pg, owner)
        assert (
            _value(
                pg, "SELECT finalize_personal_agent_cloud_removal(%s,%s,%s)", owner, attempt, plan
            )
            is False
        )
        assert _row(pg, owner) == replacement
    finally:
        pg.execute("ROLLBACK")


def _refuse_replay_after_shared_choice(pg, owner, attempt, plan, after):
    pg.execute("BEGIN")
    try:
        pg.execute(
            "INSERT INTO vault_keys(user_id,one_hosting_choice,one_hosting_choice_at) VALUES (%s,'shared',clock_timestamp()) ON CONFLICT(user_id) DO UPDATE SET one_hosting_choice='shared',one_hosting_choice_at=clock_timestamp()",
            (owner,),
        )
        assert (
            _value(pg, "SELECT personal_agent_cloud_removal_replay_current(%s,%s)", owner, attempt)
            is False
        )
        assert (
            _value(
                pg, "SELECT finalize_personal_agent_cloud_removal(%s,%s,%s)", owner, attempt, plan
            )
            is False
        )
        assert _value(pg, "SELECT personal_agent_cloud_removed(%s)", owner) is True
        assert _row(pg, owner) == after
    finally:
        pg.execute("ROLLBACK")


def _verify_eventual_account_erasure(pg, owner):
    from hushh_mcp.services.account_service import AccountService

    assert _value(pg, "SELECT personal_agent_erasure_archived(%s,'{}'::jsonb)", owner) is False
    with pytest.raises(psycopg2.errors.InsufficientPrivilege):
        pg.execute("DELETE FROM personal_agent_cloud_removals WHERE user_id=%s", (owner,))
    pg.execute(
        "INSERT INTO account_deletion_tombstones(user_id_hash,firebase_uid,cleanup_status) VALUES ('sha256:'||encode(sha256(convert_to(%s,'UTF8')),'hex'),%s,'pending')",
        (owner, owner),
    )
    database = Db(pg)
    try:
        with database.engine.begin() as conn:
            AccountService()._delete_personal_agent_state(
                conn, params={"user_id": owner}, results={}
            )
    finally:
        database.engine.dispose()
    assert _value(pg, "SELECT count(*) FROM personal_agent_cloud_removals") == 0


@pytest.mark.parametrize("cleanup_pg", ["unreserved"], indirect=True)
def test_cloud_review_cancel_restores_only_an_undispatched_snapshot(cleanup_pg):
    pg, owner, _, _ = cleanup_pg
    root = Path(__file__).resolve().parents[1] / "db/migrations"
    pg.apply_file(root / "parked/972_personal_agent_cloud_removal.sql")
    pg.apply_file(root / "419_cloud_removal_recovery.sql")
    original = _row(pg, owner)
    snapshot_digest = _value(
        pg,
        "SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') FROM personal_agent_registry p WHERE user_id=%s",
        owner,
    )
    reservation = _value(
        pg, "SELECT reserve_personal_agent_cloud_removal(%s,%s)", owner, snapshot_digest
    )
    attempt = reservation["attemptId"]
    assert _value(pg, "SELECT cloud_removal_cancel_ready(%s,%s)", owner, attempt) is True
    columns = ",".join('"' + name.replace('"', '""') + '"' for name in original)
    with pytest.raises(psycopg2.Error):
        pg.execute(
            "SELECT set_config('hussh.erasure_restore_attempt',%s,true); "
            f"UPDATE personal_agent_registry SET ({columns})=(SELECT {columns} FROM jsonb_populate_record(NULL::personal_agent_registry,%s::jsonb)) WHERE user_id=%s",
            (attempt, json.dumps(original), owner),
        )
    assert (
        _value(pg, "SELECT cancel_personal_agent_cloud_removal(%s,%s)", owner, "wrong-attempt")
        is False
    )
    assert _value(pg, "SELECT cancel_personal_agent_cloud_removal(%s,%s)", owner, attempt) is True
    assert _row(pg, owner) == original
    assert _value(pg, "SELECT cancel_personal_agent_cloud_removal(%s,%s)", owner, attempt) is True
    assert (
        _value(pg, "SELECT begin_personal_agent_cloud_removal(%s,%s,%s)", owner, attempt, "a" * 64)
        is False
    )
    assert (
        _value(
            pg, "SELECT count(*) FROM personal_agent_cloud_removals WHERE cancelled_at IS NOT NULL"
        )
        == 1
    )
    # Re-reservation never revives the old attempt or its callback authority.
    replacement = _value(
        pg, "SELECT reserve_personal_agent_cloud_removal(%s,%s)", owner, snapshot_digest
    )
    assert replacement["attemptId"] != attempt
    assert _value(pg, "SELECT cancel_personal_agent_cloud_removal(%s,%s)", owner, attempt) is False
    assert (
        _value(pg, "SELECT azure_cleanup_cloud_purpose_authorized(%s,%s)", owner, attempt) is False
    )


@pytest.mark.parametrize("cleanup_pg", ["unreserved"], indirect=True)
def test_cloud_approval_and_cancel_serialize_under_owner_authority(cleanup_pg):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    pg, owner, _, _ = cleanup_pg
    root = Path(__file__).resolve().parents[1] / "db/migrations"
    pg.apply_file(root / "parked/972_personal_agent_cloud_removal.sql")
    pg.apply_file(root / "419_cloud_removal_recovery.sql")
    original = _row(pg, owner)
    digest = _value(
        pg,
        "SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') FROM personal_agent_registry p WHERE user_id=%s",
        owner,
    )
    reservation = _value(pg, "SELECT reserve_personal_agent_cloud_removal(%s,%s)", owner, digest)
    attempt = reservation["attemptId"]
    context = _value(pg, "SELECT azure_erasure_context(%s)", owner)
    group = f"/subscriptions/{context['subscriptionId']}/resourceGroups/{context['resourceGroup']}"
    plan = {
        "version": 1,
        "context": context,
        "termsVersion": "azure-exact-parent-retention-v2",
        "resources": {
            group: {
                "apiVersion": "2021-04-01",
                "kind": "resource",
                "expected": {},
                "coveredBy": None,
                "identity": {"id": group},
                "deletionScope": "whole_group",
            }
        },
    }
    state = {
        "plan": plan,
        "approvals": [],
        "resources": {},
        "setupHistory": _value(pg, "SELECT azure_erasure_setup_history(%s)", owner),
    }
    assert (
        _value(
            pg,
            "SELECT retain_azure_erasure_state(%s,%s,%s::jsonb,%s::jsonb)",
            owner,
            attempt,
            json.dumps(reservation),
            json.dumps(state),
        )
        is True
    )
    plan_digest = _value(
        pg,
        "SELECT encode(sha256(convert_to(personal_agent_cloud_removal_review(backend_metadata->'erasure')::text,'UTF8')),'hex') FROM personal_agent_registry WHERE user_id=%s",
        owner,
    )
    assert _value(pg, "SELECT cloud_removal_cancel_ready(%s,%s)", owner, attempt) is True
    # A historical GUC/adoption recovery may not bypass this explicit review.
    snapshot = reservation["registrySnapshot"]
    evidence = {
        "project": snapshot.get("user_cloud_project")
        or snapshot["backend_metadata"].get("project", "not-gcp"),
        "service": snapshot.get("external_agent_id") or "not-gcp",
        "url": "https://synthetic.invalid",
        "observedAt": 0,
    }
    assert (
        _value(
            pg,
            "SELECT restore_personal_agent_erasure_reservation(%s,%s,%s,%s::jsonb)",
            owner,
            attempt,
            digest,
            json.dumps(evidence),
        )
        is False
    )
    start = Barrier(2)

    def cancel():
        start.wait(timeout=5)
        return _value(pg, "SELECT cancel_personal_agent_cloud_removal(%s,%s)", owner, attempt)

    def approve():
        start.wait(timeout=5)
        return _value(
            pg,
            "SELECT approve_personal_agent_cloud_removal(%s,%s,%s,%s)",
            owner,
            attempt,
            plan_digest,
            group,
        )

    with ThreadPoolExecutor(max_workers=2) as pool:
        cancelled, approved = pool.submit(cancel), pool.submit(approve)
        outcomes = cancelled.result(timeout=10), approved.result(timeout=10)
    assert outcomes in {(True, False), (False, True)}
    if outcomes[0]:
        assert _row(pg, owner) == original
        assert (
            _value(
                pg,
                "SELECT begin_personal_agent_cloud_removal(%s,%s,%s)",
                owner,
                attempt,
                plan_digest,
            )
            is False
        )
    else:
        assert (
            _value(
                pg,
                "SELECT begin_personal_agent_cloud_removal(%s,%s,%s)",
                owner,
                attempt,
                plan_digest,
            )
            is True
        )
        assert (
            _value(pg, "SELECT cancel_personal_agent_cloud_removal(%s,%s)", owner, attempt) is False
        )


@pytest.mark.parametrize("settled_cleanup", [True], indirect=True)
async def test_cloud_only_finalization_keeps_identity_and_refuses_stale_or_forged_proof(
    settled_cleanup,
):
    pg, owner, current, _connection = settled_cleanup
    attempt, plan = _admit_cloud_removal(pg, owner, current)
    _refuse_stale_or_forged_proof(pg, owner, attempt, plan)
    assert _value(pg, "SELECT cancel_personal_agent_cloud_removal(%s,%s)", owner, attempt) is False
    assert (
        _value(pg, "SELECT begin_personal_agent_cloud_removal(%s,%s,%s)", owner, attempt, "0" * 64)
        is False
    )
    assert (
        _value(
            pg,
            "SELECT execution_started_at FROM personal_agent_cloud_removals WHERE user_id=%s",
            owner,
        )
        is None
    )
    with _store(pg) as store:
        await store.require_completion_contract()
        await store.require_execution(owner, attempt, plan)
        assert _value(pg, "SELECT cloud_removal_execution_admitted(%s,%s)", owner, attempt) is True
        assert (
            _value(pg, "SELECT cancel_personal_agent_cloud_removal(%s,%s)", owner, attempt) is False
        )
        assert (await store.view(owner))["canFinalize"] is True
    after = _verify_atomic_finalization(pg, owner, attempt, plan)
    with _store(pg) as store:
        recovered = await store.view(owner)
        assert recovered["operationId"] == attempt and recovered["canFinalize"] is True
        assert (await store.finalize(owner, attempt, plan))["accountRetained"] is True
    assert _row(pg, owner) == after
    _refuse_replay_on_next_placement(pg, owner, attempt, plan, after)
    _refuse_replay_after_shared_choice(pg, owner, attempt, plan, after)
    _verify_eventual_account_erasure(pg, owner)


def test_cloud_removal_uses_only_vault_owner_and_does_not_call_account_deletion(monkeypatch):

    from api.routes import account_cloud_cleanup

    client, calls = _build(monkeypatch)
    removal = AsyncMock(return_value={"status": "cloud_removed", "accountRetained": True})
    monkeypatch.setattr(account_cloud_cleanup, "remove_owner_cloud", removal)
    response = client.post(
        "/api/one/personal-agent/removal",
        json={"action": "finalize", "operationId": "attempt-1", "planDigest": "a" * 64},
    )
    assert response.status_code == 200 and response.json()["accountRetained"] is True
    assert removal.await_args.args[0] == "uid1"
    assert "deprovision" not in calls
    assert (
        client.post(
            "/api/one/personal-agent/removal",
            json={"action": "inspect", "user_id": "another-owner"},
        ).status_code
        == 422
    )
    from hushh_mcp.services.azure_teardown_inventory import AzureTeardownRefused
    from hushh_mcp.services.personal_agent_cloud_removal import CloudRemovalStore

    client.app.dependency_overrides[require_firebase_auth] = lambda: "uid1"
    ready = AsyncMock()
    monkeypatch.setattr(CloudRemovalStore, "require_completion_contract", ready)
    from types import SimpleNamespace

    monkeypatch.setattr(
        pa,
        "PersonalAgentRegistryRepo",
        lambda: SimpleNamespace(get=AsyncMock(return_value={"deployment_target": "user_azure"})),
    )
    assert client.get("/api/one/personal-agent/removal").json() == {
        "available": True,
        "provider": "azure",
    }
    ready.side_effect = AzureTeardownRefused("CLOUD_REMOVAL_NOT_AVAILABLE")
    assert client.get("/api/one/personal-agent/removal").json() == {
        "available": False,
        "provider": None,
    }
    client.app.dependency_overrides.clear()
    assert (
        client.post("/api/one/personal-agent/removal", json={"action": "status"}).status_code == 401
    )


def test_legacy_deprovision_refuses_bypassing_cloud_review(monkeypatch):
    client, calls = _build(monkeypatch)
    monkeypatch.setattr(
        pa,
        "PersonalAgentRegistryRepo",
        lambda: SimpleNamespace(
            get=AsyncMock(return_value={"deployment_target": "user_gcp"}),
        ),
    )
    response = client.post("/api/one/personal-agent/deprovision")
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "CLOUD_REMOVAL_REVIEW_REQUIRED"
    assert "deprovision" not in calls


def _bind_callback_store(monkeypatch, authorization, cloud_only, calls):
    context = {
        "ownerId": _UID,
        "attemptId": "attempt-1",
        "tenantId": _TENANT,
        "subscriptionId": _SUB,
    }

    async def ready(self):
        return None

    async def matching(self, owner, *, attempt, digest):
        calls.append("binding")
        assert owner == _UID and attempt == "attempt-1" and digest == "a" * 64
        if authorization == "stale":
            raise AzureTeardownRefused("AZURE_CLEANUP_AUTHORIZATION_CHANGED")
        return {
            "purpose": "execute" if authorization == "cloud_unapproved" else authorization,
            "context": context,
        }

    async def metadata(self, sql, _params):
        if "azure_cleanup_cloud_purpose_authorized(:" in sql:
            return authorization != "cloud_unapproved"
        if "jsonb_build_object('attempt',c.attempt_id" in sql:
            return {"attempt": "attempt-1", "approved": "a" * 64}
        if "begin_personal_agent_cloud_removal" in sql:
            calls.append("execution_claim")
            return authorization == "execute"
        if "to_regprocedure" in sql:
            return True
        return cloud_only

    monkeypatch.setattr(AzureTeardownStore, "require_completion_contract", ready)
    monkeypatch.setattr(AzureTeardownStore, "match_authorization", matching)
    monkeypatch.setattr(AzureTeardownStore, "_value", metadata)


@pytest.mark.parametrize(
    ("authorization", "cloud_only"),
    [
        ("inspect", False),
        ("execute", False),
        ("stale", False),
        ("wrong_tenant", False),
        ("inspect", True),
        ("execute", True),
        ("cloud_unapproved", True),
    ],
)
def test_cleanup_callback_binds_current_erasure_before_redeeming_and_never_approves(
    spawned, monkeypatch, authorization, cloud_only
):
    from hushh_mcp.services import azure_owner_cleanup
    from hushh_mcp.services.azure_teardown_store import AzureTeardownStore

    calls = []
    _bind_callback_store(monkeypatch, authorization, cloud_only, calls)

    def redeem(*_args, **_kwargs):
        assert calls == ["binding"], "do not burn a code before current SQL authority matches"
        calls.append("redeem")
        return entra.DelegatedToken(
            "synthetic-memory-only",
            _OTHER_SUB if authorization == "wrong_tenant" else _TENANT,
            3600,
        )

    async def complete(*_args):
        calls.append("queued")

    async def inspected(*_args):
        calls.append("inspected")
        return {}

    async def marked(*_args):
        calls.append("marked")

    monkeypatch.setattr(entra, "redeem", redeem)
    monkeypatch.setattr(azure_owner_cleanup, "run_cleanup", complete)
    monkeypatch.setattr(azure_owner_cleanup, "complete", inspected)
    monkeypatch.setattr(AzureTeardownStore, "mark_authorization", marked)
    state = entra.make_state(
        _UID,
        kind="teardown",
        subscription_id=_SUB,
        authority=_TENANT,
        erasure_attempt="attempt-1",
        erasure_digest="a" * 64,
    )
    response = _client().post(_COMPLETE, json={"state": state, "code": "synthetic-code"})
    assert response.status_code == (
        409 if authorization in {"stale", "wrong_tenant", "cloud_unapproved"} else 200
    )
    if authorization in {"stale", "cloud_unapproved"}:
        assert calls == ["binding"]
    elif authorization == "wrong_tenant":
        assert calls == ["binding", "redeem"]
    else:
        assert response.json() == {
            "status": "cleanup_review_required"
            if authorization == "inspect"
            else "cleanup_pending",
            "operationId": "attempt-1",
            **({"cleanupPurpose": "remove_cloud"} if cloud_only else {}),
        }
        assert calls == (
            ["binding", "redeem", "inspected"]
            if authorization == "inspect"
            else [
                "binding",
                "redeem",
                *(["execution_claim"] if cloud_only else []),
                "marked",
                "queued",
            ]
        )
    assert spawned == [], "cleanup cannot fall through into setup or upgrade"
