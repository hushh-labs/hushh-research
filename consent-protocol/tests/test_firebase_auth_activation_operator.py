# SPDX-License-Identifier: Apache-2.0
"""Qualified activation, source-owner retirement and non-replaying recovery."""

import copy
import json

import pytest
from sqlalchemy import text

from scripts.ops import firebase_identity_activation as activation
from scripts.ops import firebase_identity_migration as migration
from tests.test_firebase_auth_migration_operator import (
    Provider,
    snapshot,
)
from tests.test_firebase_auth_migration_operator import (
    database as database,
)
from tests.test_firebase_auth_migration_operator import (
    postgres as postgres,
)


def test_workos_attribution_absence_active_binding_and_offboarding_are_pinned(database):
    from hushh_mcp.services.enterprise_sso.membership import membership_hash

    provider = Provider()
    provider.source[0]["customAttributes"] = json.dumps(
        {"workosOrgId": "org", "workosUserId": "person", "workosOrigin": "linked"}
    )
    manifest = snapshot(database, provider)
    digest = migration.identity_hash("owner-a")
    with database.begin() as conn:
        conn.exec_driver_sql("ALTER TABLE account_generations ADD COLUMN identity_hash text")
        conn.exec_driver_sql("""CREATE TABLE account_workos_memberships(
            profile_hash text,owner_hash text,identity_hash text,generation integer,
            origin text,offboarded_at timestamptz)""")
        conn.execute(
            text("""INSERT INTO account_generations(owner_hash,identity_hash,
            identity_uid,owner_id,generation) VALUES(:digest,:digest,'owner-a','owner-a',0)"""),
            {"digest": digest},
        )
    selected = {"owner-a": migration.record(provider.source[0])}
    with database.connect() as conn:
        absent = activation.workos_snapshot(conn, selected, manifest)
        assert absent[digest]["membershipSha256"] == migration.sha(None)
    with database.begin() as conn:
        conn.execute(
            text("""INSERT INTO account_workos_memberships VALUES(
            :profile,:digest,:digest,0,'linked',NULL)"""),
            {"profile": membership_hash("org", "person"), "digest": digest},
        )
    with database.connect() as conn:
        active = activation.workos_snapshot(conn, selected, manifest, lock=True)
        assert active != absent
        with database.begin() as writer, pytest.raises(Exception, match="lock timeout"):
            writer.exec_driver_sql("UPDATE account_workos_memberships SET offboarded_at=now()")
        conn.rollback()
    with database.begin() as writer:
        writer.exec_driver_sql("UPDATE account_workos_memberships SET offboarded_at=now()")
    with (
        database.connect() as conn,
        pytest.raises(migration.Refused, match="WORKOS_ATTRIBUTION_CHANGED"),
    ):
        activation.workos_snapshot(conn, selected, manifest)


def test_owner_deleted_before_activation_fence_never_enables_identity(
    database, tmp_path, monkeypatch
):
    provider = Provider()
    manifest = snapshot(database, provider)
    with database.connect() as conn:
        staged = migration.stage(conn, provider, manifest, tmp_path / "stage.json", resume=False)
        _, selected = migration.owner_snapshot(conn, provider.source)
    plan = activation.activation_plan(staged, manifest, selected, provider.target)
    install = activation.install_fences

    def delete_before_fence(conn, operation):
        conn.exec_driver_sql("DELETE FROM actor_profiles; DELETE FROM vault_keys")
        install(conn, operation)

    monkeypatch.setattr(activation, "install_fences", delete_before_fence)
    with database.connect() as conn, pytest.raises(migration.Refused, match="COHORT_SIZE_INVALID"):
        activation.activate(conn, provider, plan, tmp_path / "activation.json", resume=False)
    assert len(provider.posts) == 1 and provider.target[0]["disabled"] is True


@pytest.mark.parametrize("failure", ["none", "lost_ack", "restored_receipt", "foreign", "missing"])
def test_activation_preserves_identity_and_never_replays_uncertain_updates(
    database, tmp_path, monkeypatch, failure
):
    provider = Provider()
    provider.source[0].update(passwordHash="aGFzaA==", salt="c2FsdA==", validSince="100")
    manifest = snapshot(database, provider)
    with database.connect() as conn:
        staging = migration.stage(conn, provider, manifest, tmp_path / "stage.json", resume=False)
    provider.target[0]["validSince"] = "101"
    with database.connect() as conn:
        _, selected = migration.owner_snapshot(conn, provider.source)
    plan = activation.activation_plan(staging, manifest, selected, provider.target)
    path = tmp_path / "activation.json"
    before = copy.deepcopy(provider.target[0])
    provider.lose_response = failure in {"lost_ack", "restored_receipt"}
    if failure == "foreign":
        provider.target[0]["passwordHash"] = "foreign"
    if failure == "missing":
        provider.target.clear()
    if failure in {"foreign", "missing"}:
        with database.connect() as conn, pytest.raises(migration.Refused):
            activation.activate(conn, provider, plan, path, resume=False)
        assert len(provider.posts) == 1
        return
    with database.connect() as conn:
        if provider.lose_response:
            with pytest.raises(TimeoutError):
                activation.activate(conn, provider, plan, path, resume=False)
        else:
            result = activation.activate(conn, provider, plan, path, resume=False)
            assert result["phase"] == "activated_verified" and result["fencesRemoved"]
    if failure == "restored_receipt":
        stale = json.loads(path.read_text())
        stale.update(history=[], phase="fence_intent")
        migration.save_receipt(path, stale)
        with database.connect() as conn, pytest.raises(migration.Refused):
            activation.activate(conn, provider, plan, path, resume=True)
    else:
        with database.connect() as conn:
            result = activation.activate(conn, provider, plan, path, resume=True)
            assert result["fencesRemoved"] and migration.fences_absent(conn)
    assert len(provider.posts) == 2
    actual = provider.target[0]
    for key in ["localId", "passwordHash", "salt", "validSince", "providerUserInfo"]:
        assert actual[key] == before[key]
    assert not actual["disabled"]
    assert migration.MARKER not in json.loads(actual["customAttributes"])
