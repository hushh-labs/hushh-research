"""Operator-only reconciliation of legacy GCP recovery inventory.

This is not resource adoption or bootstrap. An authenticated operator supplies
fresh provider reads and complete Admin Activity history, qualified against the
original provision window. Only bucket/key evidence is added; other resources
remain unqualified. The original receipt and bounded audit references survive.
No public route, credential, cloud mutation or owner approval is introduced.
"""

from __future__ import annotations

import hashlib
import json
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import text

from hushh_mcp.services.byoc_substrate import (
    RECEIPT_VERSION,
    SubstrateReceipt,
    _bucket_creation_identity,
    _kms_key_creation_identity,
    plan_digest,
    resource_ids,
)
from hushh_mcp.services.byoc_substrate_inventory import merge_substrate_inventory
from hushh_mcp.services.personal_agent_registry_repo import upgrade_host_snapshot


class InventoryReconciliationRefused(ValueError):
    """Evidence or lifecycle does not qualify this metadata-only correction."""


def _require(condition: bool, code: str) -> None:
    if not condition:
        raise InventoryReconciliationRefused(code)


def _at(value: Any) -> datetime:
    try:
        result = value if isinstance(value, datetime) else datetime.fromisoformat(value)
        _require(result.utcoffset() is not None, "INVENTORY_TIME_UNCONFIRMED")
        return result.astimezone(timezone.utc)
    except (TypeError, ValueError) as exc:
        raise InventoryReconciliationRefused("INVENTORY_TIME_UNCONFIRMED") from exc


def _digest(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":"), default=str).encode()
    ).hexdigest()


def _creation_history(
    history: dict,
    *,
    name: str,
    kind: str,
    principal: str,
    created: datetime,
    started: datetime,
    finished: datetime,
    observed: datetime,
) -> list[dict]:
    _require(
        history.get("complete") is True
        and history.get("http") == 200
        and _at(history.get("from")) <= started
        and _at(history.get("through")) >= observed,
        "INVENTORY_HISTORY_INCOMPLETE",
    )
    entries = history.get("entries")
    if not isinstance(entries, list) or not 1 <= len(entries) <= 128:
        raise InventoryReconciliationRefused("INVENTORY_HISTORY_INVALID")
    create = "storage.buckets.create" if kind == "gcs_bucket" else "CreateCryptoKey"
    policy = "storage.setIamPermissions" if kind == "gcs_bucket" else "SetIamPolicy"
    receipts: list[dict] = []
    creations = []
    for entry in entries:
        _require(isinstance(entry, dict), "INVENTORY_HISTORY_INVALID")
        insert_id = entry.get("insertId")
        _require(
            isinstance(insert_id, str)
            and 1 <= len(insert_id) <= 128
            and entry.get("resource") == name
            and entry.get("statusCode") == 0
            and entry.get("method") in {create, policy}
            and started <= _at(entry.get("timestamp")) <= observed,
            "INVENTORY_HISTORY_CHANGED",
        )
        receipt = {
            key: entry.get(key)
            for key in ("insertId", "timestamp", "resource", "method", "principal", "statusCode")
        }
        _require(receipt not in receipts, "INVENTORY_HISTORY_DUPLICATED")
        receipts.append(receipt)
        if entry["method"] == create:
            when = _at(entry["timestamp"])
            _require(
                entry.get("principal") == principal
                and when <= finished
                and timedelta(0) <= created - when <= timedelta(minutes=1),
                "INVENTORY_CREATOR_UNCONFIRMED",
            )
            creations.append(receipt)
    _require(len(creations) == 1, "INVENTORY_CREATION_UNCONFIRMED")
    return receipts


def _legacy_receipt(row: dict, planned: list[dict]) -> dict:
    """The original plan and settled legacy lifecycle are independent prerequisites."""
    metadata = row.get("backend_metadata") or {}
    receipt = metadata.get("substrateReceipt") or {}
    project, region = row.get("user_cloud_project"), row.get("user_cloud_region")
    principal = row.get("user_cloud_bootstrap_sa")
    if not isinstance(principal, str) or not principal:
        raise InventoryReconciliationRefused("INVENTORY_CREATOR_UNCONFIRMED")
    _require(
        row.get("status") == "provisioned"
        and row.get("backend") == "user_gcp"
        and row.get("deployment_target") == "user_gcp"
        and isinstance(project, str)
        and isinstance(region, str)
        and isinstance(metadata.get("serviceUid"), str)
        and bool(metadata["serviceUid"])
        and not any(key in metadata for key in ("erasure", "upgradeLease", "provisionAttempt"))
        and (metadata.get("upgradeApproval") or {}).get("status") in {None, "succeeded", "failed"},
        "INVENTORY_LIFECYCLE_BUSY",
    )
    _require(
        receipt.get("version") == RECEIPT_VERSION
        and receipt.get("applied") is True
        and receipt.get("tenantRef") == f"{project}/{region}"
        and isinstance(planned, list)
        and 1 <= len(planned) <= 64
        and all(
            isinstance(item, dict)
            and set(item) == {"type", "id"}
            and all(isinstance(value, str) and 1 <= len(value) <= 512 for value in item.values())
            for item in planned
        )
        and len({(item["type"], item["id"]) for item in planned}) == len(planned)
        and resource_ids({"resources": planned}) == receipt.get("resourceIds")
        and plan_digest({"resources": planned}) == receipt.get("planDigest"),
        "INVENTORY_ORIGINAL_PLAN_CHANGED",
    )
    return receipt


def _storage_evidence(
    row: dict,
    planned: list[dict],
    evidence: dict,
    *,
    kind: str,
    started: datetime,
    finished: datetime,
    observed: datetime,
) -> tuple[dict, list[dict]]:
    project, region = row["user_cloud_project"], row["user_cloud_region"]
    resources = [item["id"] for item in planned if item["type"] == kind]
    _require(len(resources) == 1, "INVENTORY_STORAGE_AMBIGUOUS")
    rid = resources[0]
    full = (
        rid
        if kind == "gcs_bucket"
        else (f"projects/{project}/locations/{region}/keyRings/hushh-one/cryptoKeys/{rid}")
    )
    value = evidence.get(kind)
    if not isinstance(value, dict):
        raise InventoryReconciliationRefused("INVENTORY_RESOURCE_UNCONFIRMED")
    current = value.get("current")
    if not isinstance(current, dict):
        raise InventoryReconciliationRefused("INVENTORY_RESOURCE_UNCONFIRMED")
    validator = _bucket_creation_identity if kind == "gcs_bucket" else _kms_key_creation_identity
    identity = validator(current, full)
    if identity is None:
        raise InventoryReconciliationRefused("INVENTORY_RESOURCE_UNCONFIRMED")
    if kind == "gcs_bucket":
        key_id = next((item["id"] for item in planned if item["type"] == "kms_key"), "")
        _require(
            current.get("projectNumber") == evidence.get("projectNumber")
            and current.get("defaultKmsKeyName")
            == (f"projects/{project}/locations/{region}/keyRings/hushh-one/cryptoKeys/{key_id}"),
            "INVENTORY_STORAGE_BINDING_CHANGED",
        )
    created = _at(identity["timeCreated" if kind == "gcs_bucket" else "createTime"])
    _require(started <= created <= finished, "INVENTORY_PROVISION_WINDOW_CHANGED")
    audit = _creation_history(
        value.get("history") or {},
        name=f"projects/_/buckets/{rid}" if kind == "gcs_bucket" else full,
        kind=kind,
        principal=row["user_cloud_bootstrap_sa"],
        created=created,
        started=started,
        finished=finished,
        observed=observed,
    )
    return {"type": kind, "id": rid, "disposition": "created", "identity": identity}, audit


def qualified_inventory(row: dict, planned: list[dict], evidence: dict, *, now: datetime) -> dict:
    """Qualify bounded, non-secret observations; never infer creation from a name."""
    receipt = _legacy_receipt(row, planned)
    metadata = row["backend_metadata"]
    observed, started, finished = (
        _at(evidence.get("observedAt")),
        _at(row.get("created_at")),
        _at(row.get("provisioned_at")),
    )
    _require(
        started <= finished <= observed <= now
        and now - observed <= timedelta(minutes=15)
        and evidence.get("ownerId") == row.get("user_id")
        and evidence.get("hushhId") == row.get("hushh_id")
        and evidence.get("serviceUid") == metadata["serviceUid"]
        and evidence.get("project") == row["user_cloud_project"]
        and evidence.get("region") == row["user_cloud_region"]
        and isinstance(evidence.get("retentionDays"), int)
        and evidence["retentionDays"] >= (observed - started).days + 1,
        "INVENTORY_BINDING_UNCONFIRMED",
    )
    observations, audit = [], {}
    for kind in ("gcs_bucket", "kms_key"):
        observation, audit[kind] = _storage_evidence(
            row,
            planned,
            evidence,
            kind=kind,
            started=started,
            finished=finished,
            observed=observed,
        )
        observations.append(observation)
    qualified = SubstrateReceipt(
        applied=True,
        tenant_ref=receipt["tenantRef"],
        resource_ids=receipt["resourceIds"],
        plan_digest=receipt["planDigest"],
        planned_resources=planned,
        resource_observations=observations,
    ).as_record()
    inventory = merge_substrate_inventory(receipt, qualified)
    _require(inventory is not None, "INVENTORY_RESOURCE_UNCONFIRMED")
    return {
        "inventory": inventory,
        "provenance": {
            "version": 1,
            "source": "gcp-admin-activity-reconciliation",
            "originalReceipt": deepcopy(receipt),
            "originalReceiptSha256": _digest(receipt),
            "evidenceSha256": _digest(evidence),
            "observedAt": evidence["observedAt"],
            "audit": audit,
        },
    }


def _locked_registry(connection: Any, observed: dict) -> dict:
    """Join existing lifecycle locks and guards before observing the writable row."""
    owner = observed["user_id"]
    connection.execute(text("SET LOCAL lock_timeout='5s'"))
    for seed in (171, 198):
        connection.execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended(:owner,:seed))"),
            {"owner": owner, "seed": seed},
        )
    ready = connection.execute(
        text("""SELECT
        current_setting('transaction_isolation')='read committed'
        AND public.notification_checkpoint_admission_ready()
        AND public.files_upgrade_admission_ready()
        AND public.operator_notification_custody_ready()
        AND EXISTS (SELECT 1 FROM pg_trigger
          WHERE tgrelid='public.byoc_setup_jobs'::regclass
          AND tgname='zz_byoc_authorization_attempts' AND tgenabled IN ('O','A')
          AND tgtype=31 AND tgnargs=0 AND tgqual IS NULL
          AND tgfoid='public.guard_byoc_authorization_attempts()'::regprocedure)
        AND EXISTS (SELECT 1 FROM pg_trigger
          WHERE tgrelid='public.personal_agent_registry'::regclass
          AND tgname='trg_reject_deleted_account_insert' AND tgenabled IN ('O','A')
          AND tgtype=7 AND tgnargs=1 AND tgqual IS NULL
          AND tgargs=decode('757365725f696400','hex')
          AND tgfoid='public.reject_deleted_account_identity_write()'::regprocedure)
        """)
    ).scalar_one()
    _require(ready is True, "INVENTORY_GUARDS_UNAVAILABLE")
    deleted = connection.execute(
        text("""SELECT EXISTS (
        SELECT 1 FROM account_deletion_tombstones
        WHERE user_id_hash=:owner_hash) OR EXISTS (
        SELECT 1 FROM personal_agent_deletion_tombstones WHERE hushh_id=:pod)"""),
        {
            "owner_hash": "sha256:" + hashlib.sha256(owner.encode()).hexdigest(),
            "pod": observed.get("hushh_id"),
        },
    ).scalar_one()
    busy = connection.execute(
        text("""SELECT EXISTS (
        SELECT 1 FROM byoc_setup_jobs WHERE user_id=:owner
        AND (status NOT IN ('recorded','failed') OR EXISTS (
            SELECT 1 FROM jsonb_each(authorization_attempts) a
            WHERE jsonb_typeof(a.value->'receipt') IS DISTINCT FROM 'object')))
        OR EXISTS (
        SELECT 1 FROM pod_migration_jobs WHERE user_id=:owner
        AND (status NOT IN ('succeeded','failed')
            OR error_code IN ('SWITCH_OUTCOME_UNKNOWN','FREEZE_OUTCOME_UNKNOWN')))"""),
        {"owner": owner},
    ).scalar_one()
    _require(not deleted and not busy, "INVENTORY_LIFECYCLE_BUSY")
    current = (
        connection.execute(
            text("SELECT * FROM personal_agent_registry WHERE user_id=:owner FOR UPDATE"),
            {"owner": owner},
        )
        .mappings()
        .one_or_none()
    )
    _require(current is not None, "INVENTORY_OWNER_UNCONFIRMED")
    current = dict(current)
    return current


def reconcile_legacy_gcp_inventory(
    *,
    observed: dict,
    planned: list[dict],
    evidence: dict,
    now: datetime,
    connection_factory: Any = None,
) -> dict:
    """One guarded transaction; callers retain their independently authenticated operator boundary."""
    from db.db_client import get_db_connection

    owner = observed.get("user_id")
    if not isinstance(owner, str) or not owner:
        raise InventoryReconciliationRefused("INVENTORY_OWNER_UNCONFIRMED")
    # Validate retained terms before opening the transaction. Exact acknowledgement
    # readback has no freshness deadline; only a new mutation requires fresh reads.
    result = qualified_inventory(observed, planned, evidence, now=_at(evidence.get("observedAt")))
    with (connection_factory or get_db_connection)() as connection:
        current = _locked_registry(connection, observed)
        metadata = deepcopy(current.get("backend_metadata") or {})
        existing = metadata.get("inventoryReconciliation")
        if (
            existing == result["provenance"]
            and metadata.get("substrateReceipt") == result["inventory"]
        ):
            prior = deepcopy(current)
            prior["backend_metadata"].pop("inventoryReconciliation")
            prior["backend_metadata"]["substrateReceipt"] = result["provenance"]["originalReceipt"]
            prior["updated_at"] = observed.get("updated_at")
            _require(
                upgrade_host_snapshot(prior) == upgrade_host_snapshot(observed),
                "INVENTORY_HOST_CHANGED",
            )
            return result
        _require(
            existing is None
            and upgrade_host_snapshot(current) == upgrade_host_snapshot(observed)
            and current.get("created_at") == observed.get("created_at")
            and current.get("provisioned_at") == observed.get("provisioned_at"),
            "INVENTORY_HOST_CHANGED",
        )
        qualified_inventory(current, planned, evidence, now=now)
        metadata.update(
            substrateReceipt=result["inventory"], inventoryReconciliation=result["provenance"]
        )
        updated = connection.execute(
            text("""UPDATE personal_agent_registry
            SET backend_metadata=CAST(:metadata AS jsonb),updated_at=clock_timestamp()
            WHERE user_id=:owner AND backend_metadata IS NOT DISTINCT FROM CAST(:previous AS jsonb)
            RETURNING user_id"""),
            {
                "owner": owner,
                "metadata": json.dumps(metadata),
                "previous": json.dumps(current.get("backend_metadata")),
            },
        ).scalar_one_or_none()
        _require(updated == owner, "INVENTORY_HOST_CHANGED")
        return result
