"""Chronological outgoing tool-response repair; stored events remain untouched."""

from typing import Any


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
