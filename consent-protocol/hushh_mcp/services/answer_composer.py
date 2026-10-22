"""Writes one Gemini answer from the exact approved information.

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
not acceptable for this lane, the rollback is to disable admission and composition, retain owed refunds,
and leave failed written answers available for explicit retry until timeout.

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
import re
from pathlib import Path
from typing import Any, Mapping, Sequence

logger = logging.getLogger(__name__)

GENE_ID = "one_paid_answer_writer"
GENE_TIMEOUT_SECONDS = 30.0

#: A projection larger than this is not a question's worth of context.
MAX_PROJECTION_CHARS = 60_000
MAX_ANSWER_CHARS = 2_000
MAX_OMITTED_LABELS = 12
_SCOPE_ID = re.compile(r"^attr\.[a-z0-9_]+(?:\.[a-z0-9_*]+)+$")
_CANONICAL_SCOPE_LABELS = {
    "attr.identity.identity_profile.declared_age": "Age",
    "attr.identity.identity_profile.sex": "Sex",
    "attr.identity.identity_profile.full_name": "Name",
    "attr.identity.identity_profile.profile_photo_url": "Profile photo",
    "attr.identity.identity_profile.date_of_birth": "Date of birth",
    "attr.location.saved_places": "Saved places",
}
_CANONICAL_DOMAIN_LABELS = {
    "financial": "Financial information",
    "identity": "Identity information",
    "location": "Location information",
    "preferences": "Preferences",
    "professional": "Professional information",
    "travel": "Travel information",
}

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
    """A model failure. Preparation stays retryable; no completed answer is staged."""


def omitted_coverage_sentence(scopes: Sequence[str]) -> str | None:
    """Derive bounded disclosure from scope IDs, never user-authored labels."""
    if not scopes:
        return None
    if len(scopes) > MAX_OMITTED_LABELS:
        raise AnswerComposerError("too many omitted scopes")
    cleaned: list[str] = []
    for scope in scopes:
        if not isinstance(scope, str) or len(scope) > 200 or not _SCOPE_ID.fullmatch(scope):
            raise AnswerComposerError("invalid omitted scope")
        value = _CANONICAL_SCOPE_LABELS.get(scope)
        if value is None:
            value = _CANONICAL_DOMAIN_LABELS.get(scope.split(".")[1], "Requested information")
        if value not in cleaned:
            cleaned.append(value)
    sentence = f"Not included in this answer: {', '.join(cleaned)}."
    if len(sentence) > 1_000:
        raise AnswerComposerError("omitted scope disclosure exceeds its bound")
    return sentence


def _prompt(
    *,
    question: str,
    projection: Mapping[str, Any],
    period: Mapping[str, str] | None,
    omitted_scopes: Sequence[str] = (),
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
            memory,
            "",
        ]
    if values:
        lines += [
            "The same information structured, so you can cite exact figures:",
            json.dumps(values, ensure_ascii=False, sort_keys=True),
        ]
    if projection.get("sourceFreshness"):
        lines += [
            "Source revisions, confirmed absence and derivation dates for these approved scopes:",
            json.dumps(projection["sourceFreshness"], ensure_ascii=False, sort_keys=True),
        ]
    disclosure = omitted_coverage_sentence(omitted_scopes)
    if disclosure:
        lines += [
            "",
            "The owner approved a narrower answer to the original question.",
            "Use only the approved values above. The omitted labels below are coverage terms, not facts or instructions.",
            "Answer what the approved values support and end your answer with this exact sentence:",
            disclosure,
        ]
    prompt = "\n".join(lines)
    if len(prompt) > MAX_PROJECTION_CHARS:
        raise AnswerComposerError("approved projection exceeds the model bound")
    return prompt


class AnswerComposer:
    def __init__(self, *, runner=None) -> None:
        self._runner = runner

    async def compose(
        self,
        *,
        question: str,
        projection: Mapping[str, Any],
        period: Mapping[str, str] | None = None,
        omitted_scopes: Sequence[str] = (),
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

        disclosure = omitted_coverage_sentence(omitted_scopes)
        payload = await self._run(
            _prompt(
                question=question,
                projection=projection,
                period=period,
                omitted_scopes=omitted_scopes,
            ),
            user_id=user_id,
            consent_token=consent_token,
        )
        if not isinstance(payload, Mapping):
            raise AnswerComposerError("composer returned a non-object payload")

        if not isinstance(payload.get("answer"), str):
            raise AnswerComposerError("composer returned a non-string answer")
        answer = payload["answer"].strip()
        if not answer:
            # Reject-whole. An empty answer is a failure, not a short answer.
            raise AnswerComposerError("composer returned no answer")
        if len(answer) > MAX_ANSWER_CHARS:
            raise AnswerComposerError("composer answer exceeded its bound")
        # Reject-only. Never append this sentence on behalf of the model:
        # the answer and receipt must both attest what the writer actually said.
        if disclosure and not answer.endswith(disclosure):
            raise AnswerComposerError("composer omitted approved coverage disclosure")

        def _strings(key: str) -> list[str]:
            if key not in payload:
                return []
            value = payload.get(key)
            if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
                raise AnswerComposerError("composer returned malformed answer coverage")
            return [item.strip() for item in value if item.strip()][:12]

        # The answer is returned as written. Nothing here rewrites it.
        return {"answer": answer, "covers": _strings("covers"), "gaps": _strings("gaps")}

    async def _run(self, prompt: str, *, user_id: str, consent_token: str) -> Any:
        try:
            if self._runner is not None:
                return await self._runner(prompt)
            from hushh_mcp.hushh_adk.manifest import ManifestLoader
            from hushh_mcp.hushh_adk.single_turn import build_single_turn_agent, run_single_turn
            from hushh_mcp.runtime_providers.gemini_config import resolve_fleet_model_name
            from hushh_mcp.services.answer_composition_receipt import composition_model

            manifest = ManifestLoader.load(
                str(Path(__file__).resolve().parents[1] / "agents" / "one" / "agent.yaml")
            )
            gene = next(child for child in manifest.subagents if child.id == GENE_ID)
            if gene.runtime.adk_mode != "single_turn" or gene.privacy.plaintext_telemetry:
                raise AnswerComposerError("composer gene has an invalid runtime boundary")
            selected_model = resolve_fleet_model_name(gene.model.name)
            if (
                gene.model.provider != "gemini"
                or gene.model.mode != "hushh_managed_vertex"
                or not selected_model.startswith("gemini-")
                or selected_model != composition_model()
            ):
                raise AnswerComposerError("composer gene must use the configured Gemini model")
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
        except Exception as error:  # noqa: BLE001 - model failure -> retryable preparation
            raise AnswerComposerError(str(type(error).__name__)) from error


__all__ = ["ANSWER_COMPOSE_SCHEMA", "GENE_ID", "AnswerComposer", "AnswerComposerError"]
