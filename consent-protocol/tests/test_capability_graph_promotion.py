# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
"""Whole-tree promotion replays provenance without replacing the actual base gate."""

from __future__ import annotations

from copy import deepcopy
from typing import Any

import pytest

from scripts import capability_graph_promotion as graph_promotion
from scripts import generate_capability_graph as generator
from tests.helpers.capability_graph_fixture import (
    V1,
    V1_REVISION,
    V2,
    Repo,
    _empty_diff,
)
from tests.helpers.capability_graph_fixture import (
    repo as repo,
)


@pytest.fixture
def promotion(repo: Repo, monkeypatch: pytest.MonkeyPatch) -> tuple[Repo, dict[str, Any]]:
    repo.git("checkout", "-q", "main")
    workflow = {"capability_id": "workflow.test", "version": 1, "steps": []}
    old_graph = {**deepcopy(V1), "workflows": [workflow]}
    repo.write_graph(old_graph)
    old = repo.commit("publish an unchanged workflow before promotion")
    repo.git("branch", "uat", old)
    repo.write_ledger(
        [
            {
                "schema_version": "one.capability_deprecation.v1",
                "semantic_id": "actions:X",
                "from_revision": V1_REVISION,
                "from_version": 1,
                "to_version": 1,
                "active_run_policy": "reject",
            }
        ]
    )
    compiled = {**deepcopy(V2), "workflows": [workflow]}
    main_graph = {
        **deepcopy(compiled),
        "revision": "independent-main-revision",
        "semantic_diff": _empty_diff(None),
    }
    main_graph["workflow_revision_compatibility"] = generator._workflow_revision_compatibility(
        old_graph, main_graph, _empty_diff(V1_REVISION)
    )
    repo.write_graph(main_graph)
    repo.commit("Main independently adopted the acknowledged binding")
    repo.git("checkout", "-q", "uat")
    repo.git("merge", "--no-ff", "--no-commit", "main")
    monkeypatch.setattr(
        generator, "compile_capability_graph_from_sources", lambda: deepcopy(compiled)
    )
    payload = generator.build_payload(base_ref=old)
    repo.write_graph(payload)
    repo.commit("UAT incorporates Main with exact old-revision rejection")
    payload = generator.build_payload(base_ref=old)
    entry = payload["workflow_revision_compatibility"]["workflows"][0]
    entry["compatible_graph_revisions"].append("candidate-only-compatible")
    entry["compatible_graph_revisions"].sort()
    entry["migration_required_graph_revisions"] = ["candidate-only-migration"]
    entry["rejected_graph_revisions"] = ["candidate-only-rejected"]
    repo.write_graph(payload)
    repo.commit("preserve the separately qualified UAT workflow history")
    assert generator._merged_workflow_predecessor_refs("main") == (old,)
    return repo, payload


def _check(monkeypatch: pytest.MonkeyPatch) -> int:
    monkeypatch.setattr(
        "sys.argv", ["generate_capability_graph.py", "--check", "--base-ref", "main"]
    )
    return generator.main()


def test_zero_main_promotion_preserves_replayed_uat_tree(
    promotion: tuple[Repo, dict[str, Any]], monkeypatch: pytest.MonkeyPatch
) -> None:
    _, payload = promotion
    assert payload["semantic_diff"]["deprecated"] == ["actions:X"]
    assert generator.build_payload(base_ref="main") == payload
    assert _check(monkeypatch) == 0


@pytest.mark.parametrize("field", ["breaking", "deprecated", "extra", "from_revision"])
def test_recorded_transition_must_equal_entire_fresh_replay(
    promotion: tuple[Repo, dict[str, Any]], field: str
) -> None:
    repo, payload = promotion
    forged = deepcopy(payload)
    forged["semantic_diff"][field] = "unknown-revision" if field == "from_revision" else "forged"
    repo.write_graph(forged)
    repo.commit("forged historical comparison")
    with pytest.raises(RuntimeError, match="Graph promotion"):
        generator.build_payload(base_ref="main")


def test_missing_current_acknowledgment_cannot_borrow_old_receipt(
    promotion: tuple[Repo, dict[str, Any]],
) -> None:
    repo, _ = promotion
    repo.write_ledger([])
    with pytest.raises(RuntimeError, match="unacknowledged breaking changes: actions:X"):
        generator.build_payload(base_ref="main")


@pytest.mark.parametrize("same_revision", [False, True])
def test_actual_nonzero_base_cannot_be_replaced_by_recorded_comparison(
    promotion: tuple[Repo, dict[str, Any]],
    monkeypatch: pytest.MonkeyPatch,
    same_revision: bool,
) -> None:
    changed = deepcopy(V2)
    changed["workflows"] = deepcopy(promotion[1]["workflows"])
    changed["actions"][0]["execution"]["binding_ref"] = "unacknowledged-third-binding"
    if same_revision:
        changed["revision"] = "independent-main-revision"
    else:
        changed["revision"] = "new-unacknowledged-revision"
    monkeypatch.setattr(generator, "compile_capability_graph_from_sources", lambda: changed)
    with pytest.raises(RuntimeError, match="unacknowledged breaking changes: actions:X"):
        generator.build_payload(base_ref="main")


@pytest.mark.parametrize("failure", ["uncommitted", "stale_digest", "mirror"])
def test_promotion_still_checks_committed_provenance_digests_and_every_mirror(
    promotion: tuple[Repo, dict[str, Any]],
    monkeypatch: pytest.MonkeyPatch,
    failure: str,
) -> None:
    repo, payload = promotion
    if failure == "uncommitted":
        zero = deepcopy(payload)
        zero["semantic_diff"] = _empty_diff(None)
        repo.write_graph(zero)
        repo.commit("zero provenance committed")
        repo.write_graph(payload)
    elif failure == "stale_digest":
        payload["source_digests"]["capability_runtime_compiler"] = "stale"
        repo.write_graph(payload)
    else:
        generator.OUTPUTS[2].write_text("{}\n", encoding="utf-8")
    with pytest.raises(SystemExit, match="artifacts are stale"):
        _check(monkeypatch)


def test_candidate_history_cannot_restore_a_rejected_workflow_revision(
    promotion: tuple[Repo, dict[str, Any]],
) -> None:
    repo, payload = promotion
    forged = deepcopy(payload)
    entry = forged["workflow_revision_compatibility"]["workflows"][0]
    entry["compatible_graph_revisions"].append("candidate-only-rejected")
    repo.write_graph(forged)
    repo.commit("conflicting workflow revision policy")
    with pytest.raises(RuntimeError, match="conflicts with revision policy"):
        generator.build_payload(base_ref="main")


def test_two_predecessors_cannot_claim_one_revision_with_different_semantics(
    promotion: tuple[Repo, dict[str, Any]],
) -> None:
    repo, payload = promotion
    graph = deepcopy(payload)
    graph["semantic_diff"] = _empty_diff(None)
    old = generator._read_workflow_predecessor(repo.git("rev-parse", "main^"))
    assert old is not None
    altered = deepcopy(old)
    altered["actions"][0]["execution"]["binding_ref"] = "unrelated-history"
    with pytest.raises(RuntimeError, match="ambiguous recorded predecessor semantics"):
        graph_promotion.retained_comparison(
            graph,
            payload,
            [old, altered],
            compare=lambda before, after: generator._semantic_diff(
                before,
                after,
                deprecations=generator._load_evolution_deprecations(),
                reuse_recorded=False,
            ),
            semantic_index=generator._semantic_index,
            require_acknowledged=generator._require_acknowledged_semantic_changes,
        )
