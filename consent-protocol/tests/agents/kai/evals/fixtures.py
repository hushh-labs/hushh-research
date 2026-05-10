# tests/agents/kai/evals/fixtures.py
"""
Shared fixtures + helpers for Kai eval harness tests.

We deliberately do NOT spin up the real Kai agents here -- those need
PKM/Renaissance/SEC services that are not available in CI. Instead the
fixtures provide:

1. A `MockProvider` that returns deterministic JSON the eval harness
   can score. It accepts a "behavior" dict that maps scenario_id ->
   canned debate output, so tests can assert metric correctness.
2. An `InMemoryAuditWriter` that captures audit records for assertion.
3. A `load_scenarios()` helper that hydrates Scenario objects from YAML.

For real provider runs (against Gemini, OpenAI, etc.), use the
`compare.py` script which calls the actual debate engine.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import AsyncIterator, Optional

import yaml

from hushh_mcp.operons.kai.providers import (
    AuditWriter,
    CompletionRequest,
    CompletionResponse,
    LLMProvider,
    StreamEvent,
)
from hushh_mcp.operons.kai.providers.audit import InferenceAuditRecord

from .schema import (
    AgentOutput,
    DebateOutput,
    Recommendation,
    Scenario,
)


# ---------------------------------------------------------------------------
# MockProvider
# ---------------------------------------------------------------------------


class MockProvider(LLMProvider):
    """Deterministic provider for test runs.

    Construct with a `responses` mapping from scenario_id -> JSON string
    that the harness will treat as the synthesis output.
    """

    name = "mock"
    kind = "private"
    default_model = "mock-1.0"

    def __init__(self, responses: Optional[dict[str, str]] = None) -> None:
        self._responses = responses or {}
        self.calls: list[CompletionRequest] = []

    def is_ready(self) -> tuple[bool, Optional[str]]:
        return True, None

    async def complete(self, request: CompletionRequest) -> CompletionResponse:
        self.calls.append(request)
        # Find scenario_id in prompt -- caller embeds it as `[scenario:ID]`.
        sid = _extract_scenario_id(request.prompt)
        text = self._responses.get(sid) or _default_response_text()
        return CompletionResponse(
            text=text, provider=self.name, model=self.default_model, finish_reason="stop"
        )

    async def stream(self, request: CompletionRequest) -> AsyncIterator[StreamEvent]:
        resp = await self.complete(request)
        yield StreamEvent(type="token", text=resp.text)
        yield StreamEvent(type="complete", text=resp.text)


def _extract_scenario_id(prompt: str) -> str:
    """Extract `[scenario:ID]` marker injected by the runner."""
    import re

    m = re.search(r"\[scenario:([\w_-]+)\]", prompt)
    return m.group(1) if m else ""


def _default_response_text() -> str:
    """Generic fallback when no per-scenario response is registered."""
    return json.dumps(
        {
            "thesis": "Insufficient signal to form a thesis at high confidence.",
            "key_drivers": ["No specific driver identified"],
            "key_risks": ["No specific risk identified"],
            "action_plan": ["Wait for additional data"],
            "watchlist_triggers": ["Quarterly earnings"],
            "horizon_fit": "Unknown",
            "_debate": {
                "fundamental": {"score": 0.0, "reasoning": "neutral"},
                "sentiment": {"score": 0.0, "reasoning": "neutral"},
                "valuation": {"score": 0.0, "reasoning": "neutral"},
                "recommendation": "HOLD",
                "confidence": 0.5,
            },
        }
    )


# ---------------------------------------------------------------------------
# InMemoryAuditWriter
# ---------------------------------------------------------------------------


class InMemoryAuditWriter(AuditWriter):
    """Audit writer that keeps records in a list for assertions."""

    async def write(
        self,
        *,
        token_id: str,
        user_id: str,
        agent_id: str,
        record: InferenceAuditRecord,
    ) -> None:
        self._records.append((token_id, record))


# ---------------------------------------------------------------------------
# Scenario loading
# ---------------------------------------------------------------------------


def scenarios_dir() -> Path:
    return Path(__file__).resolve().parent / "scenarios"


def load_scenarios(directory: Optional[Path] = None) -> dict[str, Scenario]:
    """Load all *.yaml scenarios from `directory` (defaults to scenarios/)."""
    out: dict[str, Scenario] = {}
    for path in sorted((directory or scenarios_dir()).glob("*.yaml")):
        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
        if not raw:
            continue
        scenario = Scenario.from_dict(raw)
        out[scenario.id] = scenario
    return out


# ---------------------------------------------------------------------------
# DebateOutput parsing helpers
# ---------------------------------------------------------------------------


def parse_debate_from_synthesis_text(
    text: str, scenario_id: str, provider: str, model: str
) -> DebateOutput:
    """
    Parse a JSON synthesis card into a DebateOutput.

    The synthesis card contains the user-facing fields plus a `_debate`
    sub-object that captures the per-agent reasoning. Real Kai would
    populate `_debate` from the actual agent runs in
    `api/routes/kai/stream.py`; for the eval harness we either:

      (a) Inject a `_debate` block via the MockProvider response, or
      (b) When running against real Gemini, pull the agent payloads
          directly from the debate engine (see compare.py).
    """
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        # Fallback: try after stripping markdown
        cleaned = text.strip().removeprefix("```json").removesuffix("```").strip()
        data = json.loads(cleaned)

    rationale = data.get("thesis", "")
    debate = data.get("_debate") or {}
    rec_raw = (debate.get("recommendation") or "HOLD").upper()
    rec: Recommendation = rec_raw if rec_raw in {  # type: ignore[assignment]
        "BUY",
        "HOLD",
        "SELL",
        "STRONG_BUY",
        "STRONG_SELL",
    } else "HOLD"
    confidence = float(debate.get("confidence", 0.5))

    def _agent(name: str) -> AgentOutput:
        a = debate.get(name) or {}
        return AgentOutput(
            agent=name,  # type: ignore[arg-type]
            score=float(a["score"]) if "score" in a else None,
            classification=a.get("classification"),
            reasoning=str(a.get("reasoning") or ""),
            citations=list(a.get("citations") or []),
        )

    fund = _agent("fundamental")
    sent = _agent("sentiment")
    val = _agent("valuation")
    ren = AgentOutput(
        agent="renaissance",
        score=None,
        classification=None,
        reasoning=str((debate.get("renaissance") or {}).get("reasoning", "")),
    )

    return DebateOutput(
        scenario_id=scenario_id,
        provider=provider,
        model=model,
        fundamental=fund,
        sentiment=sent,
        valuation=val,
        renaissance=ren if ren.reasoning else None,
        recommendation=rec,
        confidence=confidence,
        rationale=rationale,
        latency_ms_per_agent=dict(data.get("_latency_ms") or {}),
    )
