"""Standby sync, pod side: read a head, export a range, import a range, set the role.

Every route sits behind the existing hub-proof gate (``pod_migration._require_hub_caller``)
with an audience that binds the exact request body (E6,
``pod_sync_proof.sync_proof_audience``), and ships dark behind the same
``HUSSH_POD_MIGRATION_ENABLED`` switch as the migration routes: this is the same
decrypt-for-transport capability, so it is exactly as reachable, no more.

Bodies are strict (no coercion, no extra fields), so the body the pod hashes is the
body the hub hashed. Field names are snake_case, the protocol's wire contract.

* ``POST /pod/sync/head`` (``sync-head``, both roles): this pod's head and role (E7).
* ``POST /pod/sync/export`` (``sync-export``, primary only): the records after the
  standby's head, sealed to it and signed by this pod (E5).
* ``POST /pod/sync/import`` (``sync-import``, standby only): verify origin and
  continuity against this pod's OWN head before any append; append with
  compare-and-swap; an already-applied range is a no-op (E8).
* ``POST /pod/sync/set-role`` (``set-role``, both roles): forward-only role write,
  bound to THIS pod's signing key id (E2).
"""

from __future__ import annotations

import logging
import os
import time
from typing import Any, Literal, Optional

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, ConfigDict, Field, StrictInt, StrictStr

from api.routes.one import pod_migration
from hushh_mcp.services.pod_role import (
    ROLE_STANDBY,
    PodRole,
    PodRoleConflict,
    PodRoleRefused,
    PodRoleStaleEpoch,
    PodRoleUnreadable,
    sync_import_scope,
)
from hushh_mcp.services.pod_sync_proof import (
    PURPOSE_SET_ROLE,
    PURPOSE_SYNC_EXPORT,
    PURPOSE_SYNC_HEAD,
    PURPOSE_SYNC_IMPORT,
    sync_proof_audience,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/pod/sync", tags=["pod-sync"])

#: A set-role proof is a short-lived instruction, not a standing grant.
SET_ROLE_MAX_HORIZON_SECONDS = 3600


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class HeadRequest(_Strict):
    pass


class ExportRequest(_Strict):
    base_seq: StrictInt = Field(ge=0)
    base_head_sha: StrictStr = Field(max_length=64)
    standby_public_key: StrictStr = Field(min_length=32, max_length=128)
    standby_key_id: StrictStr = Field(min_length=4, max_length=128)


class ImportRequest(_Strict):
    bundle: dict[str, Any]
    base_seq: StrictInt = Field(ge=0)
    base_head_sha: StrictStr = Field(max_length=64)


class SetRoleRequest(_Strict):
    role: Literal["primary", "standby"]
    epoch: StrictInt = Field(ge=0)
    primary_signing_key_id: Optional[StrictStr] = Field(max_length=64)
    target_pod_signing_key_id: StrictStr = Field(max_length=64)
    expires_at: StrictInt = Field(ge=0)


def _authorize(purpose: str, body: _Strict, proof: Optional[str]) -> None:
    pod_migration._require_enabled()
    hushh_id = str(os.getenv("HUSSH_ID") or "").strip()
    if not hushh_id:
        raise HTTPException(status_code=403, detail="sync refused")
    audience = sync_proof_audience(hushh_id, purpose, body.model_dump(mode="json"))
    pod_migration._require_hub_caller(proof, audience=audience)


def _sync_log() -> Any:
    """This pod's role-aware commit log, or a loud refusal."""
    from hushh_mcp.services.pod_role_log import RoleAwareCommitLog  # noqa: PLC0415

    log = pod_migration._commit_log()
    if not isinstance(log, RoleAwareCommitLog):
        raise HTTPException(status_code=503, detail="this pod's log cannot take part in sync")
    return log


async def _role(log: Any) -> PodRole:
    try:
        role: PodRole = await log.read_role(fresh=True)
        return role
    except PodRoleUnreadable:
        raise HTTPException(
            status_code=503, detail={"code": "POD_ROLE_UNREADABLE", "message": "role unreadable"}
        ) from None


def _refuse_role(expected: str) -> HTTPException:
    return HTTPException(
        status_code=409,
        detail={"code": "POD_ROLE_MISMATCH", "message": f"this route runs on a {expected} only"},
    )


async def _head(log: Any) -> tuple[int, str]:
    try:
        cursor = await log.verified_head()
    except Exception:  # noqa: BLE001 - storage errors may carry private coordinates
        logger.warning("pod_sync.head_unavailable")
        raise HTTPException(status_code=409, detail="this pod's log head is unavailable") from None
    return (cursor.seq, cursor.sha) if cursor else (0, "")


@router.post("/head")
async def sync_head(
    body: HeadRequest,
    x_hussh_hub_proof: Optional[str] = Header(default=None, alias="X-Hussh-Hub-Proof"),
) -> dict[str, Any]:
    """This pod's head, key and role. Works on both roles (E7)."""
    _authorize(PURPOSE_SYNC_HEAD, body, x_hussh_hub_proof)
    from hushh_mcp.services.pod_self_registration import (  # noqa: PLC0415
        pod_keypair,
        pod_signing_public_payload,
    )

    log = _sync_log()
    role = await _role(log)
    head_seq, head_sha = await _head(log)
    return {
        "head_seq": head_seq,
        "head_sha": head_sha,
        "pod_key_id": pod_keypair().key_id,
        "pod_signing_key_id": pod_signing_public_payload()["podSigningKeyId"],
        "role": role.role,
        "epoch": role.epoch,
    }


def _range_after(records: list[dict[str, Any]], base_seq: int, base_head_sha: str) -> list:
    """The records after the base, or a refusal when the base is not in this chain."""
    if base_seq > len(records):
        raise HTTPException(status_code=409, detail="the standby is ahead of this primary")
    anchor = records[base_seq - 1]["sha"] if base_seq else ""
    if anchor != base_head_sha:
        raise HTTPException(status_code=409, detail="the standby's head is not in this chain")
    return records[base_seq:]


@router.post("/export")
async def sync_export(
    body: ExportRequest,
    x_hussh_hub_proof: Optional[str] = Header(default=None, alias="X-Hussh-Hub-Proof"),
) -> dict[str, Any]:
    """Seal the records after the standby's head to the standby. Primary only."""
    _authorize(PURPOSE_SYNC_EXPORT, body, x_hussh_hub_proof)
    from hushh_mcp.services.pod_self_registration import (  # noqa: PLC0415
        pod_keypair,
        pod_signing_key,
    )
    from hushh_mcp.services.pod_sync_bundle import (  # noqa: PLC0415
        PodSyncBundleError,
        seal_range_bundle,
    )

    log = _sync_log()
    if (await _role(log)).is_standby:
        raise _refuse_role("primary")
    own = pod_keypair()
    if body.standby_key_id == own.key_id or body.standby_public_key == own.public_key_b64:
        raise HTTPException(status_code=400, detail="the standby is this pod")
    records = await pod_migration._verified_replay(log)
    after = _range_after(records, body.base_seq, body.base_head_sha)
    head_seq, head_sha = (len(records), records[-1]["sha"]) if records else (0, "")
    if not after:
        return {"bundle": None, "head_seq": head_seq, "head_sha": head_sha}
    try:
        bundle = seal_range_bundle(
            records=after,
            base_seq=body.base_seq,
            base_head_sha=body.base_head_sha,
            recipient_public_key_b64=body.standby_public_key,
            recipient_key_id=body.standby_key_id,
            signing_key=pod_signing_key(),
        )
    except PodSyncBundleError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    logger.info("pod_sync.exported records=%d head_seq=%d", len(after), head_seq)
    return {"bundle": bundle, "head_seq": head_seq, "head_sha": head_sha}


def _resume_point(contents: Any, own_seq: int, own_sha: str) -> Optional[int]:
    """Where this standby sits on the range's chain; None when it is not on it."""
    if contents.base_seq <= own_seq <= contents.head_seq:
        if contents.chain.get(own_seq) == own_sha:
            return own_seq
    return None


async def _apply(log: Any, contents: Any, start_seq: int) -> str:
    """Append the records after ``start_seq``, each against the expected head."""
    from hushh_mcp.services.pod_commit_log import PodLogConflict  # noqa: PLC0415

    head_sha: str = contents.chain[start_seq]
    with sync_import_scope():
        for record in contents.records[start_seq - contents.base_seq :]:
            try:
                written = await log.append(
                    record["kind"], record.get("payload"), expected_seq=record["seq"] - 1
                )
            except PodLogConflict:
                raise HTTPException(
                    status_code=409, detail="the standby's log moved during import"
                ) from None
            if written.get("sha") != contents.chain[record["seq"]]:
                raise HTTPException(status_code=500, detail="the rebuilt chain diverged")
            head_sha = contents.chain[record["seq"]]
    return head_sha


async def _reload_owner_ai(log: Any) -> None:
    """The owner's AI selection may have arrived or changed: read it again (never raises).

    Startup alone is not enough. A standby that booted before the owner chose, or
    before they removed a key, would otherwise serve a stale choice after promotion.
    """
    from hushh_mcp.services.pod_ai_selection import load_active_ai_selection  # noqa: PLC0415

    await load_active_ai_selection(log)


@router.post("/import")
async def sync_import(
    body: ImportRequest,
    x_hussh_hub_proof: Optional[str] = Header(default=None, alias="X-Hussh-Hub-Proof"),
) -> dict[str, Any]:
    """Verify, place on this pod's own head, then append. Standby only (E8)."""
    _authorize(PURPOSE_SYNC_IMPORT, body, x_hussh_hub_proof)
    from hushh_mcp.services.pod_self_registration import pod_keypair  # noqa: PLC0415
    from hushh_mcp.services.pod_sync_bundle import (  # noqa: PLC0415
        PodSyncBundleError,
        open_range_bundle,
    )

    log = _sync_log()
    role = await _role(log)
    if not role.is_standby:
        raise _refuse_role("standby")
    own = pod_keypair()
    try:
        contents = open_range_bundle(
            body.bundle,
            private_key=own.private_key,
            expected_key_id=own.key_id,
            pinned_signing_key_id=str(role.primary_signing_key_id or ""),
        )
    except PodSyncBundleError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if (contents.base_seq, contents.base_head_sha) != (body.base_seq, body.base_head_sha):
        raise HTTPException(status_code=400, detail="the request base disagrees with the range")
    own_seq, own_sha = await _head(log)
    start = _resume_point(contents, own_seq, own_sha)
    if start is None:
        raise HTTPException(status_code=409, detail="the range does not continue this standby")
    head_sha = contents.head_sha
    if start < contents.head_seq:
        head_sha = await _apply(log, contents, start)
        await _reload_owner_ai(log)
    logger.info("pod_sync.imported from_seq=%d head_seq=%d", start, contents.head_seq)
    return {"head_seq": contents.head_seq, "head_sha": head_sha}


def _role_from(body: SetRoleRequest) -> PodRole:
    from hushh_mcp.services.pod_role import validate_role  # noqa: PLC0415
    from hushh_mcp.services.pod_self_registration import (  # noqa: PLC0415
        pod_signing_public_payload,
    )

    own_signing = pod_signing_public_payload()["podSigningKeyId"]
    if body.target_pod_signing_key_id != own_signing:
        raise HTTPException(status_code=403, detail="this role proof names another pod")
    now = int(time.time())
    if not now < body.expires_at <= now + SET_ROLE_MAX_HORIZON_SECONDS:
        raise HTTPException(status_code=403, detail="this role proof is expired or too long-lived")
    if body.role == ROLE_STANDBY and body.primary_signing_key_id == own_signing:
        raise HTTPException(status_code=400, detail="a standby cannot pin itself as primary")
    try:
        return validate_role(
            PodRole(
                role=body.role, epoch=body.epoch, primary_signing_key_id=body.primary_signing_key_id
            )
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/set-role")
async def sync_set_role(
    body: SetRoleRequest,
    x_hussh_hub_proof: Optional[str] = Header(default=None, alias="X-Hussh-Hub-Proof"),
) -> dict[str, Any]:
    """Write this pod's role, strictly forward in epoch (E1, E2, E3)."""
    _authorize(PURPOSE_SET_ROLE, body, x_hussh_hub_proof)
    new = _role_from(body)
    log = _sync_log()
    try:
        written = await log.write_role(new)
    except PodRoleStaleEpoch:
        raise HTTPException(
            status_code=409, detail={"code": "POD_ROLE_STALE_EPOCH", "message": "stale epoch"}
        ) from None
    except PodRoleConflict:
        raise HTTPException(status_code=409, detail="the role changed during the write") from None
    except (PodRoleUnreadable, PodRoleRefused):
        raise HTTPException(
            status_code=503, detail={"code": "POD_ROLE_UNREADABLE", "message": "role unreadable"}
        ) from None
    except Exception:  # noqa: BLE001 - storage errors may carry private coordinates
        logger.warning("pod_sync.role_write_unconfirmed")
        raise HTTPException(status_code=503, detail="the role write was not confirmed") from None
    await _reload_owner_ai(log)
    logger.info("pod_sync.role_set role=%s epoch=%d", written.role, written.epoch)
    return {"role": written.role, "epoch": written.epoch}
