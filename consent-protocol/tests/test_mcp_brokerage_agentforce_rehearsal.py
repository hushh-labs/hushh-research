from __future__ import annotations

import json

import jsonschema

from hushh_mcp.consent.connector_projection import FINANCIAL_STATEMENT_BUNDLE_SCHEMA
from scripts.rehearse_mcp_brokerage_compatibility import (
    run_rehearsal,
)


def test_multi_statement_brokerage_round_trip_and_static_mcp_projection() -> None:
    result = run_rehearsal()
    decrypted = result["connector_decrypted_source"]
    mcp_result = result["proposed_agentforce_action_mcp_result"]
    bundle = mcp_result["structuredContent"]

    source_statements = decrypted["financial"]["documents"]["statements"]
    assert len(source_statements) == 2
    assert all(len(statement["holdings"]) == 20 for statement in source_statements)

    jsonschema.validate(bundle, FINANCIAL_STATEMENT_BUNDLE_SCHEMA)
    assert bundle["statement_count"] == 2
    assert bundle["holding_count"] == 40
    assert {statement["statement_ref"] for statement in bundle["statements"]} == {
        "stmt_demo_2026_05",
        "stmt_demo_2026_06",
    }
    assert {holding["statement_ref"] for holding in bundle["holdings"]} == {
        "stmt_demo_2026_05",
        "stmt_demo_2026_06",
    }

    text_payload = json.loads(mcp_result["content"][0]["text"])
    assert text_payload == bundle
    assert result["current_hosted_hussh_result"]["delivery"] == "encrypted_inline"
    assert "encryptedData" not in json.dumps(result)


def test_agentforce_projection_has_no_nested_values_inside_array_records() -> None:
    bundle = run_rehearsal()["proposed_agentforce_action_mcp_result"]["structuredContent"]
    for collection in (bundle["statements"], bundle["holdings"]):
        for record in collection:
            assert all(not isinstance(value, (dict, list)) for value in record.values())
