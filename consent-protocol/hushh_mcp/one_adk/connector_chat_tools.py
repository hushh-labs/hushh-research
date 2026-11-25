"""First-party Chat connector launcher and status posture tool for Agent One.

Routes bank/investment/card (`plaid`), seller payouts (`stripe`), Google
Workspace (`drive`, `gmail`, `calendar`), and private MCP (`custom`) connector
requests directly to an inline interactive Chat card instead of redirecting the
owner away to Profile screens. Never accepts credentials or owner IDs from
model arguments; owner identity is verified strictly from runtime state.
"""

from __future__ import annotations

from typing import Any, Literal

from google.adk.tools.tool_context import ToolContext

from hushh_mcp.adk_bridge.delegation import validate_first_party_owner_token
from hushh_mcp.one_adk.external_read_boundary import STATE_EXECUTION_SURFACE
from hushh_mcp.one_adk.pod_connector_tools import pod_tool_owner
from hushh_mcp.one_adk.request_secrets import resolve_request_secret
from hushh_mcp.one_adk.workspace_mcp_tools import WORKSPACE_CHAT_ADMISSION_STATE
from hushh_mcp.runtime_settings import pod_mode

ConnectorProvider = Literal["plaid", "stripe", "drive", "gmail", "calendar", "custom"]
ConnectorOperation = Literal["connect", "add_account", "refresh", "status"]

_VALID_PROVIDERS: frozenset[str] = frozenset(
    {"plaid", "stripe", "drive", "gmail", "calendar", "custom"}
)
_VALID_OPERATIONS: frozenset[str] = frozenset({"connect", "add_account", "refresh", "status"})


def _screen_state(tool_context: ToolContext) -> dict[str, Any]:
    state = getattr(tool_context, "state", None)
    voice_ctx = state.get("hussh:voice_context") if state is not None else None
    screen_state = voice_ctx.get("screen_state") if isinstance(voice_ctx, dict) else None
    return screen_state if isinstance(screen_state, dict) else {}


async def _admit_connector_owner(tool_context: ToolContext, provider: str) -> str | None:
    if pod_mode():
        if provider in {"plaid", "stripe", "custom"}:
            from hushh_mcp.one_adk.request_secrets import _PREFIX as REQUEST_SECRET_PREFIX
            from hushh_mcp.services.pod_owner_cloud import pod_owner_user_id
            from hushh_mcp.services.pod_session_authority import LOCAL_TOKEN_PREFIX

            state = getattr(tool_context, "state", None)
            if state is None or state.get(STATE_EXECUTION_SURFACE) != "typed_chat":
                return None
            owner = str(state.get("hussh:user_id") or "").strip()
            expected = pod_owner_user_id()
            if not owner or getattr(tool_context, "user_id", None) != owner:
                return None
            if expected and owner != expected:
                return None
            reference = str(state.get("hussh:consent_token") or "")
            if not reference.startswith(REQUEST_SECRET_PREFIX):
                return None
            try:
                token = str(resolve_request_secret(reference) or "")
            except Exception:  # noqa: BLE001
                return None
            return owner if token.startswith(LOCAL_TOKEN_PREFIX) else None
        return await pod_tool_owner(tool_context, provider)
    state = getattr(tool_context, "state", None)
    if (
        state is None
        or state.get(WORKSPACE_CHAT_ADMISSION_STATE) is not True
        or state.get(STATE_EXECUTION_SURFACE) != "typed_chat"
    ):
        return None
    owner = str(state.get("hussh:user_id") or "").strip()
    if (
        not owner
        or owner.startswith("anonymous:")
        or getattr(tool_context, "user_id", None) != owner
    ):
        return None
    token = resolve_request_secret(state.get("hussh:consent_token"))
    return owner if await validate_first_party_owner_token(owner, token) else None


async def _stripe_posture(owner: str, screen_state: dict[str, Any]) -> dict[str, bool]:
    raw_connected = screen_state.get("stripe_connected")
    payouts_enabled = screen_state.get("stripe_payouts_enabled") is True
    details_submitted = screen_state.get("stripe_details_submitted") is True
    connected = raw_connected is True or payouts_enabled or details_submitted

    if not pod_mode():
        try:
            from hushh_mcp.services.pkm_payout_service import PkmPayoutService

            status = await PkmPayoutService().account_status(user_id=owner, force_refresh=False)
            account = status.get("account") if isinstance(status, dict) else None
            if isinstance(account, dict):
                payouts_enabled = bool(account.get("payoutsEnabled"))
                details_submitted = bool(account.get("detailsSubmitted"))
                connected = True
        except Exception:  # noqa: BLE001 - DB/Stripe may be unconfigured on Hub/tests
            pass

    return {
        "connected": connected,
        "payouts_enabled": payouts_enabled,
        "details_submitted": details_submitted,
    }


def _plaid_posture(screen_state: dict[str, Any]) -> tuple[bool, int]:
    raw_count = screen_state.get("plaid_institution_count")
    institution_count = (
        int(raw_count)
        if isinstance(raw_count, int) and not isinstance(raw_count, bool) and raw_count >= 0
        else 0
    )
    connected = bool(screen_state.get("plaid_connected") is True or institution_count > 0)
    return connected, institution_count


async def manage_connector(
    provider: ConnectorProvider,
    tool_context: ToolContext,
    operation: ConnectorOperation = "connect",
) -> dict[str, Any]:
    """Open or inspect an inline connector setup card inside Chat.

    For Plaid (`plaid`): call `manage_connector` ONLY when no bank is connected
    yet or the owner explicitly asks to link/add another bank (`operation="connect"`
    or `"add_account"`). When Plaid is already connected and the owner asks to
    fetch, refresh, sync, or inspect balances/accounts/holdings/loans/bills, call
    `sync_plaid_connector` or `read_plaid_mirror` directly so the browser runs the
    sync or read in this same turn instead of pausing on a setup card.
    Also handles Stripe (`stripe`: seller payouts), Google Workspace (`drive`,
    `gmail`, `calendar`), and private MCP connectors (`custom`).
    """
    normalized_provider = str(provider or "").strip().lower()
    normalized_op = str(operation or "connect").strip().lower()
    if normalized_provider not in _VALID_PROVIDERS:
        return {
            "status": "blocked",
            "reason": "unsupported_connector",
            "message": "That connector is not available in Chat setup.",
        }
    if normalized_op not in _VALID_OPERATIONS:
        normalized_op = "connect"

    owner = await _admit_connector_owner(tool_context, normalized_provider)
    if owner is None:
        return {
            "status": "blocked",
            "reason": "owner_required",
            "message": "Connector setup is available only to the signed-in owner in Chat.",
        }

    screen_state = _screen_state(tool_context)

    if normalized_provider == "plaid":
        connected, institution_count = _plaid_posture(screen_state)
        status = "manage_available" if connected else "connect_required"
        message = (
            f"Plaid is connected ({institution_count} institution(s)). "
            "Use the card below to refresh live balances or add another institution."
            if connected
            else "Plaid Link is ready in the card below to connect your bank, card, investment, or loan account."
        )
        return {
            "status": status,
            "provider": "plaid",
            "operation": normalized_op,
            "connected": connected,
            "institution_count": institution_count,
            "message": message,
        }

    if normalized_provider == "stripe":
        posture = await _stripe_posture(owner, screen_state)
        status = "manage_available" if posture["connected"] else "connect_required"
        message = (
            "Stripe payouts are linked. Use the card below to review status or open Express setup."
            if posture["connected"]
            else "Stripe Connect is ready in the card below to set up payouts."
        )
        return {
            "status": status,
            "provider": "stripe",
            "operation": normalized_op,
            "connected": posture["connected"],
            "payouts_enabled": posture["payouts_enabled"],
            "details_submitted": posture["details_submitted"],
            "message": message,
        }

    if normalized_provider in {"drive", "gmail", "calendar"}:
        from hushh_mcp.one_adk.workspace_mcp_tools import discover_workspace_tools

        result = await discover_workspace_tools(normalized_provider, tool_context)  # type: ignore[arg-type]
        return {**result, "provider": normalized_provider, "operation": normalized_op}

    from hushh_mcp.one_adk.registered_mcp_toolset import inspect_private_connectors

    result = await inspect_private_connectors(tool_context)
    return {**result, "provider": "custom", "operation": normalized_op}


__all__ = ["ConnectorOperation", "ConnectorProvider", "manage_connector"]
