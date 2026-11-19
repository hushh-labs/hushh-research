"""Recovery must retain ownership, provider absence and crash-persistent guards."""

from __future__ import annotations

import hashlib
import sys
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest

OPS = Path(__file__).resolve().parents[3] / "scripts/ops"
sys.path.insert(0, str(OPS))
from reconcile_uat_shared_files import Provider  # noqa: E402
from shared_files_maintenance_contract import (  # noqa: E402
    PROTOCOL,
    RecoveryRefused,
    absence_receipt,
    inventory_digest,
    library_prefix,
    owner_prefix,
    select_target,
    validate_bucket,
    validate_claim,
    validate_initial,
    validate_markers,
    writable_policy,
)


def cohort():
    metadata = {
        "name": "synthetic-files",
        "generation": "1",
        "timeCreated": "2026-11-19T00:00:00Z",
        "projectNumber": "123",
        "metageneration": "2",
        "softDeletePolicy": {"retentionDurationSeconds": "0"},
        "iamConfiguration": {
            "publicAccessPrevention": "enforced",
            "uniformBucketLevelAccess": {"enabled": True},
        },
    }
    admission = {
        "identity": {
            key: metadata[key] for key in ("name", "generation", "timeCreated", "projectNumber")
        },
        "noSoftDeleteHistory": False,
    }
    rows = [
        {
            "user_id": owner,
            "library_id": str(uuid4()),
            "bucket": metadata["name"],
            "prefix": owner_prefix(owner),
            "bucket_admission": deepcopy(admission),
            "state": "erasing" if owner == "alice" else "active",
            "writes": {},
            "lease_id": None,
            "lease_until": None,
        }
        for owner in ("alice", "bob")
    ]
    return rows, metadata


def test_existing_cohort_requires_exact_owner_and_no_undispatched_writer():
    rows, metadata = cohort()
    target = select_target(rows, hashlib.sha256(b"alice").hexdigest())
    validate_initial(rows)
    validate_bucket(target, metadata)
    with pytest.raises(RecoveryRefused, match="object_outside_active_library"):
        inventory_digest([{"name": library_prefix(target) + "opaque", "generation": "1"}], rows)
    with pytest.raises(RecoveryRefused, match="object_outside_active_library"):
        inventory_digest([{"name": "unregistered/opaque", "generation": "1"}], rows)
    rows[1]["writes"] = {"pending": {"state": "sending"}}
    with pytest.raises(RecoveryRefused, match="writer_not_quiescent"):
        validate_initial(rows)


def test_canonical_qualification_cannot_be_replaced_by_selected_revoked_fields():
    rows, _ = cohort()
    cleanup = str(uuid4())
    receipt = {
        "version": 2,
        "cleanupId": cleanup,
        "ownerHash": "sha256:" + hashlib.sha256(b"alice").hexdigest(),
        "localErasureAccepted": True,
        "items": {"synthetic": {"revocation": "revoked"}},
    }
    claim = {
        "account_owner_id": "alice",
        "erasure_phase": "provider_cleanup",
        "cleanup_intent_kind": "full_account",
        "provider_cleanup_id": cleanup,
        "provider_cleanup_receipt": receipt,
        "provider_qualified": True,
    }
    validate_claim(rows[0], [claim])
    claim["provider_qualified"] = False
    with pytest.raises(RecoveryRefused, match="canonical_deletion_qualification_failed"):
        validate_claim(rows[0], [claim])
    claim["provider_qualified"] = True
    receipt["ownerHash"] = "sha256:" + hashlib.sha256(b"bob").hexdigest()
    with pytest.raises(RecoveryRefused, match="deletion_owner_mismatch"):
        validate_claim(rows[0], [claim])


@pytest.mark.parametrize("status", [400, 403, 500])
def test_retained_listing_failure_is_not_empty(status):
    response = SimpleNamespace(status_code=status, json=lambda: {})
    provider = Provider(
        SimpleNamespace(get=lambda *_, **__: response), "synthetic-files", str(uuid4())
    )
    with pytest.raises(RecoveryRefused, match="retained_listing_unconfirmed"):
        provider.objects(retained=True)


def test_paginated_empty_page_cannot_establish_absence():
    response = SimpleNamespace(status_code=200, json=lambda: {"items": [], "nextPageToken": "more"})
    provider = Provider(
        SimpleNamespace(get=lambda *_, **__: response), "synthetic-files", str(uuid4())
    )
    with pytest.raises(RecoveryRefused, match="empty_paginated_listing"):
        provider.objects(retained=True)


def test_exact_maintenance_marker_survives_an_owner_reset_and_rejects_adoption():
    rows, _ = cohort()
    operation = str(uuid4())
    marker = {
        "protocol": PROTOCOL,
        "state": "maintenance",
        "operation": operation,
        "bucket": "synthetic-files",
        "cohortSize": 2,
        "originalPolicy": {"retentionDurationSeconds": "0"},
    }
    key = "operator-maintenance-v1:" + operation
    for row in rows:
        row.update(writes={key: marker}, lease_id=operation)
    rows[1]["state"] = "erasing"  # Preserve the owner's concurrent request.
    validate_markers(rows, key, marker)
    rows[1]["writes"] = {key: {**marker, "operation": str(uuid4())}}
    with pytest.raises(RecoveryRefused, match="maintenance_ownership_changed"):
        validate_markers(rows, key, marker)


def test_restoration_allows_provider_managed_time_without_forging_no_history():
    rows, metadata = cohort()
    metadata["softDeletePolicy"]["effectiveTime"] = "2026-11-19T01:00:00Z"
    assert writable_policy(metadata) == {"retentionDurationSeconds": "0"}
    receipt = absence_receipt(rows[0], metadata)
    assert receipt["complete"] is True
    assert rows[0]["bucket_admission"]["noSoftDeleteHistory"] is False
    metadata["generation"] = "2"
    with pytest.raises(RecoveryRefused, match="bucket_incarnation_changed"):
        absence_receipt(rows[0], metadata)


def test_unknown_writable_policy_is_not_silently_overwritten():
    with pytest.raises(RecoveryRefused, match="policy_schema_unknown"):
        writable_policy(
            {"softDeletePolicy": {"retentionDurationSeconds": "0", "unknownFutureControl": True}}
        )


@pytest.mark.parametrize(
    "case", ["exact", "gfe_suffix", "actor", "log", "type", "operation", "before_dispatch"]
)
def test_uncertain_policy_requires_durable_intent_and_exact_operator_audit(case):
    from reconcile_uat_shared_files import AUDIT_LOG, AUDIT_TYPE, POLICY_SECONDS

    rows, metadata = cohort()
    operation = str(uuid4())
    actor = "synthetic-operator@example.test"
    reason = "hushh-uat-files-recovery/" + operation
    marker = {
        "operator": actor,
        "bucket": "synthetic-files",
        "identity": rows[0]["bucket_admission"]["identity"],
        "policyIntent": {
            "reason": reason,
            "principal": actor,
            "seconds": POLICY_SECONDS,
            "metageneration": "2",
            "dispatchedAt": "2026-11-19T00:00:00Z",
        },
    }
    current = {
        **metadata,
        "metageneration": "3",
        "softDeletePolicy": {"retentionDurationSeconds": POLICY_SECONDS},
    }
    entry = {
        "logName": AUDIT_LOG if case != "log" else "projects/hushh-pda-uat/logs/custom",
        "timestamp": "2026-11-19T00:00:01Z"
        if case != "before_dispatch"
        else "2026-11-18T23:59:59Z",
        "resource": {"type": "gcs_bucket", "labels": {"bucket_name": "synthetic-files"}},
        "protoPayload": {
            "@type": AUDIT_TYPE if case != "type" else "untrusted-type",
            "serviceName": "storage.googleapis.com",
            "authenticationInfo": {
                "principalEmail": actor if case != "actor" else "unrelated@example.test"
            },
            "requestMetadata": {
                "callerSuppliedUserAgent": reason
                + (
                    ",gzip(gfe),gzip(gfe)"
                    if case == "gfe_suffix"
                    else "-other"
                    if case == "operation"
                    else ""
                )
            },
            "methodName": "storage.buckets.update",
        },
    }
    response = SimpleNamespace(status_code=200, json=lambda: {"entries": [entry]})
    provider = Provider(
        SimpleNamespace(post=lambda *_, **__: response), "synthetic-files", operation
    )
    if case in {"exact", "gfe_suffix"}:
        assert provider.reconcile_policy_intent(marker, current) == "3"
    else:
        with pytest.raises(RecoveryRefused, match="policy_ownership_uncertain"):
            provider.reconcile_policy_intent(marker, current)
    with pytest.raises(RecoveryRefused, match="policy_intent_missing"):
        provider.reconcile_policy_intent({**marker, "policyIntent": {}}, current)
    with pytest.raises(RecoveryRefused, match="policy_revision_unowned"):
        provider.reconcile_policy_intent(marker, {**current, "metageneration": "4"})
