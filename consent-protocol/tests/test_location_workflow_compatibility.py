"""Additive app observations cannot loosen an existing workflow authority."""

from copy import deepcopy

import pytest

from scripts.generate_capability_graph import (
    _merge_workflow_predecessor,
    _workflow_change_is_additive,
    _workflow_revision_compatibility,
)


def graphs():
    workflow = {
        "capability_id": "workflow.setup.location",
        "version": 2,
        "execution": {"binding_ref": "existing"},
        "settlement_proof": "server_receipts",
        "interaction_surfaces": [
            {
                "surface_id": "place",
                "allowed_results": [{"result": "pause", "presentation": "button"}],
                "result_schema": {"oneOf": [{"properties": {"result": {"const": "pause"}}}]},
            }
        ],
        "steps": [
            {
                "step_id": "place",
                "transitions": [{"when": "pause", "next": "$paused"}],
                "verifier": {"outcomes": ["pause"]},
            }
        ],
    }
    before = {"workflows": [workflow], "actions": [{"capability_id": "location.resume_updates"}]}
    after = deepcopy(before)
    surface = after["workflows"][0]["interaction_surfaces"][0]
    surface["allowed_results"].append({"result": "draft_prepared", "presentation": "app_result"})
    surface["result_schema"]["oneOf"].append(
        {"properties": {"result": {"const": "draft_prepared"}, "draft": {"type": "object"}}}
    )
    after["workflows"][0]["steps"][0]["transitions"].append(
        {"when": "draft_prepared", "next": "complete"}
    )
    after["workflows"][0]["steps"][0]["verifier"]["outcomes"].append("draft_prepared")
    return before, after


def test_added_app_result_preserves_old_clients_and_authored_tail():
    before, after = graphs()
    assert _workflow_change_is_additive(before, after, "workflows:workflow.setup.location")
    after["workflows"][0]["command_completion_action_ids"] = ["location.resume_updates"]
    assert _workflow_change_is_additive(before, after, "workflows:workflow.setup.location")
    assert not _workflow_change_is_additive(before, before, "workflows:workflow.setup.location")


def test_merged_workflow_history_preserves_both_compatible_branches():
    before, after = graphs()
    before["revision"] = "shipped"
    after["revision"] = "candidate"
    before["workflow_revision_compatibility"] = _workflow_revision_compatibility(None, before, {})
    prior = before["workflow_revision_compatibility"]["workflows"][0]
    prior["compatible_graph_revisions"] = ["older_shipped"]
    after["workflow_revision_compatibility"] = _workflow_revision_compatibility(None, after, {})
    after["workflow_revision_compatibility"]["workflows"][0]["compatible_graph_revisions"] = [
        "repair_branch"
    ]
    _merge_workflow_predecessor(after, before)
    _merge_workflow_predecessor(after, before)
    assert after["workflow_revision_compatibility"]["workflows"][0][
        "compatible_graph_revisions"
    ] == ["older_shipped", "repair_branch", "shipped"]


@pytest.mark.parametrize(
    "conflict", ["authority", "rejected", "migration_required", "cross_policy", "current_revision"]
)
def test_merged_workflow_history_cannot_override_authority_or_revision_policy(conflict):
    before, after = graphs()
    before["revision"] = "shipped"
    after["revision"] = "candidate"
    after["workflow_revision_compatibility"] = _workflow_revision_compatibility(None, after, {})
    if conflict == "authority":
        after["workflows"][0]["settlement_proof"] = "client_says_success"
    elif conflict in {"rejected", "migration_required"}:
        after["workflow_revision_compatibility"]["workflows"][0][f"{conflict}_graph_revisions"] = [
            "shipped"
        ]
    else:
        before["workflow_revision_compatibility"] = _workflow_revision_compatibility(
            None, before, {}
        )
        before["workflow_revision_compatibility"]["workflows"][0]["rejected_graph_revisions"] = [
            "older" if conflict == "cross_policy" else "candidate"
        ]
        after["workflow_revision_compatibility"]["workflows"][0][
            "migration_required_graph_revisions"
        ] = ["older"]
    original = deepcopy(after)
    with pytest.raises(RuntimeError):
        _merge_workflow_predecessor(after, before)
    assert after == original


@pytest.mark.parametrize(
    "change",
    ["binding", "proof", "button", "prior_result", "prior_transition", "version", "unknown_tail"],
)
def test_other_semantic_changes_are_not_silently_compatible(change):
    before, after = graphs()
    workflow = after["workflows"][0]
    if change == "binding":
        workflow["execution"]["binding_ref"] = "different"
    if change == "proof":
        workflow["settlement_proof"] = "client_says_success"
    if change == "button":
        workflow["interaction_surfaces"][0]["allowed_results"][-1]["presentation"] = "button"
    if change == "prior_result":
        workflow["interaction_surfaces"][0]["allowed_results"][0]["presentation"] = "app_result"
    if change == "prior_transition":
        workflow["steps"][0]["transitions"][0]["next"] = "complete"
    if change == "version":
        workflow["version"] = 3
    if change == "unknown_tail":
        workflow["command_completion_action_ids"] = ["invented.action"]
    assert not _workflow_change_is_additive(before, after, "workflows:workflow.setup.location")


def test_service_catalog_additions_do_not_invalidate_unchanged_workflow():
    before, after = graphs()
    before["workflows"][0]["knowledge_package"] = {
        "catalog_capability_ids": ["location.resume_updates"]
    }
    after["workflows"][0]["knowledge_package"] = {
        "catalog_capability_ids": ["location.resume_updates", "location.set_ghost_mode"]
    }
    after["actions"].append({"capability_id": "location.set_ghost_mode"})
    assert _workflow_change_is_additive(before, after, "workflows:workflow.setup.location")
    after["workflows"][0]["knowledge_package"]["catalog_capability_ids"] = [
        "location.set_ghost_mode"
    ]
    assert not _workflow_change_is_additive(before, after, "workflows:workflow.setup.location")


@pytest.mark.parametrize(
    "change", [None, "method", "authorization", "binding", "old_endpoint", "count"]
)
def test_discovered_endpoint_addition_cannot_change_execution_or_authority(change):
    before, after = graphs()
    endpoint = {
        "capability_id": "location.api.state",
        "method": "GET",
        "authorization": "vault_owner",
        "binding_status": "discovered_unbound",
    }
    before["workflows"][0]["api_endpoints"] = [endpoint]
    before["workflows"][0]["plan"] = {
        "executor_hierarchy": [
            {"kind": "backend_api", "status": "adapter_required", "discovered_endpoint_count": 1}
        ]
    }
    workflow = after["workflows"][0]
    workflow["api_endpoints"] = [
        deepcopy(endpoint),
        {**endpoint, "capability_id": "location.api.sms_contacts"},
    ]
    workflow["plan"] = {
        "executor_hierarchy": [
            {"kind": "backend_api", "status": "adapter_required", "discovered_endpoint_count": 2}
        ]
    }
    if change == "method":
        workflow["api_endpoints"][1]["method"] = "POST"
    if change == "authorization":
        workflow["api_endpoints"][1]["authorization"] = "public"
    if change == "binding":
        workflow["api_endpoints"][1]["binding_status"] = "executable"
    if change == "old_endpoint":
        workflow["api_endpoints"][0]["path"] = "/different"
    if change == "count":
        workflow["plan"]["executor_hierarchy"][0]["discovered_endpoint_count"] = 20
    assert _workflow_change_is_additive(before, after, "workflows:workflow.setup.location") is (
        change is None
    )


def test_connect_discovery_accepts_only_its_existing_authenticated_read_boundary():
    before, after = graphs()
    after = deepcopy(before)
    for graph in (before, after):
        graph["workflows"][0]["steps"] = [{"step_id": "prepare"}]
        graph["workflows"][0]["interaction_surfaces"] = [
            {"surface_id": "connect", "result_schema": {"type": "object"}}
        ]
        graph["workflows"][0]["capability_id"] = "workflow.setup.connections"
        graph["workflows"][0]["api_endpoints"] = [
            {
                "capability_id": "connect.api.directory",
                "method": "GET",
                "authorization": "firebase_auth",
                "binding_status": "discovered_unbound",
            }
        ]
        graph["workflows"][0]["plan"] = {
            "executor_hierarchy": [
                {
                    "kind": "backend_api",
                    "status": "adapter_required",
                    "discovered_endpoint_count": 1,
                }
            ]
        }
    after["workflows"][0]["api_endpoints"].append(
        {
            "capability_id": "connect.api.context",
            "method": "GET",
            "authorization": "firebase_auth",
            "binding_status": "discovered_unbound",
        }
    )
    after["workflows"][0]["plan"]["executor_hierarchy"][0]["discovered_endpoint_count"] = 2
    assert _workflow_change_is_additive(before, after, "workflows:workflow.setup.connections")
    before["workflows"][0]["api_endpoints"][0]["authorization"] = "vault_owner"
    after["workflows"][0]["api_endpoints"][0]["authorization"] = "vault_owner"
    assert not _workflow_change_is_additive(before, after, "workflows:workflow.setup.connections")
