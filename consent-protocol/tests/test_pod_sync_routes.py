"""Standby sync end to end through the pod routes: two pods, one HusshID, the hub in between.

Each pod is a role-aware commit log on its own storage under its own log key and its own
identity keypair. The "hub" here is the test: it reads heads, ferries the envelope it
cannot open, and compares heads. Equal heads are checked against the PRIMARY's own
head read (E7), never against a value the hub recorded.
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass

import pytest
from fastapi import HTTPException

os.environ.setdefault("APP_SIGNING_KEY", "test_secret_key_for_ci_only_32chars_min")
os.environ.setdefault("VAULT_DATA_KEY", "0" * 64)

from api.routes.one import pod_migration, pod_sync  # noqa: E402
from api.routes.one.pod_sync import (  # noqa: E402
    ExportRequest,
    HeadRequest,
    ImportRequest,
    SetRoleRequest,
)
from hushh_mcp.services import pod_role  # noqa: E402
from hushh_mcp.services.pod_commit_log import LocalObjectStore  # noqa: E402
from hushh_mcp.services.pod_connector_keypair_service import (  # noqa: E402
    PodKeyPair,
    generate_pod_keypair,
)
from hushh_mcp.services.pod_request_signing import public_key_b64, signing_key_id  # noqa: E402
from hushh_mcp.services.pod_role import sync_import_scope  # noqa: E402
from hushh_mcp.services.pod_role_log import RoleAwareCommitLog  # noqa: E402
from hushh_mcp.services.pod_self_registration import derive_signing_key  # noqa: E402
from hushh_mcp.services.pod_sync_bundle import seal_range_bundle  # noqa: E402
from hushh_mcp.services.pod_sync_proof import sync_proof_audience  # noqa: E402

OWNER = "ha1_owner"
PROOF = "Bearer hub-proof"


@dataclass
class Pod:
    log: RoleAwareCommitLog
    keypair: PodKeyPair

    @property
    def signing_id(self) -> str:
        return signing_key_id(public_key_b64(derive_signing_key(self.keypair.private_key)))


@pytest.fixture
def hub(monkeypatch):
    """Enable the surface and record every proof audience the pod demanded."""
    monkeypatch.setenv("HUSSH_POD_MIGRATION_ENABLED", "1")
    monkeypatch.setenv("HUSSH_ID", OWNER)
    monkeypatch.delenv("POD_STORAGE_BACKEND", raising=False)
    audiences: list[str] = []
    monkeypatch.setattr(
        pod_migration,
        "_require_hub_caller",
        lambda proof, *, audience=None: audiences.append(audience),
    )
    pod_role.reset_role_cache()
    yield audiences
    pod_role.reset_role_cache()


def _pod(tmp_path, name: str, key: bytes) -> Pod:
    store = LocalObjectStore(str(tmp_path / name))
    return Pod(RoleAwareCommitLog(store, key, owner_id=OWNER), generate_pod_keypair())


def _use(monkeypatch, pod: Pod) -> None:
    """Point the routes at one pod, as if the request had arrived there."""
    monkeypatch.setattr(pod_migration, "_commit_log", lambda: pod.log)
    monkeypatch.setattr("hushh_mcp.services.pod_self_registration.pod_keypair", lambda: pod.keypair)
    pod_role.reset_role_cache()


async def _set_role(monkeypatch, pod: Pod, role: str, epoch: int, primary_id=None, target=None):
    _use(monkeypatch, pod)
    body = SetRoleRequest(
        role=role,
        epoch=epoch,
        primary_signing_key_id=primary_id,
        target_pod_signing_key_id=target or pod.signing_id,
        expires_at=int(time.time()) + 600,
    )
    return await pod_sync.sync_set_role(body, PROOF)


@pytest.fixture
async def pair(tmp_path, monkeypatch, hub):
    primary, standby = _pod(tmp_path, "primary", b"P" * 32), _pod(tmp_path, "standby", b"S" * 32)
    for n in range(3):
        await primary.log.append("memory_record", {"text": f"fact {n}"})
    await _set_role(monkeypatch, standby, "standby", 1, primary.signing_id)
    return primary, standby


async def _head(monkeypatch, pod: Pod) -> dict:
    _use(monkeypatch, pod)
    return await pod_sync.sync_head(HeadRequest(), PROOF)


async def _export(monkeypatch, primary: Pod, standby: Pod, head: dict) -> dict:
    _use(monkeypatch, primary)
    body = ExportRequest(
        base_seq=head["head_seq"],
        base_head_sha=head["head_sha"],
        standby_public_key=standby.keypair.public_key_b64,
        standby_key_id=standby.keypair.key_id,
    )
    return await pod_sync.sync_export(body, PROOF)


async def _import(monkeypatch, standby: Pod, bundle: dict, base_seq: int, base_sha: str) -> dict:
    _use(monkeypatch, standby)
    body = ImportRequest(bundle=bundle, base_seq=base_seq, base_head_sha=base_sha)
    return await pod_sync.sync_import(body, PROOF)


async def _sync(monkeypatch, primary: Pod, standby: Pod) -> dict:
    head = await _head(monkeypatch, standby)
    exported = await _export(monkeypatch, primary, standby, head)
    if exported["bundle"] is None:
        return exported
    return await _import(
        monkeypatch, standby, exported["bundle"], head["head_seq"], head["head_sha"]
    )


async def _count_appends(monkeypatch, pod: Pod) -> list:
    calls: list = []
    original = pod.log.append

    async def spy(*args, **kwargs):
        calls.append(args)
        return await original(*args, **kwargs)

    monkeypatch.setattr(pod.log, "append", spy)
    return calls


# --------------------------------------------------------------------------- #
# The property: after sync the standby's head equals the primary's own head
# --------------------------------------------------------------------------- #


async def test_sync_makes_the_standby_head_equal_the_primary_head(pair, monkeypatch):
    primary, standby = pair
    imported = await _sync(monkeypatch, primary, standby)
    primary_head = await _head(monkeypatch, primary)
    standby_head = await _head(monkeypatch, standby)

    assert (standby_head["head_seq"], standby_head["head_sha"]) == (3, primary_head["head_sha"])
    assert imported == {"head_seq": 3, "head_sha": primary_head["head_sha"]}
    assert (standby_head["role"], standby_head["epoch"]) == ("standby", 1)
    assert (primary_head["role"], primary_head["epoch"]) == ("primary", 0)

    _use(monkeypatch, primary)
    for n in range(2):
        await primary.log.append("memory_record", {"text": f"later {n}"})
    await _sync(monkeypatch, primary, standby)
    assert (await _head(monkeypatch, standby))["head_sha"] == (await _head(monkeypatch, primary))[
        "head_sha"
    ]
    _use(monkeypatch, standby)
    assert [r["payload"] for r in await standby.log.replay()][-1] == {"text": "later 1"}


async def test_equal_heads_export_no_bundle(pair, monkeypatch):
    primary, standby = pair
    await _sync(monkeypatch, primary, standby)
    head = await _head(monkeypatch, standby)

    exported = await _export(monkeypatch, primary, standby, head)
    assert exported == {"bundle": None, "head_seq": 3, "head_sha": head["head_sha"]}


async def test_every_route_binds_its_body_into_the_proof_audience(pair, monkeypatch, hub):
    primary, standby = pair
    hub.clear()
    head = await _head(monkeypatch, standby)
    exported = await _export(monkeypatch, primary, standby, head)
    await _import(monkeypatch, standby, exported["bundle"], 0, "")

    export_body = {
        "base_seq": 0,
        "base_head_sha": "",
        "standby_public_key": standby.keypair.public_key_b64,
        "standby_key_id": standby.keypair.key_id,
    }
    import_body = {"bundle": exported["bundle"], "base_seq": 0, "base_head_sha": ""}
    assert hub == [
        sync_proof_audience(OWNER, "sync-head", {}),
        sync_proof_audience(OWNER, "sync-export", export_body),
        sync_proof_audience(OWNER, "sync-import", import_body),
    ]


async def test_an_export_proof_for_one_standby_key_is_refused_for_another(
    pair, monkeypatch, tmp_path
):
    primary, standby = pair
    other = _pod(tmp_path, "other", b"O" * 32)
    granted = sync_proof_audience(
        OWNER,
        "sync-export",
        {
            "base_seq": 0,
            "base_head_sha": "",
            "standby_public_key": standby.keypair.public_key_b64,
            "standby_key_id": standby.keypair.key_id,
        },
    )

    def gate(proof, *, audience=None):
        if audience != granted:
            raise HTTPException(status_code=403, detail="migration refused")

    monkeypatch.setattr(pod_migration, "_require_hub_caller", gate)
    await _export(monkeypatch, primary, standby, {"head_seq": 0, "head_sha": ""})
    with pytest.raises(HTTPException) as refused:
        await _export(monkeypatch, primary, other, {"head_seq": 0, "head_sha": ""})
    assert refused.value.status_code == 403


async def test_the_surface_is_dark_without_the_switch(pair, monkeypatch):
    primary, _ = pair
    monkeypatch.delenv("HUSSH_POD_MIGRATION_ENABLED")
    with pytest.raises(HTTPException) as dark:
        await _head(monkeypatch, primary)
    assert dark.value.status_code == 404


# --------------------------------------------------------------------------- #
# Refusals before any write
# --------------------------------------------------------------------------- #


async def test_a_forked_standby_is_refused_by_export_and_import_before_any_write(pair, monkeypatch):
    """Negative control: the standby holds a different seq 1 than the primary."""
    primary, standby = pair
    _use(monkeypatch, standby)
    await standby.log.read_role(fresh=True)
    with sync_import_scope():
        await standby.log.append("memory_record", {"text": "a different history"})
    forked = await _head(monkeypatch, standby)

    with pytest.raises(HTTPException) as refused:
        await _export(monkeypatch, primary, standby, forked)
    assert refused.value.status_code == 409

    valid = await _export(monkeypatch, primary, standby, {"head_seq": 0, "head_sha": ""})
    calls = await _count_appends(monkeypatch, standby)
    with pytest.raises(HTTPException) as refused:
        await _import(monkeypatch, standby, valid["bundle"], 0, "")
    assert refused.value.status_code == 409
    assert calls == []
    assert await _head(monkeypatch, standby) == forked


async def test_a_tampered_bundle_is_refused_with_no_write(pair, monkeypatch):
    primary, standby = pair
    exported = await _export(monkeypatch, primary, standby, {"head_seq": 0, "head_sha": ""})
    bundle = dict(exported["bundle"])
    bundle["ciphertext"] = bundle["ciphertext"][:-8] + "AAAAAAA="
    calls = await _count_appends(monkeypatch, standby)

    with pytest.raises(HTTPException) as refused:
        await _import(monkeypatch, standby, bundle, 0, "")
    assert refused.value.status_code == 400
    assert calls == []


async def test_a_range_signed_by_another_primary_is_refused(pair, monkeypatch, tmp_path):
    primary, standby = pair
    _use(monkeypatch, primary)
    records = await primary.log.replay()
    impostor = derive_signing_key(generate_pod_keypair().private_key)
    bundle = seal_range_bundle(
        records=records,
        base_seq=0,
        base_head_sha="",
        recipient_public_key_b64=standby.keypair.public_key_b64,
        recipient_key_id=standby.keypair.key_id,
        signing_key=impostor,
    )
    calls = await _count_appends(monkeypatch, standby)

    with pytest.raises(HTTPException) as refused:
        await _import(monkeypatch, standby, bundle, 0, "")
    assert refused.value.status_code == 400
    assert "pinned primary" in str(refused.value.detail)
    assert calls == []


async def test_a_request_base_that_disagrees_with_the_signed_range_is_refused(pair, monkeypatch):
    primary, standby = pair
    exported = await _export(monkeypatch, primary, standby, {"head_seq": 0, "head_sha": ""})
    with pytest.raises(HTTPException) as refused:
        await _import(monkeypatch, standby, exported["bundle"], 1, "a" * 64)
    assert refused.value.status_code == 400


async def test_import_runs_on_a_standby_only_and_export_on_a_primary_only(pair, monkeypatch):
    primary, standby = pair
    exported = await _export(monkeypatch, primary, standby, {"head_seq": 0, "head_sha": ""})
    with pytest.raises(HTTPException) as refused:
        await _import(monkeypatch, primary, exported["bundle"], 0, "")
    assert refused.value.status_code == 409
    with pytest.raises(HTTPException) as refused:
        await _export(monkeypatch, standby, primary, {"head_seq": 0, "head_sha": ""})
    assert refused.value.status_code == 409


# --------------------------------------------------------------------------- #
# Idempotent and resumable (E8)
# --------------------------------------------------------------------------- #


async def test_re_importing_an_applied_range_returns_the_same_head_with_no_write(pair, monkeypatch):
    primary, standby = pair
    exported = await _export(monkeypatch, primary, standby, {"head_seq": 0, "head_sha": ""})
    first = await _import(monkeypatch, standby, exported["bundle"], 0, "")
    calls = await _count_appends(monkeypatch, standby)

    again = await _import(monkeypatch, standby, exported["bundle"], 0, "")
    assert again == first
    assert calls == []


async def test_a_partly_applied_range_resumes_from_the_standby_head(pair, monkeypatch):
    primary, standby = pair
    exported = await _export(monkeypatch, primary, standby, {"head_seq": 0, "head_sha": ""})
    _use(monkeypatch, primary)
    first_record = (await primary.log.replay())[0]
    _use(monkeypatch, standby)
    await standby.log.read_role(fresh=True)
    with sync_import_scope():
        await standby.log.append(first_record["kind"], first_record["payload"], expected_seq=0)
    calls = await _count_appends(monkeypatch, standby)

    resumed = await _import(monkeypatch, standby, exported["bundle"], 0, "")
    assert len(calls) == 2
    assert resumed["head_sha"] == (await _head(monkeypatch, primary))["head_sha"]


# --------------------------------------------------------------------------- #
# The role: bound to one pod's key, forward only
# --------------------------------------------------------------------------- #


async def test_a_set_role_proof_for_one_pod_key_is_refused_at_another(pair, monkeypatch):
    primary, standby = pair
    with pytest.raises(HTTPException) as refused:
        await _set_role(monkeypatch, primary, "primary", 2, target=standby.signing_id)
    assert refused.value.status_code == 403
    assert (await _head(monkeypatch, standby))["epoch"] == 1


@pytest.mark.parametrize("epoch", [1, 0])
async def test_an_equal_or_older_set_role_epoch_is_refused(pair, monkeypatch, epoch):
    primary, standby = pair
    with pytest.raises(HTTPException) as refused:
        await _set_role(monkeypatch, standby, "primary", epoch)
    assert refused.value.status_code == 409
    head = await _head(monkeypatch, standby)
    assert (head["role"], head["epoch"]) == ("standby", 1)


async def test_an_expired_set_role_is_refused(pair, monkeypatch):
    _, standby = pair
    _use(monkeypatch, standby)
    body = SetRoleRequest(
        role="primary",
        epoch=5,
        primary_signing_key_id=None,
        target_pod_signing_key_id=standby.signing_id,
        expires_at=int(time.time()) - 1,
    )
    with pytest.raises(HTTPException) as refused:
        await pod_sync.sync_set_role(body, PROOF)
    assert refused.value.status_code == 403


async def test_promotion_moves_the_epoch_forward_and_reverses_direction(pair, monkeypatch):
    primary, standby = pair
    await _sync(monkeypatch, primary, standby)
    await _set_role(monkeypatch, standby, "primary", 2)
    await _set_role(monkeypatch, primary, "standby", 2, standby.signing_id)

    _use(monkeypatch, standby)
    await standby.log.append("memory_record", {"text": "learned after promotion"})
    imported = await _sync(monkeypatch, standby, primary)
    assert imported["head_seq"] == 4
    assert (await _head(monkeypatch, primary))["head_sha"] == imported["head_sha"]


async def test_import_and_promotion_reload_the_owners_ai_selection(pair, monkeypatch):
    """A standby must serve the owner's current AI choice the moment it takes over.

    Negative control: without the reload the active copy stays whatever the standby
    loaded at boot, so an import that carried a new choice would read as no reloads.
    """
    from hushh_mcp.services import pod_ai_selection

    reloads: list[object] = []

    async def _load(log: object = None) -> None:
        reloads.append(log)

    monkeypatch.setattr(pod_ai_selection, "load_active_ai_selection", _load)
    primary, standby = pair
    await _sync(monkeypatch, primary, standby)
    assert reloads == [standby.log], "an import that appended records reloads once"
    await _set_role(monkeypatch, standby, "primary", 2)
    assert len(reloads) == 2, "a role change reloads too"


def test_bodies_are_strict_so_the_hashed_body_is_the_sent_body():
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        ExportRequest(
            base_seq="3",
            base_head_sha="",
            standby_public_key="k" * 44,
            standby_key_id="pod-a",
        )
    with pytest.raises(ValidationError):
        HeadRequest(extra=True)
