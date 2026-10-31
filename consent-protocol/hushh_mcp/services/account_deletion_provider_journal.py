"""Provider-stage transitions owned by the existing account deletion lifecycle.

Only identifiers, immutable inventory hashes and enumerated outcomes cross this
port. Credentials remain in their original encrypted rows. Provider calls never
run inside a database transaction.
"""

from __future__ import annotations

import copy
import json
from dataclasses import dataclass, field
from typing import Literal
from uuid import uuid4

from sqlalchemy import text

from db.db_client import get_db_connection
from hushh_mcp.services.account_deletion_cleanup_stall import CLEANUP_STALL_ALERT_SECONDS
from hushh_mcp.services.account_deletion_lifecycle_service import (
    AccountDeletionLifecycleService,
    account_deletion_user_hash,
)

Phase = Literal["watchOutcome", "revocation"]
Outcome = Literal["stopped", "revoked", "failed", "uncertain", "token_absent"]
_LIMITS = text(
    "SELECT set_config('statement_timeout','5000ms',true),set_config('lock_timeout','3000ms',true)"
)


class ProviderCleanupClaimLost(RuntimeError):
    """An expired or replaced claim has no authority to publish outcomes."""


class ProviderCleanupNotReady(RuntimeError):
    """Cleanup needs another stage, provider evidence or owner intervention."""


class CleanupOperationNotFound(RuntimeError):
    """No cleanup operation belongs to this verified external identity."""


def needs_local_erasure(item: dict) -> bool:
    return (
        item.get("revocationSupport") == "unsupported"
        or item.get("authorityScope") == "retain_shared_google"
    )


def inspect_for_identity(firebase_uid: str, *, operation_id: str | None = None) -> dict:
    """Purpose-bound aggregate status; no normal account or vault admission."""
    with get_db_connection() as conn:
        conn.execute(_LIMITS)
        row = (
            conn.execute(
                text("""SELECT account_owner_id,user_id_hash,provider_cleanup_id,erasure_phase,cleanup_status,
              provider_cleanup_inventory,provider_cleanup_receipt,
              provider_cleanup_next_attempt_at,
              (erasure_phase='provider_cleanup' AND (cleanup_status IN ('pending','retry_pending')
                OR (cleanup_status='running' AND cleanup_claimed_at<now()-interval '5 minutes'))
                AND provider_cleanup_next_attempt_at<now()-make_interval(secs=>:stall_seconds))
                IS TRUE AS delayed
            FROM account_deletion_tombstones
            WHERE firebase_identity_hash=:identity_hash AND cleanup_intent_kind='full_account'
              AND provider_cleanup_id IS NOT NULL
              AND (:operation_id IS NULL OR provider_cleanup_id=CAST(:operation_id AS uuid))
            ORDER BY deleted_at DESC LIMIT 1"""),
                {
                    "identity_hash": account_deletion_user_hash(firebase_uid),
                    "operation_id": operation_id,
                    "stall_seconds": CLEANUP_STALL_ALERT_SECONDS,
                },
            )
            .mappings()
            .first()
        )
        if row is None:
            raise CleanupOperationNotFound("cleanup operation is unavailable")
        inventory, receipt = row["provider_cleanup_inventory"], row["provider_cleanup_receipt"]
        unsupported = sum(needs_local_erasure(item) for item in inventory.values())
        if row["erasure_phase"] == "erased":
            state = "complete"
        elif row["cleanup_status"] == "quarantined":
            state = "action_required"
        elif row["cleanup_status"] == "retry_pending":
            state = "waiting_for_provider"
        else:
            state = "cleaning_up"
        return {
            "id": str(row["provider_cleanup_id"]),
            "owner_hash": row["user_id_hash"],
            "owner_id": row["account_owner_id"] if state != "complete" else None,
            "state": state,
            "credential_count": len(inventory),
            "local_erasure_confirmation_required": bool(
                unsupported and receipt.get("localErasureAccepted") is not True
            ),
            "external_validity_unconfirmed_count": unsupported,
            "inventory_sha256": receipt.get("inventorySha256"),
            "retry_after_seconds": 3 if state in {"cleaning_up", "waiting_for_provider"} else None,
            "delayed": bool(row["delayed"]),
        }


def authorize_continuation(
    firebase_uid: str,
    *,
    operation_id: str,
    inventory_sha256: str,
    accept_local_erasure: bool = False,
) -> None:
    """Continue this approved inventory; never replay an uncertain effect."""
    params = {
        "identity_hash": account_deletion_user_hash(firebase_uid),
        "operation_id": operation_id,
    }
    with get_db_connection() as conn:
        conn.execute(_LIMITS)
        owner = conn.execute(
            text("""SELECT account_owner_id FROM account_deletion_tombstones
            WHERE firebase_identity_hash=:identity_hash AND provider_cleanup_id=CAST(:operation_id AS uuid)
              AND erasure_phase='provider_cleanup'"""),
            params,
        ).scalar_one_or_none()
        if not owner:
            raise CleanupOperationNotFound("cleanup operation is unavailable")
        AccountDeletionLifecycleService._lock_user_ids_in_transaction(conn, user_ids=(owner,))
        row = (
            conn.execute(
                text("""SELECT provider_cleanup_inventory,provider_cleanup_receipt,cleanup_status
            FROM account_deletion_tombstones
            WHERE firebase_identity_hash=:identity_hash AND provider_cleanup_id=CAST(:operation_id AS uuid)
              AND account_owner_id=:owner AND erasure_phase='provider_cleanup' FOR UPDATE"""),
                {**params, "owner": owner},
            )
            .mappings()
            .first()
        )
        if row is None:
            raise CleanupOperationNotFound("cleanup operation is unavailable")
        if row["cleanup_status"] == "running":
            # A worker may be about to publish a parked result from its earlier
            # observation. Let that claim settle before accepting new terms.
            raise ProviderCleanupNotReady("cleanup is still settling")
        receipt = copy.deepcopy(row["provider_cleanup_receipt"])
        if receipt.get("inventorySha256") != inventory_sha256:
            raise ProviderCleanupNotReady("cleanup review changed")
        unsupported = any(
            needs_local_erasure(item) for item in row["provider_cleanup_inventory"].values()
        )
        if accept_local_erasure:
            if not unsupported:
                raise ProviderCleanupNotReady("no local-erasure exception is applicable")
            receipt["localErasureAccepted"] = True
        elif unsupported and receipt.get("localErasureAccepted") is not True:
            raise ProviderCleanupNotReady("local erasure needs explicit owner confirmation")
        uncertain = any(
            item.get("refresh", {}).get("state") in {"dispatched", "uncertain"}
            or any(
                item.get(phase) in {"dispatched", "uncertain", "token_absent"}
                for phase in ("watchOutcome", "revocation")
            )
            for item in receipt["items"].values()
        )
        if uncertain:
            raise ProviderCleanupNotReady("provider outcome needs reconciliation")
        conn.execute(
            text("""UPDATE account_deletion_tombstones SET
            provider_cleanup_receipt=CAST(:receipt AS jsonb),
            cleanup_status=CASE WHEN cleanup_status='running' THEN cleanup_status ELSE 'pending' END,
            provider_cleanup_next_attempt_at=now(),updated_at=now()
            WHERE firebase_identity_hash=:identity_hash AND provider_cleanup_id=CAST(:operation_id AS uuid)"""),
            {**params, "receipt": json.dumps(receipt)},
        )


@dataclass(frozen=True, slots=True)
class ProviderCleanupClaim:
    owner_id: str
    firebase_uid: str
    cleanup_id: str
    claim_token: str = field(repr=False)
    inventory: dict = field(repr=False)
    receipt: dict = field(repr=False)
    requested_target: str = "both"


@dataclass(frozen=True, slots=True)
class CleanupRefreshOperation:
    claim: ProviderCleanupClaim = field(repr=False)
    reference: str
    operation_id: str
    from_revision: str


def effective_inventory(claim: ProviderCleanupClaim, receipt: dict) -> dict:
    inventory = copy.deepcopy(claim.inventory)
    for ref, item in inventory.items():
        captured = receipt["items"][ref]
        item["revision"] = captured.get("custodyRevision", item["revision"])
    return inventory


def _parameters(claim: ProviderCleanupClaim) -> dict:
    return {
        "owner": claim.owner_id,
        "owner_hash": account_deletion_user_hash(claim.owner_id),
        "cleanup_id": claim.cleanup_id,
        "claim_token": claim.claim_token,
    }


def available() -> bool:
    with get_db_connection() as conn:
        conn.execute(_LIMITS)
        return (
            conn.execute(
                text("""SELECT to_regprocedure(
            'public.account_provider_cleanup_live_inventory(text)') IS NOT NULL
            AND to_regprocedure('public.account_provider_cleanup_contract_version()') IS NOT NULL""")
            ).scalar_one()
            is True
        )


def current_receipt(claim: ProviderCleanupClaim) -> dict:
    with get_db_connection() as conn:
        return _lock_claim(conn, claim)


def load_grants(claim: ProviderCleanupClaim):
    from hushh_mcp.services.account_deletion_provider_credentials import read_grants

    with get_db_connection() as conn:
        receipt = _lock_claim(conn, claim)
        return read_grants(conn, claim.owner_id, effective_inventory(claim, receipt))


def _lock_claim(conn, claim: ProviderCleanupClaim) -> dict:
    conn.execute(_LIMITS)
    AccountDeletionLifecycleService._lock_user_ids_in_transaction(conn, user_ids=(claim.owner_id,))
    row = (
        conn.execute(
            text("""SELECT provider_cleanup_inventory,provider_cleanup_receipt,
        firebase_uid,account_owner_id FROM account_deletion_tombstones
        WHERE user_id_hash=:owner_hash AND provider_cleanup_id=CAST(:cleanup_id AS uuid)
          AND cleanup_claim_token=CAST(:claim_token AS uuid) AND cleanup_status='running'
          AND erasure_phase='provider_cleanup'
          AND cleanup_claimed_at > now()-interval '5 minutes' FOR UPDATE"""),
            _parameters(claim),
        )
        .mappings()
        .first()
    )
    if (
        row is None
        or row["firebase_uid"] != claim.firebase_uid
        or row["account_owner_id"] != claim.owner_id
    ):
        raise ProviderCleanupClaimLost("provider cleanup claim is no longer current")
    if row["provider_cleanup_inventory"] != claim.inventory:
        raise ProviderCleanupClaimLost("provider cleanup inventory changed")
    return copy.deepcopy(row["provider_cleanup_receipt"])


def claim_due(*, limit: int = 5) -> list[ProviderCleanupClaim]:
    """Claim bounded work; a dead worker's dispatched effects become uncertain."""
    bounded = max(1, min(int(limit), 10))
    with get_db_connection() as conn:
        conn.execute(_LIMITS)
        rows = (
            conn.execute(
                text("""SELECT user_id_hash,account_owner_id,firebase_uid,provider_cleanup_requested_target,
            provider_cleanup_id,provider_cleanup_inventory,provider_cleanup_receipt
            FROM account_deletion_tombstones
            WHERE erasure_phase='provider_cleanup' AND provider_cleanup_next_attempt_at<=now()
              AND (cleanup_status IN ('pending','retry_pending') OR
                (cleanup_status='running' AND cleanup_claimed_at<now()-interval '5 minutes'))
            ORDER BY provider_cleanup_next_attempt_at,user_id_hash
            LIMIT :limit FOR UPDATE SKIP LOCKED"""),
                {"limit": bounded},
            )
            .mappings()
            .all()
        )
        claims = []
        for row in rows:
            receipt = copy.deepcopy(row["provider_cleanup_receipt"])
            # No effect is replayed merely because its lease expired. A worker
            # may have died after provider acceptance but before recording it.
            for item in receipt["items"].values():
                if item.get("refresh", {}).get("state") == "dispatched":
                    item["refresh"]["state"] = "uncertain"
                for phase in ("watchOutcome", "revocation"):
                    if item[phase] == "dispatched":
                        item[phase] = "uncertain"
            claimed = conn.execute(
                text("""UPDATE account_deletion_tombstones SET
                cleanup_status='running',cleanup_claim_token=gen_random_uuid(),
                cleanup_claimed_at=now(),cleanup_attempt_count=cleanup_attempt_count+1,
                provider_cleanup_receipt=CAST(:receipt AS jsonb),updated_at=now()
                WHERE user_id_hash=:owner_hash RETURNING cleanup_claim_token::text"""),
                {"owner_hash": row["user_id_hash"], "receipt": json.dumps(receipt)},
            ).scalar_one()
            claims.append(
                ProviderCleanupClaim(
                    owner_id=row["account_owner_id"],
                    firebase_uid=row["firebase_uid"],
                    cleanup_id=str(row["provider_cleanup_id"]),
                    claim_token=claimed,
                    inventory=row["provider_cleanup_inventory"],
                    receipt=receipt,
                    requested_target=row["provider_cleanup_requested_target"],
                )
            )
    return claims


def dispatch_refresh(claim: ProviderCleanupClaim, *, reference: str) -> CleanupRefreshOperation:
    """Persist refresh intent before the provider may rotate its credential."""
    with get_db_connection() as conn:
        receipt = _lock_claim(conn, claim)
        if reference not in claim.inventory:
            raise ValueError("provider cleanup reference is invalid")
        item = receipt["items"][reference]
        if item.get("refresh", {}).get("state") in {"dispatched", "uncertain"}:
            raise ProviderCleanupNotReady("provider refresh needs reconciliation")
        revision = item.get("custodyRevision", item["revision"])
        live = conn.execute(
            text("SELECT public.account_provider_cleanup_live_inventory(:owner)"),
            {"owner": claim.owner_id},
        ).scalar_one()
        if live.get(reference, {}).get("revision") != revision:
            raise ProviderCleanupNotReady("provider cleanup custody changed")
        operation = CleanupRefreshOperation(claim, reference, str(uuid4()), revision)
        item["refresh"] = {
            "state": "dispatched",
            "operationId": operation.operation_id,
            "fromRevision": revision,
        }
        _write_receipt(conn, claim, receipt)
    return operation


def capture_refresh(operation: CleanupRefreshOperation, *, grant, encrypted_update: dict) -> None:
    """CAS encrypted authority into its original row and record its exact revision."""
    from hushh_mcp.services.account_deletion_provider_credentials import _SOURCES

    claim = operation.claim
    identities = dict(_SOURCES)
    if grant.source not in identities or grant.reference != operation.reference:
        raise ValueError("provider cleanup source is invalid")
    with get_db_connection() as conn:
        conn.execute(_LIMITS)
        AccountDeletionLifecycleService._lock_user_ids_in_transaction(
            conn, user_ids=(claim.owner_id,)
        )
        retained = (
            conn.execute(
                text("""SELECT provider_cleanup_receipt FROM account_deletion_tombstones
            WHERE user_id_hash=:owner_hash AND account_owner_id=:owner
              AND firebase_uid=:firebase_uid AND provider_cleanup_id=CAST(:cleanup_id AS uuid)
              AND provider_cleanup_inventory=CAST(:inventory AS jsonb)
              AND erasure_phase='provider_cleanup' FOR UPDATE"""),
                {
                    **_parameters(claim),
                    "firebase_uid": claim.firebase_uid,
                    "inventory": json.dumps(claim.inventory),
                },
            )
            .mappings()
            .first()
        )
        if retained is None:
            raise ProviderCleanupClaimLost("provider refresh custody is no longer current")
        receipt = copy.deepcopy(retained["provider_cleanup_receipt"])
        item = receipt["items"][operation.reference]
        observed = item.get("refresh", {})
        if (
            observed.get("state") not in {"dispatched", "uncertain"}
            or observed.get("operationId") != operation.operation_id
            or observed.get("fromRevision") != operation.from_revision
            or item.get("custodyRevision", item["revision"]) != operation.from_revision
        ):
            raise ProviderCleanupNotReady("provider refresh capture is no longer current")
        allowed = conn.execute(
            text("SELECT public.account_cleanup_refresh_columns(:source)"),
            {"source": grant.source},
        ).scalar_one()
        if not encrypted_update or set(encrypted_update) - set(allowed):
            raise ValueError("provider refresh fields are invalid")
        # Source and fields are static contract identifiers, never request input.
        assignments = ",".join(f"{name}=replacement.{name}" for name in encrypted_update)
        identity = identities[grant.source]
        row = (
            conn.execute(
                text(f"""UPDATE public.{grant.source} AS retained SET {assignments}
            FROM jsonb_populate_record(NULL::public.{grant.source},CAST(:envelope AS jsonb)) replacement
            WHERE retained.user_id=:owner AND retained.{identity}::text=:identity
              AND encode(sha256(convert_to(to_jsonb(retained)::text,'UTF8')),'hex')=:revision
            RETURNING to_jsonb(retained) AS row,
              encode(sha256(convert_to(to_jsonb(retained)::text,'UTF8')),'hex') AS revision"""),  # nosec B608 # _SOURCES and migration416 allowlist constrain identifiers; values are bound.
                {
                    "owner": claim.owner_id,
                    "identity": str(grant.row[identity]),
                    "revision": operation.from_revision,
                    "envelope": json.dumps(encrypted_update),
                },
            )
            .mappings()
            .first()
        )
        if row is None:
            raise ProviderCleanupNotReady("provider refresh custody changed")
        item["custodyRevision"] = row["revision"]
        item["refresh"]["state"] = "captured"
        # A late response may only save custody for this unchanged refresh
        # operation. It does not renew or restore its old execution claim.
        conn.execute(
            text("""UPDATE account_deletion_tombstones
            SET provider_cleanup_receipt=CAST(:receipt AS jsonb),updated_at=now()
            WHERE user_id_hash=:owner_hash AND provider_cleanup_id=CAST(:cleanup_id AS uuid)"""),
            {**_parameters(claim), "receipt": json.dumps(receipt)},
        )
        grant.row = row["row"]


def dispatch(claim: ProviderCleanupClaim, *, reference: str, phase: Phase) -> bool:
    """Commit exact dispatch intent before HTTP; false means already settled."""
    if phase not in {"watchOutcome", "revocation"} or reference not in claim.inventory:
        raise ValueError("provider cleanup action is invalid")
    with get_db_connection() as conn:
        receipt = _lock_claim(conn, claim)
        item = receipt["items"][reference]
        terminal = (
            {"stopped", "not_required"}
            if phase == "watchOutcome"
            else {"revoked", "covered_by_group"}
        )
        if item[phase] in terminal:
            return False
        if item[phase] not in {"pending", "failed"}:
            raise ProviderCleanupNotReady("provider outcome needs reconciliation")
        if phase == "revocation" and any(
            candidate["watchOutcome"] not in {"stopped", "not_required"}
            and not (
                claim.inventory[ref].get("authorityScope") == "retain_shared_google"
                and claim.inventory[ref].get("watchRequired") is True
                and candidate.get("authorityScope") == "retain_shared_google"
                and candidate.get("watchOutcome") == "retained_shared"
                and candidate.get("revocation") == "local_erasure_approved"
                and receipt.get("localErasureAccepted") is True
            )
            for ref, candidate in receipt["items"].items()
        ):
            raise ProviderCleanupNotReady("all watches must stop before grant revocation")
        item[phase] = "dispatched"
        _write_receipt(conn, claim, receipt)
    return True


def record(claim: ProviderCleanupClaim, *, reference: str, phase: Phase, outcome: Outcome) -> None:
    """A result belongs only to its exact previously committed dispatch."""
    allowed = (
        {"stopped", "failed", "uncertain"}
        if phase == "watchOutcome"
        else {"revoked", "failed", "uncertain", "token_absent"}
    )
    if phase not in {"watchOutcome", "revocation"} or outcome not in allowed:
        raise ValueError("provider cleanup outcome is invalid")
    with get_db_connection() as conn:
        receipt = _lock_claim(conn, claim)
        if reference not in claim.inventory:
            raise ValueError("provider cleanup reference is invalid")
        item = receipt["items"][reference]
        if item[phase] == outcome:
            return
        if item[phase] != "dispatched":
            raise ProviderCleanupNotReady("provider cleanup has no matching dispatch")
        item[phase] = outcome
        _write_receipt(conn, claim, receipt)


def record_group_revoked(claim: ProviderCleanupClaim, *, reference: str) -> None:
    """One confirmed Google revocation covers its frozen project/account group."""
    with get_db_connection() as conn:
        receipt = _lock_claim(conn, claim)
        expected = claim.inventory.get(reference, {})
        group = expected.get("groupDigest")
        if not group or expected.get("revocationSupport") != "required":
            raise ProviderCleanupNotReady("provider cleanup group is unverified")
        if receipt["items"][reference]["revocation"] != "dispatched":
            raise ProviderCleanupNotReady("group cleanup has no matching dispatch")
        for ref, item in receipt["items"].items():
            if claim.inventory[ref].get("groupDigest") != group:
                continue
            if claim.inventory[ref].get("revocationSupport") != "required":
                raise ProviderCleanupNotReady("provider cleanup group changed")
            if item["revocation"] not in {
                "pending",
                "failed",
                "dispatched",
                "revoked",
                "covered_by_group",
            }:
                raise ProviderCleanupNotReady("group cleanup needs reconciliation")
            if ref != reference and item["revocation"] == "dispatched":
                raise ProviderCleanupNotReady("another group dispatch is unresolved")
            item["revocation"] = "revoked" if ref == reference else "covered_by_group"
        _write_receipt(conn, claim, receipt)


def settle_unsupported(claim: ProviderCleanupClaim, *, reference: str) -> None:
    """Remove only Hussh's copy after the owner's explicit local-erasure terms."""
    with get_db_connection() as conn:
        receipt = _lock_claim(conn, claim)
        if (
            reference not in claim.inventory
            or not needs_local_erasure(claim.inventory[reference])
            or receipt.get("localErasureAccepted") is not True
        ):
            raise ProviderCleanupNotReady("local erasure needs explicit owner confirmation")
        item = receipt["items"][reference]
        if (
            item.get("refresh")
            or item.get("revocation") in {"dispatched", "uncertain", "token_absent"}
            or item.get("watchOutcome") in {"dispatched", "uncertain", "token_absent"}
        ):
            raise ProviderCleanupNotReady("provider outcome needs reconciliation")
        if claim.inventory[reference].get("authorityScope") == "retain_shared_google":
            item["watchOutcome"] = (
                "retained_shared" if claim.inventory[reference]["watchRequired"] else "not_required"
            )
        receipt["items"][reference]["revocation"] = "local_erasure_approved"
        _write_receipt(conn, claim, receipt)


def _write_receipt(conn, claim: ProviderCleanupClaim, receipt: dict) -> None:
    conn.execute(
        text("""UPDATE account_deletion_tombstones
        SET provider_cleanup_receipt=CAST(:receipt AS jsonb),cleanup_claimed_at=now(),updated_at=now()
        WHERE user_id_hash=:owner_hash AND cleanup_claim_token=CAST(:claim_token AS uuid)"""),
        {**_parameters(claim), "receipt": json.dumps(receipt)},
    )


def release(claim: ProviderCleanupClaim, *, action_required: bool) -> None:
    """Park safely or schedule continuation; no provider credential is removed."""
    with get_db_connection() as conn:
        receipt = _lock_claim(conn, claim)
        uncertain = any(
            item.get("refresh", {}).get("state") in {"dispatched", "uncertain"}
            for item in receipt["items"].values()
        ) or any(
            item[phase] in {"dispatched", "uncertain", "token_absent"}
            for item in receipt["items"].values()
            for phase in ("watchOutcome", "revocation")
        )
        needs_owner = bool(action_required or uncertain)
        conn.execute(
            text("""UPDATE account_deletion_tombstones SET
            cleanup_status=CASE WHEN :needs_owner OR cleanup_attempt_count>=8
                THEN 'quarantined' ELSE 'retry_pending' END,
            provider_cleanup_next_attempt_at=CASE WHEN :needs_owner OR cleanup_attempt_count>=8 THEN NULL
                ELSE now()+make_interval(secs=>LEAST(3600,
                    30*POWER(2,LEAST(cleanup_attempt_count,7))::integer)) END,
            cleanup_claim_token=NULL,cleanup_claimed_at=NULL,
            cleanup_last_classification=CASE WHEN :needs_owner OR cleanup_attempt_count>=8 THEN 'provider_action_required'
                ELSE 'provider_waiting' END,updated_at=now()
            WHERE user_id_hash=:owner_hash AND cleanup_claim_token=CAST(:claim_token AS uuid)"""),
            {**_parameters(claim), "needs_owner": needs_owner},
        )


def begin_local_erasure(conn, claim: ProviderCleanupClaim) -> None:
    """Called only inside the existing account erasure transaction."""
    _lock_claim(conn, claim)
    conn.execute(
        text("""UPDATE account_deletion_tombstones SET erasure_phase='local_erasure'
        WHERE user_id_hash=:owner_hash AND cleanup_claim_token=CAST(:claim_token AS uuid)"""),
        _parameters(claim),
    )


def is_ready(claim: ProviderCleanupClaim) -> bool:
    with get_db_connection() as conn:
        receipt = _lock_claim(conn, claim)
        return (
            conn.execute(
                text("""SELECT public.account_provider_cleanup_qualified(
            CAST(:receipt AS jsonb),CAST(:inventory AS jsonb),:owner_hash,CAST(:cleanup_id AS uuid))"""),
                {
                    **_parameters(claim),
                    "receipt": json.dumps(receipt),
                    "inventory": json.dumps(claim.inventory),
                },
            ).scalar_one()
            is True
        )


def settle_local_erasure(conn, claim: ProviderCleanupClaim) -> None:
    """Commit with local erasure; retain the person's external Firebase identity."""
    updated = conn.execute(
        text("""UPDATE account_deletion_tombstones SET erasure_phase='erased',
        cleanup_status='quarantined',firebase_uid=NULL,provider_cleanup_next_attempt_at=NULL,
        cleanup_next_attempt_at=NULL,cleanup_claim_token=NULL,cleanup_claimed_at=NULL,
        cleanup_last_outcome='identity_retained',
        cleanup_last_classification='firebase_shared_identity_retained',updated_at=now()
        WHERE user_id_hash=:owner_hash AND provider_cleanup_id=CAST(:cleanup_id AS uuid)
          AND cleanup_claim_token=CAST(:claim_token AS uuid) AND erasure_phase='local_erasure'"""),
        _parameters(claim),
    )
    if updated.rowcount != 1:
        raise ProviderCleanupClaimLost("local erasure lost its exact cleanup claim")
