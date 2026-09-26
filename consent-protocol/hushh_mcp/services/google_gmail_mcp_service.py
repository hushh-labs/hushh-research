"""Official Gmail MCP reads using the existing per-owner Gmail connection.

Provider writes are never admitted here. Reviewed delivery retains its existing
service and confirmation authority; a discovered draft tool is not a send grant.
"""

from __future__ import annotations

from copy import deepcopy
from typing import Any

from hushh_mcp.services.external_mcp_client import ExternalMcpToolResult, call_tool, list_tools
from hushh_mcp.services.gmail_delivery_service import normalize_draft
from hushh_mcp.services.gmail_receipts_service import GmailApiError, GmailReceiptsService
from hushh_mcp.services.mcp_capability_policy import (
    admit_catalog,
    arguments_bounded,
    arguments_valid,
)
from hushh_mcp.services.mcp_catalog_cache import McpCatalogCache

GOOGLE_GMAIL_MCP_ENDPOINT = "https://gmailmcp.googleapis.com/mcp/v1"
# Draft contents and arbitrary message bodies are outside typed Chat's existing
# metadata-only Mail read contract, even when OAuth grants gmail.readonly.
GOOGLE_GMAIL_READ_TOOLS = frozenset({"search_threads", "get_thread", "list_labels"})
_CATALOG_TTL_SECONDS = 300
_MAX_ROWS = 25
_REQUIRED_MODES = {
    "get_thread": ("messageFormat", "METADATA_ONLY"),
    "search_threads": ("view", "THREAD_VIEW_METADATA_ONLY"),
}
_MESSAGE_FIELDS = {"id": 200, "sender": 320, "date": 100}
_MESSAGE_LIST_FIELDS = {"toRecipients", "ccRecipients", "labelIds"}


def _metadata_row(value: Any, *, labels: bool = False) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise GmailApiError("Gmail metadata is unavailable", status_code=502)
    fields = {"id": 200, "name": 320, "type": 40} if labels else _MESSAGE_FIELDS
    row: dict[str, Any] = {}
    for key, limit in fields.items():
        raw = value.get(key)
        if raw is not None:
            if not isinstance(raw, str):
                raise GmailApiError("Gmail metadata is unavailable", status_code=502)
            row[key] = " ".join(raw.split())[:limit]
    if not row.get("id"):
        raise GmailApiError("Gmail metadata is unavailable", status_code=502)
    if not labels:
        for key in _MESSAGE_LIST_FIELDS:
            raw = value.get(key)
            if raw is None:
                continue
            if (
                not isinstance(raw, list)
                or len(raw) > _MAX_ROWS
                or any(not isinstance(item, str) for item in raw)
            ):
                raise GmailApiError("Gmail metadata is unavailable", status_code=502)
            row[key] = [" ".join(item.split())[:320] for item in raw]
    return row


def _metadata_thread(value: Any) -> tuple[dict[str, Any], bool]:
    if (
        not isinstance(value, dict)
        or not isinstance(value.get("id"), str)
        or not value["id"].strip()
    ):
        raise GmailApiError("Gmail metadata is unavailable", status_code=502)
    messages = value.get("messages")
    if not isinstance(messages, list):
        raise GmailApiError("Gmail metadata is unavailable", status_code=502)
    return {
        "id": " ".join(value["id"].split())[:200],
        "messages": [_metadata_row(message) for message in messages[:_MAX_ROWS]],
    }, len(messages) > _MAX_ROWS


def _metadata_result(tool_name: str, payload: Any) -> tuple[dict[str, Any], bool]:
    """Allowlist output fields; never pass provider bodies, snippets or attachments onward."""
    if not isinstance(payload, dict):
        raise GmailApiError("Gmail metadata is unavailable", status_code=502)
    if tool_name == "list_labels":
        key = "labels"
    elif tool_name == "search_threads":
        threads = payload.get("threads")
        if not isinstance(threads, list):
            raise GmailApiError("Gmail metadata is unavailable", status_code=502)
        projected = [_metadata_thread(thread) for thread in threads[:_MAX_ROWS]]
        return {
            "threads": [thread for thread, _ in projected],
            "metadata_only": True,
        }, bool(payload.get("nextPageToken")) or len(threads) > _MAX_ROWS or any(
            truncated for _, truncated in projected
        )
    else:
        thread = payload.get("thread", payload)
        row, truncated = _metadata_thread(thread)
        return {"thread": row, "metadata_only": True}, truncated
    rows = payload.get(key)
    if not isinstance(rows, list):
        raise GmailApiError("Gmail metadata is unavailable", status_code=502)
    return {
        key: [_metadata_row(row, labels=key == "labels") for row in rows[:_MAX_ROWS]],
        "metadata_only": True,
    }, len(rows) > _MAX_ROWS


def _narrowed_capability(capability: dict[str, Any]) -> dict[str, Any] | None:
    """Advertise only a mode whose published response excludes snippets and bodies."""
    name = capability["name"]
    policy = _REQUIRED_MODES.get(name)
    if policy is None:
        return deepcopy(capability)
    field, required_mode = policy
    schema = deepcopy(capability["inputSchema"])
    properties = schema.get("properties")
    if not isinstance(properties, dict) or not isinstance(properties.get(field), dict):
        return None
    field_schema = properties[field]
    if ("enum" in field_schema and required_mode not in field_schema["enum"]) or (
        "const" in field_schema and field_schema["const"] != required_mode
    ):
        return None
    field_schema["enum"] = [required_mode]
    field_schema.pop("default", None)
    required = schema.get("required", [])
    if not isinstance(required, list):
        return None
    schema["required"] = sorted(set(required) | {field})
    return {**capability, "inputSchema": schema}


def _policy_arguments(tool_name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    policy = _REQUIRED_MODES.get(tool_name)
    if policy is None:
        return arguments
    field, required_mode = policy
    if field in arguments and arguments[field] != required_mode:
        raise GmailApiError("Gmail metadata mode is required", status_code=400)
    # Filling an omitted safety mode is a retrieval constraint, not a semantic rewrite.
    return {**arguments, field: required_mode}


class GoogleGmailMcpService:
    def __init__(self, *, connections: GmailReceiptsService | None = None) -> None:
        self._connections = connections or GmailReceiptsService()
        self._catalog = McpCatalogCache(ttl_seconds=_CATALOG_TTL_SECONDS)

    async def _catalog_for_token(
        self, token: str, *, force_refresh: bool = False
    ) -> list[dict[str, Any]]:
        async def discover() -> list[dict[str, Any]]:
            tools = await list_tools(
                endpoint=GOOGLE_GMAIL_MCP_ENDPOINT,
                headers={"Authorization": f"Bearer {token}"},
            )
            return admit_catalog(tools, allowed_names=GOOGLE_GMAIL_READ_TOOLS)

        return await self._catalog.load(token, discover, force_refresh=force_refresh)

    async def discover_read_tools(
        self, *, user_id: str, force_refresh: bool = False
    ) -> list[dict[str, Any]]:
        if not user_id:
            raise GmailApiError("Connect Gmail first", status_code=403)
        token = await self._connections.get_read_access_token(user_id=user_id)
        catalog = await self._catalog_for_token(token, force_refresh=force_refresh)
        return [narrowed for item in catalog if (narrowed := _narrowed_capability(item))]

    async def read_tool(
        self, *, user_id: str, tool_name: str, arguments: dict[str, Any]
    ) -> ExternalMcpToolResult:
        if not user_id or tool_name not in GOOGLE_GMAIL_READ_TOOLS:
            raise GmailApiError("This Gmail operation is not available", status_code=403)
        if not arguments_bounded(arguments):
            raise GmailApiError("Gmail request is invalid", status_code=400)
        token = await self._connections.get_read_access_token(user_id=user_id)
        catalog = await self._catalog_for_token(token)
        capability = next((item for item in catalog if item["name"] == tool_name), None)
        if capability is None or _narrowed_capability(capability) is None:
            raise GmailApiError("This Gmail operation is unavailable", status_code=403)
        safe_arguments = _policy_arguments(tool_name, arguments)
        if not arguments_valid(capability, safe_arguments):
            raise GmailApiError("Gmail request is invalid", status_code=400)
        result = await call_tool(
            tool_name,
            safe_arguments,
            endpoint=GOOGLE_GMAIL_MCP_ENDPOINT,
            headers={"Authorization": f"Bearer {token}"},
        )
        if result.is_error:
            return ExternalMcpToolResult(is_error=True, payload={}, truncated=result.truncated)
        metadata, truncated = _metadata_result(tool_name, result.payload)
        return ExternalMcpToolResult(
            is_error=False, payload=metadata, truncated=result.truncated or truncated
        )

    async def create_reviewed_draft(
        self, *, user_id: str, draft_payload: dict[str, Any]
    ) -> dict[str, str]:
        """Save an explicitly reviewed, attachment-free draft via hosted Gmail MCP.

        Never return provider-echoed recipients or bodies to Chat/history. A
        missing acknowledgement has unknown outcome: callers must not auto-retry.
        """
        draft = normalize_draft(draft_payload)
        token = await self._connections.get_compose_access_token(user_id=user_id)
        tools = await list_tools(
            endpoint=GOOGLE_GMAIL_MCP_ENDPOINT,
            headers={"Authorization": f"Bearer {token}"},
        )
        catalog = admit_catalog(tools, allowed_names=frozenset({"create_draft"}))
        capability = next((item for item in catalog if item["name"] == "create_draft"), None)
        if capability is None:
            raise GmailApiError("Gmail drafts are unavailable", status_code=503)
        arguments: dict[str, Any] = {
            "to": list(draft.to),
            "cc": list(draft.cc),
            "bcc": list(draft.bcc),
            "subject": draft.subject,
            "body": draft.body,
        }
        if draft.html_body:
            arguments["htmlBody"] = draft.html_body
        if not arguments_bounded(arguments) or not arguments_valid(capability, arguments):
            raise GmailApiError("Gmail draft is invalid", status_code=400)
        result = await call_tool(
            "create_draft",
            arguments,
            endpoint=GOOGLE_GMAIL_MCP_ENDPOINT,
            headers={"Authorization": f"Bearer {token}"},
        )
        if result.is_error:
            raise GmailApiError("Gmail could not save this draft", status_code=502)
        draft_id = result.payload.get("id")
        if not isinstance(draft_id, str) or not 1 <= len(draft_id) <= 256:
            raise GmailApiError("Gmail draft outcome is unknown", status_code=502)
        return {"status": "saved", "draft_id": draft_id}
