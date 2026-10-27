"""Managed hosting remains unavailable until project admission and custody qualify.

Deployment flags name intent and a project; they do not prove capacity or sibling
isolation. BYOC and reviewer phone-verification retain their separate authorities.
Plan rendering and existing resource inspection remain available.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
from collections.abc import Mapping
from copy import deepcopy
from dataclasses import dataclass
from typing import Any

from hushh_mcp.services.dev_simulation_guard import deploy_lane, runtime_environment

_OPT_IN_FLAG = "HUSSH_HOSTED_POD_TIER_ENABLED"
_POD_PROJECT_VAR = "HUSSH_POD_PROJECT"


class HostedTierNotPermittedError(RuntimeError):
    """No new managed owner resources before the qualified admission path exists."""


def _norm(value: str | None) -> str:
    return str(value or "").strip().lower()


def _flag(name: str) -> bool:
    return _norm(os.getenv(name)) in {"1", "true", "yes", "on"}


def hosted_pod_project() -> str:
    return str(os.getenv(_POD_PROJECT_VAR) or "").strip()


def hosted_pod_creates_permitted() -> bool:
    # Deliberate qualification gate, not an operator-configurable bypass. The
    # legacy renderer uses development master-key derivation and a shared
    # identity. Replace this refusal only with authoritative project reservations
    # and qualified per-owner key custody, together with their negative controls.
    return False


def require_supported_erasure(row: object) -> None:
    """Preserve managed recovery until its complete erasure receipts qualify."""
    if not isinstance(row, Mapping):
        return
    target = row.get("deployment_target")
    if target == "gcp" or (not target and row.get("backend") == "gcp"):
        from hushh_mcp.services.account_service import PersonalAgentDeprovisioningRequiredError

        raise PersonalAgentDeprovisioningRequiredError()


def require_hosted_pod_maintenance_permitted(what: str = "hosted pod maintenance") -> None:
    # Existing resources still need owner-approved upgrades and recovery. This
    # admission permits maintenance intent only; the backend separately proves
    # the existing service/incarnation, handoff and exact approved target.
    if _flag(_OPT_IN_FLAG) and deploy_lane() and hosted_pod_project():
        return
    raise HostedTierNotPermittedError(f"{what} requires an explicitly configured existing fleet")


def require_hosted_pod_creates_permitted(what: str = "hosted pod provisioning") -> None:
    if hosted_pod_creates_permitted():
        return
    raise HostedTierNotPermittedError(
        f"{what} is unavailable until project capacity admission and per-pod "
        f"custody are qualified. {_OPT_IN_FLAG} and {_POD_PROJECT_VAR} are configuration "
        f"intent, not qualification. Observed opt_in={_flag(_OPT_IN_FLAG)} "
        f"lane={deploy_lane()!r} project={hosted_pod_project()!r} "
        f"environment={runtime_environment()!r}."
    )


@dataclass(frozen=True)
class HostedPilotSelection:
    """Intent-only admission; provisioning still claims its durable allocation."""

    owner_id: str
    hushh_id: str
    registry_row: dict[str, Any] | None

    @property
    def registry_present(self) -> bool:
        return self.registry_row is not None


async def require_hosted_pilot_selection(
    owner_id: str, registry: Any, *, require_record: bool = False
) -> HostedPilotSelection:
    """Read trusted fixed-cohort policy; never authorize resource creation here."""
    from hushh_mcp.managed_ai_config import load_profile, profile_hash
    from hushh_mcp.services.hosted_engine_location_contract import provider_contract, utc_now
    from hushh_mcp.services.pod_release import configured_release, image_digest

    try:
        if not owner_id or owner_id != owner_id.strip() or deploy_lane() != "dev":
            raise ValueError
        image = os.getenv("HUSSH_ONE_POD_IMAGE", "")
        release = configured_release(image)
        sha = os.getenv("HUSHH_DEPLOY_SHA", "")
        if release is None or release["sourceRevision"] != sha:
            raise ValueError
        cleanup = provider_contract(utc_now())
        profile = load_profile("dev")
        binding = {
            "provider": "gemini",
            "model": profile["text_model"],
            "project": profile["project"],
            "profileHash": profile_hash(profile),
        }
        result = await asyncio.to_thread(
            registry._db().execute_raw,
            _PILOT_SELECTION_QUERY,
            {
                "owner": owner_id,
                "owner_hash": "sha256:" + hashlib.sha256(owner_id.encode()).hexdigest(),
                "sha": sha,
                "digest": image_digest(image),
                "binding": json.dumps(binding),
                "cleanup_expiry": cleanup["qualificationExpiresAt"],
            },
        )
        if len(result.data or []) != 1:
            raise ValueError
        match = result.data[0]
        row = match["registry_row"]
        hushh_id = match["hushh_id"]
        if not isinstance(hushh_id, str) or not hushh_id:
            raise ValueError
        if row is None:
            if require_record:
                raise ValueError
        elif not _pending_hosted_choice(row, owner_id, hushh_id):
            raise ValueError
        return HostedPilotSelection(owner_id, hushh_id, deepcopy(row))
    except Exception as exc:  # noqa: BLE001 - missing policy/schema/read authority must deny
        raise HostedTierNotPermittedError("Hosted pilot selection is unavailable") from exc


def _pending_hosted_choice(row: object, owner_id: str, hushh_id: str) -> bool:
    if not isinstance(row, dict):
        return False
    metadata = row.get("backend_metadata") or {}
    return (
        row.get("user_id") == owner_id
        and row.get("hushh_id") == hushh_id
        and row.get("status") in {"pending", "unprovisioned"}
        and row.get("deployment_target") in {None, "gcp"}
        and not any(
            row.get(key)
            for key in (
                "user_cloud_project",
                "user_cloud_region",
                "user_cloud_bootstrap_sa",
                "user_cloud_authorized_at",
                "external_agent_id",
                "a2a_route",
                "pod_pubkey",
            )
        )
        and isinstance(metadata, dict)
        and not any(key in metadata for key in ("provisionAttempt", "erasure"))
    )


_PILOT_SELECTION_QUERY = """
SELECT assignment->>'hushhId' AS hushh_id, to_jsonb(r) AS registry_row
FROM public.hosted_pod_pilot_policy p
CROSS JOIN LATERAL jsonb_array_elements(p.assignments) WITH ORDINALITY AS a(assignment,slot)
LEFT JOIN public.personal_agent_registry r ON r.user_id=:owner
WHERE p.singleton AND p.environment='dev' AND p.expires_at>clock_timestamp()
 AND p.expires_at<=CAST(:cleanup_expiry AS timestamptz)
 AND p.source_revision=:sha AND p.image_digest=:digest
 AND p.model_binding=CAST(:binding AS jsonb)
 AND public.valid_hosted_pod_pilot_assignments(p.assignments) IS TRUE
 AND jsonb_array_length(p.assignments)=2
 AND assignment->>'ownerHash'=:owner_hash
 AND CASE WHEN slot=1 THEN p.attempt_a IS NULL ELSE p.attempt_b IS NULL END
 AND NOT EXISTS (SELECT 1 FROM public.account_deletion_tombstones
   WHERE user_id_hash=:owner_hash)
"""
