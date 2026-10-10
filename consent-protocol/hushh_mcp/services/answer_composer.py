"""Writes the answer to one paid question from the approved information.

Where this runs, and why that matters
-------------------------------------
The owner's device decrypts their own PKM, projects it down to exactly the
approved scopes and dates, and sends that projection here for one request so a
model can write the answer. The backend decrypts nothing and stores nothing:
the projection lives for the duration of the call and the written answer goes
straight back to the device, which seals it to the requester's key.

This is the same owner-present shape One chat already uses, but it does mean
approved plaintext transits the backend during that one request. That is a
security-model property worth stating plainly rather than burying: if it is
not acceptable for this lane, the rollback is to stop calling the compose
endpoint, and the sweep delivers the approved projection labelled
``answer_mode='projection'`` instead.

Boundary declaration (backend-semantic-boundary.md, "new semantic surface"):

  owning agent      one_paid_answer_writer
  manifest path     hushh_mcp/agents/one/agent.yaml (subagents)
  output contract   ANSWER_COMPOSE_SCHEMA -> {answer, covers, gaps}
  validator rules   reject-whole on malformed output; the answer is never
                    rewritten or re-derived here, only refused
  live eval phase   required before PKM_ANSWER_PAYMENTS_ENABLED is enabled in
                    any environment; the lane ships disabled
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Mapping

logger = logging.getLogger(__name__)

GENE_ID = "one_paid_answer_writer"
GENE_TIMEOUT_SECONDS = 30.0

#: A projection larger than this is not a question's worth of context.
MAX_PROJECTION_CHARS = 60_000
MAX_ANSWER_CHARS = 2_000

ANSWER_COMPOSE_SCHEMA: dict[str, Any] = {
    "type": "OBJECT",
    "properties": {
        "answer": {"type": "STRING"},
        "covers": {"type": "ARRAY", "items": {"type": "STRING"}},
        "gaps": {"type": "ARRAY", "items": {"type": "STRING"}},
    },
    "required": ["answer"],
}


class AnswerComposerError(RuntimeError):
    """A model FAILURE. The caller records a projection, never a guess."""


def _prompt(
    *,
    question: str,
    projection: Mapping[str, Any],
    period: Mapping[str, str] | None,
) -> str:
    """Build the prompt from the person's own memory document.

    The device sends `{memory, values}`: the approved slice of their living
    memory, and the same values structured so exact figures can be cited.
    Older callers may still send a bare projection; that is handled rather
    than refused.
    """
    memory = str(projection.get("memory") or "").strip() if isinstance(projection, Mapping) else ""
    values = projection.get("values") if isinstance(projection, Mapping) else None
    if not memory:
        # No memory document: the whole payload is the values.
        values = projection

    lines = ["Question:", str(question or "").strip(), ""]
    if period:
        lines += [f"Requested period: {period.get('start')} to {period.get('end')}", ""]
    if memory:
        lines += [
            "This person's memory, limited to what they approved for this question.",
            "It opens with who they are, then holds each approved area in full:",
            memory[:MAX_PROJECTION_CHARS],
            "",
        ]
    if values:
        lines += [
            "The same information structured, so you can cite exact figures:",
            json.dumps(values, ensure_ascii=False, sort_keys=True)[:MAX_PROJECTION_CHARS],
        ]
    return "\n".join(lines)


class AnswerComposer:
    def __init__(self, *, runner=None) -> None:
        self._runner = runner

    async def compose(
        self,
        *,
        question: str,
        projection: Mapping[str, Any],
        period: Mapping[str, str] | None = None,
        user_id: str = "",
        consent_token: str = "",
    ) -> dict[str, Any]:
        if not isinstance(projection, Mapping) or not projection:
            raise AnswerComposerError("no approved information to answer from")
        # A payload whose memory and values are both empty has nothing to
        # answer from, whatever shape it arrived in.
        if not str(projection.get("memory") or "").strip() and not projection.get("values"):
            if set(projection) <= {"memory", "values"}:
                raise AnswerComposerError("no approved information to answer from")

        payload = await self._run(
            _prompt(question=question, projection=projection, period=period),
            user_id=user_id,
            consent_token=consent_token,
        )
        if not isinstance(payload, Mapping):
            raise AnswerComposerError("composer returned a non-object payload")

        answer = str(payload.get("answer") or "").strip()
        if not answer:
            # Reject-whole. An empty answer is a failure, not a short answer.
            raise AnswerComposerError("composer returned no answer")
        if len(answer) > MAX_ANSWER_CHARS:
            raise AnswerComposerError("composer answer exceeded its bound")

        def _strings(key: str) -> list[str]:
            value = payload.get(key)
            if not isinstance(value, list):
                return []
            return [str(item).strip() for item in value if str(item or "").strip()][:12]

        # The answer is returned as written. Nothing here rewrites it.
        return {"answer": answer, "covers": _strings("covers"), "gaps": _strings("gaps")}

    async def _run(self, prompt: str, *, user_id: str, consent_token: str) -> Any:
        try:
            if self._runner is not None:
                return await self._runner(prompt)
            from hushh_mcp.hushh_adk.manifest import ManifestLoader
            from hushh_mcp.hushh_adk.single_turn import build_single_turn_agent, run_single_turn

            manifest = ManifestLoader.load(
                str(Path(__file__).resolve().parents[1] / "agents" / "one" / "agent.yaml")
            )
            gene = next(child for child in manifest.subagents if child.id == GENE_ID)
            if gene.runtime.adk_mode != "single_turn" or gene.privacy.plaintext_telemetry:
                raise AnswerComposerError("composer gene has an invalid runtime boundary")
            agent = build_single_turn_agent(gene, output_schema=ANSWER_COMPOSE_SCHEMA)
            return await run_single_turn(
                agent,
                prompt_parts=prompt,
                user_id=user_id,
                consent_token=consent_token,
                timeout_seconds=GENE_TIMEOUT_SECONDS,
            )
        except AnswerComposerError:
            raise
        except Exception as error:  # noqa: BLE001 - model FAILURE -> recorded projection
            raise AnswerComposerError(str(type(error).__name__)) from error


__all__ = ["ANSWER_COMPOSE_SCHEMA", "GENE_ID", "AnswerComposer", "AnswerComposerError"]
