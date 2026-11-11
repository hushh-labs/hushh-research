"""The capability-graph breaking-change gate compares against the PR base, not HEAD.

On a pull request the checkout is the merge ref, so ``HEAD:`` holds the author's
own committed graph. Its revision equals the compiled one, and the gate then
returns whatever ``breaking`` list the author recorded. ``help.open_examples``
was repurposed inside merge commit 4d939219a with ``breaking: []`` that way.

Every test builds a throwaway repository under ``tmp_path`` and never reads the
real repository's git state.
"""

from __future__ import annotations

import json
import subprocess
from copy import deepcopy
from pathlib import Path
from typing import Any
from unittest.mock import Mock

import pytest

from scripts import generate_capability_graph as generator
from tests.helpers.capability_graph_fixture import (
    GRAPH_RELATIVE,
    MIRRORS,
    V1,
    V1_REVISION,
    V2,
    V2_REVISION,
    Repo,
    _aliased,
)
from tests.helpers.capability_graph_fixture import (
    repo as repo,
)


def _gate(previous: dict[str, Any] | None) -> dict[str, Any]:
    deprecations = generator._load_evolution_deprecations()
    semantic_diff = generator._semantic_diff(previous, V2, deprecations=deprecations)
    generator._require_acknowledged_semantic_changes(semantic_diff)
    return semantic_diff


def test_head_comparison_reproduces_the_historical_bypass(
    repo: Repo, capsys: pytest.CaptureFixture[str]
) -> None:
    """Historical behaviour, kept only as the local fallback.

    Without a configured base or CI marker, an absent ``origin/main`` warns
    and falls back to ``HEAD:``; this does not prove comparison against main.
    """

    previous = generator._read_previous()

    assert previous is not None
    assert previous["revision"] == V2_REVISION
    semantic_diff = _gate(previous)
    assert semantic_diff["breaking"] == []
    assert semantic_diff == V2["semantic_diff"]
    stderr = capsys.readouterr().err
    assert "capability graph base: HEAD" in stderr
    assert "origin/main is unresolvable" in stderr


def test_merged_branch_history_is_selected_from_the_base_merge(repo: Repo) -> None:
    assert generator._merged_workflow_predecessor_refs("main") == ()
    feature_tip = repo.git("rev-parse", "HEAD")
    repo.git("checkout", "-q", "main")
    (repo.root / "main-change.txt").write_text("base advanced\n", encoding="utf-8")
    repo.commit("advance main")
    repo.git("checkout", "-q", "feature")
    repo.git("merge", "--no-ff", "--no-edit", "main")

    assert generator._merged_workflow_predecessor_refs("main") == (feature_tip,)

    # Both concurrent branches independently integrate the same base.
    repo.git("checkout", "-q", "-b", "parallel", feature_tip)
    (repo.root / "parallel.txt").write_text("concurrent feature\n", encoding="utf-8")
    parallel_tip = repo.commit("concurrent feature history")
    repo.git("merge", "--no-ff", "--no-edit", "main")
    parallel_integrated = repo.git("rev-parse", "HEAD")
    repo.git("checkout", "-q", "feature")
    repo.git("merge", "--no-ff", "--no-edit", "parallel")
    expected = {parallel_integrated, parallel_tip, feature_tip}
    assert set(generator._merged_workflow_predecessor_refs("main")) == expected

    # A verification merge can carry the main merge through its second parent.
    repo.git("checkout", "-q", "-b", "verification", feature_tip)
    (repo.root / "verification.txt").write_text("isolated verification\n", encoding="utf-8")
    verification_tip = repo.commit("prepare isolated verification")
    repo.git("merge", "--no-ff", "--no-edit", "feature")

    assert set(generator._merged_workflow_predecessor_refs("main")) == expected | {verification_tip}


def test_only_inferred_prepublication_parent_has_no_graph_history(repo: Repo) -> None:
    unpublished = repo.git("rev-list", "--max-parents=0", "HEAD")

    assert generator._read_workflow_predecessor(unpublished, allow_unpublished=True) is None
    # A ledger or CLI declaration promises a published predecessor and remains strict.
    with pytest.raises(subprocess.CalledProcessError):
        generator._read_workflow_predecessor(unpublished)


@pytest.mark.parametrize("state", ["partial", "deleted", "shallow", "malformed", "no_revision"])
def test_inferred_parent_never_hides_missing_or_invalid_published_history(
    repo: Repo, state: str
) -> None:
    unpublished = repo.git("rev-list", "--max-parents=0", "HEAD")
    repo.git("checkout", "-q", "-b", "historical", unpublished)
    if state == "partial":
        mirror = repo.root / MIRRORS[1]
        mirror.parent.mkdir(parents=True, exist_ok=True)
        mirror.write_text(json.dumps(V1), encoding="utf-8")
    elif state == "deleted":
        repo.write_graph(V1)
        repo.commit("publish graph")
        for mirror in MIRRORS:
            (repo.root / mirror).unlink()
    elif state == "shallow":
        (repo.root / ".git" / "shallow").write_text(unpublished + "\n", encoding="utf-8")
    else:
        graph = repo.root / GRAPH_RELATIVE
        graph.parent.mkdir(parents=True, exist_ok=True)
        graph.write_text("{" if state == "malformed" else "{}", encoding="utf-8")
    historical = repo.commit("historical graph state") if state != "shallow" else unpublished

    with pytest.raises((subprocess.CalledProcessError, json.JSONDecodeError, RuntimeError)):
        generator._read_workflow_predecessor(historical, allow_unpublished=True)


@pytest.mark.parametrize(
    ("history", "expected"),
    [
        (
            "verification pre-base newer\nnewer matching parallel\n"
            "matching base feature-a feature-b\nparallel base parallel-tip\n",
            ("pre-base", "parallel", "feature-a", "feature-b", "parallel-tip"),
        ),
        ("newer parent-a parent-b\nolder parent-c parent-d\n", ()),
    ],
)
def test_merge_parent_history_uses_one_full_git_query(
    repo: Repo,
    monkeypatch: pytest.MonkeyPatch,
    history: str,
    expected: tuple[str, ...],
) -> None:
    monkeypatch.setattr(generator, "_resolve_base_ref", lambda _: "main")
    monkeypatch.setattr(generator, "_resolve_base_commit", lambda _: "base")
    commands: list[list[str]] = []

    def run(command: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        commands.append(command)
        assert kwargs["cwd"] == repo.root
        assert kwargs["check"] is True
        return subprocess.CompletedProcess(command, 0, stdout=history)

    monkeypatch.setattr(generator.subprocess, "run", run)

    assert generator._merged_workflow_predecessor_refs("main") == expected
    assert commands == [["git", "rev-list", "--ancestry-path", "--parents", "base..HEAD"]]


def test_base_ref_comparison_names_the_changed_action_and_fails(
    repo: Repo, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv(generator.CAPABILITY_GRAPH_BASE_REF_ENV, "main")

    previous = generator._read_previous()

    assert previous is not None
    assert previous["revision"] == V1_REVISION
    main_tip = repo.git("rev-parse", "main")
    assert f"capability graph base: main (merge-base {main_tip[:12]})" in capsys.readouterr().err
    with pytest.raises(RuntimeError, match=r"unacknowledged breaking changes: actions:X") as exc:
        _gate(previous)
    assert "exact-revision deprecation" in str(exc.value)
    monkeypatch.setattr(generator, "compile_capability_graph_from_sources", lambda: deepcopy(V2))
    with pytest.raises(RuntimeError, match=r"unacknowledged breaking changes: actions:X"):
        generator.build_payload(base_ref="main")
    deprecations = generator._load_evolution_deprecations()
    semantic_diff = generator._semantic_diff(previous, V2, deprecations=deprecations)
    assert semantic_diff["from_revision"] == V1_REVISION
    assert semantic_diff["changed"] == ["actions:X"]
    assert semantic_diff["breaking"] == ["actions:X"]


def test_an_added_spoken_alias_is_compatible_not_breaking() -> None:
    """More phrasings reach the same contract, so no paused run is invalidated.

    Without this the only way to regenerate the graph after a wording edit is
    an evolution-ledger retirement, which rejects in-flight runs -- a false
    statement about the change, written into the governed ledger.
    """

    before = _aliased(V1_REVISION, ["cancel my request", "withdraw that request"])
    after = _aliased(
        V2_REVISION,
        ["cancel my request", "cancel that request I just sent", "withdraw that request"],
    )

    semantic_diff = generator._semantic_diff(before, after, deprecations=())

    assert semantic_diff["changed"] == ["actions:X"]
    assert semantic_diff["compatible"] == ["actions:X"]
    assert semantic_diff["breaking"] == []
    generator._require_acknowledged_semantic_changes(semantic_diff)


@pytest.mark.parametrize(
    ("after", "reason"),
    [
        (
            _aliased(V2_REVISION, ["cancel my request"]),
            "a removed alias",
        ),
        (
            _aliased(V2_REVISION, ["withdraw that request", "cancel my request", "take it back"]),
            "a reordered alias",
        ),
        (
            _aliased(
                V2_REVISION,
                ["cancel my request", "withdraw that request", "take it back"],
                version=2,
            ),
            "a version bump",
        ),
        (
            _aliased(
                V2_REVISION,
                ["cancel my request", "withdraw that request", "take it back"],
                binding_ref="binding-b",
            ),
            "any other field changing",
        ),
    ],
)
def test_the_additive_alias_rule_stays_narrow(after: dict[str, Any], reason: str) -> None:
    before = _aliased(V1_REVISION, ["cancel my request", "withdraw that request"])

    semantic_diff = generator._semantic_diff(before, after, deprecations=())

    assert semantic_diff["compatible"] == [], reason
    assert semantic_diff["breaking"] == ["actions:X"], reason
    with pytest.raises(RuntimeError, match="unacknowledged breaking changes"):
        generator._require_acknowledged_semantic_changes(semantic_diff)


@pytest.mark.parametrize("field", ["search_keywords", "routes", "screens"])
def test_navigation_discovery_can_append_without_retiring_actions(field: str) -> None:
    before = _aliased(V1_REVISION, ["open profile"])
    before["actions"][0].update(
        {
            "search_keywords": ["profile"],
            "execution": {
                "outcome": "NAVIGATE",
                "target": {"path": "route", "target": "/one/profile", "status": "wired"},
            },
            "side_effect": {"classification": "navigation"},
            "navigation": {
                "routes": ["/one/profile"],
                "screens": ["profile"],
                "fallback": "/one/profile",
            },
        }
    )
    after = deepcopy(before)
    after["revision"] = V2_REVISION
    node = after["actions"][0]
    container = node if field == "search_keywords" else node["navigation"]
    container[field].append("/one/profile/appearance" if field == "routes" else "appearance")
    diff = generator._semantic_diff(before, after)
    assert diff["compatible"] == ["actions:X"]
    assert diff["breaking"] == []
    generator._require_acknowledged_semantic_changes(diff)


@pytest.mark.parametrize(
    "change", ["remove", "reorder", "fallback", "target", "input", "authorization", "confirmation"]
)
def test_added_metadata_never_masks_a_changed_action_boundary(change: str) -> None:
    before = _aliased(V1_REVISION, ["open profile"])
    before["actions"][0].update(
        {
            "search_keywords": ["profile", "account"],
            "execution": {
                "outcome": "NAVIGATE",
                "target": {"path": "route", "target": "/one/profile", "status": "wired"},
            },
            "side_effect": {"classification": "navigation"},
            "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
            "navigation": {
                "routes": ["/one/profile"],
                "screens": ["profile"],
                "fallback": "/one/profile",
            },
        }
    )
    after = deepcopy(before)
    after["revision"] = V2_REVISION
    node = after["actions"][0]
    node["search_keywords"].append("appearance")
    if change == "remove":
        node["navigation"]["routes"] = ["/one/profile/appearance"]
    elif change == "reorder":
        node["search_keywords"] = ["account", "profile", "appearance"]
    elif change == "fallback":
        node["navigation"]["fallback"] = "/one/profile/appearance"
    elif change == "target":
        node["execution"]["target"]["target"] = "/one/profile/appearance"
    elif change == "input":
        node["inputSchema"]["properties"]["record_id"] = {"type": "string"}
    else:
        node[change] = {"changed": True}
    diff = generator._semantic_diff(before, after)
    assert diff["compatible"] == []
    assert diff["breaking"] == ["actions:X"]
    with pytest.raises(RuntimeError, match="unacknowledged breaking changes"):
        generator._require_acknowledged_semantic_changes(diff)


def test_non_navigation_actions_cannot_gain_routes_through_metadata_compatibility() -> None:
    before = _aliased(V1_REVISION, ["save record"])
    before["actions"][0].update(
        {
            "execution": {"outcome": "EXECUTE", "target": {"path": "local_handler"}},
            "side_effect": {"classification": "write"},
            "navigation": {"routes": [], "screens": [], "fallback": None},
        }
    )
    after = deepcopy(before)
    after["revision"] = V2_REVISION
    after["actions"][0]["navigation"]["routes"].append("/one/profile")
    diff = generator._semantic_diff(before, after)
    assert diff["compatible"] == []
    assert diff["breaking"] == ["actions:X"]


def test_exact_revision_deprecation_acknowledges_the_change(
    repo: Repo, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(generator.CAPABILITY_GRAPH_BASE_REF_ENV, "main")
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

    semantic_diff = _gate(generator._read_previous())

    assert semantic_diff["changed"] == ["actions:X"]
    assert semantic_diff["deprecated"] == ["actions:X"]
    assert semantic_diff["breaking"] == []


def test_stale_revision_deprecation_does_not_acknowledge_the_change(
    repo: Repo, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A ledger entry naming a different predecessor revision never suppresses the gate."""

    monkeypatch.setenv(generator.CAPABILITY_GRAPH_BASE_REF_ENV, "main")
    repo.write_ledger(
        [
            {
                "schema_version": "one.capability_deprecation.v1",
                "semantic_id": "actions:X",
                "from_revision": "rev-someone-else",
                "from_version": 1,
                "to_version": 1,
                "active_run_policy": "reject",
            }
        ]
    )

    with pytest.raises(RuntimeError, match=r"actions:X"):
        _gate(generator._read_previous())


@pytest.mark.parametrize("marker", ["CI", "GITHUB_ACTIONS"])
def test_unresolvable_base_fails_closed_under_ci(
    repo: Repo, monkeypatch: pytest.MonkeyPatch, marker: str
) -> None:
    monkeypatch.setenv(marker, "1")

    with pytest.raises(RuntimeError, match=r"capability graph base ref unavailable") as exc:
        generator._read_previous()

    assert "origin/main" in str(exc.value)
    assert "fetch-depth 0" in str(exc.value)


def test_github_base_ref_is_read_as_the_remote_tracking_branch_and_fails_closed(
    repo: Repo, monkeypatch: pytest.MonkeyPatch
) -> None:
    """GitHub exposes a bare branch name; a shallow checkout has no origin/main."""

    monkeypatch.setenv("GITHUB_ACTIONS", "true")
    monkeypatch.setenv("GITHUB_BASE_REF", "main")

    assert generator._resolve_base_ref() == "origin/main"
    with pytest.raises(RuntimeError, match=r"unavailable \(origin/main\)"):
        generator._read_previous()


def test_graph_absent_at_the_base_is_a_first_release(
    repo: Repo, monkeypatch: pytest.MonkeyPatch
) -> None:
    first_commit = repo.git("rev-list", "--max-parents=0", "HEAD")
    monkeypatch.setenv(generator.CAPABILITY_GRAPH_BASE_REF_ENV, first_commit)

    previous = generator._read_previous()

    assert previous is None
    semantic_diff = _gate(previous)
    assert semantic_diff["from_revision"] is None
    assert semantic_diff["added"] == ["actions:X"]
    assert semantic_diff["removed"] == []
    assert semantic_diff["changed"] == []
    assert semantic_diff["breaking"] == []


def test_pull_request_merge_ref_resolves_to_the_base_tip(
    repo: Repo, monkeypatch: pytest.MonkeyPatch
) -> None:
    """On a merge ref the merge-base is the base branch tip; locally it is the fork point."""

    fork_point = repo.git("rev-parse", "main")
    repo.git("checkout", "-q", "main")
    (repo.root / "unrelated.txt").write_text("main moved on\n", encoding="utf-8")
    main_tip = repo.commit("chore: unrelated change on main")
    assert main_tip != fork_point

    repo.git("checkout", "-q", "feature")
    assert generator._resolve_base_commit("main") == fork_point

    repo.git("checkout", "-q", "-b", "scratch", "main")
    repo.git("merge", "-q", "--no-ff", "-m", "Merge feature into scratch", "feature")
    assert generator._resolve_base_commit("main") == main_tip
    assert repo.git("rev-parse", "HEAD^1") == main_tip

    monkeypatch.setenv(generator.CAPABILITY_GRAPH_BASE_REF_ENV, "main")
    previous = generator._read_previous()
    assert previous is not None
    assert previous["revision"] == V1_REVISION
    with pytest.raises(RuntimeError, match=r"actions:X"):
        _gate(previous)


def test_equal_revisions_keep_the_recorded_diff_byte_stable(
    repo: Repo, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A branch that did not touch the graph regenerates the committed diff verbatim."""

    monkeypatch.setenv(generator.CAPABILITY_GRAPH_BASE_REF_ENV, "main")
    repo.git("checkout", "-q", "main")
    (repo.root / "unrelated.txt").write_text("no graph change\n", encoding="utf-8")
    repo.commit("chore: unrelated change")

    previous = generator._read_previous()

    assert previous is not None
    semantic_diff = generator._semantic_diff(previous, V1, deprecations=())
    assert semantic_diff == V1["semantic_diff"]


def test_base_ref_precedence(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in (
        generator.CAPABILITY_GRAPH_BASE_REF_ENV,
        "GITHUB_BASE_REF",
        "WEB_TARGETED_BASE_REF",
    ):
        monkeypatch.delenv(name, raising=False)

    assert generator._resolve_base_ref() == "origin/main"

    monkeypatch.setenv("WEB_TARGETED_BASE_REF", "develop")
    assert generator._resolve_base_ref() == "origin/develop"
    monkeypatch.setenv("WEB_TARGETED_BASE_REF", "origin/develop")
    assert generator._resolve_base_ref() == "origin/develop"

    monkeypatch.setenv("GITHUB_BASE_REF", "release")
    assert generator._resolve_base_ref() == "origin/release"

    monkeypatch.setenv(generator.CAPABILITY_GRAPH_BASE_REF_ENV, "main")
    assert generator._resolve_base_ref() == "main"

    assert generator._resolve_base_ref("0123abcd") == "0123abcd"
    assert generator._resolve_base_ref("  ") == "main"


def test_exported_archive_without_git_compares_the_file_to_itself(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("CI", "1")
    root = tmp_path / "archive"
    outputs = tuple(root / mirror for mirror in MIRRORS)
    outputs[0].parent.mkdir(parents=True)
    outputs[0].write_text(json.dumps(V2), encoding="utf-8")
    monkeypatch.setattr(generator, "REPO_ROOT", root)
    monkeypatch.setattr(generator, "OUTPUTS", outputs)

    previous = generator._read_previous()

    assert previous is not None
    assert previous["revision"] == V2_REVISION


def test_zero_transition_is_canonical_across_ancestral_bases_and_still_checks_every_mirror(
    repo: Repo, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    repo.git("checkout", "-q", "main")
    first = repo.git("rev-parse", "HEAD")
    prior = {**deepcopy(V1), "revision": "prior-format-revision"}
    repo.write_graph(prior)
    second = repo.commit("chore: graph format without a semantic transition")
    compiled = {**deepcopy(V1), "revision": "current-format-revision"}
    monkeypatch.setattr(generator, "compile_capability_graph_from_sources", lambda: compiled)
    compatibility = Mock(wraps=generator._workflow_revision_compatibility)
    monkeypatch.setattr(generator, "_workflow_revision_compatibility", compatibility)

    first_payload = generator.build_payload(base_ref=first)
    second_payload = generator.build_payload(base_ref=second)
    assert json.dumps(first_payload, sort_keys=True) == json.dumps(second_payload, sort_keys=True)
    assert first_payload["semantic_diff"]["from_revision"] is None
    assert [call.args[2]["from_revision"] for call in compatibility.call_args_list] == [
        V1_REVISION,
        prior["revision"],
    ]
    assert first[:12] in capsys.readouterr().err
    repo.write_graph(first_payload)
    for base in (first, second):
        monkeypatch.setattr(
            "sys.argv", ["generate_capability_graph.py", "--check", "--base-ref", base]
        )
        assert generator.main() == 0

    stale = deepcopy(first_payload)
    stale["source_digests"]["capability_runtime_compiler"] = "stale"
    generator.OUTPUTS[1].write_text(json.dumps(stale), encoding="utf-8")
    for base in (first, second):
        monkeypatch.setattr(
            "sys.argv", ["generate_capability_graph.py", "--check", "--base-ref", base]
        )
        with pytest.raises(SystemExit, match="artifacts are stale"):
            generator.main()


@pytest.mark.parametrize("branch", ["uat", "dev"])
def test_exact_uat_checks_the_serving_transition_and_landed_pr_mirrors(
    repo: Repo, monkeypatch: pytest.MonkeyPatch, branch: str
) -> None:
    repo.git("checkout", "-q", "main")
    serving = repo.git("rev-parse", "HEAD")
    candidate = deepcopy(V1)
    candidate["revision"] = V2_REVISION
    candidate["actions"].append({**deepcopy(candidate["actions"][0]), "capability_id": "Y"})
    monkeypatch.setattr(generator, "compile_capability_graph_from_sources", lambda: candidate)

    serving_payload = generator.build_payload(base_ref=serving)
    assert serving_payload["semantic_diff"]["added"] == ["actions:Y"]
    repo.write_graph(serving_payload)
    parent = repo.commit("land the additive graph")
    pr_payload = generator.build_payload(base_ref=parent)
    pr_payload["semantic_diff"] = {
        key: None if key == "from_revision" else [] for key in pr_payload["semantic_diff"]
    }
    repo.write_graph(pr_payload)
    repo.commit("record the zero comparison in the next reviewed graph")
    repo.git("checkout", "-q", "-b", "uat-follow-up")
    (repo.root / "proof.txt").touch()
    repo.commit("land another reviewed change")
    repo.git("checkout", "-q", "main")
    repo.git("merge", "--no-ff", "--no-edit", "uat-follow-up")
    monkeypatch.setattr(
        "sys.argv", ["generate_capability_graph.py", "--check", "--base-ref", serving]
    )
    with pytest.raises(SystemExit, match="artifacts are stale"):
        generator.main()

    monkeypatch.setenv("GITHUB_EVENT_NAME", "workflow_dispatch")
    monkeypatch.setenv("GITHUB_REF", f"refs/heads/{branch}")
    monkeypatch.setenv("GITHUB_SHA", repo.git("rev-parse", "HEAD"))
    monkeypatch.setenv("CI_VALIDATION_LEVEL", "release")
    assert generator.main() == 0

    generator.OUTPUTS[1].write_text("{}\n", encoding="utf-8")
    with pytest.raises(SystemExit, match="artifacts are stale"):
        generator.main()

    repo.write_graph(pr_payload)
    candidate["actions"][0]["execution"]["binding_ref"] = "breaking-binding"
    with pytest.raises(RuntimeError, match="unacknowledged breaking changes"):
        generator.main()


@pytest.mark.parametrize(
    "case", ["declared", "undeclared", "missing", "action", "workflow", "policy"]
)
def test_reviewed_divergent_serving_history_keeps_semantics_and_revision_fences(
    repo: Repo,
    monkeypatch: pytest.MonkeyPatch,
    case: str,
) -> None:
    repo.git("checkout", "-q", "main")
    compiled = deepcopy(V1)
    compiled["workflows"] = [
        {
            "capability_id": "workflow.synthetic",
            "version": 1,
            "execution": {"binding_ref": "workflow-binding"},
        }
    ]
    monkeypatch.setattr(
        generator, "compile_capability_graph_from_sources", lambda: deepcopy(compiled)
    )
    common_payload = generator.build_payload(base_ref="main")
    repo.write_graph(common_payload)
    repo.commit("publish the common workflow")
    repo.git("checkout", "-q", "-b", "published-serving")
    published = deepcopy(common_payload)
    published["revision"] = "published-divergent"
    published["workflow_revision_compatibility"]["current_graph_revision"] = published["revision"]
    if case == "action":
        published["actions"][0]["execution"]["binding_ref"] = "serving-only-action"
    if case == "workflow":
        published["workflows"][0]["execution"]["binding_ref"] = "serving-only-workflow"
    if case == "policy":
        published["workflow_revision_compatibility"]["workflows"][0]["rejected_graph_revisions"] = [
            "candidate-current"
        ]
    repo.write_graph(published)
    if case == "missing":
        for output in generator.OUTPUTS:
            output.unlink()
    serving = repo.commit("publish the separate serving history")
    repo.git("checkout", "-q", "main")
    ledger = json.loads(generator.EVOLUTION_CONTRACT_PATH.read_text())
    ledger["workflow_predecessor_refs"] = [] if case == "undeclared" else [serving]
    generator.EVOLUTION_CONTRACT_PATH.write_text(json.dumps(ledger))
    repo.commit("review the exact retained serving pin")
    compiled["revision"] = "candidate-current"
    compiled["actions"].append({**deepcopy(compiled["actions"][0]), "capability_id": "Y"})
    if case == "undeclared":
        with pytest.raises(subprocess.CalledProcessError):
            generator.build_payload(base_ref="main", workflow_predecessor_refs=(serving,))
        return
    if case == "missing":
        with pytest.raises(subprocess.CalledProcessError):
            generator.build_payload(base_ref="main")
        return
    if case in {"action", "workflow", "policy"}:
        with pytest.raises(
            RuntimeError, match="unacknowledged breaking changes|conflicts with revision policy"
        ):
            generator.build_payload(base_ref="main")
        return
    payload = generator.build_payload(base_ref="main")
    assert (
        published["revision"]
        in payload["workflow_revision_compatibility"]["workflows"][0]["compatible_graph_revisions"]
    )
    repo.write_graph(payload)
    parent = repo.commit("publish the compatible successor")
    reviewed = generator.build_payload(base_ref=parent)
    reviewed["semantic_diff"] = {
        key: None if key == "from_revision" else [] for key in reviewed["semantic_diff"]
    }
    repo.write_graph(reviewed)
    repo.commit("record the reviewed zero comparison")
    repo.git("checkout", "-q", "-b", "reviewed-change")
    (repo.root / "proof.txt").touch()
    repo.commit("reviewed unrelated change")
    repo.git("checkout", "-q", "main")
    repo.git("merge", "--no-ff", "--no-edit", "reviewed-change")
    monkeypatch.setenv("GITHUB_EVENT_NAME", "workflow_dispatch")
    monkeypatch.setenv("GITHUB_REF", "refs/heads/uat")
    monkeypatch.setenv("GITHUB_SHA", repo.git("rev-parse", "HEAD"))
    monkeypatch.setenv("CI_VALIDATION_LEVEL", "release")
    monkeypatch.setattr(
        "sys.argv", ["generate_capability_graph.py", "--check", "--base-ref", serving]
    )
    assert generator.main() == 0
    monkeypatch.setenv("GITHUB_REF", "refs/heads/uat-isolated")
    with pytest.raises(SystemExit, match="artifacts are stale"):
        generator.main()
    # The Main-owned TestFlight gate must preserve the same normal-UAT
    # comparison after its exact-source/backend acceptance preflight.
    head = repo.git("rev-parse", "HEAD")
    workflow = "hushh-labs/hushh-research/.github/workflows/ship-ios-testflight.yml@refs/heads/main"
    monkeypatch.setenv("GITHUB_REF", "refs/heads/main")
    monkeypatch.setenv("UAT_CI_CANDIDATE", head)
    monkeypatch.setenv("SOURCE_BRANCH", "uat")
    monkeypatch.setenv("GITHUB_WORKFLOW_REF", workflow)
    assert generator.main() == 0
    for field, value in (
        ("SOURCE_BRANCH", "uat-isolated"),
        ("GITHUB_WORKFLOW_REF", workflow.replace("ship-ios-testflight", "ci")),
        ("UAT_CI_CANDIDATE", parent),
    ):
        with monkeypatch.context() as wrong:
            wrong.setenv(field, value)
            with pytest.raises(SystemExit, match="artifacts are stale"):
                generator.main()
