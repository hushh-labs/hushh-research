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
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest

from scripts import generate_capability_graph as generator

GRAPH_RELATIVE = Path("contracts") / "kai" / "one-capability-graph.v1.json"
MIRRORS = (
    GRAPH_RELATIVE,
    Path("hushh-webapp") / GRAPH_RELATIVE,
    Path("consent-protocol") / GRAPH_RELATIVE,
)
LEDGER_RELATIVE = (
    Path("consent-protocol") / "hushh_mcp" / "agents" / "capability_graph_evolution.v1.json"
)
V1_REVISION = "rev-v1-0000000"
V2_REVISION = "rev-v2-0000000"


def _empty_diff(from_revision: str | None) -> dict[str, Any]:
    return {
        "from_revision": from_revision,
        "added": [],
        "removed": [],
        "changed": [],
        "migrated": [],
        "compatible": [],
        "deprecated": [],
        "breaking": [],
    }


def _graph(revision: str, binding_ref: str, semantic_diff: dict[str, Any]) -> dict[str, Any]:
    """A minimal graph shaped the way ``_semantic_index`` and ``_semantic_node`` read it."""

    return {
        "schema_version": "one.capability_graph.v1",
        "revision": revision,
        "actions": [
            {
                "capability_id": "X",
                "version": 1,
                "execution": {"binding_ref": binding_ref},
            }
        ],
        "workflows": [],
        "semantic_diff": semantic_diff,
    }


V1 = _graph(V1_REVISION, "binding-a", {**_empty_diff(None), "added": ["actions:X"]})
# The author changed X's contract at the same version and recorded no breaking
# change. This is the exact shape of the historical bypass.
V2 = _graph(
    V2_REVISION,
    "binding-b",
    {**_empty_diff(V1_REVISION), "changed": ["actions:X"], "breaking": []},
)


@dataclass(frozen=True)
class Repo:
    root: Path

    def git(self, *args: str) -> str:
        completed = subprocess.run(  # noqa: S603 - fixed git executable, test-owned arguments
            ["git", *args],  # noqa: S607
            cwd=self.root,
            check=True,
            capture_output=True,
            text=True,
        )
        return completed.stdout.strip()

    def write_graph(self, graph: dict[str, Any]) -> None:
        text = json.dumps(graph, indent=2, sort_keys=True) + "\n"
        for mirror in MIRRORS:
            path = self.root / mirror
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")

    def write_ledger(self, deprecations: list[dict[str, Any]]) -> None:
        path = self.root / LEDGER_RELATIVE
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "schema_version": generator.CAPABILITY_GRAPH_EVOLUTION_SCHEMA_VERSION,
            "deprecations": deprecations,
        }
        path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")

    def commit(self, message: str) -> str:
        self.git("add", "-A")
        self.git("commit", "-q", "-m", message)
        return self.git("rev-parse", "HEAD")


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

    With no base ref configured and no CI marker, ``origin/main`` does not
    exist in this repo, so the generator warns and reads ``HEAD:``. That is
    the author's own v2 graph, the revisions match, and the gate returns the
    recorded ``breaking: []`` without ever comparing to main.
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
