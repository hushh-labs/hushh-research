# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Lossless-first cutover and migration onto Pooled Personal Sandboxes (#9744).

Converts ``unplaced``, legacy ``shared``, hosted, and owner-cloud accounts onto
pooled single-use ``ace`` personal sandboxes. When a prior pod is reachable, it
performs zero-knowledge sealed commit-log migration with SHA-256 ``headSha``
parity before flipping the registry; dead or incompatible clouds fall back safely
to a fresh Personal Sandbox under a 3-day non-destructive safety hold.
"""

from __future__ import annotations

import asyncio
import base64
import copy
import hashlib
import hmac
import logging
import os
import secrets
import time
import urllib.parse
from collections.abc import Mapping
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey

from hushh_mcp.runtime_settings import personal_agent_enabled
from hushh_mcp.services import pod_migration_transport
from hushh_mcp.services.agent_sandbox.edge_gateway_app import derive_owner_pod_identity
from hushh_mcp.services.compute_backend import is_owner_cloud_target
from hushh_mcp.services.dev_simulation_guard import deploy_lane
from hushh_mcp.services.hosted_ace_placement import (
    has_hosted_ace_evidence,
    retained_hosted_ace_placement,
)
from hushh_mcp.services.hosted_azure_placement import has_hosted_azure_evidence
from hushh_mcp.services.hosted_gcp_placement import has_hosted_evidence
from hushh_mcp.services.personal_agent_identity_service import mint_billing_space_id
from hushh_mcp.services.pod_ai_selection_seal import SUPPORTED_PROVIDERS
from hushh_mcp.services.pod_connector_keypair_service import WRAPPING_ALG
from hushh_mcp.services.pod_migration_transport import PodMigrationTransportError
from hushh_mcp.services.pod_request_signing import public_key_b64, signing_key_id
from hushh_mcp.services.pod_self_registration import derive_signing_key
from hushh_mcp.services.pod_upgrade_handoff import (
    PodUpgradeHandoffClient,
    PodUpgradeHandoffUnavailable,
)

logger = logging.getLogger(__name__)

_TRUTHY = frozenset({"1", "true", "yes"})
_ALLOWED_LANES = frozenset({"dev", "uat"})
_POOLED_HUSHH_ID_CONTEXT = b"hushh.personal-agent.pooled-hushh-id.v1"
_SOURCE_POD_GRACE_DAYS = 3
_SOURCE_HANDOFF_BUDGET_SECONDS = 18.0
_SANDBOX_WAKE_TIMEOUT_SECONDS = 25.0
_FALLBACK_TRANSPORT_ERRORS = frozenset(
    {
        "POD_UNREACHABLE",
        "HUB_IDENTITY_UNAVAILABLE",
        "POD_REFUSED_403",
        "POD_REFUSED_404",
        "POD_REFUSED_500",
        "POD_REFUSED_502",
        "POD_REFUSED_503",
        "POD_REFUSED_504",
    }
)
_OWNER_CLOUD_COLUMNS = (
    "user_cloud_project",
    "user_cloud_region",
    "user_cloud_bootstrap_sa",
    "user_cloud_authorized_at",
    "user_cloud_tenant_id",
    "user_cloud_subscription_id",
    "user_cloud_resource_group",
)
_STALE_NON_ACE_METADATA_KEYS = frozenset(
    {
        "bindings",
        "endpoint",
        "directReadiness",
        "provisionAttempt",
        "setupNonce",
        "installedRelease",
        "observed",
        "credential",
        "hostedAzureAdmission",
        "tenantId",
        "subscriptionId",
        "resourceGroup",
        "image",
        "image_digest",
        "region",
        "livenessMode",
    }
)
_BLOCKING_BYOC_STAGES = frozenset(
    {
        "azure_setup_intent",
        "azure_setup_prior_intent",
        "azure_provider_request",
        "azure_worker_started",
        "awaiting_agent_record",
        "creating_project",
        "linking_billing",
        "enabling_apis",
        "applying_iam",
        "settling_grant",
        "proving",
    }
)


def _edge_public_base_url() -> str:
    raw = (
        os.environ.get("HUSSH_SANDBOX_EDGE_PUBLIC_URL")
        or os.environ.get("HUSSH_SANDBOX_EDGE_URL")
        or ""
    ).strip()
    if not raw:
        return ""
    text = raw.rstrip("/")
    try:
        parsed = urllib.parse.urlsplit(text)
    except ValueError:
        return ""
    if (
        parsed.scheme != "https"
        or not parsed.netloc
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        return ""
    return text


def _identity_master_seed() -> bytes:
    raw = (
        os.environ.get("HUSSH_SANDBOX_IDENTITY_MASTER_KEY")
        or os.environ.get("HUSSH_SANDBOX_IDENTITY_SEED")
        or ""
    ).strip()
    return raw.encode("utf-8")


def sandbox_pool_cutover_enabled() -> bool:
    """True only when pooled cutover, HTTPS Edge URL, and master key are explicitly configured."""
    if not personal_agent_enabled() or deploy_lane() not in _ALLOWED_LANES:
        return False
    enabled = (os.environ.get("HUSSH_AGENT_SANDBOX_CUTOVER_ENABLED") or "").strip().lower()
    if enabled not in _TRUTHY:
        return False
    if not _edge_public_base_url():
        return False
    return len(_identity_master_seed()) >= 32


def mint_pooled_hushh_id(user_id: str) -> str:
    """Derive a deterministic ``ha1_<32-base32>`` owner id safe for pooled Edge routes."""
    seed = _identity_master_seed()
    digest = hmac.new(
        seed, _POOLED_HUSHH_ID_CONTEXT + b"|" + user_id.encode("utf-8"), hashlib.sha256
    )
    token = base64.b32encode(digest.digest()[:20]).decode("ascii").rstrip("=").lower()
    return f"ha1_{token}"


def derive_pooled_owner_public_keys(seed: bytes, hushh_id: str) -> dict[str, str]:
    """Derive exact X25519 + Ed25519 public descriptors matching Edge Gateway's private key."""
    priv_b64, pub_b64, pod_key_id = derive_owner_pod_identity(seed, hushh_id)
    x25519_priv = X25519PrivateKey.from_private_bytes(base64.b64decode(priv_b64))
    ed_priv = derive_signing_key(x25519_priv)
    sign_pub = public_key_b64(ed_priv)
    sign_kid = signing_key_id(sign_pub)
    return {
        "pod_pubkey": pub_b64,
        "pod_key_id": pod_key_id,
        "pod_key_wrapping_alg": WRAPPING_ALG,
        "pod_signing_pubkey": sign_pub,
        "pod_signing_key_id": sign_kid,
    }


async def has_blocking_byoc_setup_job(user_id: str, *, job_repo: Any = None) -> bool:
    """Return True if the owner has an active, unresolved, or failed provider-mutating BYOC job."""
    from hushh_mcp.services.byoc_setup_job_service import ByocSetupJobRepo  # noqa: PLC0415

    repo = job_repo or ByocSetupJobRepo()
    try:
        job = await repo._current(user_id)
    except Exception:  # noqa: BLE001 - fail safe: never overwrite an owner whose setup job is unreadable
        return True
    if not isinstance(job, Mapping):
        return False
    if str(job.get("status") or "").strip() == "running":
        return True
    attempts = job.get("authorization_attempts")
    if isinstance(attempts, Mapping) and len(attempts) > 0:
        return True
    stages = job.get("stages")
    if isinstance(stages, list):
        for entry in stages:
            if not isinstance(entry, Mapping):
                continue
            stage_name = str(entry.get("stage") or "").strip()
            if stage_name in _BLOCKING_BYOC_STAGES:
                return True
    return False


def _should_preserve_existing_row(
    row: Mapping[str, Any] | None, *, allow_non_ace_hosted_cutover: bool = False
) -> bool:
    if row is None:
        return False
    if is_owner_cloud_target(row.get("deployment_target")):
        return True
    if any(row.get(col) is not None for col in _OWNER_CLOUD_COLUMNS):
        return True
    if not allow_non_ace_hosted_cutover and (
        has_hosted_evidence(row) or has_hosted_azure_evidence(row)
    ):
        return True
    meta = row.get("backend_metadata")
    if isinstance(meta, Mapping):
        if "erasure" in meta or meta.get("upgradeLease"):
            return True
        attempt = meta.get("provisionAttempt")
        if isinstance(attempt, Mapping) and str(attempt.get("phase") or "") != "provisioned":
            return True
    return False


async def ensure_pooled_sandbox_placement(
    *,
    user_id: str,
    existing_row: dict[str, Any] | None = None,
    registry: Any = None,
    job_repo: Any = None,
    grant_service: Any = None,
    hosting_choice_repo: Any = None,
    cloud_marker_writer: Any = None,
    bypass_byoc_job_fence: bool = False,
    allow_non_ace_hosted_cutover: bool = False,
    force_reenter_sandbox: bool = False,
    extra_source_retirements: Mapping[str, Any] | None = None,
) -> dict[str, Any] | None:
    """Idempotently place or cut over an unplaced/shared user onto Pooled Personal Sandboxes."""
    if not sandbox_pool_cutover_enabled():
        return existing_row

    from hushh_mcp.services.owner_hosting_choice import (  # noqa: PLC0415
        write_cloud_setup_marker,
    )
    from hushh_mcp.services.personal_agent_grant_service import (  # noqa: PLC0415
        PersonalAgentGrantService,
    )
    from hushh_mcp.services.personal_agent_hosting import (  # noqa: PLC0415
        _last_detach,
        _unassigned_placement_clear,
    )
    from hushh_mcp.services.personal_agent_registry_repo import (  # noqa: PLC0415
        PersonalAgentRegistryRepo,
    )

    async def _ensure_cloud_marker() -> None:
        if cloud_marker_writer is not None:
            await cloud_marker_writer(user_id)
        elif registry is None:
            await write_cloud_setup_marker(user_id)

    del hosting_choice_repo
    repo = registry or PersonalAgentRegistryRepo()
    row = existing_row if existing_row is not None else await repo.get(user_id)

    tombstone_check = getattr(repo, "tombstone_exists", None)
    if callable(tombstone_check) and await tombstone_check(user_id):
        return row
    if _should_preserve_existing_row(
        row, allow_non_ace_hosted_cutover=allow_non_ace_hosted_cutover
    ):
        if has_hosted_ace_evidence(row) and str((row or {}).get("status") or "") == "provisioned":
            await _ensure_cloud_marker()
        return row
    if not force_reenter_sandbox and isinstance(row, Mapping):
        row_dict = dict(row)
        last_detach = _last_detach(row_dict)
        if (
            last_detach is not None
            and _unassigned_placement_clear(row_dict)
            and str(last_detach.get("reason") or "") == "owner switched to Bring your own cloud"
        ):
            return row
    if (
        not bypass_byoc_job_fence
        and not has_hosted_ace_evidence(row)
        and await has_blocking_byoc_setup_job(user_id, job_repo=job_repo)
    ):
        return row

    edge_base = _edge_public_base_url()
    seed = _identity_master_seed()
    existing_hushh_id = str((row or {}).get("hushh_id") or "").strip()
    hushh_id = existing_hushh_id or mint_pooled_hushh_id(user_id)
    pod_url = f"{edge_base}/u/{urllib.parse.quote(hushh_id, safe='')}"
    keys = derive_pooled_owner_public_keys(seed, hushh_id)

    if (
        not extra_source_retirements
        and row is not None
        and retained_hosted_ace_placement(row) is not None
        and str(row.get("status") or "") == "provisioned"
        and str((row.get("backend_metadata") or {}).get("url") or "").rstrip("/") == pod_url
        and str(row.get("pod_pubkey") or "") == keys["pod_pubkey"]
        and str(row.get("pod_signing_pubkey") or "") == keys["pod_signing_pubkey"]
        and (row.get("backend_metadata") or {}).get("ready") is True
    ):
        await _ensure_cloud_marker()
        return dict(row)

    billing_space_id = str(
        (row or {}).get("billing_space_id") or ""
    ).strip() or mint_billing_space_id(hushh_id)
    phone_hash = (
        str((row or {}).get("phone_e164_hash") or "").strip()
        or hashlib.sha256(f"pooled-sandbox:{user_id}".encode("utf-8")).hexdigest()
    )

    raw_prev_meta = (
        dict(row["backend_metadata"])
        if isinstance(row, Mapping) and isinstance(row.get("backend_metadata"), Mapping)
        else {}
    )
    # Strip stale legacy cloud keys when entering ACE while preserving
    # detachedPlacements, monotonic endpoint version floor, and puppy* keys.
    prior_endpoint_record = raw_prev_meta.get("endpoint")
    preserved_endpoint: dict[str, Any] | None = None
    if (
        not has_hosted_ace_evidence(row)
        and isinstance(prior_endpoint_record, Mapping)
        and type(prior_endpoint_record.get("version")) is int
        and prior_endpoint_record["version"] >= 1
    ):
        preserved_endpoint = {
            "version": prior_endpoint_record["version"],
            "url": str(prior_endpoint_record.get("url") or ""),
            "podKeyId": str(prior_endpoint_record.get("podKeyId") or ""),
        }
    prev_meta = (
        raw_prev_meta
        if has_hosted_ace_evidence(row)
        else {k: v for k, v in raw_prev_meta.items() if k not in _STALE_NON_ACE_METADATA_KEYS}
    )
    if preserved_endpoint is not None:
        prev_meta["endpoint"] = preserved_endpoint
    raw_ver = prev_meta.get("endpointVersion")
    prev_ep_ver = preserved_endpoint["version"] if preserved_endpoint is not None else 0
    detached_ep_ver = 0
    detached_list = raw_prev_meta.get("detachedPlacements")
    if isinstance(detached_list, list):
        for item in detached_list:
            if not isinstance(item, Mapping):
                continue
            item_meta = item.get("backend_metadata")
            if not isinstance(item_meta, Mapping):
                continue
            cand_ver = item_meta.get("endpointVersion")
            if type(cand_ver) is int and cand_ver >= 1:
                detached_ep_ver = max(detached_ep_ver, cand_ver)
            cand_ep = item_meta.get("endpoint")
            if isinstance(cand_ep, Mapping) and type(cand_ep.get("version")) is int:
                detached_ep_ver = max(detached_ep_ver, cand_ep["version"])
    prior_floor = max(prev_ep_ver, detached_ep_ver)
    base_ver = raw_ver if isinstance(raw_ver, int) and raw_ver >= 1 else 1
    endpoint_version = max(base_ver, prior_floor + 1 if prior_floor >= 1 else 1)
    service_uid = f"ace-pool-{hushh_id}"
    lane = deploy_lane()
    owner_hash = "sha256:" + hashlib.sha256(user_id.encode("utf-8")).hexdigest()

    existing_observed = prev_meta.get("observed")
    ai_selection = {
        "version": 1,
        "providers": list(SUPPORTED_PROVIDERS),
        "defaultVerification": True,
    }
    observed_meta: dict[str, Any] = (
        {**existing_observed} if isinstance(existing_observed, Mapping) else {}
    )
    observed_meta.setdefault("aiSelection", ai_selection)

    merged_retirements: dict[str, Any] = {}
    existing_retirements = prev_meta.get("sourcePodRetirements")
    if isinstance(existing_retirements, Mapping):
        merged_retirements.update(copy.deepcopy(dict(existing_retirements)))
    if isinstance(extra_source_retirements, Mapping):
        merged_retirements.update(copy.deepcopy(dict(extra_source_retirements)))

    merged_meta: dict[str, Any] = {
        **prev_meta,
        "tenancy": "hussh-hosted",
        "pool": "agent_sandbox_warm_pool",
        "service": "sandbox-edge-gateway",
        "serviceUid": service_uid,
        "url": pod_url,
        "ingress": "direct",
        "ready": True,
        "endpointVersion": endpoint_version,
        "observed": observed_meta,
        "directReadiness": {
            "verified": True,
            "url": pod_url,
            "serviceUid": service_uid,
            "podKeyId": keys["pod_key_id"],
        },
        "hostedAceAdmission": {
            "version": 1,
            "environment": lane,
            "ownerId": user_id,
            "ownerHash": owner_hash,
            "hushhId": hushh_id,
            "url": pod_url,
        },
        **({"sourcePodRetirements": merged_retirements} if merged_retirements else {}),
    }

    grants = grant_service or PersonalAgentGrantService()
    await grants.issue_or_reuse_standing_pkm_read(user_id)

    await repo.upsert(
        user_id=user_id,
        hushh_id=hushh_id,
        phone_e164_hash=phone_hash,
        status="provisioned",
        pod_pubkey=keys["pod_pubkey"],
        pod_key_id=keys["pod_key_id"],
        pod_key_wrapping_alg=keys["pod_key_wrapping_alg"],
        pod_signing_pubkey=keys["pod_signing_pubkey"],
        pod_signing_key_id=keys["pod_signing_key_id"],
        external_agent_id=f"ace-pool:{hushh_id}",
        a2a_route=pod_url,
        backend="ace",
        billing_space_id=billing_space_id,
        backend_metadata=merged_meta,
        liveness_mode="economy",
        deployment_target="ace",
        model_credential_mode="byok_per_turn",
    )
    await _ensure_cloud_marker()
    updated = await repo.get(user_id)
    return dict(updated) if isinstance(updated, Mapping) else row


def _clear_unassigned_owner_cloud_columns_sync(db: Any, user_id: str) -> None:
    db.execute_raw(
        """
        UPDATE public.personal_agent_registry
        SET status = 'unprovisioned',
            backend = NULL,
            deployment_target = NULL,
            user_cloud_project = NULL,
            user_cloud_region = NULL,
            user_cloud_bootstrap_sa = NULL,
            user_cloud_authorized_at = NULL,
            user_cloud_tenant_id = NULL,
            user_cloud_subscription_id = NULL,
            user_cloud_resource_group = NULL,
            updated_at = now()
        WHERE user_id = :user_id
          AND external_agent_id IS NULL
          AND NOT (coalesce(backend_metadata, '{}'::jsonb) ? 'erasure')
          AND NOT (coalesce(backend_metadata, '{}'::jsonb) ? 'upgradeLease')
        """,
        {"user_id": user_id},
    )


def _parse_utc_iso(raw: object) -> datetime | None:
    if not isinstance(raw, str):
        return None
    text = raw.strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)


def _record_grace_retirement_from_detach(
    prior_retirements: dict[str, Any],
    detached_row: Mapping[str, Any] | None,
    *,
    migration_mode: str = "clean_slate_fallback",
    remove_prior_cloud_resources: bool = False,
) -> bool:
    """Record retirement state for the newest detached host without mutating ``detachedPlacements``."""
    if not isinstance(detached_row, Mapping):
        return False
    meta = detached_row.get("backend_metadata")
    if not isinstance(meta, Mapping):
        return False
    detached = meta.get("detachedPlacements")
    if not isinstance(detached, list) or not detached or not isinstance(detached[-1], Mapping):
        return False
    from hushh_mcp.services.source_pod_retirement import compute_placement_id  # noqa: PLC0415

    newest = detached[-1]
    pid = compute_placement_id(newest)
    anchor_dt = _parse_utc_iso(newest.get("detachedAt")) or datetime.now(timezone.utc)
    now_iso = anchor_dt.strftime("%Y-%m-%dT%H:%M:%SZ")
    source_target = str(
        newest.get("deployment_target") or newest.get("deploymentTarget") or ""
    ).strip()

    is_managed_pod = source_target in {"azure", "gcp"}
    is_byoc = source_target in {"user_azure", "user_gcp"}
    verified_lossless = migration_mode in {"lossless_commit_log", "empty_source_log"}

    if is_managed_pod and verified_lossless:
        prior_retirements[pid] = {
            "status": "ready_for_retirement",
            "ownerConfirmed": True,
            "confirmedAt": now_iso,
            "graceDays": 0,
            "graceReapAfter": now_iso,
            "sourceTarget": source_target,
            "migrationMode": migration_mode,
        }
        return True

    if is_byoc and remove_prior_cloud_resources:
        prior_retirements[pid] = {
            "status": "ready_for_retirement",
            "ownerConfirmed": True,
            "confirmedAt": now_iso,
            "graceDays": 0,
            "graceReapAfter": now_iso,
            "sourceTarget": source_target,
            "removePriorCloudResources": True,
            "migrationMode": migration_mode,
        }
        return True

    reap_iso = (anchor_dt + timedelta(days=_SOURCE_POD_GRACE_DAYS)).strftime("%Y-%m-%dT%H:%M:%SZ")
    prior_retirements[pid] = {
        "status": "awaiting_owner_confirmation",
        "ownerConfirmed": False,
        "graceDays": _SOURCE_POD_GRACE_DAYS,
        "graceReapAfter": reap_iso,
        "sourceTarget": source_target,
        "migrationMode": migration_mode,
    }
    return False


async def _default_wake_sandbox(pod_url: str) -> None:
    """Wake the destination Personal Sandbox on Edge Gateway before importing sealed history."""
    health_url = f"{pod_url.rstrip('/')}/health"
    deadline = time.monotonic() + _SANDBOX_WAKE_TIMEOUT_SECONDS
    async with httpx.AsyncClient(timeout=15.0) as client:
        while time.monotonic() < deadline:
            try:
                resp = await client.get(health_url)
                if resp.status_code == 200:
                    return
            except httpx.HTTPError:
                pass
            await asyncio.sleep(0.25)
    raise ValueError("Personal Sandbox is still waking up; try switching again in a moment.")


def _release_handoff_best_effort(
    handoff: Any,
    *,
    operation_id: str | None,
    incarnation: str | None,
) -> None:
    if handoff is None or not operation_id or not incarnation:
        return
    try:
        handoff.release(operation_id=operation_id, incarnation=incarnation)
    except Exception:  # noqa: BLE001 - best-effort release on fallback or post-sync completion
        logger.info("pooled_sandbox_cutover.handoff_release_skipped op=%s", operation_id)


async def _sync_prior_pod_to_personal_sandbox(
    *,
    row: Mapping[str, Any],
    dest_hushh_id: str,
    dest_pod_url: str,
    dest_keys: Mapping[str, str],
    migration_transport: Any = None,
    handoff_factory: Any = None,
    token_minter: Any = None,
    wake_sandbox_fn: Any = None,
) -> tuple[str, int]:
    """Export sealed commit log from reachable prior pod into Personal Sandbox.

    Returns ``(migration_mode, synced_record_count)``. Dead/unreachable clouds
    fall back to ``("clean_slate_fallback", 0)``, whereas a failed import or SHA
    mismatch after a successful live export raises ``ValueError`` before detach
    so live user data is never orphaned or discarded.
    """
    raw_meta = row.get("backend_metadata")
    meta: Mapping[str, Any] = raw_meta if isinstance(raw_meta, Mapping) else {}
    source_url = str(meta.get("url") or row.get("a2a_route") or "").strip().rstrip("/")
    source_hushh_id = str(row.get("hushh_id") or "").strip()
    if not source_url.startswith("https://") or not source_hushh_id:
        return "clean_slate_fallback", 0

    transport = migration_transport or pod_migration_transport
    wake_fn = wake_sandbox_fn or _default_wake_sandbox
    deadline = time.monotonic() + _SOURCE_HANDOFF_BUDGET_SECONDS

    handoff = (
        handoff_factory(source_url, source_hushh_id)
        if handoff_factory is not None
        else PodUpgradeHandoffClient(
            url=source_url,
            hushh_id=source_hushh_id,
            request_budget=lambda: max(0.0, deadline - time.monotonic()),
        )
    )

    frozen_op_id: str | None = None
    frozen_incarnation: str | None = None
    try:
        status_payload = await asyncio.to_thread(
            handoff._request,
            "GET",
            "/api/one/pod/upgrade/status",
        )
    except PodUpgradeHandoffUnavailable as exc:
        logger.info(
            "pooled_sandbox_cutover.source_probe_unavailable reason=%s",
            str(exc),
        )
        return "clean_slate_fallback", 0

    incarnation = (
        str(status_payload.get("incarnation") or "").strip()
        if isinstance(status_payload, Mapping)
        else ""
    )
    if incarnation and str(status_payload.get("state") or "").strip() == "accepting":
        op_id = f"ace_{secrets.token_hex(12)}"
        try:
            await asyncio.to_thread(
                handoff.prepare_and_wait,
                operation_id=op_id,
                incarnation=incarnation,
                timeout_seconds=max(2.0, min(10.0, deadline - time.monotonic())),
            )
            frozen_op_id = op_id
            frozen_incarnation = incarnation
        except PodUpgradeHandoffUnavailable as exc:
            logger.info(
                "pooled_sandbox_cutover.source_drain_skipped reason=%s",
                str(exc),
            )
            _release_handoff_best_effort(handoff, operation_id=op_id, incarnation=incarnation)

    try:
        await wake_fn(dest_pod_url)
    except Exception:
        await asyncio.to_thread(
            _release_handoff_best_effort,
            handoff,
            operation_id=frozen_op_id,
            incarnation=frozen_incarnation,
        )
        raise

    export_kwargs: dict[str, Any] = {
        "pod_url": source_url,
        "hushh_id": source_hushh_id,
        "recipient_public_key": dest_keys["pod_pubkey"],
        "recipient_key_id": dest_keys["pod_key_id"],
    }
    if token_minter is not None:
        export_kwargs["token_minter"] = token_minter

    try:
        exported = await asyncio.to_thread(transport.export_from, **export_kwargs)
    except PodMigrationTransportError as exc:
        await asyncio.to_thread(
            _release_handoff_best_effort,
            handoff,
            operation_id=frozen_op_id,
            incarnation=frozen_incarnation,
        )
        if exc.code == "POD_REFUSED_400" or exc.code in _FALLBACK_TRANSPORT_ERRORS:
            logger.info("pooled_sandbox_cutover.export_fallback code=%s", exc.code)
            return "clean_slate_fallback", 0
        raise ValueError(
            "Encrypted history export could not complete; your existing pod stays active."
        ) from exc

    record_count = int(exported.get("recordCount") or 0) if isinstance(exported, Mapping) else 0
    export_head = str((exported or {}).get("headSha") or "").strip()
    if record_count <= 0:
        await asyncio.to_thread(
            _release_handoff_best_effort,
            handoff,
            operation_id=frozen_op_id,
            incarnation=frozen_incarnation,
        )
        return "empty_source_log", 0

    import_kwargs: dict[str, Any] = {
        "pod_url": dest_pod_url,
        "hushh_id": dest_hushh_id,
        "bundle": exported["bundle"],
    }
    if token_minter is not None:
        import_kwargs["token_minter"] = token_minter

    try:
        imported = await asyncio.to_thread(transport.import_into, **import_kwargs)
    except PodMigrationTransportError as exc:
        await asyncio.to_thread(
            _release_handoff_best_effort,
            handoff,
            operation_id=frozen_op_id,
            incarnation=frozen_incarnation,
        )
        raise ValueError(
            "Encrypted history import failed; your prior pod remains active and untouched."
        ) from exc

    import_head = str((imported or {}).get("headSha") or "").strip()
    import_count = int((imported or {}).get("recordCount") or 0)
    matches_source = bool((imported or {}).get("matchesSource", import_head == export_head))
    if (
        not export_head
        or not matches_source
        or import_head != export_head
        or import_count != record_count
    ):
        await asyncio.to_thread(
            _release_handoff_best_effort,
            handoff,
            operation_id=frozen_op_id,
            incarnation=frozen_incarnation,
        )
        raise ValueError(
            "Encrypted history verification failed; your prior pod remains active and untouched."
        )

    await asyncio.to_thread(
        _release_handoff_best_effort,
        handoff,
        operation_id=frozen_op_id,
        incarnation=frozen_incarnation,
    )
    return "lossless_commit_log", record_count


async def adopt_pooled_sandbox_for_owner(
    *,
    user_id: str,
    allow_clean_slate: bool = False,
    remove_prior_cloud_resources: bool = False,
    registry: Any = None,
    job_repo: Any = None,
    migration_job_repo: Any = None,
    grant_service: Any = None,
    detach_fn: Any = None,
    identity_service: Any = None,
    db: Any = None,
    migration_transport: Any = None,
    handoff_factory: Any = None,
    token_minter: Any = None,
    wake_sandbox_fn: Any = None,
    trigger_retirement_sweep_fn: Any = None,
) -> dict[str, Any]:
    """Explicit owner-confirmed switch from personal/stalled/fenced cloud onto ACE sandbox."""
    if not sandbox_pool_cutover_enabled():
        raise PermissionError("POOLED_SANDBOX_UNAVAILABLE")

    from hushh_mcp.services.actor_identity_service import ActorIdentityService  # noqa: PLC0415
    from hushh_mcp.services.byoc_setup_job_service import ByocSetupJobRepo  # noqa: PLC0415
    from hushh_mcp.services.personal_agent_placement_detach import (  # noqa: PLC0415
        detach_placement,
    )
    from hushh_mcp.services.personal_agent_registry_repo import (  # noqa: PLC0415
        PersonalAgentRegistryRepo,
    )
    from hushh_mcp.services.pod_migration_service import PodMigrationJobRepo  # noqa: PLC0415
    from hushh_mcp.services.source_pod_retirement import (  # noqa: PLC0415
        trigger_source_pod_retirement_sweep,
    )

    repo = registry or PersonalAgentRegistryRepo()
    tombstone_check = getattr(repo, "tombstone_exists", None)
    if callable(tombstone_check) and await tombstone_check(user_id):
        raise ValueError("Account deletion is in progress.")

    jobs = job_repo or ByocSetupJobRepo()
    setup_job = await jobs._current(user_id)
    if isinstance(setup_job, Mapping) and str(setup_job.get("status") or "").strip() == "running":
        raise ValueError("A cloud setup job is currently running. Wait for it to finish first.")
    if isinstance(setup_job, Mapping):
        from hushh_mcp.services import byoc_setup_intent  # noqa: PLC0415

        if byoc_setup_intent.is_untouched_intent(dict(setup_job)):
            try:
                await byoc_setup_intent.clear_intent(user_id)
            except Exception:  # noqa: BLE001 - best-effort intent cleanup when returning to ACE
                logger.info("pooled_sandbox_cutover.clear_intent_skipped user=%s", user_id)

    mig_repo = migration_job_repo or PodMigrationJobRepo()
    mig_job = await mig_repo.get(user_id)
    if isinstance(mig_job, Mapping) and str(mig_job.get("status") or "").strip() == "running":
        raise ValueError("A pod migration is currently running. Wait for it to finish first.")

    row = await repo.get(user_id)
    if isinstance(row, Mapping):
        raw_row_meta = row.get("backend_metadata")
        meta: Mapping[str, Any] = raw_row_meta if isinstance(raw_row_meta, Mapping) else {}
        if "erasure" in meta:
            raise ValueError("Account cloud removal is in progress.")
        if meta.get("upgradeLease"):
            raise ValueError("An agent update is currently running. Try again after it settles.")
        vm_power = meta.get("vmPower")
        if isinstance(vm_power, Mapping) and str(vm_power.get("phase") or "").strip() not in {
            "",
            "ready",
        }:
            raise ValueError("Your cloud VM is currently changing power state.")
        attempt = meta.get("provisionAttempt")
        if isinstance(attempt, Mapping) and str(attempt.get("phase") or "") != "provisioned":
            raise ValueError("An unfinished cloud provisioning attempt is holding this slot.")

        if has_hosted_ace_evidence(row) and str(row.get("status") or "") == "provisioned":
            ensured = await ensure_pooled_sandbox_placement(
                user_id=user_id,
                existing_row=dict(row),
                registry=repo,
                job_repo=jobs,
                grant_service=grant_service,
                bypass_byoc_job_fence=True,
            )
            if not isinstance(ensured, Mapping):
                raise ValueError("Could not refresh Personal Sandbox placement.")
            return {
                "status": "ready",
                "hostingMode": "hussh_pods",
                "deploymentTarget": "ace",
                "hushhId": str(ensured.get("hushh_id") or ""),
                "podUrl": str(ensured.get("a2a_route") or ""),
                "detachedPriorHost": False,
                "migrationMode": "already_active",
                "syncedRecordCount": 0,
                "backgroundCleanupQueued": False,
            }

    prior_retirements: dict[str, Any] = {}
    if isinstance(row, Mapping):
        raw_prev_ret = (row.get("backend_metadata") or {}).get("sourcePodRetirements")
        if isinstance(raw_prev_ret, Mapping):
            prior_retirements.update(copy.deepcopy(dict(raw_prev_ret)))

    detached_prior = False
    immediate_sweep = False
    migration_mode = "fresh_start"
    synced_record_count = 0

    if (
        isinstance(row, Mapping)
        and bool(row.get("external_agent_id"))
        and str(row.get("deployment_target") or "").strip() != "ace"
    ):
        if not allow_clean_slate:
            raise ValueError("CLEAN_SLATE_CONFIRMATION_REQUIRED")

        in_memory_unit_seam = (
            detach_fn is not None
            and migration_transport is None
            and handoff_factory is None
            and wake_sandbox_fn is None
        )
        if in_memory_unit_seam:
            migration_mode = "clean_slate_fallback"
            synced_record_count = 0
        else:
            edge_base = _edge_public_base_url()
            seed = _identity_master_seed()
            existing_hushh_id = str(row.get("hushh_id") or "").strip()
            dest_hushh_id = existing_hushh_id or mint_pooled_hushh_id(user_id)
            dest_pod_url = f"{edge_base}/u/{urllib.parse.quote(dest_hushh_id, safe='')}"
            dest_keys = derive_pooled_owner_public_keys(seed, dest_hushh_id)
            migration_mode, synced_record_count = await _sync_prior_pod_to_personal_sandbox(
                row=row,
                dest_hushh_id=dest_hushh_id,
                dest_pod_url=dest_pod_url,
                dest_keys=dest_keys,
                migration_transport=migration_transport,
                handoff_factory=handoff_factory,
                token_minter=token_minter,
                wake_sandbox_fn=wake_sandbox_fn,
            )

        actual_detach = detach_fn or detach_placement
        detached = await actual_detach(
            row=dict(row),
            reason="owner switched to Hussh Personal Sandbox",
            db=db,
            allow_stalled_states=True,
        )
        if detached is None:
            fresh = await repo.get(user_id)
            if (
                isinstance(fresh, Mapping)
                and bool(fresh.get("external_agent_id"))
                and str(fresh.get("deployment_target") or "").strip() != "ace"
            ):
                raw_fresh_meta = fresh.get("backend_metadata")
                fresh_meta: Mapping[str, Any] = (
                    raw_fresh_meta if isinstance(raw_fresh_meta, Mapping) else {}
                )
                raw_fresh_ret = fresh_meta.get("sourcePodRetirements")
                if isinstance(raw_fresh_ret, Mapping):
                    prior_retirements.update(copy.deepcopy(dict(raw_fresh_ret)))
                detached = await actual_detach(
                    row=dict(fresh),
                    reason="owner switched to Hussh Personal Sandbox",
                    db=db,
                    allow_stalled_states=True,
                )
            if detached is None:
                raise ValueError("Hosting state changed while switching. Refresh and try again.")
        detached_prior = True
        row = await repo.get(user_id)
        immediate_sweep = _record_grace_retirement_from_detach(
            prior_retirements,
            row,
            migration_mode=migration_mode,
            remove_prior_cloud_resources=remove_prior_cloud_resources,
        )
    elif isinstance(row, Mapping) and (
        is_owner_cloud_target(row.get("deployment_target"))
        or any(row.get(col) is not None for col in _OWNER_CLOUD_COLUMNS)
        or (
            not has_hosted_ace_evidence(row)
            and (
                str(row.get("deployment_target") or "").strip() in {"gcp", "azure"}
                or has_hosted_evidence(row)
                or has_hosted_azure_evidence(row)
            )
        )
    ):
        if not allow_clean_slate:
            raise ValueError("CLEAN_SLATE_CONFIRMATION_REQUIRED")
        migration_mode = "clean_slate_fallback"
        target_db = db or (repo._db() if hasattr(repo, "_db") else None)
        if target_db is not None:
            await asyncio.to_thread(_clear_unassigned_owner_cloud_columns_sync, target_db, user_id)
            row = await repo.get(user_id)
        elif callable(getattr(repo, "clear_unassigned_owner_cloud", None)):
            await repo.clear_unassigned_owner_cloud(user_id)
            row = await repo.get(user_id)
        else:
            stored = (
                repo.rows.get(user_id) if isinstance(getattr(repo, "rows", None), dict) else None
            )
            for target_row in (stored, row):
                if isinstance(target_row, dict):
                    for col in _OWNER_CLOUD_COLUMNS:
                        target_row[col] = None
                    target_row["deployment_target"] = None
                    target_row["backend"] = None
                    target_row["status"] = "unprovisioned"
            if isinstance(stored, dict):
                row = await repo.get(user_id)
            else:
                cleared_copy = dict(row)
                for col in _OWNER_CLOUD_COLUMNS:
                    cleared_copy[col] = None
                cleared_copy["deployment_target"] = None
                cleared_copy["backend"] = None
                cleared_copy["status"] = "unprovisioned"
                row = cleared_copy

    if row is None:
        id_svc = identity_service or ActorIdentityService()
        identity = (await id_svc.get_many([user_id])).get(user_id) or {}
        if identity.get("phone_verified") is not True:
            raise ValueError("Verify your phone number first.")

    updated = await ensure_pooled_sandbox_placement(
        user_id=user_id,
        existing_row=dict(row) if isinstance(row, Mapping) else None,
        registry=repo,
        job_repo=jobs,
        grant_service=grant_service,
        bypass_byoc_job_fence=True,
        allow_non_ace_hosted_cutover=True,
        force_reenter_sandbox=True,
        extra_source_retirements=prior_retirements or None,
    )
    if not isinstance(updated, Mapping) or str(updated.get("deployment_target") or "") != "ace":
        raise ValueError("Could not activate Hussh Personal Sandbox right now.")

    if immediate_sweep:
        sweep_trigger = trigger_retirement_sweep_fn or trigger_source_pod_retirement_sweep
        sweep_trigger()

    return {
        "status": "ready",
        "hostingMode": "hussh_pods",
        "deploymentTarget": "ace",
        "hushhId": str(updated.get("hushh_id") or ""),
        "podUrl": str(updated.get("a2a_route") or ""),
        "detachedPriorHost": detached_prior,
        "migrationMode": migration_mode,
        "syncedRecordCount": synced_record_count,
        "backgroundCleanupQueued": detached_prior,
    }


__all__ = [
    "adopt_pooled_sandbox_for_owner",
    "derive_pooled_owner_public_keys",
    "ensure_pooled_sandbox_placement",
    "has_blocking_byoc_setup_job",
    "mint_pooled_hushh_id",
    "sandbox_pool_cutover_enabled",
]
