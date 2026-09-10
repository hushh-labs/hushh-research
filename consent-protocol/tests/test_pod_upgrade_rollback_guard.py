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
    assert upgrade._image_sha("gcr.io/p/consent-protocol-pod:da1dfc5943bf") == "da1dfc5943bf"
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
