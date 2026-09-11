"""The rollback guard: a pod with tombstones never moves onto a pre-tombstone image.

An image built before memory schema 2 replays the same log and skips every
revoke and supersede record, so a rollback onto it resurrects what the owner
removed. ``pod_upgrade.py`` refuses (exit 2) when the pod REPORTS tombstones
and the target predates the tombstone-aware commit, unless the operator typed
the exact acknowledgement. The count comes from the pod's own memory status,
never from the registry row.
"""

from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
import yaml

_UPGRADE = Path(__file__).resolve().parents[1] / "scripts" / "ops" / "pod_upgrade.py"
_spec = importlib.util.spec_from_file_location("pod_upgrade_under_test", _UPGRADE)
upgrade = importlib.util.module_from_spec(_spec)
sys.modules["pod_upgrade_under_test"] = upgrade
_spec.loader.exec_module(upgrade)  # type: ignore[union-attr]


def _git_repo(tmp_path: Path) -> tuple[Path, str, str]:
    """A repo with two commits: ``older`` then ``newer``; returns (root, older, newer)."""

    def git(*args: str) -> str:
        return subprocess.check_output(["git", *args], cwd=tmp_path).decode().strip()  # noqa: S603 - synthetic fixture arguments

    git("init", "-q")
    git("config", "user.email", "synthetic@example.invalid")
    git("config", "user.name", "Synthetic Fixture")
    (tmp_path / "a.txt").write_text("one\n")
    git("add", "a.txt")
    git("commit", "-qm", "older")
    older = git("rev-parse", "HEAD")
    (tmp_path / "a.txt").write_text("two\n")
    git("add", "a.txt")
    git("commit", "-qm", "newer")
    newer = git("rev-parse", "HEAD")
    return tmp_path, older, newer


def test_the_floor_is_the_tombstone_commit_and_the_acknowledgement_is_a_sentence():
    assert len(upgrade.MEMORY_TOMBSTONE_MIN_IMAGE_COMMIT) == 40
    assert int(upgrade.MEMORY_TOMBSTONE_MIN_IMAGE_COMMIT, 16)
    assert "revoked facts may return" in upgrade.ROLLBACK_ACKNOWLEDGEMENT
    assert upgrade.EXIT_REFUSED == 2


def test_image_sha_is_read_from_dev_tags_and_bare_shas_only():
    assert upgrade._image_sha("gcr.io/p/consent-protocol-pod:dev-195de95d2") == "195de95d2"
    assert upgrade._image_sha("gcr.io/p/consent-protocol-pod:4d2777002395") == "4d2777002395"
    assert upgrade._image_sha("gcr.io/p/consent-protocol-pod:latest") is None
    assert upgrade._image_sha("gcr.io/p/consent-protocol-pod") is None


def test_an_image_before_the_floor_predates_and_one_after_does_not(tmp_path):
    root, older, newer = _git_repo(tmp_path)
    assert (
        upgrade.image_predates_tombstones(f"img:dev-{older[:9]}", min_commit=newer, repo_root=root)
        is True
    )
    assert (
        upgrade.image_predates_tombstones(f"img:dev-{newer[:9]}", min_commit=newer, repo_root=root)
        is False
    )
    assert (
        upgrade.image_predates_tombstones(f"img:dev-{newer[:9]}", min_commit=older, repo_root=root)
        is False
    ), "a descendant of the floor never predates it"
    # Unknown stays unknown: a tag with no commit, or a commit git has never seen.
    assert upgrade.image_predates_tombstones("img:latest", min_commit=newer, repo_root=root) is None
    assert (
        upgrade.image_predates_tombstones("img:dev-abcdef123", min_commit=newer, repo_root=root)
        is None
    )


@pytest.mark.parametrize(
    "tombstones, predates, acknowledgement, refused",
    [
        (3, True, None, True),
        (None, True, None, True),  # an unknown count is not permission
        (3, None, None, True),  # an unplaceable image is not permission
        (0, True, None, False),  # nothing to lose
        (3, False, None, False),  # the target honours tombstones
        (3, True, upgrade.ROLLBACK_ACKNOWLEDGEMENT, False),
        (3, True, "yes", True),  # a paraphrase is not the acknowledgement
        (3, True, upgrade.ROLLBACK_ACKNOWLEDGEMENT.lower(), True),
    ],
)
def test_the_refusal_matrix(tombstones, predates, acknowledgement, refused):
    sentence = upgrade.rollback_refusal(
        tombstones=tombstones, predates=predates, acknowledgement=acknowledgement
    )
    assert (sentence is not None) is refused
    if sentence:
        assert "resurrect revoked facts" in sentence
        assert "--acknowledge-tombstone-rollback" in sentence


async def test_the_count_comes_from_the_pod_not_the_registry():
    row = {"hushh_id": "ha1x", "memory_tombstones": 99}  # a registry field must be ignored

    async def _pod_says(_row):
        return {"schema": 2, "tombstones": 2}

    assert await upgrade.pod_tombstone_count(row, reader=_pod_says) == 2

    async def _pod_down(_row):
        raise RuntimeError("HTTP 503")

    assert await upgrade.pod_tombstone_count(row, reader=_pod_down) is None

    async def _malformed(_row):
        return {"tombstones": "two"}

    assert await upgrade.pod_tombstone_count(row, reader=_malformed) is None


async def test_main_refuses_with_exit_two_and_never_calls_upgrade_pod(monkeypatch, tmp_path):
    root, older, newer = _git_repo(tmp_path)
    monkeypatch.setattr(upgrade, "MEMORY_TOMBSTONE_MIN_IMAGE_COMMIT", newer)
    monkeypatch.setattr(upgrade, "ROOT", root)
    moved: list[str] = []

    class Registry:
        async def get(self, user_id):
            return {"user_id": user_id, "hushh_id": "ha1x", "status": "provisioned"}

    class Service:
        def __init__(self, **_kw):
            pass

        async def list_upgrade_candidates(self, **_kw):
            return []

        async def upgrade_pod(self, *, user_id, current_image):
            moved.append(user_id)
            return {"upgraded": True, "hushhId": "ha1x", "image": current_image}

    async def _pod_reports_two(_row):
        return {"tombstones": 2}

    monkeypatch.setattr(upgrade, "_read_pod_memory_status", _pod_reports_two)
    import hushh_mcp.services.compute_backend as compute_backend
    import hushh_mcp.services.personal_agent_provisioning_service as provisioning
    import hushh_mcp.services.personal_agent_registry_repo as registry_repo

    monkeypatch.setattr(compute_backend, "resolve_compute_backend", lambda: object())
    monkeypatch.setattr(provisioning, "PersonalAgentProvisioningService", Service)
    monkeypatch.setattr(provisioning, "running_image", lambda row: "img:dev-old")
    monkeypatch.setattr(registry_repo, "PersonalAgentRegistryRepo", Registry)

    args = SimpleNamespace(
        image=f"img:dev-{older[:9]}",
        user_id="uid-1",
        limit=3,
        list=False,
        dry_run=False,
        json=False,
        acknowledge_tombstone_rollback=None,
    )
    assert await upgrade._main(args) == 2
    assert moved == []

    args.acknowledge_tombstone_rollback = upgrade.ROLLBACK_ACKNOWLEDGEMENT
    assert await upgrade._main(args) == 0
    assert moved == ["uid-1"]

    # Moving FORWARD onto the floor or later never consults the pod at all.
    async def _never(_row):
        raise AssertionError("a forward move must not read the pod")

    monkeypatch.setattr(upgrade, "_read_pod_memory_status", _never)
    args.acknowledge_tombstone_rollback = None
    args.image = f"img:dev-{newer[:9]}"
    assert await upgrade._main(args) == 0
    assert moved == ["uid-1", "uid-1"]


# -- the pin itself, and the history the gate has to hand it -------------------------
#
# Everything above runs against synthetic repositories, which is what let the pin rot
# unseen: it was written on a temporary worktree branch, cherry-picked here, and the
# original branch deleted, so the sha it named survived in no ref. git then answers
# "not an ancestor" for every target, ``image_predates_tombstones`` reports "predates"
# every time, and the guard refuses even a forward roll. A guard that always fires
# teaches the operator to type the override, which is the one outcome it exists to
# prevent. So the pin is checked against THIS repository's real history.
#
# That check needs history, and there is no history-free formulation of it. Measured
# in a real ``git clone --depth 1`` of this repository: the pin's commit object is
# absent, so ``git merge-base --is-ancestor`` and ``git show <pin>:<path>`` both exit
# 128. Asking a different question does not help, because every question about a
# commit needs the commit. A depth-1 checkout therefore turns each assertion below
# into a skip, and a rewritten pin lands green.
#
# So the lane is part of the fix: the job that runs this suite checks the repository
# out at ``fetch-depth: 0``, and the first test here asserts that it still does. That
# one test reads only the workflow file, which is present at any clone depth, so it
# stays awake in exactly the shallow checkout where the others fall asleep.

_CI_WORKFLOW = Path(__file__).resolve().parents[2] / ".github" / "workflows" / "ci.yml"


def _jobs_running_the_protocol_suite(workflow_path: Path) -> dict[str, dict]:
    """Every job in ``workflow_path`` whose steps run the Python suite."""
    workflow = yaml.safe_load(workflow_path.read_text(encoding="utf-8")) or {}
    jobs = workflow.get("jobs") or {}
    return {
        name: job
        for name, job in jobs.items()
        if any(
            "orchestrate.sh protocol" in str(step.get("run") or "")
            for step in (job.get("steps") or [])
        )
    }


def test_the_pull_request_lane_gives_the_pin_check_the_history_it_needs():
    """The guard on the guard: a shallow checkout must not be able to silence this file.

    ``.github/workflows/ci.yml`` is the lane every pull request into ``main`` has to
    pass, and it is where this suite actually gates a merge. ``actions/checkout``
    defaults to depth 1; at that depth the pin's commit object is not in the clone and
    every history-backed assertion below skips rather than fails. This test needs no
    history of its own, so removing ``fetch-depth: 0`` goes red here instead of going
    quiet everywhere else.
    """
    assert _CI_WORKFLOW.exists(), f"{_CI_WORKFLOW} is missing; this guard is aimed at nothing"
    jobs = _jobs_running_the_protocol_suite(_CI_WORKFLOW)
    assert jobs, (
        "no job in ci.yml runs `orchestrate.sh protocol` any more. Either the Python "
        "suite stopped gating pull requests, or it moved; point this test at the lane "
        "that runs it, because a guard aimed at nothing is a guard that is off."
    )
    for name, job in jobs.items():
        checkouts = [
            step
            for step in (job.get("steps") or [])
            if str(step.get("uses") or "").startswith("actions/checkout@")
        ]
        assert checkouts, f"ci.yml job {name} runs the Python suite without a checkout step"
        for step in checkouts:
            depth = (step.get("with") or {}).get("fetch-depth")
            assert depth == 0, (
                f"ci.yml job {name} checks the repository out at fetch-depth {depth!r}. "
                "actions/checkout defaults to depth 1, and in a depth-1 clone of this "
                "repository the tombstone pin's commit object is absent: git exits 128, "
                "every pin assertion in this file pytest.skips, and a rewritten "
                "MEMORY_TOMBSTONE_MIN_IMAGE_COMMIT lands green in the lane that gates "
                "merges. Set `fetch-depth: 0` on this checkout."
            )


def _orphan_commit(repo_root: Path) -> str:
    """A commit that exists in the object store but is reachable from no ref."""

    def git(*args: str) -> str:
        return subprocess.check_output(["git", *args], cwd=repo_root).decode().strip()  # noqa: S603 - synthetic fixture arguments

    on = git("rev-parse", "--abbrev-ref", "HEAD")
    git("checkout", "-q", "-b", "throwaway")
    (repo_root / "orphan.txt").write_text("gone\n")
    git("add", "orphan.txt")
    git("commit", "-qm", "on a branch that will not survive")
    sha = git("rev-parse", "HEAD")
    git("checkout", "-q", on)
    git("branch", "-q", "-D", "throwaway")
    return sha


def _reachable_from_head(sha: str, *, repo_root: Path) -> tuple[bool | None, str]:
    """Is ``sha`` an ancestor of HEAD in ``repo_root``?

    ``(True, "")`` yes. ``(False, why)`` git answered and the commit is not on this
    branch, which is exactly what a rewritten or never-landed pin looks like.
    ``(None, why)`` the checkout cannot answer at all (no git, no work tree, a shallow
    clone whose history is truncated). Unknown is reported as unknown so the caller can
    skip; it is never reported as reachable.
    """

    def run(*args: str) -> subprocess.CompletedProcess[str] | None:
        try:
            return subprocess.run(  # noqa: S603 - fixed argv, sha is test-supplied
                ["git", *args],
                cwd=repo_root,
                capture_output=True,
                text=True,
                timeout=20,
                check=False,
            )
        except (OSError, subprocess.SubprocessError):
            return None

    work_tree = run("rev-parse", "--is-inside-work-tree")
    if work_tree is None:
        return None, "git is not runnable here"
    if work_tree.returncode != 0:
        return None, f"{repo_root} is not a git work tree"

    probe = run("merge-base", "--is-ancestor", sha, "HEAD")
    if probe is None:
        return None, "git is not runnable here"
    if probe.returncode == 0:
        return True, ""
    if probe.returncode == 1:
        return False, (
            f"commit {sha[:12]} is in this object store but is not an ancestor of HEAD; "
            "a cherry-picked or rebased pin looks exactly like this"
        )

    # Absent object. In a shallow clone that proves nothing, so ask before judging.
    shallow = run("rev-parse", "--is-shallow-repository")
    if shallow is not None and shallow.stdout.strip() == "true":
        return None, "shallow clone: history is truncated, so an absent commit proves nothing"
    if probe.returncode == 128:
        return False, f"there is no commit {sha[:12]} in this repository at all"
    return None, f"git exited {probe.returncode}: {probe.stderr.strip()[:200]}"


def _rev_parse(rev: str) -> str | None:
    """The full sha ``rev`` names in this checkout, or None when it cannot be resolved."""
    try:
        done = subprocess.run(  # noqa: S603 - fixed argv, rev is a module constant
            ["git", "rev-parse", "--verify", "--quiet", f"{rev}^{{commit}}"],
            cwd=upgrade.ROOT,
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    resolved = done.stdout.strip()
    return resolved if done.returncode == 0 and len(resolved) == 40 else None


def test_the_tombstone_pin_is_a_commit_this_branch_can_actually_reach():
    verdict, why = _reachable_from_head(
        upgrade.MEMORY_TOMBSTONE_MIN_IMAGE_COMMIT, repo_root=upgrade.ROOT
    )
    if verdict is None:
        pytest.skip(f"cannot place MEMORY_TOMBSTONE_MIN_IMAGE_COMMIT here: {why}")
    assert verdict is True, (
        f"MEMORY_TOMBSTONE_MIN_IMAGE_COMMIT is unreachable: {why}. "
        "image_predates_tombstones() then answers 'predates' for every target, so the "
        "rollback guard refuses forward upgrades too and the operator is trained to type "
        "--acknowledge-tombstone-rollback. Re-pin it to the commit that introduced "
        "tombstone-aware hydration on this branch."
    )


def test_a_forward_roll_onto_this_checkouts_own_head_is_never_refused():
    """The operator-facing symptom, driven through the real constant and real history.

    A rotten pin does not merely fail an abstract reachability assertion: git answers
    "not an ancestor" for every target, so an image built from THIS checkout's own HEAD
    reads as predating tombstones and the guard refuses a roll that moves strictly
    forward. That refusal is the whole defect, so it is asserted directly.
    """
    head = _rev_parse("HEAD")
    if head is None:
        pytest.skip("this checkout cannot resolve its own HEAD")
    forward = upgrade.image_predates_tombstones(f"img:dev-{head[:12]}")
    if forward is None:
        pytest.skip("this checkout cannot place its own HEAD against the pin")
    assert forward is False, (
        f"an image built from HEAD ({head[:12]}) reads as predating tombstones, so the "
        "guard refuses a roll that moves strictly forward. That is what an unreachable "
        "MEMORY_TOMBSTONE_MIN_IMAGE_COMMIT does to every target."
    )
    assert upgrade.rollback_refusal(tombstones=7, predates=forward, acknowledgement=None) is None, (
        "a forward roll must never need --acknowledge-tombstone-rollback"
    )

    # The floor still holds in the other direction: its own parent is a real rollback.
    parent = _rev_parse(f"{upgrade.MEMORY_TOMBSTONE_MIN_IMAGE_COMMIT}^")
    if parent is None:
        pytest.skip("this checkout cannot resolve the pin's parent")
    backward = upgrade.image_predates_tombstones(f"img:dev-{parent[:12]}")
    assert backward is True, f"{parent[:12]} is the pin's parent and must read as predating"
    refusal = upgrade.rollback_refusal(tombstones=7, predates=backward, acknowledgement=None)
    assert refusal is not None and "resurrect revoked facts" in refusal


def test_the_tombstone_pin_still_names_the_commit_that_introduced_tombstones():
    """Reachable is not enough: re-pinning to HEAD would also be reachable, and wrong.

    The floor is the FIRST image that applies tombstones, so the memory service must
    know the word at the pin and not at its parent. Both trees are read at fixed
    historical commits, so a later rename cannot make this lie.

    Reachability is re-asserted here rather than assumed: ``git show`` happily reads a
    commit that no branch can reach, so without this the content checks below would
    pass on an orphaned pin whose tree is byte-identical to the right one, which is
    precisely the shape the rot took.
    """
    service = "consent-protocol/hushh_mcp/services/pod_memory_service.py"
    pin = upgrade.MEMORY_TOMBSTONE_MIN_IMAGE_COMMIT

    verdict, why = _reachable_from_head(pin, repo_root=upgrade.ROOT)
    if verdict is None:
        pytest.skip(f"cannot place {pin[:12]} in this checkout: {why}")
    assert verdict is True, (
        f"{pin[:12]} is not on this branch ({why}), so the content assertions below "
        "would be reading an orphaned object rather than the floor this branch ships."
    )

    def tree_at(rev: str) -> str | None:
        try:
            done = subprocess.run(  # noqa: S603 - fixed argv, rev is a module constant
                ["git", "show", f"{rev}:{service}"],
                cwd=upgrade.ROOT,
                capture_output=True,
                text=True,
                timeout=20,
                check=False,
            )
        except (OSError, subprocess.SubprocessError):
            return None
        return done.stdout if done.returncode == 0 else None

    at_pin = tree_at(pin)
    at_parent = tree_at(f"{pin}^")
    if at_pin is None or at_parent is None:
        pytest.skip(f"cannot read {service} at {pin[:12]} and its parent in this checkout")
    assert "tombstone" in at_pin, f"{pin[:12]} does not apply tombstones; it is not the floor"
    assert "tombstone" not in at_parent, (
        f"{pin[:12]} is not the FIRST tombstone-aware commit: its parent already has them. "
        "The floor must be the earliest image that honours a revocation, otherwise the "
        "guard refuses rollbacks that are in fact safe."
    )


# -- controls on the reachability helper itself --------------------------------------
#
# These two exercise ``_reachable_from_head`` against synthetic repositories. They are
# negative controls for the helper, not regression tests for the pin: they never read
# MEMORY_TOMBSTONE_MIN_IMAGE_COMMIT, so they pass whatever its value is. Their job is
# to prove the helper reports each rotten shape as not-True, which is what makes the
# pin assertions above trustworthy.


def test_the_reachability_check_fails_a_rewritten_pin_instead_of_passing(tmp_path):
    """Control: every shape a rotten pin takes must come back not-True."""
    src = tmp_path / "src"
    src.mkdir()
    root, _older, newer = _git_repo(src)

    assert _reachable_from_head(newer, repo_root=root) == (True, "")

    # Shape 1: the object survived the deleted branch, reachable from no ref. This is
    # what da1dfc594 was, and why the rot was invisible on a developer's own machine.
    verdict, why = _reachable_from_head(_orphan_commit(root), repo_root=root)
    assert verdict is False, why
    assert "not an ancestor of HEAD" in why

    # Shape 2: a fresh clone never fetched the rewritten object, so it is simply gone.
    verdict, why = _reachable_from_head("0" * 39 + "1", repo_root=root)
    assert verdict is False, why
    assert "no commit" in why

    # A detached HEAD, which is how every CI lane checks a sha out, still answers.
    subprocess.check_call(  # noqa: S603 - synthetic fixture arguments
        ["git", "checkout", "-q", "--detach"], cwd=root
    )
    assert _reachable_from_head(newer, repo_root=root) == (True, "")


def test_a_truncated_clone_skips_the_pin_check_rather_than_passing_it(tmp_path):
    """Control: an absent commit in a shallow clone is unknown, not proof the pin is fine."""
    src = tmp_path / "src"
    src.mkdir()
    root, older, _newer = _git_repo(src)
    shallow = tmp_path / "shallow"
    clone = subprocess.run(  # noqa: S603 - synthetic fixture arguments
        ["git", "clone", "-q", "--depth", "1", f"file://{root}", str(shallow)],
        capture_output=True,
        text=True,
        check=False,
    )
    if clone.returncode != 0:
        pytest.skip(f"shallow clone unavailable here: {clone.stderr.strip()[:200]}")

    verdict, why = _reachable_from_head(older, repo_root=shallow)
    assert verdict is None, f"a truncated history must be unknown, not a verdict: {why}"
    assert "shallow" in why


# -- an unplaceable image refuses, and says why --------------------------------------
#
# Nothing outside this script calls rollback_refusal() or image_predates_tombstones():
# no route, worker or service imports pod_upgrade, so the only caller is an operator at
# a terminal. The script does ship inside the deployed image though (Dockerfile COPY . .
# keeps scripts/, .dockerignore drops .git), and there the guard can place no image at
# all and refuses every roll. The refusal stays -- unknown placement is not permission --
# but it names its cause so the operator is not left guessing at a forward roll.


def test_an_environment_without_history_refuses_and_names_the_reason(tmp_path):
    not_a_repo = tmp_path / "container"
    not_a_repo.mkdir()

    assert upgrade.image_predates_tombstones("img:dev-4d2777002395", repo_root=not_a_repo) is None
    why = upgrade.placement_diagnostic("img:dev-4d2777002395", repo_root=not_a_repo)
    assert "not a git work tree" in why
    assert ".git" in why

    # Refusal is unchanged: unknown placement still stops the roll.
    refusal = upgrade.rollback_refusal(tombstones=4, predates=None, acknowledgement=None)
    assert refusal is not None
    assert "cannot be placed relative to" in refusal


async def test_main_prints_why_an_unplaceable_target_was_refused(monkeypatch, tmp_path, capsys):
    """The refusal an operator actually sees says what could not be placed, and why."""
    root, _older, newer = _git_repo(tmp_path)
    monkeypatch.setattr(upgrade, "MEMORY_TOMBSTONE_MIN_IMAGE_COMMIT", newer)
    monkeypatch.setattr(upgrade, "ROOT", root)
    moved: list[str] = []

    class Registry:
        async def get(self, user_id):
            return {"user_id": user_id, "hushh_id": "ha1x", "status": "provisioned"}

    class Service:
        def __init__(self, **_kw):
            pass

        async def list_upgrade_candidates(self, **_kw):
            return []

        async def upgrade_pod(self, *, user_id, current_image):
            moved.append(user_id)
            return {"upgraded": True, "hushhId": "ha1x", "image": current_image}

    async def _pod_reports_two(_row):
        return {"tombstones": 2}

    monkeypatch.setattr(upgrade, "_read_pod_memory_status", _pod_reports_two)
    import hushh_mcp.services.compute_backend as compute_backend
    import hushh_mcp.services.personal_agent_provisioning_service as provisioning
    import hushh_mcp.services.personal_agent_registry_repo as registry_repo

    monkeypatch.setattr(compute_backend, "resolve_compute_backend", lambda: object())
    monkeypatch.setattr(provisioning, "PersonalAgentProvisioningService", Service)
    monkeypatch.setattr(provisioning, "running_image", lambda row: "img:dev-old")
    monkeypatch.setattr(registry_repo, "PersonalAgentRegistryRepo", Registry)

    args = SimpleNamespace(
        image="gcr.io/p/consent-protocol-pod:latest",
        user_id="uid-1",
        limit=3,
        list=False,
        dry_run=False,
        json=False,
        acknowledge_tombstone_rollback=None,
    )
    assert await upgrade._main(args) == upgrade.EXIT_REFUSED
    assert moved == []
    printed = capsys.readouterr().out
    assert "unplaceable target" in printed
    assert "names no commit" in printed


def test_a_tagless_target_is_named_as_unorderable_rather_than_as_old(tmp_path):
    root, _older, _newer = _git_repo(tmp_path)
    why = upgrade.placement_diagnostic("gcr.io/p/consent-protocol-pod:latest", repo_root=root)
    assert "names no commit" in why
    assert "consent-protocol-pod:latest" in why


def test_a_shallow_checkout_is_named_as_truncated_rather_than_as_broken(tmp_path):
    src = tmp_path / "src"
    src.mkdir()
    root, _older, newer = _git_repo(src)
    shallow = tmp_path / "shallow"
    clone = subprocess.run(  # noqa: S603 - synthetic fixture arguments
        ["git", "clone", "-q", "--depth", "1", f"file://{root}", str(shallow)],
        capture_output=True,
        text=True,
        check=False,
    )
    if clone.returncode != 0:
        pytest.skip(f"shallow clone unavailable here: {clone.stderr.strip()[:200]}")

    why = upgrade.placement_diagnostic(f"img:dev-{newer[:12]}", repo_root=shallow)
    assert "shallow clone" in why
