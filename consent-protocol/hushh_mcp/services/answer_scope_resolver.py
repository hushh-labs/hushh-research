"""The semantic stage that turns a question into candidate scopes.

Turning "how much did you spend on travel?" into a scope set is a semantic
judgement, so it belongs to a manifest-owned gene rather than to host code.
`consent-protocol/docs/reference/backend-semantic-boundary.md` forbids
replacing that judgement with keyword or regex classification, and nothing
here does any.

What this module owns is the boundary around the gene:

* it shows the gene only scope handles and labels, never a PKM value, so a
  resolution cannot leak what it is resolving over;
* it never widens the gene's answer -- a handle that was not offered is
  dropped here before `validate_resolved_scopes` sees it;
* a model FAILURE (timeout, malformed output, schema violation) raises, and
  the caller records `resolution_mode='skipped'` with a reason. That is the
  legitimate failure exception in the boundary doc; it is not a licence to
  guess a substitute.

Declaration required by the boundary doc's "new semantic surface" section:

  owning agent      one_answer_scope_resolver
  manifest path     hushh_mcp/agents/one/agent.yaml (subagents)
  output contract   ANSWER_SCOPE_SCHEMA -> {"scopes": [handle, ...]}
  validator rules   reject-whole on malformed output; per-handle membership in
                    the offered candidates; then the deterministic authority
                    guard in hushh_mcp/consent/answer_scope_resolution.py
                    (requestability, owner catalog, limit) which can only
                    remove
  live eval phase   required before PKM_ANSWER_PAYMENTS_ENABLED is turned on
                    in any environment; the lane ships disabled
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Mapping, Sequence

logger = logging.getLogger(__name__)

GENE_ID = "one_answer_scope_resolver"
GENE_TIMEOUT_SECONDS = 20.0

#: A question the owner must read should not arrive with a thousand candidates.
MAX_CANDIDATES = 120

ANSWER_SCOPE_SCHEMA: dict[str, Any] = {
    "type": "OBJECT",
    "properties": {
        "scopes": {
            "type": "ARRAY",
            "items": {"type": "STRING"},
        }
    },
    "required": ["scopes"],
}


class AnswerScopeResolverError(RuntimeError):
    """A model FAILURE. The caller records a skip; it never substitutes a guess."""


def _prompt(question: str, candidates: Sequence[Mapping[str, str]]) -> str:
    lines = [
        "Question from the requester:",
        str(question or "").strip(),
        "",
        "Candidate scopes (handle -- label):",
    ]
    for candidate in candidates:
        handle = str(candidate.get("handle") or "").strip()
        label = str(candidate.get("label") or "").strip()
        if not handle:
            continue
        lines.append(f"- {handle} -- {label}" if label else f"- {handle}")
    return "\n".join(lines)


class AnswerScopeResolver:
    """Runs the manifest-owned gene once, schema-constrained, with no tools."""

    def __init__(self, *, runner=None) -> None:
        # Injected in tests so the boundary can be exercised without a model.
        self._runner = runner

    async def propose_scopes(
        self,
        *,
        question: str,
        candidate_scopes: Sequence[str],
        candidate_labels: Mapping[str, str] | None = None,
        user_id: str = "",
        consent_token: str = "",
    ) -> list[str]:
        offered = [str(scope or "").strip() for scope in candidate_scopes if scope]
        offered = offered[:MAX_CANDIDATES]
        if not offered:
            return []

        labels = candidate_labels or {}
        candidates = [{"handle": handle, "label": labels.get(handle, "")} for handle in offered]

        payload = await self._run(
            _prompt(question, candidates), user_id=user_id, consent_token=consent_token
        )

        scopes = payload.get("scopes") if isinstance(payload, Mapping) else None
        if not isinstance(scopes, list):
            # Reject-whole: a malformed answer is a failure, not a partial result.
            raise AnswerScopeResolverError("resolver returned no scope list")

        offered_set = set(offered)
        accepted: list[str] = []
        for value in scopes:
            handle = str(value or "").strip()
            # The gene may only choose from what it was shown. A handle it
            # invented or "corrected" is dropped here, before the deterministic
            # guard, so the owner is never offered something nobody listed.
            if handle in offered_set and handle not in accepted:
                accepted.append(handle)
            elif handle:
                logger.info("answer_scope_resolver.dropped_unoffered_handle")
        return accepted

    async def _run(self, prompt: str, *, user_id: str, consent_token: str) -> Any:
        try:
            if self._runner is not None:
                # Injected runners get the same failure wrapping as the real
                # gene, so a test exercises the production failure path rather
                # than a shortcut around it.
                return await self._runner(prompt)
            from hushh_mcp.hushh_adk.manifest import ManifestLoader
            from hushh_mcp.hushh_adk.single_turn import build_single_turn_agent, run_single_turn

            manifest = ManifestLoader.load(
                str(Path(__file__).resolve().parents[1] / "agents" / "one" / "agent.yaml")
            )
            gene = next(child for child in manifest.subagents if child.id == GENE_ID)
            if gene.runtime.adk_mode != "single_turn" or gene.privacy.plaintext_telemetry:
                raise AnswerScopeResolverError("resolver gene has an invalid runtime boundary")
            agent = build_single_turn_agent(gene, output_schema=ANSWER_SCOPE_SCHEMA)
            return await run_single_turn(
                agent,
                prompt_parts=prompt,
                user_id=user_id,
                consent_token=consent_token,
                timeout_seconds=GENE_TIMEOUT_SECONDS,
            )
        except AnswerScopeResolverError:
            raise
        except Exception as error:  # noqa: BLE001 - model FAILURE -> recorded skip
            raise AnswerScopeResolverError(str(type(error).__name__)) from error


__all__ = [
    "ANSWER_SCOPE_SCHEMA",
    "GENE_ID",
    "AnswerScopeResolver",
    "AnswerScopeResolverError",
]
