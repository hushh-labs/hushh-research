"""Bridge native ADK safety requests to exact, authenticated owner review."""

from __future__ import annotations

import json

from google.adk.tools.tool_confirmation import ToolConfirmation

from .contracts import BrowserRefused
from .control import BrowserControl
from .information import BrowserModelProcessing


async def review_provider_action(
    control: BrowserControl,
    processing: BrowserModelProcessing,
    *,
    call_id: str,
    tool: str,
    arguments: dict,
    warnings: list[dict],
) -> None:
    if (
        not isinstance(call_id, str)
        or not 1 <= len(call_id) <= 256
        or not warnings
        or len(warnings) > 8
    ):
        raise BrowserRefused("BROWSER_PROVIDER_REVIEW_INVALID")
    epoch = await control.require_model_observation()
    await processing.require()
    terms = {
        "model": processing.model_name,
        "transport": processing.transport,
        "call_id": call_id,
        "tool": tool,
        "arguments": arguments,
        "warnings": warnings,
        "origins": list(processing.allowed_origins),
        "control_epoch": epoch,
        "sequence": control.next_sequence,
        "viewport": control.viewport.model_dump(),
    }
    # Copy exact terms before awaiting; ADK normalizes coordinates in place.
    try:
        encoded = json.dumps(terms, allow_nan=False, separators=(",", ":"))
        if len(encoded.encode()) > 65536:
            raise ValueError()
        terms = json.loads(encoded)
    except (ValueError, TypeError):
        raise BrowserRefused("BROWSER_PROVIDER_REVIEW_INVALID") from None
    await processing.information.provider_review(control.binding, terms)
    await control.require_model_observation(expected_epoch=epoch)
    if (
        control.next_sequence != terms["sequence"]
        or control.viewport.model_dump() != terms["viewport"]
    ):
        raise BrowserRefused("BROWSER_CONTROL_CHANGED")
    await processing.require()
    await control.require_model_observation(expected_epoch=epoch)


def gemini_before_tool(control: BrowserControl, processing: BrowserModelProcessing):
    async def before_tool(tool, args, tool_context):
        await control.require_model_observation()
        decision = args.get("safety_decision")
        if decision is None:
            control.admit_native_call(tool_context.function_call_id)
            return None
        if (
            not isinstance(decision, dict)
            or set(decision) - {"decision", "explanation"}
            or decision.get("decision") not in {"require_confirmation", "proceed"}
        ):
            raise BrowserRefused("BROWSER_PROVIDER_REVIEW_INVALID")
        if decision["decision"] == "proceed":
            control.admit_native_call(tool_context.function_call_id)
            return None  # Ordinary action and network consent still apply.
        explanation = (
            decision.get("explanation") or "The model flagged this browser action for review."
        )
        if not isinstance(explanation, str) or len(explanation) > 4096:
            raise BrowserRefused("BROWSER_PROVIDER_REVIEW_INVALID")
        await review_provider_action(
            control,
            processing,
            call_id=tool_context.function_call_id,
            tool=tool.name,
            arguments=args,
            warnings=[{"code": "provider_safety", "message": explanation}],
        )
        # ADK's public confirmation seam is set only AFTER the owner ledger
        # receipt was consumed for this exact call/viewport/control epoch.
        control.admit_native_call(tool_context.function_call_id)
        tool_context.tool_confirmation = ToolConfirmation(confirmed=True)
        return None

    return before_tool
