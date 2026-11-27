# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Single-use Virgin Sandbox lease coordinator and Muse-style quota ledger (#9744)."""

from __future__ import annotations

import os
import secrets
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Callable, Literal

from hushh_mcp.operons.agent_sandbox.tamper_evident_audit import TamperEvidentAuditLedger
from hushh_mcp.services.compute_backend import is_owner_cloud_target

SANDBOX_INVITE_REQUIRED = "SANDBOX_INVITE_REQUIRED"
SANDBOX_WEEKLY_QUOTA_EXCEEDED = "SANDBOX_WEEKLY_QUOTA_EXCEEDED"
SC4_SINGLE_USE_VIOLATION = "SC4_SINGLE_USE_VIOLATION"
DEFAULT_WEEKLY_QUOTA_UNITS = 100
_WEEK_SECONDS = 7 * 24 * 60 * 60


class SandboxAdmissionError(RuntimeError):
    """Fail-closed admission error for invite or weekly quota boundaries."""

    def __init__(self, code: str, detail: str = "", *, status: int = 403) -> None:
        self.code = code
        self.status = status
        super().__init__(detail or code)


class SandboxObjectReuseViolation(RuntimeError):
    """Hard NIST SC-4 violation raised when a sandbox instance is reused across claims."""

    def __init__(self, detail: str = SC4_SINGLE_USE_VIOLATION) -> None:
        self.code = SC4_SINGLE_USE_VIOLATION
        super().__init__(detail)


@dataclass(frozen=True)
class WeeklyQuotaSnapshot:
    owner_id: str
    exempt_target: bool
    used_units: int
    limit_units: int
    used_pct: float
    reset_at_epoch_s: int


@dataclass
class SandboxLeaseRecord:
    lease_id: str
    sandbox_instance_id: str
    claim_name: str
    owner_id: str
    workspace_id: str
    billing_space_id: str
    state: Literal["CLAIMED_ACTIVE", "DESTROYED_TOMBSTONED"]
    nvme_ephemeral_key: bytearray = field(repr=False)
    created_at_s: int
    destroyed_at_s: int | None = None


@dataclass(frozen=True)
class SanitizationReceipt:
    lease_id: str
    sandbox_instance_id: str
    owner_id: str
    key_zeroized: bool
    sandbox_terminated: bool
    tombstoned_at_s: int


class WeeklySandboxQuotaLedger:
    """Optional invite and 7-day rolling usage quota ledger for hosted sandboxes (#9744).

    Defaults to open, unrestricted adoption (`require_invite=False`, `weekly_limit_units=None`)
    while preserving bounded concurrency and explicit policy enforcement when configured.
    """

    def __init__(
        self,
        *,
        weekly_limit_units: int | None = None,
        clock_s: Callable[[], int] | None = None,
        require_invite: bool = False,
    ) -> None:
        self.weekly_limit_units: int | None = (
            None if weekly_limit_units is None else max(1, int(weekly_limit_units))
        )
        self._clock_s = clock_s or (lambda: int(time.time()))
        self.require_invite = bool(require_invite)
        self._invited_owners: set[str] = set()
        self._owner_windows: dict[str, tuple[int, int]] = {}

    def grant_invite(self, owner_id: str) -> None:
        clean_owner = str(owner_id or "").strip()
        if not clean_owner:
            raise ValueError("owner_id is required")
        self._invited_owners.add(clean_owner)

    @staticmethod
    def is_exempt_target(target: str) -> bool:
        clean = str(target or "").strip().lower()
        return clean == "puppy" or is_owner_cloud_target(clean)

    def _window_for(self, owner_id: str, now_s: int) -> tuple[int, int]:
        start_s, used = self._owner_windows.get(owner_id, (now_s, 0))
        if now_s - start_s >= _WEEK_SECONDS:
            return now_s, 0
        return start_s, used

    def check_and_consume(
        self,
        owner_id: str,
        *,
        target: str = "ace",
        units: int = 1,
    ) -> WeeklyQuotaSnapshot:
        clean_owner = str(owner_id or "").strip()
        if not clean_owner:
            raise SandboxAdmissionError(SANDBOX_INVITE_REQUIRED, "Authenticated owner required")
        now_s = int(self._clock_s())
        limit = self.weekly_limit_units
        if self.is_exempt_target(target):
            return WeeklyQuotaSnapshot(
                owner_id=clean_owner,
                exempt_target=True,
                used_units=0,
                limit_units=limit or 0,
                used_pct=0.0,
                reset_at_epoch_s=now_s + _WEEK_SECONDS,
            )
        if self.require_invite and clean_owner not in self._invited_owners:
            raise SandboxAdmissionError(
                SANDBOX_INVITE_REQUIRED,
                "Hosted microVM access currently requires an active invite, BYOC, or Puppy.",
                status=403,
            )
        start_s, used = self._window_for(clean_owner, now_s)
        cost = max(0, int(units))
        if limit is not None and used + cost > limit:
            raise SandboxAdmissionError(
                SANDBOX_WEEKLY_QUOTA_EXCEEDED,
                f"Weekly free quota reached; resets at epoch {start_s + _WEEK_SECONDS}.",
                status=429,
            )
        next_used = used + cost
        self._owner_windows[clean_owner] = (start_s, next_used)
        pct = round((next_used / limit) * 100.0, 2) if limit else 0.0
        return WeeklyQuotaSnapshot(
            owner_id=clean_owner,
            exempt_target=False,
            used_units=next_used,
            limit_units=limit or 0,
            used_pct=pct,
            reset_at_epoch_s=start_s + _WEEK_SECONDS,
        )


class VirginSandboxLeaseManager:
    """Single-use warm-pool lease coordinator enforcing NIST SC-4 destroy-on-exit."""

    def __init__(
        self,
        *,
        quota_ledger: WeeklySandboxQuotaLedger | None = None,
        audit_ledger: TamperEvidentAuditLedger | None = None,
        clock_s: Callable[[], int] | None = None,
    ) -> None:
        self.quota_ledger = quota_ledger or WeeklySandboxQuotaLedger(require_invite=False)
        self.audit_ledger = audit_ledger
        self._clock_s = clock_s or (lambda: int(time.time()))
        self._virgin_pool: deque[str] = deque()
        self._known_instances: set[str] = set()
        self._tombstoned_instances: set[str] = set()
        self._leases: dict[str, SandboxLeaseRecord] = {}
        self._active_by_instance: dict[str, str] = {}

    def register_virgin_instance(self, sandbox_instance_id: str) -> None:
        """Register one freshly provisioned virgin sandbox pod into the warm pool."""
        clean_id = str(sandbox_instance_id or "").strip()
        if not clean_id:
            raise ValueError("sandbox_instance_id is required")
        if clean_id in self._tombstoned_instances or clean_id in self._known_instances:
            raise SandboxObjectReuseViolation(
                f"{SC4_SINGLE_USE_VIOLATION}: cannot re-add used instance {clean_id}"
            )
        self._known_instances.add(clean_id)
        self._virgin_pool.append(clean_id)

    def warm_pool_size(self) -> int:
        return len(self._virgin_pool)

    def claim_lease(
        self,
        *,
        owner_id: str,
        workspace_id: str,
        billing_space_id: str,
        target: str = "ace",
        units: int = 1,
        preferred_instance_id: str | None = None,
    ) -> tuple[SandboxLeaseRecord, WeeklyQuotaSnapshot]:
        """Claim one untouched virgin sandbox and bind a fresh ephemeral NVMe key."""
        if not self._virgin_pool:
            raise SandboxAdmissionError(
                "SANDBOX_WARM_POOL_EMPTY", "No virgin sandbox available", status=503
            )
        quota = self.quota_ledger.check_and_consume(owner_id, target=target, units=units)
        if preferred_instance_id is not None:
            clean_pref = str(preferred_instance_id).strip()
            if clean_pref not in self._virgin_pool:
                raise SandboxAdmissionError(
                    "SANDBOX_WARM_POOL_EMPTY",
                    f"Requested virgin sandbox {clean_pref} unavailable",
                    status=503,
                )
            self._virgin_pool.remove(clean_pref)
            instance_id = clean_pref
        else:
            instance_id = self._virgin_pool.popleft()
        if instance_id in self._tombstoned_instances or instance_id in self._active_by_instance:
            raise SandboxObjectReuseViolation(
                f"{SC4_SINGLE_USE_VIOLATION}: instance {instance_id} already dirty"
            )
        now_s = int(self._clock_s())
        lease_id = f"lease_{secrets.token_hex(12)}"
        claim_name = f"claim-{lease_id[-12:]}"
        nvme_key = bytearray(os.urandom(32))
        record = SandboxLeaseRecord(
            lease_id=lease_id,
            sandbox_instance_id=instance_id,
            claim_name=claim_name,
            owner_id=owner_id,
            workspace_id=workspace_id,
            billing_space_id=billing_space_id,
            state="CLAIMED_ACTIVE",
            nvme_ephemeral_key=nvme_key,
            created_at_s=now_s,
        )
        self._leases[lease_id] = record
        self._active_by_instance[instance_id] = lease_id
        if self.audit_ledger is not None:
            self.audit_ledger.append(
                lease_id=lease_id,
                owner_id=owner_id,
                event_type="SANDBOX_LEASE_CLAIMED",
                payload={"sandbox_instance_id": instance_id, "workspace_id": workspace_id},
            )
        return record, quota

    def release_and_destroy(self, lease_id: str, *, owner_id: str) -> SanitizationReceipt:
        """Zeroize in-memory NVMe key and tombstone instance permanently (never return to pool)."""
        record = self._leases.get(lease_id)
        if record is None or record.owner_id != owner_id:
            raise SandboxAdmissionError(
                "SANDBOX_LEASE_NOT_FOUND", "Unknown or foreign lease", status=404
            )
        if record.state == "DESTROYED_TOMBSTONED":
            return SanitizationReceipt(
                lease_id=record.lease_id,
                sandbox_instance_id=record.sandbox_instance_id,
                owner_id=record.owner_id,
                key_zeroized=all(b == 0 for b in record.nvme_ephemeral_key),
                sandbox_terminated=True,
                tombstoned_at_s=int(record.destroyed_at_s or self._clock_s()),
            )
        # In-place wipe of the ephemeral Local NVMe scratch encryption key.
        for idx in range(len(record.nvme_ephemeral_key)):
            record.nvme_ephemeral_key[idx] = 0
        now_s = int(self._clock_s())
        record.state = "DESTROYED_TOMBSTONED"
        record.destroyed_at_s = now_s
        self._active_by_instance.pop(record.sandbox_instance_id, None)
        self._tombstoned_instances.add(record.sandbox_instance_id)
        if self.audit_ledger is not None:
            self.audit_ledger.append(
                lease_id=record.lease_id,
                owner_id=record.owner_id,
                event_type="SANDBOX_DESTROYED_SANITIZED",
                payload={"sandbox_instance_id": record.sandbox_instance_id, "key_zeroized": True},
            )
        return SanitizationReceipt(
            lease_id=record.lease_id,
            sandbox_instance_id=record.sandbox_instance_id,
            owner_id=record.owner_id,
            key_zeroized=all(b == 0 for b in record.nvme_ephemeral_key),
            sandbox_terminated=True,
            tombstoned_at_s=now_s,
        )
