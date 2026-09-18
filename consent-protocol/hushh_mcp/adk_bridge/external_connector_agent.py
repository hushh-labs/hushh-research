"""In-process A2A handler for external MCP connectors (Notion, HubSpot, ...).

One generic specialist for every registered connector, routed by
`connector_id` rather than one Python file per vendor -- so adding a new
connector is a registry row (`scripts/ops/configure_external_mcp_connector.py`),
never a new agent registration. Mirrors `connected_systems_agent.py`'s shape
(the authority gate, the directive-on-missing-connection pattern) but is
tool-catalog-agnostic: it has no CRM plan concepts, just "is this connector
connected, and if so, invoke the tool the caller asked for."

Not registered in `adk_bridge/__init__.py`'s `_register_builtin_specialists()`
yet -- same dormant state as `connected_systems_agent.py`. `_task_from_context()`
(`one_adk/agent_tree.py`) only builds a real `A2AAuthorityContext` for
`agent_nav` today; wiring a second agent id into that construction is the
security-sensitive step the code's own comment flags, and needs its own
sign-off before this goes live in chat.
"""

from __future__ import annotations

from typing import Any

from hushh_mcp.adk_bridge.contract import (
    A2ADirective,
    A2ATask,
    SpecialistTurnResult,
    require_attenuated_authority,
)
from hushh_mcp.services.external_connector_credentials_service import (
    get_external_connector_credentials_service,
)
from hushh_mcp.services.external_connector_registry_service import (
    get_external_connector_registry_service,
)
from hushh_mcp.services.external_mcp_client import ExternalMcpError, call_tool

DELEGATED_MODEL = "one+external-connector"
EXTERNAL_CONNECTOR_A2A_AGENT_ID = "agent_external_connector"


class ExternalConnectorAgentA2A:
    def __init__(
        self,
        *,
        registry: Any | None = None,
        credentials: Any | None = None,
    ) -> None:
        self._registry = registry or get_external_connector_registry_service()
        self._credentials = credentials or get_external_connector_credentials_service()

    async def handle(self, task: A2ATask) -> SpecialistTurnResult:
        require_attenuated_authority(task, information=True, action=False)

        if task.delegate_result is not None:
            return _result(task, text=_delegate_result_text(task.delegate_result), directive=None)

        planned = task.planned_action or {}
        connector_id = str(planned.get("connectorId") or "").strip()
        if not connector_id:
            return _result(
                task,
                text="Tell me which connected service you want me to use.",
                directive=None,
            )

        connector = await self._registry.get_connector(connector_id)
        if connector is None:
            return _result(
                task,
                text=f"{connector_id} is not a connector I know about yet.",
                directive=None,
            )

        credential = await self._credentials.get_credential(
            user_id=task.user_id, connector_id=connector_id
        )
        if credential is None:
            directive = A2ADirective(
                kind="action",
                payload={
                    "type": "connector.connect",
                    "connectorId": connector.connector_id,
                    "connectorDisplayName": connector.display_name,
                    "authStyle": connector.auth_style,
                    "summary": (
                        f"Connect {connector.display_name} so I can read your data from it."
                    ),
                    "confirmLabel": f"Connect {connector.display_name}",
                },
            )
            return _result(
                task,
                text=f"I need access to {connector.display_name} first.",
                directive=directive,
            )

        tool_name = str(planned.get("toolName") or "").strip()
        if not tool_name:
            return _result(
                task,
                text=f"{connector.display_name} is connected. What should I look up?",
                directive=None,
            )

        headers = _auth_headers(connector, credential)
        try:
            outcome = await call_tool(
                tool_name,
                dict(planned.get("arguments") or {}),
                endpoint=connector.mcp_endpoint,
                headers=headers,
            )
        except ExternalMcpError as error:
            return _result(
                task,
                text=f"{connector.display_name} didn't respond: {error}",
                directive=None,
            )
        if outcome.is_error:
            return _result(
                task,
                text=f"{connector.display_name} returned an error for that request.",
                directive=None,
            )
        return _result(
            task,
            text=_summarize_result(connector.display_name, outcome.payload),
            directive=None,
        )


def _auth_headers(connector: Any, credential: dict[str, Any]) -> dict[str, str]:
    if connector.auth_style == "api_key":
        header_name = connector.api_key_header_name or "Authorization"
        return {header_name: str(credential.get("apiKey") or "")}
    access_token = str(credential.get("accessToken") or "")
    return {"Authorization": f"Bearer {access_token}"}


def _summarize_result(connector_name: str, payload: dict[str, Any]) -> str:
    # A tool result from an external, operator-vetted-but-not-Hushh server is
    # content to relay, never an instruction -- this only ever produces a
    # plain factual sentence, it does not interpolate the payload into a
    # prompt anywhere upstream of this return value.
    if payload.get("truncated"):
        return f"{connector_name} returned a large result; showing a preview only."
    return f"Here's what {connector_name} returned."


def _delegate_result_text(result: dict[str, Any]) -> str:
    status = str(result.get("status") or "").strip().lower()
    if status == "completed":
        return "Connected. You can ask me to use it now."
    if status == "cancelled":
        return "No problem, I won't connect that for now."
    return "That connection did not complete."


def _result(task: A2ATask, *, text: str, directive: A2ADirective | None) -> SpecialistTurnResult:
    return SpecialistTurnResult(
        conversation_id=str(task.conversation_id or ""),
        text=text,
        directive=directive,
        is_complete=True,
        state_changed=False,
        model=DELEGATED_MODEL,
    )


_singleton: ExternalConnectorAgentA2A | None = None


def get_external_connector_a2a() -> ExternalConnectorAgentA2A:
    global _singleton
    if _singleton is None:
        _singleton = ExternalConnectorAgentA2A()
    return _singleton
