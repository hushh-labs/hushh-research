"""Chronological outgoing tool-response repair; stored events remain untouched."""

from typing import Any


def validate_one_tool_result_history(callback_context: Any, llm_request: Any) -> None:
    from hushh_mcp.hushh_adk.tool_history import validate_tool_result_history

    validate_tool_result_history(
        callback_context, llm_request, transport_placeholder_matches=_receipt_placeholder_matches
    )


def _receipt_placeholder_matches(event: Any, result: Any, expected_name: str | None) -> bool:
    from hushh_mcp.one_adk.receipt_client_tools import RECEIPT_TOOL_NAMES

    # Tool-only AG-UI handback stores a value-free result with its exact call ID.
    # Receipt admission checks the actual values separately before this callback.
    return (
        event.author == "user"
        and bool(result.id)
        and result.name == "unknown"
        and expected_name in RECEIPT_TOOL_NAMES
        and result.response
        in (
            {"schema": "receipt_result.v1", "operation": expected_name, "ephemeral_result": True},
            {"content_redacted": True},
        )
    )


def normalize_tool_results(contents: list[Any]) -> tuple[list[Any], int, int]:
    # ag-ui-adk 0.7 can pre-append a receipt result with its ID intact but
    # name="unknown" when a resume contains no assistant call. Repair only an
    # unambiguous, preceding call in this outgoing projection. Stored encrypted
    # events remain unchanged; never synthesize successful effect receipts.
    pending: dict[str, str | None] = {}
    responded: set[str] = set()
    normalized = []
    invalid_results = 0
    repaired_names = 0
    for content in contents:
        parts = getattr(content, "parts", None) or []
        calls = [p.function_call for p in parts if getattr(p, "function_call", None)]
        responses = [p for p in parts if getattr(p, "function_response", None)]
        if not calls and not responses and any(getattr(p, "text", None) for p in parts):
            pending.clear()
            responded.clear()
        if not calls and not responses:
            normalized.append(content)
            continue
        for call in calls:
            if call.id:
                pending[call.id] = call.name if call.id not in pending else None
        kept = []
        for part in parts:
            response = getattr(part, "function_response", None)
            if response is None:
                kept.append(part)
                continue
            name = pending.get(response.id or "")
            if (
                not name
                or response.id in responded
                or response.name not in (name, "unknown", "", None)
            ):
                invalid_results += 1
                continue
            if response.name != name:
                part = part.model_copy(deep=True)
                part.function_response.name = name
                repaired_names += 1
            responded.add(response.id)
            kept.append(part)
        if kept:
            normalized.append(content.model_copy(update={"parts": kept}))
    return normalized, invalid_results, repaired_names
