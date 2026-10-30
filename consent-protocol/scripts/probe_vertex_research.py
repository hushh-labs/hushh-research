"""Synthetic native research completion and attribution; never owner research."""

import json

from google.genai import types


async def _probe_native_research() -> None:
    """Qualify native research task completion and the shared attribution corpus.

    Search budget is already exhausted for this fictional invocation. Only its
    final native task/schema call is admitted; no owner store or search runs.
    """
    from hushh_mcp.one_adk import world_model
    from scripts.verify_azure_pwm_runtime import _production_contract_examples

    examples, _ = _production_contract_examples()
    charged = []

    async def current():
        return None

    async def charge(slots):
        charged.extend(slots)

    slots = world_model.MAX_SEARCHES + world_model.MAX_MODEL_CALLS
    result = await world_model.run_world_model(
        identity={
            "full_name": "Synthetic Example",
            "email": "synthetic@example.test",
            "phone_number": None,
        },
        user_id="synthetic-research-reader",
        consent_token="",
        require_access=current,
        attempts_used=range(1, slots),
        on_attempts_start=charge,
        work={"assessment": examples["assessment"], "sources": {}, "attempts": {}},
        owner_research_context={
            "confirmed": ["I authored the fictional LumenForge Transit Atlas."],
            "permitted_public_research": True,
        },
    )
    if (
        result.get("status") != "offered"
        or result.get("pkm_written") is not False
        or result.get("report", {}).get("sections")
        or result.get("grounded_answers")
        or result.get("research", {}).get("provider") != "vertex_google_search"
        or charged != [slots]
    ):
        raise ValueError("Vertex native research completion contract failed")


async def _probe_attribution(client) -> dict:
    from hushh_mcp.one_adk import world_model
    from hushh_mcp.runtime_providers.gemini_config import resolve_fleet_model_name
    from scripts.verify_azure_pwm_runtime import _ATTRIBUTION_CASES

    response = await client.aio.models.generate_content(
        model=resolve_fleet_model_name(world_model.manifest().model.name),
        contents=json.dumps(
            {
                "cases": [
                    {"case_id": key, "excerpt": excerpt, "statement": statement}
                    for key, excerpt, statement, _ in _ATTRIBUTION_CASES
                ]
            }
        ),
        config=types.GenerateContentConfig(
            system_instruction=(
                "Evaluate each fictional statement against only its own excerpt. "
                "A source or account's claim does not establish linkage to the owner. "
                "Reject unsupported identity, ownership and completion claims; accept "
                "accurately attributed self-reports and explicit metadata. Return each case once."
            ),
            response_mime_type="application/json",
            response_json_schema={
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {"case_id": {"type": "string"}, "supported": {"type": "boolean"}},
                    "required": ["case_id", "supported"],
                    "additionalProperties": False,
                },
            },
            max_output_tokens=2048,
            thinking_config=types.ThinkingConfig(thinking_level=types.ThinkingLevel.LOW),
        ),
    )
    if not response.candidates or response.candidates[0].finish_reason != types.FinishReason.STOP:
        raise ValueError("Vertex research attribution response did not complete")
    rows = json.loads(response.text or "null")
    expected = {key: supported for key, _, _, supported in _ATTRIBUTION_CASES}
    if (
        not isinstance(rows, list)
        or len(rows) != len(expected)
        or any(
            not isinstance(row, dict)
            or set(row) != {"case_id", "supported"}
            or type(row["supported"]) is not bool
            or row["case_id"] not in expected
            for row in rows
        )
        or {row["case_id"]: row["supported"] for row in rows} != expected
    ):
        raise ValueError("Vertex research attribution contract failed")
    return {"research_contracts": 1, "attribution_cases": len(expected)}


async def probe_vertex_research(client) -> dict:
    await _probe_native_research()
    return await _probe_attribution(client)
