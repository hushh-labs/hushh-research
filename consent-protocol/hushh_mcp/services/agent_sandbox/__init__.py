# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""FedRAMP-ready pooled MicroVM sandbox services (#9744)."""

from hushh_mcp.services.agent_sandbox.edge_gateway_app import (
    SANDBOX_INTERNAL_PATH_FORBIDDEN,
    SANDBOX_OWNER_ID_INVALID,
    ActiveOwnerLease,
    SandboxEdgeGatewayManager,
    create_edge_gateway_from_env,
    create_sandbox_edge_gateway_app,
    derive_owner_pod_identity,
)
from hushh_mcp.services.agent_sandbox.hub_sandbox_router import (
    BROWSER_TAKEOVER_REQUIRED,
    HANDOFF_CODE_INVALID,
    AllocatedSandboxSession,
    BrowserTerminalHandoffReceipt,
    HubSandboxSessionRouter,
)
from hushh_mcp.services.agent_sandbox.k8s_claim_allocator import (
    ClaimedSandboxEndpoint,
    InMemorySandboxClaimClient,
    LiveK8sSandboxClaimClient,
    SandboxClaimPort,
    SentinelControlClient,
)
from hushh_mcp.services.agent_sandbox.lease_manager import (
    DEFAULT_WEEKLY_QUOTA_UNITS,
    SANDBOX_INVITE_REQUIRED,
    SANDBOX_WEEKLY_QUOTA_EXCEEDED,
    SC4_SINGLE_USE_VIOLATION,
    SandboxAdmissionError,
    SandboxLeaseRecord,
    SandboxObjectReuseViolation,
    SanitizationReceipt,
    VirginSandboxLeaseManager,
    WeeklyQuotaSnapshot,
    WeeklySandboxQuotaLedger,
)
from hushh_mcp.services.agent_sandbox.process_session_manager import (
    SANDBOX_RAW_CREDENTIAL_FORBIDDEN,
    TERMINAL_NOT_FOUND,
    TERMINAL_OWNER_TAKEOVER_ACTIVE,
    ProcessSessionSnapshot,
    SandboxProcessSessionManager,
    TerminalSessionRefused,
)
from hushh_mcp.services.agent_sandbox.sentinel_egress_proxy import (
    AUDIT_UNAVAILABLE,
    SURROGATE_EXFILTRATION_BLOCKED,
    SURROGATE_PREFIX,
    PreparedEgressRequest,
    SentinelEgressError,
    SentinelEgressGatekeeper,
    SurrogateGrant,
)
from hushh_mcp.services.agent_sandbox.sentinel_proxy_server import (
    SENTINEL_ROOT_FORBIDDEN,
    DurableAuditSink,
    SentinelProxyRuntime,
)

__all__ = [
    "AUDIT_UNAVAILABLE",
    "BROWSER_TAKEOVER_REQUIRED",
    "DEFAULT_WEEKLY_QUOTA_UNITS",
    "HANDOFF_CODE_INVALID",
    "SANDBOX_INTERNAL_PATH_FORBIDDEN",
    "SANDBOX_INVITE_REQUIRED",
    "SANDBOX_OWNER_ID_INVALID",
    "SANDBOX_RAW_CREDENTIAL_FORBIDDEN",
    "SANDBOX_WEEKLY_QUOTA_EXCEEDED",
    "SC4_SINGLE_USE_VIOLATION",
    "SENTINEL_ROOT_FORBIDDEN",
    "SURROGATE_EXFILTRATION_BLOCKED",
    "SURROGATE_PREFIX",
    "TERMINAL_NOT_FOUND",
    "TERMINAL_OWNER_TAKEOVER_ACTIVE",
    "ActiveOwnerLease",
    "AllocatedSandboxSession",
    "BrowserTerminalHandoffReceipt",
    "ClaimedSandboxEndpoint",
    "DurableAuditSink",
    "HubSandboxSessionRouter",
    "InMemorySandboxClaimClient",
    "LiveK8sSandboxClaimClient",
    "PreparedEgressRequest",
    "ProcessSessionSnapshot",
    "SandboxAdmissionError",
    "SandboxClaimPort",
    "SandboxEdgeGatewayManager",
    "SandboxLeaseRecord",
    "SandboxObjectReuseViolation",
    "SandboxProcessSessionManager",
    "SanitizationReceipt",
    "SentinelControlClient",
    "SentinelEgressError",
    "SentinelEgressGatekeeper",
    "SentinelProxyRuntime",
    "SurrogateGrant",
    "TerminalSessionRefused",
    "VirginSandboxLeaseManager",
    "WeeklyQuotaSnapshot",
    "WeeklySandboxQuotaLedger",
    "create_edge_gateway_from_env",
    "create_sandbox_edge_gateway_app",
    "derive_owner_pod_identity",
]
