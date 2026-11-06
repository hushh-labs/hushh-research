"""The Dev phone action's historical graph needs an exact acknowledgement."""

import json
from pathlib import Path

import pytest

from scripts import generate_capability_graph as generator


def test_landed_uat_workflow_history_survives_cumulative_release() -> None:
    """Existing runs remain admissible after rebuilding from the serving base."""
    graph_path = Path(__file__).resolve().parents[1] / "contracts/kai/one-capability-graph.v1.json"
    graph = json.loads(graph_path.read_text(encoding="utf-8"))
    policies = {
        item["workflow_id"]: item for item in graph["workflow_revision_compatibility"]["workflows"]
    }
    revisions = {"3e761f3cb5bebeaf", "6c49b50b94a5d1d7"}
    for name in (
        "calendar",
        "cloud",
        "connections",
        "email",
        "finance",
        "gmail",
        "location",
        "ria",
    ):
        policy = policies[f"workflow.setup.{name}"]
        assert revisions <= set(policy["compatible_graph_revisions"])
        assert revisions.isdisjoint(policy["migration_required_graph_revisions"])
        assert revisions.isdisjoint(policy["rejected_graph_revisions"])


def test_dev_phone_deletion_revision_is_retired_without_accepting_other_revisions() -> None:
    """The ledger declares rejection for this predecessor, not arbitrary revisions."""
    ledger_path = (
        Path(__file__).resolve().parents[1] / "hushh_mcp/agents/capability_graph_evolution.v1.json"
    )
    ledger = json.loads(ledger_path.read_text(encoding="utf-8"))
    semantic_id = "actions:phone_mandate.delete_previous"
    previous = {
        "revision": "a6a99d8a8ceae915",
        "actions": [
            {
                "capability_id": semantic_id.removeprefix("actions:"),
                "version": 1,
                "description": "previous-account sign-in",
            }
        ],
    }
    current = {
        "revision": "new-phone-review",
        "actions": [
            {
                "capability_id": semantic_id.removeprefix("actions:"),
                "version": 1,
                "description": "fresh-proof deletion review",
            }
        ],
    }
    declarations = tuple(ledger["deprecations"])
    change = generator._semantic_diff(previous, current, deprecations=declarations)
    assert change["deprecated"] == [semantic_id]
    assert change["breaking"] == []

    previous["revision"] = "unrecognized-old-revision"
    change = generator._semantic_diff(previous, current, deprecations=declarations)
    assert change["breaking"] == [semantic_id]


@pytest.mark.parametrize("revision", ["076c05cd70ea69d7", "f6d226a2c5ca0b34"])
def test_connections_endpoint_inventory_history_is_retired_exactly(revision: str) -> None:
    """Identical retired Connections workflows have distinct whole-graph identities."""
    semantic_id = "workflows:workflow.setup.connections"
    previous = {
        "revision": revision,
        "workflows": [
            {
                "capability_id": "workflow.setup.connections",
                "version": 1,
                "execution": {"binding_ref": "legacy-inventory"},
            }
        ],
    }
    current = {
        "revision": "current-connections",
        "workflows": [
            {
                "capability_id": "workflow.setup.connections",
                "version": 1,
                "execution": {"binding_ref": "current-inventory"},
            }
        ],
    }
    declarations = generator._load_evolution_deprecations()
    change = generator._semantic_diff(previous, current, deprecations=declarations)
    assert change["deprecated"] == [semantic_id]
    assert change["breaking"] == []
    policy = generator._workflow_revision_compatibility(previous, current, change)
    assert policy["workflows"][0]["rejected_graph_revisions"] == [revision]
    previous["revision"] = "unrecognized-connections-revision"
    change = generator._semantic_diff(previous, current, deprecations=declarations)
    assert change["breaking"] == [semantic_id]
