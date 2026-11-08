# SPDX-License-Identifier: Apache-2.0
"""Qualified activation, source-owner retirement and non-replaying recovery."""

import copy
import json

import pytest

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
