"""Scripted memory agents for the synthetic context-transfer document.

A deterministic stand-in for the model, answering each memory agent's contract
the way the rewritten manifests ask (keep everything, attribute it, account for
every line). It drives the REAL ``PKMAgentLabService.generate_structure_preview``
so the server's own sanitizing and normalization decide what the device sees.

Two quirks real models show are reproduced on purpose: a quote with its Markdown
emphasis cleaned, and an em dash returned as a hyphen. Both must still map back
to the owner's exact text.

The recorded server answers live beside the document in
``hushh-webapp/__tests__/fixtures/pkm/context-transfer.recording.v1.json``.
``tests/services/test_context_transfer_is_kept.py`` proves every recorded answer
is what this code produces today; the web app's save-job test replays them
through the resumable save job. To re-record after a chunking change, run
``PKM_CONTEXT_TRANSFER_RECORD=1 npx vitest run __tests__/services/pkm-save-job.test.ts``
from ``hushh-webapp``. All content is synthetic.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURE_DIR = REPO_ROOT / "hushh-webapp" / "__tests__" / "fixtures" / "pkm"
DOCUMENT_PATH = FIXTURE_DIR / "context-transfer.v1.md"
RECORDING_PATH = FIXTURE_DIR / "context-transfer.recording.v1.json"
OWNER = "owner-synthetic"

_HEADING = re.compile(r"^\s*#{1,6}\s+(.+?)\s*$")
_SECTION_DOMAINS = {
    "Identity and preferences": "identity",
    "Role and compensation": "professional",
    "Immigration": "immigration",
    "Education": "education",
    "Housing": "housing",
    "Health and routines": "health",
    "Travel": "travel",
}
# A model names a domain after the subject; three of these are protocol names.
_PROTOCOL_SUBJECTS = (("Our agents", "agents"), ("The MCP server", "mcp"), ("The system", "system"))
_SENSITIVE_SECTIONS = {"Role and compensation", "Immigration", "Housing"}
_DISCLAIMER_SECTIONS = {"Information not known"}


def _segment_quote(line: str) -> str:
    """The quote a model tends to return: emphasis cleaned, dashes flattened."""
    quote = line
    if "**" in quote:
        quote = quote.replace("**", "")
    if "—" in quote:
        quote = quote.replace("—", "-")
    return quote


def _segmentation(message: str) -> dict[str, Any]:
    heading_line = ""
    section = ""
    seen: set[str] = set()
    segments: list[dict[str, Any]] = []
    not_memory: list[dict[str, str]] = []
    for line in message.split("\n"):
        if not line.strip():
            continue
        match = _HEADING.match(line)
        if match:
            heading_line, section = line, match.group(1)
            continue
        if section in _DISCLAIMER_SECTIONS or line.startswith("Context transfer for my private"):
            not_memory.append({"quote": line, "reason": "disclaimer"})
            continue
        if line in seen:
            not_memory.append({"quote": line, "reason": "duplicate"})
            continue
        seen.add(line)
        segments.append(
            {
                "source_text": _segment_quote(line),
                "context_quotes": [heading_line] if heading_line else [],
                "confidence": 0.93,
                "reason": f"Stated under {section or 'the opening'}.",
            }
        )
    return {
        "segments": segments[:8],
        "not_memory": not_memory,
        "has_more_candidates": len(segments) > 8,
        "source_agent": "memory_segmentation_agent",
        "contract_version": 1,
    }


def _request(prompt: str) -> dict[str, Any]:
    """The JSON request a memory-agent prompt ends with, after its worked examples."""
    return json.loads(prompt.rpartition("Request: ")[2])


def _section_of(prompt: str) -> str:
    quotes = _request(prompt).get("section_context") or []
    match = _HEADING.match(quotes[0]) if quotes else None
    return match.group(1) if match else ""


def _domain_for(section: str, message: str) -> str:
    for subject, slug in _PROTOCOL_SUBJECTS:
        if subject in message:
            return slug
    return _SECTION_DOMAINS.get(section, "professional")


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_") or "note"


def _intent(prompt: str) -> dict[str, Any]:
    message = _request(prompt)["message"]
    section = _section_of(prompt)
    if message.startswith("Optimize my portfolio"):
        return {
            "save_class": "ephemeral",
            "intent_class": "command",
            "mutation_intent": "no_op",
            "requires_confirmation": False,
            "confirmation_reason": "",
            "candidate_domain_choices": [{"domain_key": "financial", "recommended": True}],
            "confidence": 0.95,
            "source_agent": "memory_intent_agent",
            "contract_version": 1,
        }
    domain = _domain_for(section, message)
    recommended = "professional" if domain in {"agents", "mcp", "system"} else domain
    sensitive = section in _SENSITIVE_SECTIONS
    return {
        "save_class": "durable",
        "intent_class": "preference" if " prefer" in f" {message.lower()}" else "profile_fact",
        "mutation_intent": "create",
        # Sensitive facts ask for confirmation: the path that used to skip the
        # structure agent and clip the statement to 240 characters.
        "requires_confirmation": sensitive,
        "confirmation_reason": "Sensitive detail." if sensitive else "",
        "candidate_domain_choices": [
            {"domain_key": recommended, "recommended": True},
            {"domain_key": "professional", "recommended": False},
        ],
        "confidence": 0.92,
        "source_agent": "memory_intent_agent",
        "contract_version": 1,
    }


def _merge(prompt: str) -> dict[str, Any]:
    frame = _request(prompt)["intent_frame"]
    message = _request(prompt)["message"]
    choices = frame.get("candidate_domain_choices") or [{}]
    # The merge agent names the subject it sees ("agents"), as models do.
    subject = next((slug for phrase, slug in _PROTOCOL_SUBJECTS if phrase in message), None)
    return {
        "merge_mode": "create_entity",
        "target_domain": subject or str(choices[0].get("domain_key") or "professional"),
        "target_entity_id": "",
        "target_entity_path": "",
        "match_confidence": 0.9,
        "match_reason": "A new detail.",
        "source_agent": "memory_merge_agent",
        "contract_version": 1,
    }


def _structure(prompt: str) -> dict[str, Any]:
    message = _request(prompt)["message"]
    section = _section_of(prompt)
    domain = _domain_for(section, message)
    root = _slug(section) if section else "notes"
    entity = _slug(message)[:48]
    summary = message.lstrip("- ").strip()
    payload = {
        root: {
            "entities": {
                entity: {
                    "entity_id": entity,
                    "kind": "profile_fact",
                    "summary": summary,
                    "observations": [summary],
                    "status": "active",
                }
            }
        }
    }
    sensitive = section in _SENSITIVE_SECTIONS
    return {
        "candidate_payload": payload,
        "structure_decision": {
            "action": "create_domain",
            "target_domain": domain,
            "json_paths": [root, f"{root}.entities", f"{root}.entities.{entity}"],
            "top_level_scope_paths": [root],
            "externalizable_paths": [f"{root}.entities.{entity}.summary"],
            "summary_projection": {"top_level_scope": root},
            "sensitivity_labels": {root: "confidential"} if sensitive else {},
            "confidence": 0.9,
            "source_agent": "pkm_structure_agent",
            "contract_version": 1,
        },
        "write_mode": "confirm_first",
        "primary_json_path": root,
        "target_entity_scope": root,
        "validation_hints": [],
    }


async def scripted_contract(**kwargs: Any) -> dict[str, Any] | None:
    agent = kwargs["manifest"].id
    prompt = kwargs["prompt"]
    if agent == "agent_memory_segmentation":
        return _segmentation(_request(prompt)["message"])
    if agent == "agent_memory_intent":
        return _intent(prompt)
    if agent == "agent_memory_merge":
        return _merge(prompt)
    if agent == "agent_pkm_structure":
        return _structure(prompt)
    raise AssertionError(f"unexpected agent {agent}")


_CARD_FIELDS = (
    "card_id",
    "source_text",
    "context_quotes",
    "save_class",
    "intent_class",
    "mutation_intent",
    "merge_mode",
    "target_domain",
    "primary_json_path",
    "target_entity_scope",
    "write_mode",
    "requires_confirmation",
    "validation_hints",
    "candidate_payload",
    "reserved_offer",
)


def project(response: dict[str, Any]) -> dict[str, Any]:
    """The part of a /memory/proposals answer the device reads."""
    summary = response.get("preview_summary") or {}
    return {
        "used_fallback": bool(response.get("used_fallback")),
        "error": response.get("error"),
        "structure_skipped": bool(response.get("structure_skipped")),
        "preview_summary": {
            key: summary.get(key)
            for key in (
                "card_count",
                "total_segments_detected",
                "split_recommended",
                "not_memory",
                "unmatched_quote_count",
            )
        },
        "preview_cards": [
            {
                **{field: card.get(field) for field in _CARD_FIELDS},
                "merge_decision": {
                    key: (card.get("merge_decision") or {}).get(key)
                    for key in ("merge_mode", "target_entity_path", "target_entity_id")
                },
                "structure_decision": {
                    key: (card.get("structure_decision") or {}).get(key)
                    for key in ("action", "target_domain", "sensitivity_labels")
                },
            }
            for card in response.get("preview_cards") or []
        ],
    }


def step_key(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


async def prepare(text: str) -> dict[str, Any]:
    """One section through the real preview pipeline with the scripted agents."""
    from hushh_mcp.services import pkm_agent_lab_service as module

    service = module.PKMAgentLabService()
    service._run_agent_contract = scripted_contract  # type: ignore[method-assign]
    service._load_domain_registry_choices = _registry  # type: ignore[method-assign]
    module._PREVIEW_CACHE.clear()
    module._PREVIEW_INFLIGHT.clear()
    response = await service.generate_structure_preview(
        user_id=OWNER, message=text, current_domains=[], capture_execution_trace=True
    )
    return project(response)


async def _registry(**_kwargs: Any) -> list[dict[str, Any]]:
    return [
        {"domain_key": key, "display_name": key.title(), "description": key, "recommended": False}
        for key in ("professional", "identity", "health", "travel", "financial", "social")
    ]


if __name__ == "__main__":  # pragma: no cover - the recorder's entry point
    import sys

    print(json.dumps(asyncio.run(prepare(sys.stdin.read()))))
