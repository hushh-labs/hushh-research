# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Clean-slate silent cutover onto Pooled Personal Sandboxes (#9744).

Converts ``unplaced`` and legacy ``shared`` accounts onto pooled single-use
``ace`` personal sandboxes while leaving owner-cloud BYOC (``user_gcp``,
``user_azure``, ``user_aws``), retained pilot placements, tombstoned owners, and
in-progress or fenced BYOC setup jobs untouched.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import os
import urllib.parse
from collections.abc import Mapping
from typing import Any

from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey

from hushh_mcp.runtime_settings import personal_agent_enabled
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
from hushh_mcp.services.pod_connector_keypair_service import WRAPPING_ALG
from hushh_mcp.services.pod_request_signing import public_key_b64, signing_key_id
from hushh_mcp.services.pod_self_registration import derive_signing_key

logger = logging.getLogger(__name__)

_TRUTHY = frozenset({"1", "true", "yes"})
_ALLOWED_LANES = frozenset({"dev", "uat"})
_POOLED_HUSHH_ID_CONTEXT = b"hushh.personal-agent.pooled-hushh-id.v1"
_OWNER_CLOUD_COLUMNS = (
    "user_cloud_project",
    "user_cloud_region",
    "user_cloud_bootstrap_sa",
    "user_cloud_authorized_at",
    "user_cloud_tenant_id",
    "user_cloud_subscription_id",
    "user_cloud_resource_group",
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


def _should_preserve_existing_row(row: Mapping[str, Any] | None) -> bool:
    if row is None:
        return False
    if is_owner_cloud_target(row.get("deployment_target")):
        return True
    if any(row.get(col) is not None for col in _OWNER_CLOUD_COLUMNS):
        return True
    if has_hosted_evidence(row) or has_hosted_azure_evidence(row):
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
) -> dict[str, Any] | None:
    """Idempotently place or cut over an unplaced/shared user onto Pooled Personal Sandboxes."""
    if not sandbox_pool_cutover_enabled():
        return existing_row

    from hushh_mcp.services.personal_agent_grant_service import (  # noqa: PLC0415
        PersonalAgentGrantService,
    )
    from hushh_mcp.services.personal_agent_registry_repo import (  # noqa: PLC0415
        PersonalAgentRegistryRepo,
    )

    repo = registry or PersonalAgentRegistryRepo()
    row = existing_row if existing_row is not None else await repo.get(user_id)

    tombstone_check = getattr(repo, "tombstone_exists", None)
    if callable(tombstone_check) and await tombstone_check(user_id):
        return row
    if _should_preserve_existing_row(row):
        return row
    if not has_hosted_ace_evidence(row) and await has_blocking_byoc_setup_job(
        user_id, job_repo=job_repo
    ):
        return row

    edge_base = _edge_public_base_url()
    seed = _identity_master_seed()
    existing_hushh_id = str((row or {}).get("hushh_id") or "").strip()
    hushh_id = existing_hushh_id or mint_pooled_hushh_id(user_id)
    pod_url = f"{edge_base}/u/{urllib.parse.quote(hushh_id, safe='')}"
    keys = derive_pooled_owner_public_keys(seed, hushh_id)

    if (
        row is not None
        and retained_hosted_ace_placement(row) is not None
        and str(row.get("status") or "") == "provisioned"
        and str((row.get("backend_metadata") or {}).get("url") or "").rstrip("/") == pod_url
        and str(row.get("pod_pubkey") or "") == keys["pod_pubkey"]
        and str(row.get("pod_signing_pubkey") or "") == keys["pod_signing_pubkey"]
    ):
        return dict(row)

    billing_space_id = str(
        (row or {}).get("billing_space_id") or ""
    ).strip() or mint_billing_space_id(hushh_id)
    phone_hash = (
        str((row or {}).get("phone_e164_hash") or "").strip()
        or hashlib.sha256(f"pooled-sandbox:{user_id}".encode("utf-8")).hexdigest()
    )

    prev_meta = (
        dict(row["backend_metadata"])
        if isinstance(row, Mapping) and isinstance(row.get("backend_metadata"), Mapping)
        else {}
    )
    raw_ver = prev_meta.get("endpointVersion")
    endpoint_version = raw_ver if isinstance(raw_ver, int) and raw_ver >= 1 else 1
    service_uid = f"ace-pool-{hushh_id}"
    lane = deploy_lane()
    owner_hash = "sha256:" + hashlib.sha256(user_id.encode("utf-8")).hexdigest()

    merged_meta: dict[str, Any] = {
        **prev_meta,
        "tenancy": "hussh-hosted",
        "pool": "agent_sandbox_warm_pool",
        "service": "sandbox-edge-gateway",
        "serviceUid": service_uid,
        "url": pod_url,
        "ingress": "direct",
        "endpointVersion": endpoint_version,
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
        liveness_mode="warm",
        deployment_target="ace",
        model_credential_mode="byok_per_turn",
    )
    updated = await repo.get(user_id)
    return dict(updated) if isinstance(updated, Mapping) else row


__all__ = [
    "derive_pooled_owner_public_keys",
    "ensure_pooled_sandbox_placement",
    "has_blocking_byoc_setup_job",
    "mint_pooled_hushh_id",
    "sandbox_pool_cutover_enabled",
]
