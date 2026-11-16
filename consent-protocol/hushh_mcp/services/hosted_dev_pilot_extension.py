# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
"""Dev-only Cohort-2 extension slot for Hussh-Hosted private pods.

Cohort 1 (``public.hosted_pod_pilot_policy``) remains immutable so the two
existing October 2026 synthetic pilot pods keep their retained admission,
upgrade, and erasure authority without altering checksum-pinned SQL functions.
This module admits one explicit hash-bound Dev personal pilot slot under the
same $200 work / $50 cleanup reservation, monotonic checkpoint CAS, and
per-project bootstrap isolation, hard-fenced to ``deploy_lane() == "dev"``.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
from collections.abc import Mapping
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any
from uuid import UUID

if TYPE_CHECKING:
    from hushh_mcp.services.hosted_tier_guard import HostedPilotSelection

from sqlalchemy import text

from hushh_mcp.managed_ai_config import load_profile, profile_hash
from hushh_mcp.services.dev_simulation_guard import deploy_lane
from hushh_mcp.services.personal_agent_hosting import _unassigned_placement_clear

CONFIG_PATH = Path(__file__).resolve().parents[2] / "config/dev-hosted-pilot-extension.json"
OVERRIDE_ENV = "HUSSH_DEV_HOSTED_PILOT_EXTENSION_JSON"
_ACTIVE_PHASES = frozenset(
    {"reserved", "substrate", "host_requested", "host_acknowledged", "connecting"}
)


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _parse_iso(raw: str) -> datetime:
    parsed = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("Timestamp must include timezone")
    return parsed.astimezone(timezone.utc)


def _sha256_prefixed(value: str) -> str:
    return "sha256:" + hashlib.sha256(value.encode("utf-8")).hexdigest()


def _contract_hash(contract: Mapping[str, Any]) -> str:
    return hashlib.sha256(
        json.dumps(contract, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def _dev_model_binding() -> dict[str, str]:
    profile = load_profile("dev")
    return {
        "provider": "gemini",
        "model": profile["text_model"],
        "project": profile["project"],
        "profileHash": profile_hash(profile),
    }


def load_extension_policy() -> dict[str, Any] | None:
    """Return the validated Dev Slot-3 extension policy, or None outside Dev."""
    if deploy_lane() != "dev":
        return None
    override = os.getenv(OVERRIDE_ENV, "").strip()
    try:
        raw = json.loads(override) if override else json.loads(CONFIG_PATH.read_text("utf-8"))
        if (
            not isinstance(raw, dict)
            or raw.get("schemaVersion") != 1
            or raw.get("environment") != "dev"
            or str(UUID(str(raw["policyId"]))) != raw["policyId"]
            or raw.get("workBudgetCents") != 20000
            or raw.get("cleanupReserveCents") != 5000
            or raw.get("modelBinding") != _dev_model_binding()
        ):
            return None
        _parse_iso(raw["expiresAt"])
        assignment = raw["assignment"]
        if not isinstance(assignment, dict) or not all(
            key in assignment
            for key in (
                "ownerHash",
                "hushhId",
                "project",
                "region",
                "bootstrapContract",
                "preparationContract",
            )
        ):
            return None
        return deepcopy(raw)
    except Exception:
        return None


def _build_admission(policy: Mapping[str, Any]) -> dict[str, Any]:
    assignment = deepcopy(dict(policy["assignment"]))
    admission: dict[str, Any] = {
        "version": 1,
        "policyId": policy["policyId"],
        "environment": "dev",
        "sourceRevision": policy["sourceRevision"],
        "imageDigest": policy["imageDigest"],
        "modelBinding": deepcopy(dict(policy["modelBinding"])),
        "assignment": assignment,
        "workBudgetCents": int(policy["workBudgetCents"]),
        "cleanupReserveCents": int(policy["cleanupReserveCents"]),
        "expiresAt": policy["expiresAt"],
    }
    if "bootstrapContract" in assignment:
        admission["bootstrapContractHash"] = _contract_hash(assignment["bootstrapContract"])
    if "preparationContract" in assignment:
        admission["preparationContractHash"] = _contract_hash(assignment["preparationContract"])
    return admission


def is_extension_admission(admission: Any) -> bool:
    policy = load_extension_policy()
    return bool(
        policy is not None
        and isinstance(admission, Mapping)
        and admission.get("policyId") == policy["policyId"]
    )


def is_extension_row(row: Any) -> bool:
    if not isinstance(row, Mapping):
        return False
    metadata = row.get("backend_metadata")
    if not isinstance(metadata, Mapping):
        return False
    attempt = metadata.get("provisionAttempt")
    if isinstance(attempt, Mapping) and is_extension_admission(attempt.get("hostedAdmission")):
        return True
    erasure = metadata.get("erasure")
    if isinstance(erasure, Mapping):
        snap = erasure.get("registrySnapshot")
        if isinstance(snap, Mapping):
            snap_meta = snap.get("backend_metadata")
            if isinstance(snap_meta, Mapping):
                snap_attempt = snap_meta.get("provisionAttempt")
                if isinstance(snap_attempt, Mapping) and is_extension_admission(
                    snap_attempt.get("hostedAdmission")
                ):
                    return True
    return False


def matches_extension_intent(
    intent: Mapping[str, Any], *, observed: Mapping[str, Any] | None = None
) -> bool:
    if observed is not None and is_extension_row(observed):
        return True
    policy = load_extension_policy()
    if policy is None:
        return False
    owner_id = str(intent.get("user_id") or "")
    hushh_id = str(intent.get("hushh_id") or "")
    assignment = policy["assignment"]
    return bool(
        owner_id
        and _sha256_prefixed(owner_id) == assignment["ownerHash"]
        and hushh_id == assignment["hushhId"]
    )


def _eligible_pending_or_detached_row(row: Any, owner_id: str, hushh_id: str) -> bool:
    if not isinstance(row, dict):
        return False
    metadata = row.get("backend_metadata") or {}
    if (
        row.get("user_id") != owner_id
        or row.get("hushh_id") != hushh_id
        or row.get("status") not in {"pending", "unprovisioned"}
        or row.get("deployment_target") not in {None, "gcp"}
        or not isinstance(metadata, dict)
        or any(key in metadata for key in ("provisionAttempt", "erasure"))
    ):
        return False
    cleared = dict(row)
    cleared["deployment_target"] = None
    return bool(_unassigned_placement_clear(cleared))


async def select_extension_slot(
    owner_id: str,
    registry: Any,
    *,
    image: str,
    release: Mapping[str, Any] | None,
    require_record: bool = False,
    now: datetime | None = None,
) -> HostedPilotSelection | None:
    """Admit the Dev Slot-3 owner for ``/byoc/hosted/select`` when eligible."""
    from hushh_mcp.services.hosted_tier_guard import HostedPilotSelection
    from hushh_mcp.services.pod_release import image_digest

    policy = load_extension_policy()
    instant = now or _utc_now()
    if (
        policy is None
        or not owner_id
        or owner_id != owner_id.strip()
        or release is None
        or release.get("sourceRevision") != policy["sourceRevision"]
        or image_digest(image) != policy["imageDigest"]
        or _parse_iso(policy["expiresAt"]) <= instant
    ):
        return None
    assignment = policy["assignment"]
    owner_hash = _sha256_prefixed(owner_id)
    if assignment["ownerHash"] != owner_hash:
        return None
    result = await asyncio.to_thread(
        registry._db().execute_raw,
        "SELECT "
        "(SELECT to_jsonb(r) FROM public.personal_agent_registry r WHERE r.user_id=:owner) AS registry_row, "
        "EXISTS(SELECT 1 FROM public.account_deletion_tombstones WHERE user_id_hash=:owner_hash) AS tombstoned, "
        "EXISTS(SELECT 1 FROM public.personal_agent_registry x WHERE x.user_id<>:owner "
        "  AND x.backend_metadata->'provisionAttempt'->'hostedAdmission'->>'policyId'=:policy_id) AS claimed_other",
        {"owner": owner_id, "owner_hash": owner_hash, "policy_id": policy["policyId"]},
    )
    if not result.data:
        return None
    record = result.data[0]
    if record.get("tombstoned") is True or record.get("claimed_other") is True:
        return None
    row = record.get("registry_row")
    hushh_id = assignment["hushhId"]
    if row is None:
        if require_record:
            return None
        return HostedPilotSelection(owner_id, hushh_id, None)
    if not _eligible_pending_or_detached_row(row, owner_id, hushh_id):
        return None
    return HostedPilotSelection(owner_id, hushh_id, deepcopy(row))


def _claim_sync(
    db: Any,
    *,
    policy: dict[str, Any],
    observed: dict[str, Any] | None,
    intent: dict[str, Any],
    attempt_id: str,
) -> dict[str, Any]:
    owner = str(intent.get("user_id") or "")
    assignment = policy["assignment"]
    if (
        deploy_lane() != "dev"
        or _parse_iso(policy["expiresAt"]) <= _utc_now()
        or intent.get("deployment_target") != "gcp"
        or any(key.startswith("user_cloud_") for key in intent)
        or _sha256_prefixed(owner) != assignment["ownerHash"]
        or intent.get("hushh_id") != assignment["hushhId"]
    ):
        raise PermissionError("hosted extension pilot admission unavailable")
    expected_admission = _build_admission(policy)
    retained = ((observed or {}).get("backend_metadata") or {}).get("provisionAttempt") or {}
    if isinstance(retained, dict) and retained.get("hostedAdmission"):
        if (
            not isinstance(observed, dict)
            or observed.get("status") not in {"provisioning", "connecting"}
            or "erasure" in (observed.get("backend_metadata") or {})
            or retained.get("ownerId") != owner
            or retained.get("attemptId") != attempt_id
            or retained.get("phase") not in _ACTIVE_PHASES
            or retained.get("intent") != intent
            or retained.get("hostedAdmission") != expected_admission
        ):
            raise PermissionError("hosted extension attempt requires reconciliation")
        verify = db.execute_raw(
            "SELECT to_jsonb(r)=to_jsonb(jsonb_populate_record("
            "NULL::public.personal_agent_registry,CAST(:expected AS jsonb))) AS unchanged "
            "FROM public.personal_agent_registry r WHERE r.user_id=:owner",
            {"owner": owner, "expected": json.dumps(observed, default=_json_default_iso)},
        )
        if not (verify.data and verify.data[0].get("unchanged") is True):
            raise PermissionError("hosted extension observation changed")
        return deepcopy(retained)

    engine = getattr(db, "engine", None)
    if engine is not None:
        with engine.begin() as conn:
            row = (
                conn.execute(
                    text(
                        "SELECT public.claim_personal_agent_provision("
                        ":owner,:attempt,CAST(:observed AS jsonb),CAST(:intent AS jsonb)"
                        ") AS reservation"
                    ),
                    {
                        "owner": owner,
                        "attempt": attempt_id,
                        "observed": json.dumps(observed, default=_json_default_iso),
                        "intent": json.dumps(intent),
                    },
                )
                .mappings()
                .one()
            )
            claimed = dict(row["reservation"])
            enriched = {**claimed, "hostedAdmission": expected_admission}
            conn.execute(
                text("SELECT set_config('hussh.provision_attempt', :attempt, true)"),
                {"attempt": attempt_id},
            )
            updated = (
                conn.execute(
                    text(
                        "UPDATE public.personal_agent_registry "
                        "SET backend_metadata=jsonb_set(backend_metadata,'{provisionAttempt}',CAST(:enriched AS jsonb)),"
                        "    updated_at=clock_timestamp() "
                        "WHERE user_id=:owner AND backend_metadata->'provisionAttempt'->>'attemptId'=:attempt "
                        "RETURNING backend_metadata->'provisionAttempt' AS reservation"
                    ),
                    {"owner": owner, "attempt": attempt_id, "enriched": json.dumps(enriched)},
                )
                .mappings()
                .one()
            )
            return dict(updated["reservation"])

    claimed_res = db.execute_raw(
        "SELECT public.claim_personal_agent_provision(:owner,:attempt,"
        "CAST(:observed AS jsonb),CAST(:intent AS jsonb)) AS reservation",
        {
            "owner": owner,
            "attempt": attempt_id,
            "observed": json.dumps(observed, default=_json_default_iso),
            "intent": json.dumps(intent),
        },
    )
    claimed = dict(claimed_res.data[0]["reservation"])
    enriched = {**claimed, "hostedAdmission": expected_admission}
    updated_res = db.execute_raw(
        "WITH _tok AS (SELECT pg_advisory_xact_lock(hashtextextended(:owner,171)),"
        "pg_advisory_xact_lock(hashtextextended(:owner,198)),"
        "set_config('hussh.provision_attempt',:attempt,true)) "
        "UPDATE public.personal_agent_registry "
        "SET backend_metadata=jsonb_set(backend_metadata,'{provisionAttempt}',CAST(:enriched AS jsonb)),"
        "    updated_at=clock_timestamp() "
        "FROM _tok WHERE user_id=:owner AND backend_metadata->'provisionAttempt'->>'attemptId'=:attempt "
        "RETURNING backend_metadata->'provisionAttempt' AS reservation",
        {"owner": owner, "attempt": attempt_id, "enriched": json.dumps(enriched)},
    )
    return dict(updated_res.data[0]["reservation"])


async def claim_extension_provision(
    db: Any, *, observed: dict[str, Any] | None, intent: dict[str, Any], attempt_id: str
) -> dict[str, Any]:
    policy = load_extension_policy()
    if policy is None:
        raise PermissionError("hosted extension pilot unavailable")
    return await asyncio.to_thread(
        _claim_sync, db, policy=policy, observed=observed, intent=intent, attempt_id=attempt_id
    )


def _load_owner_row_sync(db: Any, owner_id: str) -> tuple[dict[str, Any] | None, bool]:
    res = db.execute_raw(
        "SELECT (SELECT to_jsonb(r) FROM public.personal_agent_registry r WHERE r.user_id=:owner) AS row_json,"
        "EXISTS(SELECT 1 FROM public.account_deletion_tombstones WHERE user_id_hash=:owner_hash) AS tombstoned",
        {"owner": owner_id, "owner_hash": _sha256_prefixed(owner_id)},
    )
    if not res.data:
        return None, False
    return res.data[0].get("row_json"), bool(res.data[0].get("tombstoned"))


def _admission_current_row(
    row: dict[str, Any] | None,
    tombstoned: bool,
    *,
    policy: Mapping[str, Any],
    owner_id: str,
    attempt_id: str,
    admission: Mapping[str, Any],
    project_observation: dict[str, Any] | None,
    require_unexpired: bool = True,
) -> bool:
    if tombstoned or not isinstance(row, dict):
        return False
    if require_unexpired and _parse_iso(policy["expiresAt"]) <= _utc_now():
        return False
    expected = _build_admission(policy)
    metadata = row.get("backend_metadata") or {}
    attempt = metadata.get("provisionAttempt") if isinstance(metadata, dict) else None
    if (
        row.get("user_id") != owner_id
        or row.get("deployment_target") != "gcp"
        or row.get("status") not in {"provisioning", "connecting"}
        or "erasure" in metadata
        or not isinstance(attempt, dict)
        or attempt.get("ownerId") != owner_id
        or attempt.get("attemptId") != attempt_id
        or attempt.get("phase") not in _ACTIVE_PHASES
        or attempt.get("hostedAdmission") != expected
        or dict(admission) != expected
        or row.get("hushh_id") != expected["assignment"]["hushhId"]
    ):
        return False
    observed_proj = attempt.get("evidence", {}).get("reserved", {}).get("projectObservation")
    return bool(observed_proj == project_observation)


async def extension_current(
    db: Any,
    *,
    owner_id: str,
    attempt_id: str,
    admission: dict[str, Any],
    project_observation: dict[str, Any] | None = None,
    purpose: str | None = None,
) -> bool:
    policy = load_extension_policy()
    if policy is None:
        return False
    row, tombstoned = await asyncio.to_thread(_load_owner_row_sync, db, owner_id)
    if not _admission_current_row(
        row,
        tombstoned,
        policy=policy,
        owner_id=owner_id,
        attempt_id=attempt_id,
        admission=admission,
        project_observation=project_observation,
    ):
        return False
    if purpose is None:
        return True
    if purpose not in {"bootstrap", "provision"} or row is None:
        return False
    attempt = row["backend_metadata"]["provisionAttempt"]
    prep = attempt.get("evidence", {}).get("reserved", {}).get("hostedPreparation") or {}
    completed = prep.get("completed")
    expected_steps = admission["assignment"]["preparationContract"]["steps"]
    if (
        prep.get("phase") != "observed"
        or prep.get("ownerId") != owner_id
        or prep.get("attemptId") != attempt_id
        or prep.get("planDigest") != admission.get("preparationContractHash")
        or not isinstance(completed, list)
        or not (3 <= len(completed) <= 5)
        or (purpose == "provision" and len(completed) != 5)
        or any(not isinstance(x, dict) or x.get("ok") is not True for x in completed)
        or [x.get("step") for x in completed] != expected_steps[: len(completed)]
        or attempt.get("evidence", {}).get("reserved", {}).get("projectObservation") is None
        or attempt.get("evidence", {}).get("reserved", {}).get("projectAuthorization") is None
    ):
        return False
    return True


def _update_attempt_sync(
    db: Any,
    *,
    owner_id: str,
    attempt_id: str,
    expected_attempt: dict[str, Any],
    next_attempt: dict[str, Any],
) -> bool:
    res = db.execute_raw(
        "WITH _tok AS (SELECT pg_advisory_xact_lock(hashtextextended(:owner,171)),"
        "pg_advisory_xact_lock(hashtextextended(:owner,198)),"
        "set_config('hussh.provision_attempt',:attempt,true)) "
        "UPDATE public.personal_agent_registry "
        "SET backend_metadata=jsonb_set(backend_metadata,'{provisionAttempt}',CAST(:next_attempt AS jsonb)),"
        "    updated_at=clock_timestamp() "
        "FROM _tok "
        "WHERE user_id=:owner AND NOT (backend_metadata ? 'erasure') "
        "  AND backend_metadata->'provisionAttempt'=CAST(:expected_attempt AS jsonb) "
        "RETURNING user_id",
        {
            "owner": owner_id,
            "attempt": attempt_id,
            "expected_attempt": json.dumps(expected_attempt),
            "next_attempt": json.dumps(next_attempt),
        },
    )
    return bool(res.data)


async def extension_publish(
    db: Any, *, kind: str, owner_id: str, attempt_id: str, checkpoint: dict[str, Any]
) -> bool:
    policy = load_extension_policy()
    if policy is None or kind not in {"bootstrap", "preparation"}:
        return False
    row, tombstoned = await asyncio.to_thread(_load_owner_row_sync, db, owner_id)
    if tombstoned or not isinstance(row, dict):
        return False
    metadata = row.get("backend_metadata") or {}
    attempt = metadata.get("provisionAttempt") if isinstance(metadata, dict) else None
    if not isinstance(attempt, dict) or attempt.get("phase") != "reserved":
        return False
    admission = attempt.get("hostedAdmission")
    if not isinstance(admission, dict) or admission != _build_admission(policy):
        return False
    journal_key = "hostedCheckpoint" if kind == "bootstrap" else "hostedPreparation"
    contract = admission["assignment"][
        "bootstrapContract" if kind == "bootstrap" else "preparationContract"
    ]
    contract_hash = admission[
        "bootstrapContractHash" if kind == "bootstrap" else "preparationContractHash"
    ]
    if (
        checkpoint.get("version") != 1
        or checkpoint.get("ownerId") != owner_id
        or checkpoint.get("attemptId") != attempt_id
        or checkpoint.get("planDigest") != contract_hash
        or checkpoint.get("phase") not in {"intent", "observed"}
        or not isinstance(checkpoint.get("expectedGeneration"), int)
        or checkpoint.get("generation") != checkpoint["expectedGeneration"] + 1
        or not isinstance(checkpoint.get("completed"), list)
    ):
        return False
    prior = attempt.get("evidence", {}).get("reserved", {}).get(journal_key)
    if prior == checkpoint:
        return bool(checkpoint.get("phase") == "observed")
    prior_gen = int((prior or {}).get("generation", 0))
    if checkpoint["expectedGeneration"] != prior_gen:
        return False
    prior_completed = list((prior or {}).get("completed", []))
    completed = checkpoint["completed"]
    if checkpoint["phase"] == "intent":
        if (
            _parse_iso(policy["expiresAt"]) <= _utc_now()
            or (prior is not None and prior.get("phase") != "observed")
            or completed != prior_completed
            or any(x.get("ok") is not True for x in completed)
            or len(completed) >= len(contract["steps"])
            or contract["steps"][len(completed)] != checkpoint.get("step")
        ):
            return False
    else:
        if (
            not isinstance(prior, dict)
            or prior.get("phase") != "intent"
            or prior.get("step") != checkpoint.get("step")
            or len(completed) != len(prior_completed) + 1
            or completed[:-1] != prior_completed
            or completed[-1].get("step") != checkpoint.get("step")
        ):
            return False
    next_attempt = deepcopy(attempt)
    evidence = next_attempt.setdefault("evidence", {})
    reserved = evidence.setdefault("reserved", {})
    reserved[journal_key] = deepcopy(checkpoint)
    return await asyncio.to_thread(
        _update_attempt_sync,
        db,
        owner_id=owner_id,
        attempt_id=attempt_id,
        expected_attempt=attempt,
        next_attempt=next_attempt,
    )


async def extension_retain_project(
    db: Any, *, owner_id: str, attempt_id: str, observation: dict[str, Any]
) -> bool:
    policy = load_extension_policy()
    if policy is None:
        return False
    if (
        not isinstance(observation, dict)
        or set(observation) != {"projectId", "projectNumber", "lifecycleState"}
        or observation.get("lifecycleState") != "ACTIVE"
        or observation.get("projectId") != policy["assignment"]["project"]
        or not isinstance(observation.get("projectNumber"), str)
        or not observation["projectNumber"].isdigit()
    ):
        return False
    row, tombstoned = await asyncio.to_thread(_load_owner_row_sync, db, owner_id)
    if tombstoned or not isinstance(row, dict):
        return False
    attempt = (row.get("backend_metadata") or {}).get("provisionAttempt")
    if (
        not isinstance(attempt, dict)
        or attempt.get("ownerId") != owner_id
        or attempt.get("attemptId") != attempt_id
        or attempt.get("phase") != "reserved"
        or attempt.get("hostedAdmission") != _build_admission(policy)
    ):
        return False
    existing = attempt.get("evidence", {}).get("reserved", {}).get("projectObservation")
    if existing is not None:
        return bool(existing == observation)
    next_attempt = deepcopy(attempt)
    next_attempt.setdefault("evidence", {}).setdefault("reserved", {})["projectObservation"] = (
        deepcopy(observation)
    )
    return await asyncio.to_thread(
        _update_attempt_sync,
        db,
        owner_id=owner_id,
        attempt_id=attempt_id,
        expected_attempt=attempt,
        next_attempt=next_attempt,
    )


async def extension_retain_authorization(db: Any, *, owner_id: str, attempt_id: str) -> bool:
    policy = load_extension_policy()
    if policy is None:
        return False
    row, tombstoned = await asyncio.to_thread(_load_owner_row_sync, db, owner_id)
    if tombstoned or not isinstance(row, dict):
        return False
    attempt = (row.get("backend_metadata") or {}).get("provisionAttempt")
    if (
        not isinstance(attempt, dict)
        or attempt.get("ownerId") != owner_id
        or attempt.get("attemptId") != attempt_id
        or attempt.get("phase") != "reserved"
        or attempt.get("hostedAdmission") != _build_admission(policy)
    ):
        return False
    prep = attempt.get("evidence", {}).get("reserved", {}).get("hostedPreparation") or {}
    completed = prep.get("completed") or []
    auth_steps = [
        x
        for x in completed
        if isinstance(x, dict) and x.get("step") == "authorize_project" and x.get("ok") is True
    ]
    if prep.get("phase") != "observed" or len(auth_steps) != 1:
        return False
    caller = attempt["hostedAdmission"]["assignment"]["bootstrapContract"]["plan"]["federation"][
        "impersonation"
    ]["granted_to"]
    retained = {
        "intent": {
            "ownerId": owner_id,
            "jobId": attempt_id,
            "project": attempt["hostedAdmission"]["assignment"]["project"],
            "callerEmail": caller,
        },
        "receipt": deepcopy(auth_steps[0]["authorizationReceipt"]),
    }
    existing = attempt.get("evidence", {}).get("reserved", {}).get("projectAuthorization")
    if existing is not None:
        return bool(existing == retained)
    next_attempt = deepcopy(attempt)
    next_attempt.setdefault("evidence", {}).setdefault("reserved", {})["projectAuthorization"] = (
        retained
    )
    return await asyncio.to_thread(
        _update_attempt_sync,
        db,
        owner_id=owner_id,
        attempt_id=attempt_id,
        expected_attempt=attempt,
        next_attempt=next_attempt,
    )


def _json_default_iso(value: Any) -> str:
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value)


def _normalize_observed_row_sync(db: Any, observed: Mapping[str, Any]) -> dict[str, Any]:
    serialized = json.dumps(dict(observed), default=_json_default_iso)
    try:
        res = db.execute_raw(
            "SELECT to_jsonb(jsonb_populate_record("
            "NULL::public.personal_agent_registry,CAST(:expected AS jsonb))) AS norm_row",
            {"expected": serialized},
        )
        if res.data and isinstance(res.data[0].get("norm_row"), dict):
            return dict(res.data[0]["norm_row"])
    except Exception:
        pass
    loaded: dict[str, Any] = json.loads(serialized)
    return loaded


async def extension_retained_current(db: Any, *, owner_id: str, observed: dict[str, Any]) -> bool:
    policy = load_extension_policy()
    if policy is None or not isinstance(observed, dict):
        return False
    from hushh_mcp.services.hosted_gcp_placement import retained_hosted_placement

    row, _ = await asyncio.to_thread(_load_owner_row_sync, db, owner_id)
    if not isinstance(row, dict) or row.get("user_id") != owner_id:
        return False
    attempt = (observed.get("backend_metadata") or {}).get("provisionAttempt") or {}
    if attempt.get("hostedAdmission") != _build_admission(policy):
        return False
    if retained_hosted_placement(observed) is None:
        return False
    norm_observed = await asyncio.to_thread(_normalize_observed_row_sync, db, observed)
    erasure_snap = ((row.get("backend_metadata") or {}).get("erasure") or {}).get(
        "registrySnapshot"
    )
    return bool(row == norm_observed or erasure_snap == norm_observed)


async def extension_upgrade_current(
    db: Any, *, owner_id: str, lease: str, observed: dict[str, Any], work: bool = True
) -> bool:
    policy = load_extension_policy()
    if policy is None or not lease or not isinstance(observed, dict):
        return False
    if work and _parse_iso(policy["expiresAt"]) <= _utc_now():
        return False
    row, tombstoned = await asyncio.to_thread(_load_owner_row_sync, db, owner_id)
    if tombstoned or not isinstance(row, dict):
        return False
    norm_observed = await asyncio.to_thread(_normalize_observed_row_sync, db, observed)
    if row != norm_observed:
        return False
    metadata = row.get("backend_metadata") or {}
    if (
        row.get("status") != "provisioned"
        or row.get("deployment_target") != "gcp"
        or metadata.get("upgradeLease") != lease
        or "erasure" in metadata
    ):
        return False
    return await extension_retained_current(db, owner_id=owner_id, observed=observed)


async def extension_cleanup_current(db: Any, *, owner_id: str, reservation: dict[str, Any]) -> bool:
    policy = load_extension_policy()
    if policy is None or not isinstance(reservation, dict):
        return False
    row, _ = await asyncio.to_thread(_load_owner_row_sync, db, owner_id)
    if (
        not isinstance(row, dict)
        or row.get("status") != "suspended"
        or row.get("deployment_target") != "gcp"
        or (row.get("backend_metadata") or {}).get("erasure") != reservation
    ):
        return False
    snap = reservation.get("registrySnapshot")
    if not isinstance(snap, dict):
        return False
    attempt = (snap.get("backend_metadata") or {}).get("provisionAttempt") or {}
    return bool(attempt.get("hostedAdmission") == _build_admission(policy))
