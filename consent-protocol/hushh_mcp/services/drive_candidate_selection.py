"""Tool-less relevance choice among already-found live Drive files.

A keyword search finds candidates; the manifest-owned gene
``agent_documents_live_select`` decides which of them are plausibly the
requested document, from metadata only (title, type and file days). The host
never judges relevance: it shows the gene opaque refs, resolves its answer back
to the exact found files, drops duplicates, and fails closed on any ref it did
not offer. An answer longer than MAX_SELECTED keeps the gene's first eight and
is recorded (``completed_over_limit``) so callers can say more matches may
exist. There is no fallback to the unfiltered list.
"""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Awaitable, Callable
from datetime import datetime
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from hushh_mcp.hushh_adk.manifest import ManifestLoader
from hushh_mcp.hushh_adk.single_turn import build_single_turn_agent, run_single_turn
from hushh_mcp.services.drive_live_reader import MAX_SEARCH_RESULTS

logger = logging.getLogger(__name__)

MAX_SELECTED = 8
_DAY = re.compile(r"^\d{4}-\d{2}-\d{2}")

Selector = Callable[..., Awaitable[Any]]


# Flat and unbounded in the schema the model is given: Vertex rejected bounded
# nested lists (#7062). The count is bounded in select_matches, after the model
# answers, and recorded; a long answer is never a failed turn.
class CandidateSelection(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    selected: list[str] = Field(default_factory=list)


def _day(value: object) -> str | None:
    return value[:10] if isinstance(value, str) and _DAY.match(value) else None


def candidate_view(matches: list[dict]) -> list[dict]:
    """What the gene may see: opaque refs and metadata, never ids or links."""
    if len(matches) > MAX_SEARCH_RESULTS:
        raise ValueError("too many candidates")
    return [
        {
            "ref": f"c{index}",
            "title": " ".join(str(match.get("name") or "").split())[:200],
            "kind": str(match.get("mime_type") or "")[:100],
            "modified": _day(match.get("modified_time")),
            "created": _day(match.get("created_time")),
        }
        for index, match in enumerate(matches, 1)
    ]


def resolve_selection(matches: list[dict], selection: CandidateSelection) -> list[dict]:
    """Map the gene's refs to the exact found files, in the gene's order, once each."""
    offered = {f"c{index}": match for index, match in enumerate(matches, 1)}
    if any(ref not in offered for ref in selection.selected):
        raise ValueError("invented candidate reference")
    return [offered[ref] for ref in dict.fromkeys(selection.selected)]


async def interpret_candidate_selection(*, prompt, user_id):
    manifest = ManifestLoader.load(
        str(Path(__file__).resolve().parents[1] / "agents/documents/agent.yaml")
    )
    gene = next(child for child in manifest.subagents if child.id == "agent_documents_live_select")
    if (
        gene.privacy.plaintext_telemetry
        or gene.runtime.adk_mode != "single_turn"
        or gene.runtime.transport != ["in_process"]
    ):
        raise ValueError("invalid candidate selector")
    agent = build_single_turn_agent(gene, output_schema=CandidateSelection)
    # Empty context grants no tool capability; the caller owns every fence.
    result = await run_single_turn(
        agent,
        prompt_parts=prompt,
        user_id=user_id,
        consent_token="",
        timeout_seconds=20,  # nosec B106
    )
    return result.model_dump(mode="json") if hasattr(result, "model_dump") else result


async def select_matches(
    *,
    selector: Selector,
    request: dict,
    mode: str,
    sort: str,
    matches: list[dict],
    truncated: bool,
    now_utc: datetime,
    timezone: str,
    user_id: str,
) -> tuple[list[dict], dict]:
    """Ask the gene which found files fit the request; return them and a trace."""
    prompt = json.dumps(
        {
            "document_request": request,
            "mode": mode,
            "sort": sort,
            "current_time_utc": now_utc.isoformat(),
            "user_timezone": timezone,
            "candidates": {"truncated": truncated, "items": candidate_view(matches)},
        },
        ensure_ascii=False,
    )
    selection = CandidateSelection.model_validate(await selector(prompt=prompt, user_id=user_id))
    chosen = resolve_selection(matches, selection)
    trace: dict[str, Any] = {"stage": "completed", "candidates": len(matches)}
    if len(chosen) > MAX_SELECTED:
        # The gene's own best-first order decides which are kept; the cut is
        # recorded, never silent (backend semantic boundary).
        logger.info(
            "drive_select.over_limit mode=%s sort=%s selected=%d kept=%d",
            mode,
            sort,
            len(chosen),
            MAX_SELECTED,
        )
        chosen = chosen[:MAX_SELECTED]
        trace.update(stage="completed_over_limit", over_limit=True)
    trace["selected"] = len(chosen)
    # Enums and counts only: never titles, terms or the request.
    logger.info(
        "drive_select.completed mode=%s sort=%s candidates=%d selected=%d",
        mode,
        sort,
        len(matches),
        len(chosen),
    )
    return chosen, trace
