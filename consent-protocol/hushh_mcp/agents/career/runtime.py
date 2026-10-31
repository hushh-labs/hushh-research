"""Manifest-owned resume extraction for the Career Agent.

The upload route parses the file deterministically (drive_document_parser, in a
resource-limited subprocess) and hands only the bounded text to this gene. The
model never sees the original bytes and nothing is persisted: the structured
resume goes back to the owner's device, which reviews and encrypts it into PKM.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from google.genai import types

from hushh_mcp.hushh_adk.manifest import ManifestLoader
from hushh_mcp.hushh_adk.single_turn import build_single_turn_agent, run_single_turn
from hushh_mcp.runtime_providers import build_managed_regional_gemini_adk_model
from hushh_mcp.runtime_providers.gemini_config import resolve_fleet_model_name

_MANIFEST_PATH = Path(__file__).with_name("agent.yaml")
RESUME_GENE = "agent_career_resume_extract"
MAX_RESUME_CHARS = 60_000

_TEXT: dict[str, Any] = {"type": "STRING", "nullable": True}
_STRINGS: dict[str, Any] = {"type": "ARRAY", "items": {"type": "STRING"}}

# Structured output only returns declared keys, so every field is declared.
RESUME_SCHEMA: dict[str, Any] = {
    "type": "OBJECT",
    "properties": {
        "name": _TEXT,
        "headline": _TEXT,
        "location": _TEXT,
        "summary": _TEXT,
        "experience": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "title": _TEXT,
                    "organization": _TEXT,
                    "location": _TEXT,
                    "start": _TEXT,
                    "end": _TEXT,
                    "highlights": _STRINGS,
                },
            },
        },
        "education": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "institution": _TEXT,
                    "degree": _TEXT,
                    "field": _TEXT,
                    "start": _TEXT,
                    "end": _TEXT,
                },
            },
        },
        "skills": _STRINGS,
        "links": {
            "type": "ARRAY",
            "items": {"type": "OBJECT", "properties": {"label": _TEXT, "url": _TEXT}},
        },
    },
    "required": ["experience", "education", "skills", "links"],
}


@lru_cache(maxsize=2)
def load_career_gene(gene_id: str = RESUME_GENE) -> Any:
    manifest = ManifestLoader.load(str(_MANIFEST_PATH))
    gene = next((child for child in manifest.subagents if child.id == gene_id), None)
    if gene is None:
        raise RuntimeError(f"Career gene is missing: {gene_id}")
    if gene.runtime.adk_mode != "single_turn" or gene.runtime.transport != ["in_process"]:
        raise RuntimeError(f"Career gene has an invalid runtime boundary: {gene_id}")
    if gene.privacy.plaintext_telemetry:
        raise RuntimeError(f"Career gene permits plaintext telemetry: {gene_id}")
    return gene


async def extract_resume(*, text: str, user_id: str, consent_token: str) -> dict[str, Any]:
    """Run the resume extractor on bounded text. Returns the structured resume."""
    if not text.strip():
        raise ValueError("resume text is empty")
    gene = load_career_gene()
    agent = build_single_turn_agent(
        gene,
        output_schema=RESUME_SCHEMA,
        model=build_managed_regional_gemini_adk_model(
            resolve_fleet_model_name(str(gene.model.name))
        ),
    )
    prompt = (
        "Extract this resume into the JSON contract.\n\n<resume>\n"
        + text[:MAX_RESUME_CHARS]
        + "\n</resume>"
    )
    result = await run_single_turn(
        agent,
        prompt_parts=prompt,
        message_content=types.Content(role="user", parts=[types.Part.from_text(text=prompt)]),
        user_id=str(user_id),
        consent_token=str(consent_token),
        timeout_seconds=max(30.0, gene.performance.latency_p95_ms / 1000),
    )
    payload = result.model_dump(mode="json") if hasattr(result, "model_dump") else result
    if not isinstance(payload, dict):
        raise ValueError("Resume extractor returned a non-object payload")
    return json.loads(json.dumps(payload))
