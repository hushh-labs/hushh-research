import json

from hushh_mcp.operons.location.capabilities import compile_location_capabilities, semantic_catalog
from hushh_mcp.services.action_gateway import list_action_gateway_actions


def test_semantic_catalog_omits_only_empty_inputs_without_mutating_authority():
    _, actions = compile_location_capabilities(list_action_gateway_actions())
    before = json.dumps(actions, sort_keys=True)
    projected = {item["action_id"]: item for item in semantic_catalog(actions)}
    with_inputs = without_inputs = 0
    for action_id, owner in actions.items():
        inputs = owner["goal"]["required_inputs"]
        if inputs:
            with_inputs += 1
            assert projected[action_id]["inputs"] == inputs
        else:
            without_inputs += 1
            assert "inputs" not in projected[action_id]
    assert with_inputs > 0 and without_inputs > 0
    assert json.dumps(actions, sort_keys=True) == before
