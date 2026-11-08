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
                erasure_phase text,provider_cleanup_receipt jsonb,firebase_erasure_checkpoint jsonb);
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
