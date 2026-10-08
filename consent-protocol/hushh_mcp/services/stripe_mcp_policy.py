"""Read-only One admission for Stripe's official MCP resource.

This applies to every registration of the official endpoint, including owner
custom connectors. OAuth and reachability do not prove a selected account or
environment. Account tools remain unavailable until a reviewed, authenticated
provider contract can establish both; scope purchases keep their app ledger.
"""

from __future__ import annotations

from typing import Any, Literal
from urllib.parse import urlsplit

from typing_extensions import TypedDict

from hushh_mcp.services.external_mcp_client import ExternalMcpError

STRIPE_MCP_ENDPOINT = "https://mcp.stripe.com"
STRIPE_OAUTH_ISSUER = "https://access.stripe.com/mcp"
STRIPE_DOCUMENTATION_TOOLS = frozenset(
    {"search_stripe_documentation", "stripe_api_search", "stripe_api_details"}
)


class StripeMcpReadiness(TypedDict):
    toolingConnected: bool
    accountVerified: bool
    environmentVerified: bool
    accountToolsAvailable: bool
    capability: Literal["documentation_only", "account_balance_readonly"]
    nextStep: Literal["authenticated_account_contract_required", "ready"]
    managementPath: Literal["/one/profile/connectors"]
    verificationState: Literal["unverified", "verified", "unsupported", "mismatch", "expired"]
    reasonCode: str | None
    verifiedAt: str | None
    configurationRevision: str | None
    catalogFingerprint: str | None


def official_stripe_endpoint(endpoint: str) -> bool:
    """The official host stays restricted under aliases, paths and query strings."""
    try:
        parts = urlsplit(endpoint)
        hostname = (parts.hostname or "").encode("idna").decode("ascii")
        return hostname.rstrip(".").lower() == "mcp.stripe.com"
    except UnicodeError:
        raise ValueError("Invalid MCP endpoint hostname") from None
    except ValueError:
        return False


def require_stripe_oauth(
    endpoint: str, authentication_kind: str | None, headers: dict[str, str]
) -> None:
    if not official_stripe_endpoint(endpoint):
        return
    bearer = headers.get("Authorization", "")
    token = bearer.removeprefix("Bearer ").strip()
    if (
        authentication_kind != "oauth"
        or not bearer.startswith("Bearer ")
        or bearer != f"Bearer {token}"
        or not token
        or token.startswith(("sk_", "rk_"))
        or set(headers) != {"Authorization"}
    ):
        raise ExternalMcpError(
            "Connect Stripe with owner OAuth.", code="MCP_STRIPE_OAUTH_REQUIRED", status_code=401
        )


def stripe_tool_admitted(descriptor: dict[str, Any]) -> bool:
    hints = descriptor.get("annotations")
    return bool(
        descriptor.get("name") in STRIPE_DOCUMENTATION_TOOLS
        and isinstance(hints, dict)
        and hints.get("readOnlyHint") is True
        and hints.get("destructiveHint") is not True
    )


def stripe_catalog(
    endpoint: str,
    catalog: list[dict[str, Any]],
    reads: dict[str, dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    if not official_stripe_endpoint(endpoint):
        return catalog
    return [descriptor for descriptor in catalog if stripe_tool_admitted(descriptor)] + list(
        (reads or {}).values()
    )


def require_stripe_tool(
    endpoint: str,
    descriptor: dict[str, Any],
    reads: dict[str, dict[str, Any]] | None = None,
) -> None:
    closed = bool(reads and reads.get(descriptor.get("name", "")) == descriptor)
    if official_stripe_endpoint(endpoint) and not (stripe_tool_admitted(descriptor) or closed):
        raise ExternalMcpError(
            "Stripe account access needs verification; payments use app review.",
            code="MCP_STRIPE_READ_ONLY",
        )


def stripe_readiness(
    *,
    tooling_connected: bool = False,
    proof: dict[str, Any] | None = None,
    reason_code: str | None = None,
) -> StripeMcpReadiness:
    verified = proof is not None
    state: Literal["unverified", "verified", "unsupported", "mismatch", "expired"] = (
        "verified" if verified else "unverified"
    )
    if not verified and reason_code:
        state = (
            "unsupported"
            if reason_code == "MCP_STRIPE_SCHEMA_UNSUPPORTED"
            else "expired"
            if reason_code
            in {"MCP_CREDENTIAL_EXPIRED", "MCP_CONNECTION_CHANGED", "MCP_CATALOG_CHANGED"}
            else "mismatch"
        )
    return {
        "toolingConnected": tooling_connected,
        "accountVerified": verified,
        "environmentVerified": verified,
        "accountToolsAvailable": verified,
        "capability": "account_balance_readonly" if verified else "documentation_only",
        "nextStep": "ready" if verified else "authenticated_account_contract_required",
        "managementPath": "/one/profile/connectors",
        "verificationState": state,
        "reasonCode": reason_code,
        "verifiedAt": proof.get("verifiedAt") if proof else None,
        "configurationRevision": proof.get("configurationRevision") if proof else None,
        "catalogFingerprint": proof.get("catalogFingerprint") if proof else None,
    }
