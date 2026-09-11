"""The merge guard must actually run and must actually refuse.

`test_pod_architecture_is_authoritative.py` names what the pod architecture is.
It went red on 2026-09-11 and it was right, but it was red AFTER a merge commit
already existed and only once somebody ran the full suite. The loss is free to
undo for exactly as long as the merge has not landed, so the guard is also
wired into `.githooks/pre-merge-commit` through
`scripts/git/check-pod-architecture-survives-merge.sh`.

A hook that exists and never fires is the defect this repository has already
paid for twice, so these tests run the real script rather than reading it.

Two properties are load-bearing and both were wrong in a first attempt:

*   **It must not gate on `MERGE_HEAD`.** Measured on git 2.50.1: during
    `pre-merge-commit` for a CLEAN merge, `MERGE_HEAD` does not exist. A guard
    that checks for it exits silently in precisely the case that matters, since
    a clean merge is how the architecture was lost. The hook passes
    `--in-merge`; the hook running at all is the signal.
*   **It must refuse, not warn.** The sibling merge-regression check is
    advisory because it is a heuristic with false positives. This one counts
    tokens that `main` does not contain at all, so there is no false positive
    available and no reason to let the commit through.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[2]
_SCRIPT = _REPO / "scripts/git/check-pod-architecture-survives-merge.sh"
_HOOK = _REPO / ".githooks/pre-merge-commit"
_CLOUDBUILD = "deploy/backend.cloudbuild.yaml"


def test_the_guard_script_and_its_hook_are_both_present_and_executable() -> None:
    assert _SCRIPT.is_file(), "the merge guard script is gone; the hook then silently no-ops"
    assert os.access(_SCRIPT, os.X_OK), "the guard is not executable, so the hook cannot run it"
    hook = _HOOK.read_text(encoding="utf-8")
    assert "check-pod-architecture-survives-merge.sh" in hook, (
        "pre-merge-commit no longer calls the guard, so a merge can delete the pod "
        "architecture again with nothing in the way"
    )
    assert "--in-merge" in hook, (
        "the hook must tell the guard a merge is underway; without it the guard "
        "falls back to looking for MERGE_HEAD, which a clean merge does not create"
    )


def test_the_guard_does_not_depend_on_merge_head_when_the_hook_calls_it() -> None:
    """The exact bug that made the first version of this guard inert."""
    body = _SCRIPT.read_text(encoding="utf-8")
    gate = body.split("MERGE_HEAD_PATH=", 1)
    assert len(gate) == 2, "the standalone MERGE_HEAD self-detection is gone entirely"
    before = gate[0]
    assert '"${1:-}" != "--in-merge"' in before, (
        "the MERGE_HEAD lookup must sit behind the --in-merge check; unguarded, it "
        "returns early during every clean merge and the guard never runs"
    )


def _run_guard(tree: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(  # noqa: S603 - fixed argv, repository-owned script
        ["bash", str(tree / "scripts/git/check-pod-architecture-survives-merge.sh"), "--in-merge"],
        cwd=tree,
        capture_output=True,
        text=True,
        timeout=300,
    )


@pytest.fixture
def tree(tmp_path: Path) -> Path:
    """A minimal repository carrying only what the guard reads."""
    root = tmp_path / "repo"
    (root / "scripts/git").mkdir(parents=True)
    (root / "deploy").mkdir(parents=True)
    (root / "consent-protocol/tests").mkdir(parents=True)
    shutil.copy2(_SCRIPT, root / "scripts/git" / _SCRIPT.name)
    shutil.copy2(
        _REPO / "consent-protocol/tests/test_pod_architecture_is_authoritative.py",
        root / "consent-protocol/tests/test_pod_architecture_is_authoritative.py",
    )
    for rel in (
        _CLOUDBUILD,
        "consent-protocol/Dockerfile.pod",
    ):
        target = root / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(_REPO / rel, target)
    subprocess.run(["git", "init", "-q"], cwd=root, check=True)  # noqa: S603, S607
    return root


def test_the_guard_refuses_a_tree_whose_pod_image_build_was_deleted(tree: Path) -> None:
    """The 2026-09-11 shape: `main`'s side of one file, taken cleanly."""
    build = tree / _CLOUDBUILD
    assert "_BUILD_POD_IMAGE" in build.read_text(encoding="utf-8")
    build.write_text(
        build.read_text(encoding="utf-8")
        .replace("_BUILD_POD_IMAGE", "_GONE")
        .replace("Dockerfile.pod", "Dockerfile.absent"),
        encoding="utf-8",
    )

    result = _run_guard(tree)

    assert result.returncode != 0, "the guard allowed a merge that deleted the pod image build"
    assert "ARCHITECTURAL REGRESSION" in result.stderr
    # It has to say something actionable, or a refusal with no reason is a
    # refusal somebody overrides. The named markers are the good case; when the
    # nested run cannot produce them, which happens under an outer pytest, the
    # script must fall back to the raw tail rather than print the banner alone.
    assert (
        "the per-user pod image is built" in result.stderr or "Raw tail follows" in result.stderr
    ), result.stderr


def test_the_guard_allows_this_repository_as_it_stands() -> None:
    """A guard that refuses everything is the same as no guard.

    Run against the real tree rather than a fixture, because that asserts two
    things at once: the guard passes a healthy tree, and THIS tree is healthy.
    A fixture carrying only some of the files the guard reads would fail for
    the wrong reason, which is how the first version of this test was wrong.
    """
    result = _run_guard(_REPO)

    assert result.returncode == 0, (
        "the guard refuses the current tree, so either the pod architecture is "
        f"missing right now or the guard is over-firing:\n{result.stderr}"
    )
