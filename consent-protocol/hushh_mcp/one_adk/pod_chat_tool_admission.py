"""Admit only generated tools available to a direct private chat turn."""

from __future__ import annotations

from typing import Any

from hushh_mcp.one_adk.agui_action_tools import action_id_from_tool_name
from hushh_mcp.one_adk.receipt_turn_admission import admit_receipt_tool
from hushh_mcp.services.action_gateway import (
    get_action_gateway_action,
    is_runtime_disabled_action,
)


class PodChatToolAdmissionError(ValueError):
    """A client tool is malformed, unknown, or violates the closed contract."""


def admit_pod_chat_tools(tools: list[Any]) -> list[Any]:
    admitted: list[Any] = []
    for tool in tools:
        try:
            if admit_receipt_tool(tool):
                admitted.append(tool)
                continue
        except ValueError:
            raise PodChatToolAdmissionError from None
        action_id = action_id_from_tool_name(tool.name)
        if action_id and get_action_gateway_action(action_id) is not None:
            admitted.append(tool)
        elif not is_runtime_disabled_action(action_id):
            raise PodChatToolAdmissionError
    return admitted


__all__ = ["PodChatToolAdmissionError", "admit_pod_chat_tools"]
