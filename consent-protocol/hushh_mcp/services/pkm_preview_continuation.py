"""Validated, request-local preparation prefix; persistence belongs to the preview LRU."""

from __future__ import annotations

import hashlib
import json
import time
from copy import deepcopy
from typing import Any

from hushh_mcp.hushh_adk.single_turn import _decode

PREFIX_AGENTS = frozenset(
    {
        "agent_memory_segmentation",
        "agent_financial_guard",
        "agent_memory_intent",
        "agent_memory_merge",
    }
)


def contract_fingerprint(manifest: Any, model: str, schema: dict, prompt: str = "") -> str:
    config = getattr(manifest, "model", None)
    material = {
        "agent": getattr(manifest, "id", ""),
        "instruction": getattr(manifest, "system_instruction", ""),
        "model": model,
        "configuration": config.model_dump(mode="json")
        if hasattr(config, "model_dump")
        else str(config),
        "schema": schema,
        "prompt": prompt,
    }
    return hashlib.sha256(
        json.dumps(material, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


class PreviewContinuation:
    """Reuse only exact validated responses; normalization and authority always rerun."""

    def __init__(self, *, run, resolve_model, records: dict | None = None):
        self._run = run
        self._resolve_model = resolve_model
        self.records = deepcopy(records or {})

    async def run(self, **kwargs):
        manifest = kwargs["manifest"]
        agent = getattr(manifest, "id", "")
        fingerprint = contract_fingerprint(
            manifest,
            self._resolve_model(manifest, kwargs.get("model_override")),
            kwargs["response_schema"],
            kwargs["prompt"],
        )
        previous = self.records.get(agent) if agent in PREFIX_AGENTS else None
        if previous and previous.get("fingerprint") == fingerprint:
            try:
                value = _decode(json.dumps(previous["value"]), kwargs["response_schema"])
            except (ValueError, TypeError, KeyError):
                self.records.pop(agent, None)
            else:
                trace = kwargs.get("execution_trace")
                if trace is not None:
                    trace.append(
                        {
                            "agent_id": agent,
                            "status": "reused",
                            "attempts": 0,
                            "latency_ms": 0.0,
                            "original_latency_ms": previous["latency_ms"],
                            "error_type": "",
                        }
                    )
                return deepcopy(value)
        started = time.perf_counter()
        result = await self._run(**kwargs)
        self.records.pop(agent, None)
        if agent in PREFIX_AGENTS and isinstance(result, dict):
            try:
                _decode(json.dumps(result), kwargs["response_schema"])
            except (ValueError, TypeError):
                pass
            else:
                self.records[agent] = {
                    "fingerprint": fingerprint,
                    "value": deepcopy(result),
                    "latency_ms": round((time.perf_counter() - started) * 1000, 2),
                }
        return result

    def checkpoint(
        self, *, message: str, response: dict, trace: list[dict], segment_source: str | None = None
    ) -> dict | None:
        recorded = set(self.records)
        guard_pending = recorded == {"agent_memory_segmentation"}
        intent_pending = recorded == {
            "agent_memory_segmentation",
            "agent_financial_guard",
        }
        merge_pending = recorded == PREFIX_AGENTS - {"agent_memory_merge"}
        if (
            not guard_pending
            and not intent_pending
            and not merge_pending
            and recorded != PREFIX_AGENTS
        ):
            return None
        segmentation = self.records["agent_memory_segmentation"]["value"]
        segments = segmentation.get("segments")
        if (
            not isinstance(segments, list)
            or not segments
            or any(
                not isinstance(segment, dict)
                or not isinstance(segment.get("source_text"), str)
                or not segment["source_text"]
                or segment["source_text"] not in message
                for segment in segments
            )
            or segmentation.get("has_more_candidates") is not False
        ):
            return None
        sources = [segment["source_text"] for segment in segments]
        if segment_source is None:
            if sources != [message]:
                return None
        elif sources.count(segment_source) != 1 or len(response.get("preview_cards") or []) != 1:
            # Only the exact, unique model-authored span owns this prefix.
            # The caller supplies a separate record set and trace per span.
            return None
        if guard_pending:
            # A failed guard has no routing authority to preserve. Retain only
            # the exact model-authored source span; guard and all later stages
            # must run again against the unchanged owner/request context.
            errors = str(response.get("error") or "").split("; ")
            if (
                response.get("used_fallback") is not True
                or "financial_guard_agent_fallback" not in errors
                or "memory_segmentation_agent_fallback" in errors
                or len(response.get("preview_cards") or []) != 1
                or not any(
                    row.get("agent_id") == "agent_financial_guard"
                    and row.get("status") in {"timeout", "budget_exhausted"}
                    for row in trace
                )
            ):
                return None
            return deepcopy(self.records)
        guard = self.records["agent_financial_guard"]["value"]
        if not guard.get("routing_decision") or guard["routing_decision"] != response.get(
            "routing_decision"
        ):
            return None
        if intent_pending:
            # A timed-out intent has no validated meaning to retain. Reuse only
            # the exact segmentation and guard; ask intent and every later
            # agent again with a fresh preview budget on the next bound retry.
            errors = str(response.get("error") or "").split("; ")
            if (
                response.get("used_fallback") is not True
                or response.get("intent_used_fallback") is not True
                or "memory_intent_agent_fallback" not in errors
                or any(
                    error in errors
                    for error in (
                        "memory_segmentation_agent_fallback",
                        "financial_guard_agent_fallback",
                    )
                )
                or len(response.get("preview_cards") or []) != 1
                or not any(
                    row.get("agent_id") == "agent_memory_intent"
                    and row.get("status") in {"timeout", "budget_exhausted"}
                    for row in trace
                )
            ):
                return None
            return deepcopy(self.records)
        # Schema-valid empty fields can still inherit fallback meaning during
        # normalization. Do not retain those as successful model decisions.
        intent = self.records["agent_memory_intent"]["value"]
        choices = intent.get("candidate_domain_choices") or []
        if not choices or any(not choice.get("domain_key", "").strip() for choice in choices):
            return None
        normalized_choices = response.get("intent_frame", {}).get("candidate_domain_choices") or []
        if [(choice.get("domain_key"), choice.get("recommended")) for choice in choices] != [
            (choice.get("domain_key"), choice.get("recommended")) for choice in normalized_choices
        ]:
            return None
        for field in ("save_class", "intent_class", "mutation_intent"):
            if intent.get(field) != response.get("intent_frame", {}).get(field):
                return None
        if merge_pending:
            # Only a timed-out merge may retain the three validated earlier
            # decisions. The fallback merge and any structure built from it are
            # discarded; both agents must run on the next exact-bound attempt.
            if (
                response.get("merge_used_fallback") is not True
                or response.get("error")
                != "memory_merge_agent_fallback; pkm_structure_agent_fallback"
                or not any(
                    row.get("agent_id") == "agent_memory_merge"
                    and row.get("status") in {"timeout", "budget_exhausted"}
                    for row in trace
                )
                or not any(
                    row.get("agent_id") == "agent_pkm_structure"
                    and row.get("status") == "budget_exhausted"
                    for row in trace
                )
            ):
                return None
            return deepcopy(self.records)
        merge = self.records["agent_memory_merge"]["value"]
        for field in (
            "merge_mode",
            "target_domain",
            "target_entity_id",
            "target_entity_path",
            "match_reason",
        ):
            if not merge.get(field) or merge[field] != response.get("merge_decision", {}).get(
                field
            ):
                return None
        # Only the observed final-stage timeout qualifies. Invalid semantics,
        # multi-card work and fallback-derived prefixes are never resumable.
        if (
            response.get("error") != "pkm_structure_agent_fallback"
            or response.get("intent_used_fallback")
            or response.get("merge_used_fallback")
            or len(response.get("preview_cards") or []) != 1
            or not any(
                row.get("agent_id") == "agent_pkm_structure"
                and row.get("status") in {"timeout", "budget_exhausted"}
                for row in trace
            )
        ):
            return None
        return deepcopy(self.records)
