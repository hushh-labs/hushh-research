"""The live selector judges already-found Drive files from metadata only.

Relevance is the gene's output. The host only resolves its refs to the found
files, drops duplicates, bounds the count and fails closed on anything else.
"""

import json
import logging
from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.genai import types
from pydantic import PrivateAttr, ValidationError

from hushh_mcp.hushh_adk.manifest import ManifestLoader
from hushh_mcp.hushh_adk.single_turn import build_single_turn_agent, run_single_turn
from hushh_mcp.services import drive_candidate_selection as selection_module
from hushh_mcp.services.drive_candidate_selection import (
    CandidateSelection,
    candidate_view,
    resolve_selection,
    select_matches,
)

NOW = datetime(2026, 9, 25, 9, 0, tzinfo=UTC)


class ScriptedLlm(BaseLlm):
    _response: str = PrivateAttr()

    def __init__(self, response: str):
        super().__init__(model="gemini-3.7-flash")
        self._response = response

    async def generate_content_async(self, llm_request, stream=False):
        yield LlmResponse(
            content=types.Content(role="model", parts=[types.Part(text=self._response)])
        )


def found(index, name, **changes):
    return {
        "file_id": f"1AbCdEfGhIjKlMnOpQrStUvWxYz0{index:05d}",
        "name": name,
        "mime_type": "application/pdf",
        "modified_time": "2026-05-02T10:00:00.000Z",
        "created_time": "2026-05-01T09:00:00Z",
        "source_ref": "document:" + f"{index:032d}",
        "open_url": f"https://drive.google.com/open?id=1AbCdEfGhIjKlMnOpQrStUvWxYz0{index:05d}",
        **changes,
    }


def test_candidate_view_exposes_only_ref_title_kind_and_days():
    matches = [
        found(1, "  HDFC   Statement\nApr 2026.pdf "),
        found(2, "x" * 400),
        {"file_id": "1AbCdEfGhIjKlMnOpQrStUvWxYz012345", "name": "Bank details.txt"},
    ]
    view = candidate_view(matches)
    shown = json.dumps(view)
    for secret in ("1AbCdEfGh", "drive.google.com", "document:", "open_url", "source_ref"):
        assert secret not in shown
    assert [item["ref"] for item in view] == ["c1", "c2", "c3"]
    assert view[0] == {
        "ref": "c1",
        "title": "HDFC Statement Apr 2026.pdf",
        "kind": "application/pdf",
        "modified": "2026-05-02",
        "created": "2026-05-01",
    }
    assert len(view[1]["title"]) == 200
    assert view[2]["kind"] == "" and view[2]["modified"] is None and view[2]["created"] is None
    with pytest.raises(ValueError):
        candidate_view([found(index, f"f{index}") for index in range(26)])


def test_candidate_view_ignores_malformed_dates():
    view = candidate_view([found(1, "a", modified_time="yesterday", created_time=7)])
    assert view[0]["modified"] is None and view[0]["created"] is None


@pytest.mark.parametrize("ref", ["c0", "c3", "c26", "document:x", "C1", " c1"])
def test_resolve_rejects_invented_or_out_of_range_refs(ref):
    matches = [found(1, "a"), found(2, "b")]
    with pytest.raises(ValueError, match="invented candidate reference"):
        resolve_selection(matches, CandidateSelection(selected=[ref]))


def test_resolve_dedupes_and_keeps_model_order():
    first, second = found(1, "a"), found(2, "b")
    chosen = resolve_selection([first, second], CandidateSelection(selected=["c2", "c1", "c2"]))
    assert chosen == [second, first]
    assert chosen[0] is second and chosen[1] is first
    assert resolve_selection([first], CandidateSelection(selected=[])) == []


def test_selection_schema_rejects_extra_keys_and_more_than_eight():
    with pytest.raises(ValidationError):
        CandidateSelection.model_validate({"selected": [f"c{index}" for index in range(1, 10)]})
    with pytest.raises(ValidationError):
        CandidateSelection.model_validate({"selected": [], "reason": "x"})
    with pytest.raises(ValidationError):
        CandidateSelection.model_validate({"selected": [1]})
    assert CandidateSelection.model_validate({}).selected == []


def test_selection_schema_given_to_the_model_is_flat_and_unbounded():
    """Vertex rejected bounded nested lists (#7062); bounds are enforced host-side."""
    schema = json.dumps(CandidateSelection.model_json_schema())
    for keyword in ("maxItems", "minItems", "pattern", "maxLength"):
        assert keyword not in schema


async def test_select_matches_prompt_carries_request_mode_sort_time_zone_and_truncated():
    matches = [found(1, "Notes by Gemini"), found(2, "HDFC_Statement_Apr2026.pdf")]
    selector = AsyncMock(return_value={"selected": ["c2"]})
    chosen, trace = await select_matches(
        selector=selector,
        request={"purpose": "last 6 months bank statements"},
        mode="read",
        sort="relevance",
        matches=matches,
        truncated=True,
        now_utc=NOW,
        timezone="Asia/Kolkata",
        user_id="owner",
    )
    assert chosen == [matches[1]]
    assert trace == {"stage": "completed", "candidates": 2, "selected": 1}
    selector.assert_awaited_once()
    assert selector.await_args.kwargs["user_id"] == "owner"
    prompt = json.loads(selector.await_args.kwargs["prompt"])
    assert prompt["document_request"] == {"purpose": "last 6 months bank statements"}
    assert prompt["mode"] == "read" and prompt["sort"] == "relevance"
    assert prompt["current_time_utc"] == NOW.isoformat()
    assert prompt["user_timezone"] == "Asia/Kolkata"
    assert prompt["candidates"]["truncated"] is True
    assert [item["ref"] for item in prompt["candidates"]["items"]] == ["c1", "c2"]
    assert "1AbCdEfGh" not in selector.await_args.kwargs["prompt"]


@pytest.mark.parametrize("answer", [{"selected": ["c9"]}, {"selected": [], "why": "x"}, "c1"])
async def test_select_matches_fails_closed_on_an_invalid_answer(answer):
    with pytest.raises((ValueError, ValidationError)):
        await select_matches(
            selector=AsyncMock(return_value=answer),
            request={"purpose": "statement"},
            mode="find",
            sort="relevance",
            matches=[found(1, "a")],
            truncated=False,
            now_utc=NOW,
            timezone="UTC",
            user_id="owner",
        )


async def test_selector_gene_is_toolless_single_turn_and_decodes_refs():
    manifest = ManifestLoader.load(
        str(Path(selection_module.__file__).resolve().parents[1] / "agents/documents/agent.yaml")
    )
    gene = next(child for child in manifest.subagents if child.id == "agent_documents_live_select")
    assert gene.model.thinking_level == "low"
    assert gene.performance.max_output_tokens == 2048
    assert gene.rollout.kill_switch == "GOOGLE_DRIVE_LIVE"
    assert gene.runtime.adk_mode == "single_turn" and gene.runtime.transport == ["in_process"]
    assert gene.privacy.plaintext_telemetry is False
    agent = build_single_turn_agent(
        gene, output_schema=CandidateSelection, model=ScriptedLlm('{"selected":["c2"]}')
    )
    assert agent.tools == []
    assert agent.include_contents == "none"
    assert agent.generate_content_config.max_output_tokens == 2048
    result = await run_single_turn(
        agent,
        prompt_parts='{"document_request":{"purpose":"statement"}}',
        user_id="owner",
        consent_token="",  # noqa: S106
        timeout_seconds=20,
    )
    assert result == CandidateSelection(selected=["c2"])


async def test_interpret_candidate_selection_runs_the_manifest_gene(monkeypatch):
    run = AsyncMock(return_value=CandidateSelection(selected=["c1"]))
    monkeypatch.setattr(selection_module, "run_single_turn", run)
    answer = await selection_module.interpret_candidate_selection(prompt="{}", user_id="owner")
    assert answer == {"selected": ["c1"]}
    agent = run.await_args.args[0]
    assert agent.name == "agent_documents_live_select" and agent.tools == []
    assert run.await_args.kwargs["consent_token"] == ""


async def test_selection_logs_carry_only_enums_and_counts(caplog):
    matches = [found(1, "Notes by Gemini"), found(2, "March bank statement.pdf")]
    with caplog.at_level(logging.DEBUG):
        await select_matches(
            selector=AsyncMock(return_value={"selected": ["c2"]}),
            request={"purpose": "my statement please"},
            mode="find",
            sort="recent",
            matches=matches,
            truncated=False,
            now_utc=NOW,
            timezone="UTC",
            user_id="owner",
        )
    logged = "\n".join(record.getMessage() for record in caplog.records)
    assert "drive_select.completed" in logged
    for private in ("statement", "Notes by Gemini", "please", "owner", "1AbCdEfGh"):
        assert private not in logged
