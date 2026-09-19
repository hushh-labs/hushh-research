from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.services.personal_knowledge_model_service import PersonalKnowledgeModelService
from hushh_mcp.services.pkm_manifest_repair import (
    ManifestRepairError,
    build_entity_path_repair_plan,
)


def _snapshot():
    paths = [
        {
            "user_id": "owner",
            "domain": "professional",
            "json_path": "employment",
            "parent_path": None,
            "path_type": "object",
            "segment_id": "root",
            "scope_handle": "scope-employment",
            "exposure_eligibility": False,
        },
        {
            "user_id": "owner",
            "domain": "professional",
            "json_path": "employment.entities",
            "parent_path": "employment",
            "path_type": "object",
            "segment_id": "root",
            "scope_handle": "scope-employment",
            "exposure_eligibility": False,
        },
        {
            "user_id": "owner",
            "domain": "professional",
            "json_path": "employment.entities.entities",
            "parent_path": "employment.entities",
            "path_type": "array",
            "segment_id": "root",
            "scope_handle": "scope-employment",
            "exposure_eligibility": False,
        },
        {
            "user_id": "owner",
            "domain": "professional",
            "json_path": "employment.entities.entities.title",
            "parent_path": "employment.entities.entities",
            "path_type": "leaf",
            "segment_id": "root",
            "scope_handle": "scope-employment",
            "exposure_eligibility": True,
        },
        {
            "user_id": "owner",
            "domain": "professional",
            "json_path": "portfolio.holdings._items.ticker",
            "parent_path": "portfolio.holdings._items",
            "path_type": "leaf",
            "segment_id": "root",
            "scope_handle": "scope-portfolio",
            "exposure_eligibility": True,
        },
        {
            "user_id": "owner",
            "domain": "professional",
            "json_path": "portfolio",
            "parent_path": None,
            "path_type": "object",
            "segment_id": "root",
            "scope_handle": "scope-portfolio",
            "exposure_eligibility": False,
        },
        {
            "user_id": "owner",
            "domain": "professional",
            "json_path": "portfolio.holdings",
            "parent_path": "portfolio",
            "path_type": "array",
            "segment_id": "root",
            "scope_handle": "scope-portfolio",
            "exposure_eligibility": False,
        },
        {
            "user_id": "owner",
            "domain": "professional",
            "json_path": "portfolio.holdings._items",
            "parent_path": "portfolio.holdings",
            "path_type": "array",
            "segment_id": "root",
            "scope_handle": "scope-portfolio",
            "exposure_eligibility": False,
        },
    ]
    scopes = [
        {
            "user_id": "owner",
            "domain": "professional",
            "scope_handle": "scope-employment",
            "scope_label": "Employment",
            "segment_ids": ["root"],
            "sensitivity_tier": "confidential",
            "scope_kind": "subtree",
            "exposure_enabled": True,
            "manifest_version": 2,
            "summary_projection": {"top_level_scope_path": "employment"},
        },
        {
            "user_id": "owner",
            "domain": "professional",
            "scope_handle": "scope-portfolio",
            "scope_label": "Portfolio",
            "segment_ids": ["root"],
            "sensitivity_tier": "confidential",
            "scope_kind": "subtree",
            "exposure_enabled": True,
            "manifest_version": 2,
            "summary_projection": {"top_level_scope_path": "portfolio"},
        },
    ]
    return {
        "manifest": {
            "user_id": "owner",
            "domain": "professional",
            "manifest_version": 2,
            "path_count": len(paths),
            "top_level_scope_paths": ["employment", "portfolio"],
            "externalizable_paths": [
                "employment.entities.entities.title",
                "portfolio.holdings._items.ticker",
            ],
            "structure_decision": {"json_paths": [path["json_path"] for path in paths]},
            "summary_projection": {"path_count": len(paths)},
        },
        "paths": paths,
        "scopes": scopes,
    }


def _plan(snapshot=None):
    snapshot = snapshot or _snapshot()
    expected_manifest_revision = snapshot["manifest"]["manifest_version"]
    return build_entity_path_repair_plan(
        user_id="owner",
        domain="professional",
        expected_content_revision=7,
        expected_manifest_revision=expected_manifest_revision,
        manifest=snapshot["manifest"],
        path_rows=snapshot["paths"],
        scope_rows=snapshot["scopes"],
    )


def test_repairs_only_exact_entity_collection_token_and_preserves_items():
    plan = _plan()

    assert plan.requires_commit is True
    assert plan.next_manifest_revision == 3
    repaired = {row["json_path"] for row in plan.path_rows}
    assert "employment.entities._entities" in repaired
    assert "employment.entities._entities.title" in repaired
    assert "portfolio.holdings._items.ticker" in repaired
    assert "portfolio.holdings._items" in repaired
    assert plan.manifest_row["externalizable_paths"] == [
        "employment.entities._entities.title",
        "portfolio.holdings._items.ticker",
    ]


def test_already_repaired_snapshot_is_idempotent_noop():
    plan = _plan()
    repaired_snapshot = {
        "manifest": plan.manifest_row,
        "paths": list(plan.path_rows),
        "scopes": list(plan.scope_rows),
    }
    noop = _plan(repaired_snapshot)
    assert noop.requires_commit is False
    assert noop.changed_paths == ()


@pytest.mark.parametrize(
    "mutate",
    [
        lambda snapshot: snapshot["paths"].append(deepcopy(snapshot["paths"][0])),
        lambda snapshot: snapshot["paths"][3].update({"parent_path": "employment"}),
        lambda snapshot: snapshot["paths"].__setitem__(
            0, {**snapshot["paths"][0], "path_type": "leaf"}
        ),
        lambda snapshot: snapshot["paths"].__setitem__(
            3, {**snapshot["paths"][3], "unexpected": True}
        ),
    ],
)
def test_rejects_unsafe_graph_or_metadata_changes(mutate):
    snapshot = _snapshot()
    mutate(snapshot)
    with pytest.raises(ManifestRepairError):
        _plan(snapshot)


def test_rejects_revision_booleans_and_owner_mismatch():
    snapshot = _snapshot()
    with pytest.raises(ManifestRepairError):
        build_entity_path_repair_plan(
            user_id="owner",
            domain="professional",
            expected_content_revision=True,
            expected_manifest_revision=2,
            manifest=snapshot["manifest"],
            path_rows=snapshot["paths"],
            scope_rows=snapshot["scopes"],
        )

    snapshot["paths"][0]["user_id"] = "other-owner"
    with pytest.raises(ManifestRepairError):
        _plan(snapshot)


def test_rejects_terminal_or_ambiguous_entity_marker():
    snapshot = _snapshot()
    snapshot["paths"][2]["path_type"] = "leaf"
    with pytest.raises(ManifestRepairError):
        _plan(snapshot)


def test_rejects_entity_collection_below_array_parent():
    snapshot = _snapshot()
    snapshot["paths"][1]["path_type"] = "array"
    with pytest.raises(ManifestRepairError, match="object parent"):
        _plan(snapshot)


def test_rejects_unknown_structure_path_after_repair():
    snapshot = _snapshot()
    snapshot["manifest"]["structure_decision"]["json_paths"].append(
        "missing.entities.entities.title"
    )
    with pytest.raises(ManifestRepairError, match="unknown path"):
        _plan(snapshot)


def test_repair_does_not_alias_nested_scope_metadata():
    snapshot = _snapshot()
    plan = _plan(snapshot)
    plan.scope_rows[0]["segment_ids"].append("new")
    assert "new" not in snapshot["scopes"][0]["segment_ids"]


def test_manifest_projection_only_repair_requires_one_revision():
    canonical = _plan()
    snapshot = {
        "manifest": deepcopy(canonical.manifest_row),
        "paths": list(canonical.path_rows),
        "scopes": list(canonical.scope_rows),
    }
    snapshot["manifest"]["manifest_version"] = 2
    for row in snapshot["scopes"]:
        row["manifest_version"] = 2
    snapshot["manifest"]["externalizable_paths"] = [
        "employment.entities.entities.title",
        "portfolio.holdings._items.ticker",
    ]
    plan = _plan(snapshot)
    assert plan.requires_commit is True
    assert plan.changed_paths == ()
    assert plan.next_manifest_revision == 3
    assert plan.manifest_row["externalizable_paths"][0] == "employment.entities._entities.title"


def test_scope_projection_only_repair_requires_one_revision():
    canonical = _plan()
    snapshot = {
        "manifest": deepcopy(canonical.manifest_row),
        "paths": list(canonical.path_rows),
        "scopes": deepcopy(list(canonical.scope_rows)),
    }
    snapshot["manifest"]["manifest_version"] = 2
    for row in snapshot["scopes"]:
        row["manifest_version"] = 2
    snapshot["scopes"][0]["summary_projection"]["top_level_scope_path"] = (
        "employment.entities.entities.title"
    )
    plan = _plan(snapshot)
    assert plan.requires_commit is True
    assert plan.changed_paths == ()
    assert (
        plan.scope_rows[0]["summary_projection"]["top_level_scope_path"]
        == "employment.entities._entities.title"
    )


@pytest.mark.asyncio
async def test_service_uses_raw_snapshot_and_revision_checked_repair_rpc():
    snapshot = _snapshot()
    service = PersonalKnowledgeModelService()
    service._run_rpc = AsyncMock(
        side_effect=[
            SimpleNamespace(
                data=[
                    {
                        "get_pkm_domain_snapshot_v1": {
                            **snapshot,
                            "content_revision": 7,
                            "manifest_revision": 2,
                        }
                    }
                ]
            ),
            SimpleNamespace(
                data=[
                    {
                        "repair_pkm_manifest_paths_v1": {
                            "success": True,
                            "conflict": False,
                            "manifest_revision": 3,
                            "data_version": 7,
                        }
                    }
                ]
            ),
        ]
    )

    result = await service.repair_historical_manifest_paths(
        user_id="owner",
        domain="professional",
    )

    assert result["success"] is True
    assert result["changed"] is True
    assert [call.args[0] for call in service._run_rpc.await_args_list] == [
        "get_pkm_domain_snapshot_v1",
        "repair_pkm_manifest_paths_v1",
    ]
    repair_params = service._run_rpc.await_args_list[1].args[1]
    assert repair_params["p_expected_content_revision"] == 7
    assert repair_params["p_expected_manifest_revision"] == 2
    assert repair_params["p_next_manifest_revision"] == 3
    assert "employment.entities._entities.title" in {
        row["json_path"] for row in repair_params["p_path_rows"].value
    }
    # Ciphertext is not part of the metadata mutation payload.
    assert "ciphertext" not in repair_params


@pytest.mark.asyncio
async def test_service_does_not_write_when_snapshot_is_already_canonical():
    snapshot = _snapshot()
    plan = _plan()
    snapshot = {
        "manifest": plan.manifest_row,
        "paths": list(plan.path_rows),
        "scopes": list(plan.scope_rows),
        "content_revision": 7,
        "manifest_revision": 3,
    }
    service = PersonalKnowledgeModelService()
    service._run_rpc = AsyncMock(
        return_value=SimpleNamespace(data=[{"get_pkm_domain_snapshot_v1": snapshot}])
    )

    result = await service.repair_historical_manifest_paths(
        user_id="owner",
        domain="professional",
    )

    assert result == {
        "success": True,
        "conflict": False,
        "idempotent_replay": True,
        "changed": False,
        "data_version": 7,
        "manifest_revision": 3,
    }
    service._run_rpc.assert_awaited_once()
