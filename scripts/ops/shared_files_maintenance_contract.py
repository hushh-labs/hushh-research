"""Fail-closed contract for an operator's bounded Shared Files verification window."""

from __future__ import annotations

import hashlib
import json
from typing import Any

FUNCTION = "hushh_files_operator_maintenance"
TRIGGER = "trg_hushh_files_operator_maintenance"
PROTOCOL = "operator_bucket_maintenance.v1"
BODY = """
DECLARE scoped boolean;
BEGIN
  IF TG_OP='INSERT' THEN scoped := NEW.bucket=TG_ARGV[0];
  ELSIF TG_OP='DELETE' THEN scoped := OLD.bucket=TG_ARGV[0];
  ELSE scoped := OLD.bucket=TG_ARGV[0] OR NEW.bucket=TG_ARGV[0]; END IF;
  IF scoped THEN
    RAISE EXCEPTION USING ERRCODE='55000',
      MESSAGE='Files enrollment is paused for verified storage maintenance';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
"""


class RecoveryRefused(RuntimeError):
    """Fixed reason only; never include owner information or provider bodies."""


def require(condition: bool, reason: str) -> None:
    if not condition:
        raise RecoveryRefused(reason)


def decoded(value: Any) -> Any:
    return json.loads(value) if isinstance(value, str) else value


def owner_prefix(owner: str) -> str:
    return (
        "shared-files/v1/"
        + hashlib.sha256(("hussh/shared-files/v1/" + owner).encode()).hexdigest()
    )


def library_prefix(row: dict) -> str:
    require(row["prefix"] == owner_prefix(row["user_id"]), "owner_prefix_mismatch")
    return row["prefix"] + "/" + str(row["library_id"]) + "/"


def identity(metadata: dict) -> dict:
    keys = ("name", "generation", "timeCreated", "projectNumber")
    require(
        all(isinstance(metadata.get(key), str) and metadata[key] for key in keys),
        "bucket_identity_missing",
    )
    return {key: metadata[key] for key in keys}


def writable_policy(metadata: dict) -> dict:
    policy = metadata.get("softDeletePolicy") or {"retentionDurationSeconds": "0"}
    require(
        isinstance(policy, dict)
        and set(policy) <= {"retentionDurationSeconds", "effectiveTime"},
        "policy_schema_unknown",
    )
    return {"retentionDurationSeconds": policy.get("retentionDurationSeconds", "0")}


def validate_bucket(row: dict, metadata: dict) -> None:
    admission = decoded(row["bucket_admission"])
    require(
        isinstance(admission, dict)
        and set(admission) == {"identity", "noSoftDeleteHistory"},
        "bucket_admission_invalid",
    )
    require(admission["identity"] == identity(metadata), "bucket_incarnation_changed")
    iam = metadata.get("iamConfiguration", {})
    require(
        iam.get("publicAccessPrevention") == "enforced"
        and iam.get("uniformBucketLevelAccess", {}).get("enabled") is True,
        "bucket_access_changed",
    )


def select_target(rows: list[dict], owner_hash: str) -> dict:
    targets = [
        row
        for row in rows
        if hashlib.sha256(row["user_id"].encode()).hexdigest().startswith(owner_hash)
    ]
    require(len(owner_hash) >= 16 and len(targets) == 1, "target_not_unique")
    target = targets[0]
    require(target["state"] == "erasing", "target_not_erasing")
    require(
        all(row["state"] == "active" or row is target for row in rows),
        "other_erasure_outstanding",
    )
    for row in rows:
        library_prefix(row)
    return target


def validate_initial(rows: list[dict]) -> None:
    require(bool(rows), "empty_cohort")
    require(
        all(
            not decoded(row["writes"])
            and row["lease_id"] is None
            and row["lease_until"] is None
            for row in rows
        ),
        "writer_not_quiescent",
    )


def validate_claim(target: dict, claims: list[dict]) -> None:
    require(len(claims) == 1, "deletion_intent_not_unique")
    claim = claims[0]
    receipt = decoded(claim["provider_cleanup_receipt"])
    require(
        claim.get("provider_qualified") is True,
        "canonical_deletion_qualification_failed",
    )
    require(
        claim["account_owner_id"] == target["user_id"]
        and claim["erasure_phase"] == "provider_cleanup"
        and claim["cleanup_intent_kind"] == "full_account",
        "deletion_intent_changed",
    )
    require(
        isinstance(receipt, dict)
        and receipt.get("version") in {1, 2}
        and receipt.get("cleanupId") == str(claim["provider_cleanup_id"])
        and receipt.get("localErasureAccepted") is True,
        "deletion_acceptance_unqualified",
    )
    require(
        receipt.get("ownerHash")
        == "sha256:" + hashlib.sha256(target["user_id"].strip().encode()).hexdigest(),
        "deletion_owner_mismatch",
    )
    items = receipt.get("items")
    require(isinstance(items, dict) and bool(items), "deletion_inventory_missing")
    require(
        all(
            isinstance(item, dict)
            and item.get("revocation")
            in {"revoked", "covered_by_group", "local_erasure_approved"}
            for item in items.values()
        ),
        "provider_effects_unsettled",
    )


def claim_fingerprint(claims: list[dict]) -> str:
    return hashlib.sha256(
        json.dumps(claims, sort_keys=True, default=str, separators=(",", ":")).encode()
    ).hexdigest()


def target_fingerprint(target: dict) -> str:
    return hashlib.sha256(
        (target["user_id"] + "/" + str(target["library_id"])).encode()
    ).hexdigest()


def inventory_digest(objects: list[dict], rows: list[dict]) -> str:
    active = [library_prefix(row) for row in rows if row["state"] == "active"]
    inventory = []
    for item in objects:
        name, generation = item.get("name"), item.get("generation")
        require(
            isinstance(name, str)
            and isinstance(generation, str)
            and generation.isdigit(),
            "object_inventory_invalid",
        )
        require(
            any(name.startswith(prefix) for prefix in active),
            "object_outside_active_library",
        )
        inventory.append((name, generation))
    return hashlib.sha256(
        json.dumps(sorted(inventory), separators=(",", ":")).encode()
    ).hexdigest()


def validate_markers(rows: list[dict], key: str, marker: dict) -> None:
    require(
        marker.get("protocol") == PROTOCOL
        and marker.get("state") == "maintenance"
        and marker.get("originalPolicy") == {"retentionDurationSeconds": "0"},
        "maintenance_contract_changed",
    )
    require(len(rows) == marker["cohortSize"], "maintenance_cohort_changed")
    for row in rows:
        require(
            decoded(row["writes"]) == {key: marker}
            and str(row["lease_id"]) == marker["operation"],
            "maintenance_ownership_changed",
        )
        require(row["bucket"] == marker["bucket"], "maintenance_bucket_changed")


def absence_receipt(target: dict, metadata: dict) -> dict:
    validate_bucket(target, metadata)
    return {
        "version": 1,
        "libraryId": str(target["library_id"]),
        "bucket": target["bucket"],
        "prefix": library_prefix(target),
        "complete": True,
        "writesFenced": True,
        "activeAndRetainedObjectsAbsent": True,
        "bucketIdentityVerified": True,
        "bucketIdentity": identity(metadata),
    }
