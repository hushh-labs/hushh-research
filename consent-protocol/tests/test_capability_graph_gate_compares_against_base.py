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
from pathlib import Path
from typing import Any

import pytest

from scripts import generate_capability_graph as generator
from tests.helpers.capability_graph_fixture import (
    GRAPH_RELATIVE,
    LEDGER_RELATIVE,
    MIRRORS,
    V1,
    V1_REVISION,
    V2,
    V2_REVISION,
    Repo,
    _aliased,
)


@pytest.fixture
def repo(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Repo:
    """A temp repo: main carries graph v1, feature carries the v2 bypass."""

    for name in (
        "CI",
        "GITHUB_ACTIONS",
        "GITHUB_BASE_REF",
        "WEB_TARGETED_BASE_REF",
        generator.CAPABILITY_GRAPH_BASE_REF_ENV,
        "GIT_DIR",
        "GIT_WORK_TREE",
    ):
        monkeypatch.delenv(name, raising=False)
    # Keep the developer's global git config (hooks path, signing) out of the
    # temp repository so the test is hermetic.
    global_config = tmp_path / "gitconfig"
    global_config.write_text("", encoding="utf-8")
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(global_config))
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")

    root = tmp_path / "repo"
    root.mkdir()
    repo = Repo(root)
    repo.git("init", "-q", "-b", "main")
    repo.git("config", "user.name", "Capability Graph Test")
    repo.git("config", "user.email", "capability-graph-test@example.invalid")
    repo.git("config", "commit.gpgsign", "false")

    repo.write_ledger([])
    repo.commit("chore: ledger without a graph")
    repo.write_graph(V1)
    repo.commit("feat: capability graph v1")
    repo.git("checkout", "-q", "-b", "feature")
    repo.write_graph(V2)
    repo.commit("feat: repurpose X and record breaking: []")

    monkeypatch.setattr(generator, "REPO_ROOT", root)
    monkeypatch.setattr(generator, "OUTPUTS", tuple(root / mirror for mirror in MIRRORS))
    monkeypatch.setattr(generator, "EVOLUTION_CONTRACT_PATH", root / LEDGER_RELATIVE)
    return repo


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
