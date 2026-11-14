# SPDX-License-Identifier: Apache-2.0
"""Real competing sessions and non-replaying transport for the Dev-only importer."""

from __future__ import annotations

import copy
import json
import sys
from pathlib import Path
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, text

from tests.pkm_conformance import postgres_harness

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from scripts.ops import firebase_identity_activation as activation
from scripts.ops import firebase_identity_migration as migration


@pytest.fixture(scope="module")
def postgres():
    from unittest.mock import patch

    server = postgres_harness.TempPostgres()
    try:
        with patch.object(postgres_harness, "MIGRATIONS", []):
            server.start()
        yield server
    finally:
        server.stop()


@pytest.fixture
def database(postgres):
    name = "auth_import_" + uuid4().hex
    postgres.execute(f"CREATE DATABASE {name}")
    engine = create_engine(
        f"postgresql+psycopg2://hushh@/{name}?host={postgres.dir}&port={postgres.port}",
        connect_args={"options": "-c statement_timeout=5000 -c lock_timeout=500"},
    )
    with engine.begin() as conn:
        conn.exec_driver_sql("""
            CREATE TABLE actor_profiles(user_id text PRIMARY KEY);
            CREATE TABLE vault_keys(user_id text PRIMARY KEY);
            CREATE TABLE account_generations(owner_hash text PRIMARY KEY,
                identity_uid text,owner_id text,generation integer,retired_at timestamptz);
            CREATE TABLE account_firebase_mutations(operation_id text PRIMARY KEY,state text);
            CREATE TABLE account_deletion_tombstones(user_id_hash text,cleanup_status text,
                erasure_phase text,provider_cleanup_receipt jsonb,firebase_erasure_checkpoint jsonb,
                cleanup_intent_kind text,firebase_uid text);
            CREATE TABLE shared_files_storage(state text);
            INSERT INTO actor_profiles VALUES('owner-a');
            INSERT INTO vault_keys VALUES('owner-a');
        """)
    try:
        yield engine
    finally:
        engine.dispose()
        postgres.execute(f"DROP DATABASE {name}")


USER = {
    "localId": "owner-a",
    "email": "owner@example.invalid",
    "emailVerified": True,
    "createdAt": "1700000000000",
    "providerUserInfo": [{"providerId": "google.com", "rawId": "source-google-subject"}],
    "customAttributes": '{"hushhWelcomeMailAt":1700000000}',
}


class Response:
    status_code = 200

    def __init__(self, value):
        self.value = value

    def json(self):
        return self.value


class Provider:
    def __init__(self, *, lose_response=False):
        self.source = [copy.deepcopy(USER)]
        self.target = []
        self.posts = []
        self.lose_response = lose_response

    def get(self, url, **_):
        if url.endswith("/config"):
            return Response(
                {
                    "signIn": {
                        "hashConfig": {
                            "algorithm": "SCRYPT",
                            "signerKey": "c3ludGhldGlj",
                            "saltSeparator": "",
                            "rounds": 8,
                            "memoryCost": 14,
                        }
                    }
                }
            )
        return Response(
            {"users": copy.deepcopy(self.target if f"/{migration.TARGET}/" in url else self.source)}
        )

    def post(self, url, *, json, **_):
        assert f"/{migration.TARGET}/" in url
        if url.endswith("/accounts:update"):
            assert set(json) == {"localId", "disableUser", "customAttributes"}
            self.posts.append(copy.deepcopy(json))
            target = next(u for u in self.target if u["localId"] == json["localId"])
            target.update(disabled=json["disableUser"], customAttributes=json["customAttributes"])
            if self.lose_response:
                raise TimeoutError("synthetic lost activation acknowledgement")
            return Response({"localId": target["localId"]})
        assert json["allowOverwrite"] is False and json["sanityCheck"] is True
        assert not self.target
        self.posts.append(copy.deepcopy(json))
        self.target = copy.deepcopy(json["users"])
        if self.lose_response:
            raise TimeoutError("synthetic lost acknowledgement")
        return Response({})


def snapshot(engine, provider):
    with engine.connect() as conn:
        return migration.owner_snapshot(conn, provider.source)[0]


def acquire(conn):
    assert conn.execute(
        text("SELECT pg_try_advisory_lock(hashtextextended(:key,0))"),
        {"key": migration.RELEASE_KEY},
    ).scalar_one()
    conn.commit()


def test_real_fence_drains_and_survives_session_loss_and_old_remover(database):
    operation = {"operation": str(uuid4()), "manifestSha256": "a" * 64}
    with database.connect() as owner:
        acquire(owner)
        with owner.begin():
            migration.install_fences(owner, operation)
        with database.connect() as competitor:
            assert not competitor.execute(
                text("SELECT pg_try_advisory_lock(hashtextextended(:key,0))"),
                {"key": migration.RELEASE_KEY},
            ).scalar_one()
        owner.invalidate()  # End the actual session, not merely its pooled wrapper.
    # The owner session has exited. Durable triggers still reject new writers.
    for statement in (
        "DELETE FROM actor_profiles WHERE false",
        "INSERT INTO account_generations VALUES('other','other','other',0,NULL)",
        "INSERT INTO account_firebase_mutations VALUES('other','dispatched')",
    ):
        with pytest.raises(Exception, match="temporarily unavailable"):
            with database.begin() as writer:
                writer.exec_driver_sql(statement)
    with database.connect() as operator:
        acquire(operator)
        # An old deploy cannot remove the root fences while import owns them.
        with pytest.raises(Exception, match="depend"):
            with operator.begin():
                operator.exec_driver_sql(migration.fence_sql("remove_release_fence.sql"))
        assert len(migration.trigger_comments(operator)) == 2
        operator.rollback()
        foreign = {**operation, "operation": str(uuid4())}
        with pytest.raises(migration.Refused, match="FOREIGN_IMPORT_FENCE"):
            migration.install_fences(operator, foreign)
        operator.rollback()
        with operator.begin():
            migration.remove_fences(operator, operation)
        operator.invalidate()
    with database.begin() as writer:
        writer.exec_driver_sql("INSERT INTO account_firebase_mutations VALUES('late','dispatched')")


@pytest.mark.parametrize(
    "table,statement",
    [
        ("mutation", "INSERT INTO account_firebase_mutations VALUES('pending','uncertain')"),
        (
            "phone",
            "INSERT INTO account_deletion_tombstones VALUES('phone','running','erased',NULL,NULL)",
        ),
        (
            "native",
            """INSERT INTO account_deletion_tombstones VALUES
        ('native','retry_pending','provider_cleanup',NULL,'{"state":"dispatched"}')""",
        ),
    ],
)
def test_installer_refuses_unsettled_native_work(database, table, statement):
    with database.begin() as conn:
        conn.exec_driver_sql(statement)
    with database.connect() as conn:
        acquire(conn)
        with pytest.raises(migration.Refused, match="UNSETTLED"):
            with conn.begin():
                migration.install_fences(
                    conn, {"operation": str(uuid4()), "manifestSha256": "b" * 64}
                )
        assert not migration.trigger_comments(conn)


def test_lost_ack_observes_once_and_recovers_original_uid(database, tmp_path):
    provider = Provider(lose_response=True)
    manifest = snapshot(database, provider)
    receipt = tmp_path / "receipt.json"
    with database.connect() as conn:
        with pytest.raises(TimeoutError):
            migration.stage(conn, provider, manifest, receipt, resume=False)
    state = json.loads(receipt.read_text())
    assert state["requestDispatched"] is True and receipt.stat().st_mode & 0o077 == 0
    assert "owner@example.invalid" not in receipt.read_text()
    assert "signerKey" not in receipt.read_text()
    with database.connect() as conn:
        result = migration.stage(conn, provider, manifest, receipt, resume=True)
        assert result["fencesRemoved"] and result["phase"] == "staged_disabled_verified"
        assert not migration.trigger_comments(conn)
    assert len(provider.posts) == 1
    assert provider.target[0]["localId"] == USER["localId"]
    assert provider.target[0]["disabled"] is True
    assert provider.target[0]["providerUserInfo"] == USER["providerUserInfo"]
    with database.connect() as conn:
        migration.stage(conn, provider, manifest, receipt, resume=True)
    assert len(provider.posts) == 1


def test_unknown_absence_and_forged_target_keep_fences_without_replay(database, tmp_path):
    provider = Provider(lose_response=True)
    manifest = snapshot(database, provider)
    receipt = tmp_path / "receipt.json"
    with database.connect() as conn:
        with pytest.raises(TimeoutError):
            migration.stage(conn, provider, manifest, receipt, resume=False)
    imported = copy.deepcopy(provider.target)
    provider.target = []
    with database.connect() as conn:
        with pytest.raises(migration.Refused, match="IMPORT_INCOMPLETE"):
            migration.stage(conn, provider, manifest, receipt, resume=True)
        assert len(migration.trigger_comments(conn)) == 2
    provider.target = imported
    provider.target[0]["customAttributes"] = USER["customAttributes"]
    with database.connect() as conn:
        with pytest.raises(migration.Refused, match="TARGET_RECORD_CHANGED"):
            migration.stage(conn, provider, manifest, receipt, resume=True)
    assert len(provider.posts) == 1


def test_ownership_retirement_claims_and_foreign_target_refuse(database, tmp_path):
    provider = Provider()
    manifest = snapshot(database, provider)
    provider.target = [{"localId": "foreign", "disabled": True}]
    with database.connect() as conn:
        with pytest.raises(migration.Refused, match="TARGET_NOT_EMPTY"):
            migration.stage(conn, provider, manifest, tmp_path / "r.json", resume=False)
    assert provider.posts == []
    with database.begin() as conn:
        conn.execute(
            text("INSERT INTO account_deletion_tombstones(user_id_hash) VALUES(:hash)"),
            {"hash": migration.identity_hash("owner-a")},
        )
    with pytest.raises(migration.Refused, match="COHORT_SIZE_INVALID"):
        snapshot(database, provider)
    with pytest.raises(migration.Refused, match="CLAIMS_NEED_REVIEW"):
        migration.record({**USER, "customAttributes": '{"admin":true}'})


@pytest.mark.parametrize("tamper", ["dispatch_boolean", "request_hash"])
def test_receipt_dispatch_cannot_be_rewound(database, tmp_path, tamper):
    provider = Provider(lose_response=True)
    manifest = snapshot(database, provider)
    receipt = tmp_path / "receipt.json"
    with database.connect() as conn:
        with pytest.raises(TimeoutError):
            migration.stage(conn, provider, manifest, receipt, resume=False)
    provider.target = []
    state = json.loads(receipt.read_text())
    if tamper == "dispatch_boolean":
        state["requestDispatched"] = False
    else:
        state["requestSha256"] = "not-a-reviewed-digest'"
    migration.save_receipt(receipt, state)
    with database.connect() as conn:
        with pytest.raises(migration.Refused, match="INVALID"):
            migration.stage(conn, provider, manifest, receipt, resume=True)
        assert len(migration.trigger_comments(conn)) == 2
    assert len(provider.posts) == 1


@pytest.mark.parametrize("tamper", ["import_trigger", "base_trigger", "function"])
def test_comments_cannot_certify_modified_fence_structure(database, tamper):
    operation = {"operation": str(uuid4()), "manifestSha256": "a" * 64}
    with database.connect() as conn:
        acquire(conn)
        with conn.begin():
            migration.install_fences(conn, operation)
        with conn.begin():
            if tamper == "function":
                conn.exec_driver_sql("""CREATE OR REPLACE FUNCTION public.block_account_deletion_during_release()
                    RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public
                    AS $$BEGIN RETURN NULL; END;$$""")
            elif tamper == "base_trigger":
                conn.exec_driver_sql("""DROP TRIGGER trg_block_account_deletion_during_release ON actor_profiles;
                    CREATE TRIGGER trg_block_account_deletion_during_release BEFORE UPDATE ON actor_profiles
                    FOR EACH STATEMENT EXECUTE FUNCTION public.block_account_deletion_during_release()""")
            else:
                conn.exec_driver_sql("""DROP TRIGGER trg_block_firebase_import_mutations ON account_firebase_mutations;
                    CREATE TRIGGER trg_block_firebase_import_mutations BEFORE UPDATE ON account_firebase_mutations
                    FOR EACH STATEMENT EXECUTE FUNCTION public.block_account_deletion_during_release()""")
                conn.exec_driver_sql(
                    "COMMENT ON TRIGGER trg_block_firebase_import_mutations "
                    "ON account_firebase_mutations IS '" + migration.canonical(operation) + "'"
                )
        with pytest.raises(migration.Refused, match="FENCE_(STRUCTURE|FUNCTION)_CHANGED"):
            migration.verify_fences(conn, operation)


def test_receipt_written_before_native_dispatch_checkpoint_is_observation_only(
    database, tmp_path, monkeypatch
):
    provider = Provider()
    manifest = snapshot(database, provider)
    receipt = tmp_path / "receipt.json"
    save = migration.save_receipt

    def interrupted(path, value):
        save(path, value)
        if value.get("phase") == "dispatched_or_uncertain":
            raise InterruptedError("synthetic process exit after fsync")

    with monkeypatch.context() as scoped:
        scoped.setattr(migration, "save_receipt", interrupted)
        with database.connect() as conn:
            with pytest.raises(InterruptedError):
                migration.stage(conn, provider, manifest, receipt, resume=False)
    assert not provider.posts
    with database.connect() as conn:
        with pytest.raises(migration.Refused, match="IMPORT_INCOMPLETE"):
            migration.stage(conn, provider, manifest, receipt, resume=True)
        comments = migration.trigger_comments(conn)
        assert len(comments) == 2
        assert all("requestSha256" in value for value in comments.values())
    assert not provider.posts


def test_fence_removal_commit_before_receipt_is_recovered_read_only(
    database, tmp_path, monkeypatch
):
    provider = Provider()
    manifest = snapshot(database, provider)
    receipt = tmp_path / "receipt.json"
    save = migration.save_receipt

    def interrupted(path, value):
        if value.get("fencesRemoved"):
            raise InterruptedError("synthetic process exit after native commit")
        save(path, value)

    with monkeypatch.context() as scoped:
        scoped.setattr(migration, "save_receipt", interrupted)
        with database.connect() as conn:
            with pytest.raises(InterruptedError):
                migration.stage(conn, provider, manifest, receipt, resume=False)
    state = json.loads(receipt.read_text())
    assert state["phase"] == "staged_disabled_verified" and not state.get("fencesRemoved")
    with database.connect() as conn:
        assert migration.fences_absent(conn)
        conn.rollback()
        result = migration.stage(conn, provider, manifest, receipt, resume=True)
        assert result["fencesRemoved"] is True
    assert len(provider.posts) == 1


def test_completed_local_flag_cannot_hide_installed_fences(database, tmp_path):
    provider = Provider(lose_response=True)
    manifest = snapshot(database, provider)
    receipt = tmp_path / "receipt.json"
    with database.connect() as conn:
        with pytest.raises(TimeoutError):
            migration.stage(conn, provider, manifest, receipt, resume=False)
    state = json.loads(receipt.read_text())
    state.update(phase="staged_disabled_verified", fencesRemoved=True)
    migration.save_receipt(receipt, state)
    with database.connect() as conn:
        with pytest.raises(migration.Refused, match="FENCE_REMOVAL_UNCONFIRMED"):
            migration.stage(conn, provider, manifest, receipt, resume=True)
    assert len(provider.posts) == 1


def test_native_password_phone_exports_use_import_contract_and_websafe_hash_key():
    user = {
        **USER,
        "passwordHash": "aGFzaA==",
        "salt": "c2FsdA==",
        "phoneNumber": "+16505550100",
        "providerUserInfo": [
            {"providerId": "password", "rawId": USER["email"]},
            {"providerId": "phone", "rawId": "+16505550100"},
            {
                "providerId": "google.com",
                "rawId": "subject",
                "federatedId": "derived-compatibility-value",
            },
        ],
    }
    projected = migration.record(user)
    assert projected["providerUserInfo"] == [{"providerId": "google.com", "rawId": "subject"}]
    assert projected["passwordHash"] == user["passwordHash"]
    assert projected["phoneNumber"] == user["phoneNumber"]
    params = migration.hash_parameters(
        {
            "algorithm": "SCRYPT",
            "signerKey": "+/8=",
            "saltSeparator": "Bw==",
            "rounds": 8,
            "memoryCost": 14,
        }
    )
    assert params["signerKey"] == "-_8=" and params["hashAlgorithm"] == "SCRYPT"


def test_import_can_strengthen_but_never_lose_or_lower_source_revocation():
    wanted = migration.record({**USER, "validSince": "100"})
    staged = migration.staged_record(wanted, "operation")
    assert migration.matches_staged({**staged, "validSince": "101"}, wanted, "operation")
    assert not migration.matches_staged({**staged, "validSince": "99"}, wanted, "operation")
    del staged["validSince"]
    assert not migration.matches_staged(staged, wanted, "operation")


@pytest.mark.parametrize(
    "extra",
    [
        {"passwordHash": "foreign", "salt": "foreign"},
        {"phoneNumber": "+16505550100"},
        {"mfaInfo": [{"mfaEnrollmentId": "foreign"}]},
    ],
)
def test_added_authentication_credentials_refuse_staging_and_activation(extra):
    wanted = migration.record(USER)
    staged = migration.staged_record(wanted, "operation")
    assert not migration.matches_staged({**staged, **extra}, wanted, "operation")
    target = {
        "stagedSha256": migration.sha(
            migration.record({**staged, "customAttributes": wanted["customAttributes"]})
        ),
        "postimageSha256": migration.sha(wanted),
        "validSince": None,
    }
    assert activation.observed_state({**wanted, **extra}, wanted, target, "operation") == "foreign"


def test_owner_snapshot_batches_on_the_original_database_session(database):
    from unittest.mock import patch

    from sqlalchemy import event

    from hushh_mcp.services import account_generation_service as generations

    users = [dict(USER, localId=f"legacy-{i}") for i in range(64)]
    with database.begin() as conn:
        conn.execute(text("DELETE FROM actor_profiles; DELETE FROM vault_keys"))
        conn.execute(
            text("INSERT INTO actor_profiles(user_id) VALUES(:uid)"),
            [{"uid": user["localId"]} for user in users],
        )
    queries = []

    def observed(conn, cursor, statement, parameters, context, executemany):
        queries.append(statement)

    event.listen(database, "before_cursor_execute", observed)
    try:
        with (
            database.connect() as conn,
            patch.object(
                generations, "get_db_connection", side_effect=AssertionError("foreign SQL session")
            ),
        ):
            manifest, selected = migration.owner_snapshot(conn, users)
            assert len(manifest["owners"]) == len(selected) == 64
            assert len(queries) <= 8
            queries.clear()
            conn.execute(
                text("UPDATE actor_profiles SET user_id=:owner WHERE user_id='legacy-0'"),
                {"owner": "acct_" + "a" * 32},
            )
            with pytest.raises(migration.Refused, match="OWNER_MAPPING_REFUSED"):
                migration.owner_snapshot(conn, users)
    finally:
        event.remove(database, "before_cursor_execute", observed)


def test_uat_preflight_preserves_large_cohort_and_occupied_target_without_writes(database):
    from scripts.ops import firebase_identity_preflight as preflight

    users = [
        dict(
            USER,
            localId=f"uat-{i}",
            email=f"owner-{i}@example.invalid",
            providerUserInfo=[{"providerId": "google.com", "rawId": f"subject-{i}"}],
        )
        for i in range(1030)
    ]
    for user in users[:2]:
        user.pop("email")
        user.update(providerUserInfo=[], customAttributes="{}")
    target = [{**user, "createdAt": "1800000000000"} for user in users[:2]]
    target_before = copy.deepcopy(target)
    with database.begin() as conn:
        conn.exec_driver_sql("DELETE FROM actor_profiles; DELETE FROM vault_keys")
        conn.execute(
            text("INSERT INTO actor_profiles(user_id) VALUES(:uid)"),
            [{"uid": f"uat-{i}"} for i in range(1076)],
        )
        conn.execute(
            text("INSERT INTO account_deletion_tombstones(user_id_hash) VALUES(:hash)"),
            {"hash": migration.identity_hash("uat-1075")},
        )
        conn.exec_driver_sql(
            "ALTER TABLE account_deletion_tombstones DROP COLUMN firebase_erasure_checkpoint"
        )
        conn.exec_driver_sql(
            "CREATE TABLE schema_migrations(migration_id text,filename text,checksum_sha256 text,status text)"
        )
    with database.connect() as conn:
        conn.exec_driver_sql("SET TRANSACTION READ ONLY")
        report = preflight.inventory(conn, users, target)
        assert report["ownerRootCount"] == 1076 and report["retiredOwnerCount"] == 1
        assert report["eligibleOwnerCount"] == 1075 and report["selectedCount"] == 1030
        assert len(report["sourceAbsentOwnerHashes"]) == 45
        assert [len(batch) for batch in report["proposedAbsentBatches"]] == [1000, 28]
        assert report["targetCount"] == 2 and len(report["collisions"]) == 2
        assert all(
            row["fields"] == ["uid"] and not row["adoptionAuthorized"]
            for row in report["collisions"]
        )
        assert not report["targetAdoptionAuthorized"] and not report["batchDispatchAuthorized"]
        assert report["databaseSchema"]["uncertainErasures"] is None
        assert report["databaseSchema"]["migrationLedger"] == []
        assert "FIREBASE_ERASURE_CHECKPOINT_UNAVAILABLE" in report["blockers"]
        assert "DURABLE_MULTI_REQUEST_CHECKPOINTS_REQUIRED" in report["blockers"]
        assert target == target_before
        assert "@example.invalid" not in json.dumps(report)
        changed = copy.deepcopy(target)
        changed[0]["createdAt"] = "1900000000000"
        fresh = preflight.inventory(conn, users, changed)
        assert fresh["targetFingerprint"] != report["targetFingerprint"]
        assert fresh["sourceFingerprint"] == report["sourceFingerprint"]
        with pytest.raises(migration.Refused, match="COHORT_SIZE_INVALID"):
            migration.owner_snapshot(conn, users)


@pytest.mark.parametrize(
    "action",
    ["stage", "observe", "activate", "observe-activation", "continue-stage", "continue-activation"],
)
def test_uat_mutation_refuses_without_reviewed_apply_before_credentials(
    monkeypatch, tmp_path, action
):
    import google.auth

    monkeypatch.setattr(
        google.auth,
        "default",
        lambda **kwargs: pytest.fail("credentials acquired before explicit apply"),
    )
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "firebase_identity_migration.py",
            action,
            "--environment",
            "uat",
            "--database-port",
            "63394",
            "--manifest",
            str(tmp_path / "manifest.json"),
        ],
    )
    with pytest.raises(migration.Refused, match="EXPLICIT_APPLY_REQUIRED"):
        migration.main()
    assert not list(tmp_path.iterdir())


def test_uat_preflight_foreign_project_refuses_before_secrets_or_sql():
    from scripts.ops import firebase_identity_preflight as preflight

    class ForeignProject:
        def get(self, url, **kwargs):
            assert url == "https://firebase.googleapis.com/v1beta1/projects/hushh-pda-uat"
            return Response({"projectNumber": "1006304528804"})

    with pytest.raises(migration.Refused, match="UAT_PROJECT_CHANGED"):
        with preflight.uat_database(ForeignProject(), 63394):
            pytest.fail("Foreign project reached SQL admission")


def test_dev_manifest_v1_does_not_acquire_preflight_fields(database):
    assert snapshot(database, Provider()) == {
        "schema": "hussh.dev-auth-import.v1",
        "sourceProject": "hushh-pda",
        "targetProject": "hushh-pda-dev",
        "unresolvedOwnerHashes": [],
        "owners": [
            {
                "ownerHash": migration.identity_hash("owner-a"),
                "identityHash": migration.identity_hash("owner-a"),
                "generation": 0,
                "sourceRecordSha256": migration.sha(migration.record(USER)),
            }
        ],
    }


@pytest.mark.parametrize("credential", ["email", "phone", "provider_subject"])
def test_uat_preflight_cross_uid_credential_collision_never_adopts(database, credential):
    from scripts.ops import firebase_identity_preflight as preflight

    user = copy.deepcopy(USER)
    target = {"localId": "foreign-owner", "createdAt": "1800000000000"}
    if credential == "email":
        target["email"] = user["email"].upper()
    elif credential == "phone":
        user["phoneNumber"] = target["phoneNumber"] = "+16505550100"
    else:
        target["providerUserInfo"] = copy.deepcopy(user["providerUserInfo"])
    before = copy.deepcopy(target)
    with database.connect() as conn:
        conn.exec_driver_sql("SET TRANSACTION READ ONLY")
        report = preflight.inventory(conn, [user], [target])
    assert report["proposedAbsentBatches"] == []
    assert report["collisions"] == [
        {
            "sourceIdentityHash": migration.identity_hash("owner-a"),
            "targetIdentityHash": migration.identity_hash("foreign-owner"),
            "fields": [credential],
            "adoptionAuthorized": False,
        }
    ]
    assert not report["targetAdoptionAuthorized"] and target == before


@pytest.mark.parametrize("tamper", ["cluster", "principal", "writable"])
def test_uat_sql_attestation_refuses_after_native_admission_and_disposes(monkeypatch, tamper):
    import base64
    from contextlib import contextmanager

    import sqlalchemy

    from scripts.ops import firebase_identity_preflight as preflight

    class NativeUat:
        def get(self, url, **kwargs):
            if url.endswith("/projects/hushh-pda-uat"):
                return Response({"projectNumber": "745506018753"})
            if url.endswith("/services/consent-protocol"):
                return Response(
                    {"status": {"traffic": [{"percent": 100, "revisionName": "uat-serving"}]}}
                )
            if url.endswith("/revisions/uat-serving"):
                return Response(
                    {
                        "metadata": {"labels": {"deploy-sha": "a" * 40}},
                        "spec": {
                            "containers": [
                                {
                                    "env": [
                                        {"name": "ENVIRONMENT", "value": "uat"},
                                        {"name": "HUSHH_DEPLOY_SHA", "value": "a" * 40},
                                        *[
                                            {
                                                "name": name,
                                                "valueFrom": {
                                                    "secretKeyRef": {"name": name, "key": "1"}
                                                },
                                            }
                                            for name in [
                                                "BACKEND_RUNTIME_CONFIG_JSON",
                                                "DB_USER",
                                                "DB_PASSWORD",
                                            ]
                                        ],
                                    ]
                                }
                            ]
                        },
                    }
                )
            name = url.split("/secrets/")[1].split("/")[0]
            value = {
                "BACKEND_RUNTIME_CONFIG_JSON": json.dumps(
                    {"cloudsql_instance_connection_name": preflight.INSTANCE, "db_name": "postgres"}
                ),
                "DB_USER": "hushh_uat_app",
                "DB_PASSWORD": "synthetic-test-only",
            }[name]
            return Response({"payload": {"data": base64.b64encode(value.encode()).decode()}})

    class Observed:
        def one(self):
            result = ["postgres", "hushh_uat_app", "hushh_uat_app", "on", preflight.CLUSTER]
            result[{"cluster": 4, "principal": 1, "writable": 3}[tamper]] = {
                "cluster": "b" * 64,
                "principal": "foreign-user",
                "writable": "off",
            }[tamper]
            return tuple(result)

    class Engine:
        disposed = False

        @contextmanager
        def connect(self):
            yield self

        def execute(self, statement):
            assert "pg_control_system" in str(statement)
            return Observed()

        def dispose(self):
            self.disposed = True

    engine = Engine()

    def create(url, **kwargs):
        assert url.host == "127.0.0.1" and url.database == "postgres"
        assert "default_transaction_read_only=on" in kwargs["connect_args"]["options"]
        assert kwargs["isolation_level"] == "REPEATABLE READ"
        return engine

    monkeypatch.setattr(sqlalchemy, "create_engine", create)
    with pytest.raises(migration.Refused, match="UAT_DATABASE_ATTESTATION_FAILED"):
        with preflight.uat_database(NativeUat(), 63394):
            pytest.fail("Foreign or writable SQL session reached inventory")
    assert engine.disposed


def test_uat_preflight_unsupported_tenant_changes_fingerprint_and_raw_password_refuses():
    from scripts.ops import firebase_identity_preflight as preflight

    first = preflight.fingerprint({**USER, "tenantId": "tenant-a"})
    changed = preflight.fingerprint({**USER, "tenantId": "tenant-b"})
    assert first["refusal"] == changed["refusal"] == "UNSUPPORTED_USER"
    assert first["sha256"] != changed["sha256"]
    assert "tenant-a" not in json.dumps(first)
    with pytest.raises(migration.Refused, match="PLAINTEXT_CREDENTIAL_REFUSED"):
        preflight.fingerprint({**USER, "rawPassword": "synthetic-test-only"})


class UatProvider(Provider):
    def __init__(self, count=3, lose_batch=None):
        super().__init__()
        self.source = [
            {"localId": f"owner-{i}", "createdAt": "1700000000000"} for i in range(count)
        ]
        self.target = [
            {**u, "createdAt": "1700000000001", "validSince": "100"} for u in self.source[:2]
        ]
        self.original_retained = copy.deepcopy(self.target)
        self.lose_batch = lose_batch
        self.batch_count = 0
        self.lookup_count = 0

    def get(self, url, **kwargs):
        if f"/{migration.UAT_TARGET}/" in url:
            return Response({"users": copy.deepcopy(self.target)})
        return super().get(url, **kwargs)

    def post(self, url, *, json, **kwargs):
        assert f"/{migration.UAT_TARGET}/" in url
        if url.endswith("accounts:lookup"):
            self.lookup_count += 1
            return Response(
                {
                    "users": [
                        copy.deepcopy(u) for u in self.target if u["localId"] in json["localId"]
                    ]
                }
            )
        self.posts.append(copy.deepcopy(json))
        if url.endswith("accounts:batchCreate"):
            assert json["allowOverwrite"] is False and 0 < len(json["users"]) <= 1000
            assert not {u["localId"] for u in self.target} & {u["localId"] for u in json["users"]}
            self.target.extend(copy.deepcopy(json["users"]))
            self.batch_count += 1
            if self.batch_count == self.lose_batch:
                raise TimeoutError("synthetic lost batch acknowledgement")
        else:
            assert url.endswith("accounts:update")
            target = next(u for u in self.target if u["localId"] == json["localId"])
            target.update(disabled=json["disableUser"], customAttributes=json["customAttributes"])
        return Response({})


def uat_manifest(engine, provider):
    from scripts.ops.firebase_identity_migration_policy import retained_preimages

    with engine.begin() as conn:
        conn.exec_driver_sql("DELETE FROM actor_profiles; DELETE FROM vault_keys")
        conn.execute(
            text("INSERT INTO actor_profiles VALUES(:uid)"),
            [{"uid": u["localId"]} for u in provider.source],
        )
    with engine.connect() as conn:
        _, selected = migration.owner_snapshot(
            conn, provider.source, target_project=migration.UAT_TARGET
        )
        return migration.owner_snapshot(
            conn,
            provider.source,
            target_project=migration.UAT_TARGET,
            retained=retained_preimages(selected, provider.target),
        )[0]


@pytest.mark.parametrize("lost", [None, 1, 2])
def test_uat_two_batches_preserve_targets_and_never_replay_lost_ack(database, tmp_path, lost):
    provider = UatProvider(count=1003, lose_batch=lost)
    manifest = uat_manifest(database, provider)
    assert list(map(len, manifest["batches"])) == [1000, 1]
    path = tmp_path / "stage.json"
    with database.connect() as conn:
        if lost:
            with pytest.raises(TimeoutError):
                migration.stage(conn, provider, manifest, path, resume=False)
        else:
            assert migration.stage(conn, provider, manifest, path, resume=False)["fencesRemoved"]
    count = len(provider.posts)
    with database.connect() as conn:
        observed = migration.stage(conn, provider, manifest, path, resume=True, observe_only=True)
    assert len(provider.posts) == count
    if lost == 1:
        assert observed["phase"] == "observed" and len(provider.target) == 1002
        with database.connect() as conn:
            observed = migration.stage(conn, provider, manifest, path, resume=True)
    assert observed["phase"] == "staged_disabled_verified" and observed["fencesRemoved"]
    assert len(provider.posts) == 2 and provider.target[:2] == provider.original_retained


@pytest.mark.parametrize("password_record", [False, True])
def test_uat_activation_never_writes_retained_targets_and_uses_uid_reads(
    database, tmp_path, password_record
):
    provider = UatProvider()
    if password_record:
        provider.source[-1].update(passwordHash="aGFzaA==", salt="c2FsdA==")
    manifest = uat_manifest(database, provider)
    with database.connect() as conn:
        staged = migration.stage(conn, provider, manifest, tmp_path / "stage.json", resume=False)
        _, selected = migration.owner_snapshot(
            conn,
            provider.source,
            target_project=migration.UAT_TARGET,
            retained=manifest["retainedTargets"],
        )
    plan = activation.activation_plan(staged, manifest, selected, provider.target)
    assert len(plan["targets"]) == 1
    with database.connect() as conn:
        result = activation.activate(
            conn, provider, plan, tmp_path / "activation.json", resume=False
        )
    assert result["fencesRemoved"] and result["phase"] == "activated_verified"
    assert len(provider.posts) == 2 and provider.lookup_count == (0 if password_record else 2)
    if password_record:
        assert (
            provider.target[-1]["passwordHash"] == "aGFzaA=="
            and provider.target[-1]["salt"] == "c2FsdA=="
        )
    assert provider.target[:2] == provider.original_retained


@pytest.mark.parametrize(
    "change",
    [
        "retained_phone",
        "extra_target",
        "rewound_receipt",
        "pending_phone",
        "request_hash",
        "password_config",
    ],
)
def test_uat_forgery_and_unsettled_legacy_intents_refuse(database, tmp_path, change):
    provider = UatProvider(lose_batch=1)
    manifest = uat_manifest(database, provider)
    path = tmp_path / "stage.json"
    if change == "pending_phone":
        with database.begin() as conn:
            conn.exec_driver_sql(
                "INSERT INTO account_deletion_tombstones(cleanup_status,cleanup_intent_kind,firebase_uid) VALUES('retry_pending','phone_orphan','old-uid')"
            )
    else:
        with database.connect() as conn, pytest.raises(TimeoutError):
            migration.stage(conn, provider, manifest, path, resume=False)
        if change == "retained_phone":
            provider.target[0]["phoneNumber"] = "+16505550100"
        elif change == "extra_target":
            provider.target.append({"localId": "foreign"})
        else:
            receipt = json.loads(path.read_text())
            if change == "request_hash":
                receipt["history"][0]["requestSha256"] = "a" * 64
            elif change == "password_config":
                receipt["passwordConfigSha256"] = "a" * 64
            else:
                receipt["history"] = []
            migration.save_receipt(path, receipt)
    before = len(provider.posts)
    with database.connect() as conn, pytest.raises(migration.Refused):
        migration.stage(
            conn, provider, manifest, path, resume=change != "pending_phone", observe_only=True
        )
    assert len(provider.posts) == before
    with database.begin() as conn, pytest.raises(Exception, match="temporarily unavailable"):
        conn.exec_driver_sql(
            "INSERT INTO account_deletion_tombstones(cleanup_status) VALUES('pending')"
        )


@pytest.mark.parametrize("change", ["missing_version", "forged_request"])
def test_uat_activation_refuses_unbound_context_and_forged_request(database, tmp_path, change):
    provider = UatProvider()
    manifest = uat_manifest(database, provider)
    with database.connect() as conn:
        staged = migration.stage(conn, provider, manifest, tmp_path / "stage.json", resume=False)
        _, selected = migration.owner_snapshot(
            conn,
            provider.source,
            target_project=migration.UAT_TARGET,
            retained=manifest["retainedTargets"],
        )
    plan = activation.activation_plan(staged, manifest, selected, provider.target)
    path = tmp_path / "activate.json"
    value = {
        "operation": str(uuid4()),
        "manifestSha256": migration.sha(plan),
        "phase": "fence_intent",
        "history": [],
    }
    expected = "RECEIPT_CONTEXT_CHANGED"
    if change == "forged_request":
        value.update(
            version=2,
            history=[{"identityHash": next(iter(plan["targets"])), "requestSha256": "a" * 64}],
        )
        expected = "ACTIVATION_HISTORY_INVALID"
    migration.save_receipt(path, value)
    before = len(provider.posts)
    with database.connect() as conn, pytest.raises(migration.Refused, match=expected):
        activation.activate(conn, provider, plan, path, resume=True, observe_only=True)
    assert len(provider.posts) == before


def test_uat_cli_refuses_dev_manifest_before_provider_observation(database, tmp_path):
    from types import SimpleNamespace

    provider = Provider()
    manifest = snapshot(database, provider)
    path = tmp_path / "dev.json"
    migration.save_receipt(path, {**manifest, "liveSource": "same-source"})
    args = SimpleNamespace(
        environment="uat",
        action="observe",
        manifest=path,
        receipt=tmp_path / "receipt.json",
        staging_receipt=None,
        activation_manifest=None,
        apply=True,
        manifest_sha256=migration.sha(manifest),
    )
    with (
        database.connect() as conn,
        pytest.raises(migration.Refused, match="MANIFEST_ENVIRONMENT_CHANGED"),
    ):
        migration.operate(conn, provider, "same-source", args)
    assert provider.posts == []
