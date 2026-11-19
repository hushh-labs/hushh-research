# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Stateless Hub Sandbox claim router and Browser-Terminal handoff coordinator (#9744)."""

from __future__ import annotations

import os
import secrets
import time
from dataclasses import dataclass
from typing import Any

from hushh_mcp.operons.agent_sandbox.tamper_evident_audit import TamperEvidentAuditLedger
from hushh_mcp.services.agent_sandbox.k8s_claim_allocator import (
    ClaimedSandboxEndpoint,
    SandboxClaimPort,
    SentinelControlClient,
)
from hushh_mcp.services.agent_sandbox.lease_manager import (
    SC4_SINGLE_USE_VIOLATION,
    SandboxAdmissionError,
    SandboxLeaseRecord,
    SandboxObjectReuseViolation,
    SanitizationReceipt,
    VirginSandboxLeaseManager,
    WeeklyQuotaSnapshot,
)
from hushh_mcp.services.agent_sandbox.process_session_manager import (
    ProcessSessionSnapshot,
    SandboxProcessSessionManager,
    TerminalSessionRefused,
)

BROWSER_TAKEOVER_REQUIRED = "BROWSER_TAKEOVER_REQUIRED"
HANDOFF_CODE_INVALID = "BROWSER_HANDOFF_CODE_INVALID"


@dataclass(frozen=True)
class AllocatedSandboxSession:
    lease_id: str
    claim_name: str
    sandbox_name: str
    pod_ip: str
    port: int
    owner_id: str
    workspace_id: str
    quota: WeeklyQuotaSnapshot
    endpoint_url: str
    direct_endpoint_url: str | None = None

    def to_public_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "lease_id": self.lease_id,
            "claim_name": self.claim_name,
            "sandbox_name": self.sandbox_name,
            "pod_ip": self.pod_ip,
            "port": self.port,
            "workspace_id": self.workspace_id,
            "quota": {
                "exempt_target": self.quota.exempt_target,
                "used_units": self.quota.used_units,
                "limit_units": self.quota.limit_units,
                "used_pct": self.quota.used_pct,
                "reset_at_epoch_s": self.quota.reset_at_epoch_s,
            },
        }
        if self.direct_endpoint_url:
            payload["direct_endpoint_url"] = self.direct_endpoint_url
        return payload


@dataclass(frozen=True)
class BrowserTerminalHandoffReceipt:
    lease_id: str
    proc_id: str
    browser_task_id: str
    audit_seq: int
    terminal_snapshot: ProcessSessionSnapshot


class HubSandboxSessionRouter:
    """Routes hosted owner turns onto single-use GKE sandboxes via Hub quota & Sentinel."""

    def __init__(
        self,
        *,
        claim_client: SandboxClaimPort,
        lease_manager: VirginSandboxLeaseManager,
        audit_ledger: TamperEvidentAuditLedger,
        sentinel_control: SentinelControlClient | None = None,
        warm_pool_name: str = "hussh-one-warm-pool",
        edge_gateway_url: str | None = None,
    ) -> None:
        self.claim_client = claim_client
        self.lease_manager = lease_manager
        self.audit_ledger = audit_ledger
        self.sentinel_control = sentinel_control
        self.warm_pool_name = warm_pool_name
        raw_edge = (
            edge_gateway_url
            if edge_gateway_url is not None
            else (os.environ.get("HUSSH_SANDBOX_EDGE_GATEWAY_URL") or "")
        )
        self.edge_gateway_url = str(raw_edge).strip().rstrip("/") or None
        self._sessions: dict[
            str, tuple[SandboxLeaseRecord, ClaimedSandboxEndpoint, WeeklyQuotaSnapshot]
        ] = {}
        self._owner_leases: dict[str, str] = {}

    def _build_session(
        self,
        lease: SandboxLeaseRecord,
        endpoint: ClaimedSandboxEndpoint,
        quota: WeeklyQuotaSnapshot,
    ) -> AllocatedSandboxSession:
        direct_url = (
            f"{self.edge_gateway_url}/u/{lease.workspace_id}" if self.edge_gateway_url else None
        )
        return AllocatedSandboxSession(
            lease_id=lease.lease_id,
            claim_name=endpoint.claim_name,
            sandbox_name=endpoint.sandbox_name,
            pod_ip=endpoint.pod_ip,
            port=endpoint.port,
            owner_id=lease.owner_id,
            workspace_id=lease.workspace_id,
            quota=quota,
            endpoint_url=f"http://{endpoint.pod_ip}:{endpoint.port}",
            direct_endpoint_url=direct_url,
        )

    def allocate_turn_sandbox(
        self,
        *,
        owner_id: str,
        workspace_id: str,
        billing_space_id: str,
        target: str = "ace",
        units: int = 1,
        idle_shutdown_seconds: int = 600,
        reuse_existing: bool = True,
    ) -> AllocatedSandboxSession:
        clean_owner = str(owner_id or "").strip()
        clean_ws = str(workspace_id or "").strip()
        clean_space = str(billing_space_id or clean_owner).strip()
        if not clean_owner or not clean_ws:
            raise SandboxAdmissionError(
                "SANDBOX_REQUEST_INVALID", "owner_id and workspace_id required", status=400
            )

        if reuse_existing:
            existing_lease_id = self._owner_leases.get(clean_owner)
            if existing_lease_id and existing_lease_id in self._sessions:
                lease, endpoint, quota = self._sessions[existing_lease_id]
                if lease.state == "CLAIMED_ACTIVE":
                    return self._build_session(lease, endpoint, quota)

        # Check invite and weekly allowance BEFORE provisioning Kubernetes compute.
        quota = self.lease_manager.quota_ledger.check_and_consume(
            clean_owner, target=target, units=units
        )
        claim_name = f"claim-{secrets.token_hex(6)}"
        endpoint = self.claim_client.create_and_wait_claim(
            claim_name=claim_name,
            billing_space_id=clean_space,
            warm_pool_name=self.warm_pool_name,
            idle_shutdown_seconds=idle_shutdown_seconds,
        )
        try:
            self.lease_manager.register_virgin_instance(endpoint.sandbox_name)
        except SandboxObjectReuseViolation:
            self.claim_client.delete_claim(claim_name)
            raise SandboxAdmissionError(
                SC4_SINGLE_USE_VIOLATION,
                f"Kubernetes returned reused sandbox {endpoint.sandbox_name}",
                status=503,
            ) from None

        # Claim the just-registered virgin instance without double-charging quota.
        lease, _ = self.lease_manager.claim_lease(
            owner_id=clean_owner,
            workspace_id=clean_ws,
            billing_space_id=clean_space,
            target="puppy",
            units=0,
            preferred_instance_id=endpoint.sandbox_name,
        )
        self._sessions[lease.lease_id] = (lease, endpoint, quota)
        self._owner_leases[clean_owner] = lease.lease_id
        return self._build_session(lease, endpoint, quota)

    def get_session(self, lease_id: str, *, owner_id: str) -> AllocatedSandboxSession:
        stored = self._sessions.get(lease_id)
        if stored is None or stored[0].owner_id != owner_id:
            raise SandboxAdmissionError("SANDBOX_LEASE_NOT_FOUND", "Unknown lease", status=404)
        lease, endpoint, quota = stored
        return self._build_session(lease, endpoint, quota)

    async def coordinate_browser_terminal_handoff(
        self,
        *,
        lease_id: str,
        owner_id: str,
        browser_task_id: str,
        proc_manager: SandboxProcessSessionManager,
        proc_id: str,
        takeover_completed: bool,
        callback_token: str,
    ) -> BrowserTerminalHandoffReceipt:
        """Pass verified owner Browser sign-in handoff into an awaiting Terminal stdin."""
        self.get_session(lease_id, owner_id=owner_id)
        if not takeover_completed:
            raise TerminalSessionRefused(
                BROWSER_TAKEOVER_REQUIRED,
                "Owner browser takeover must complete before resuming terminal.",
                status=409,
            )
        clean_code = str(callback_token or "").strip()
        if (
            not clean_code
            or len(clean_code) > 256
            or "\n" in clean_code
            or "\r" in clean_code
            or "hsur_" in clean_code
        ):
            raise TerminalSessionRefused(
                HANDOFF_CODE_INVALID,
                "Invalid single-line confirmation token.",
                status=400,
            )
        if proc_manager.control_mode == "owner":
            proc_manager.set_control_mode("resume_agent")
        snapshot = await proc_manager.write_stdin(proc_id, clean_code + "\n", actor="agent")
        audit_entry = self.audit_ledger.append(
            lease_id=lease_id,
            owner_id=owner_id,
            event_type="BROWSER_TERMINAL_HANDOFF_COMPLETED",
            payload={
                "browser_task_id": browser_task_id,
                "proc_id": proc_id,
                "completed_at_s": int(time.time()),
            },
        )
        return BrowserTerminalHandoffReceipt(
            lease_id=lease_id,
            proc_id=proc_id,
            browser_task_id=browser_task_id,
            audit_seq=audit_entry.seq,
            terminal_snapshot=snapshot,
        )

    def teardown_turn_sandbox(self, lease_id: str, *, owner_id: str) -> SanitizationReceipt:
        stored = self._sessions.get(lease_id)
        if stored is None or stored[0].owner_id != owner_id:
            raise SandboxAdmissionError("SANDBOX_LEASE_NOT_FOUND", "Unknown lease", status=404)
        _lease, endpoint, _quota = stored
        if self.sentinel_control is not None:
            self.sentinel_control.revoke_lease(lease_id)
        self.claim_client.delete_claim(endpoint.claim_name)
        receipt = self.lease_manager.release_and_destroy(lease_id, owner_id=owner_id)
        self._sessions.pop(lease_id, None)
        if self._owner_leases.get(owner_id) == lease_id:
            self._owner_leases.pop(owner_id, None)
        return receipt
