# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
"""Contract tests for the 4-dimension Release Train & Environment Parity Matrix."""

from __future__ import annotations

import datetime as dt
import importlib.util
import subprocess
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = REPO_ROOT / "scripts" / "ops" / "release_train_parity.py"


def _load_module() -> Any:
    spec = importlib.util.spec_from_file_location("release_train_parity", MODULE_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _git(repo: Path, *args: str) -> str:
    proc = subprocess.run(  # noqa: S603 - isolated temp repo test fixture
        ["git", "-C", str(repo), *args],
        text=True,
        capture_output=True,
        check=True,
    )
    return proc.stdout.strip()


def _init_three_lane_repo(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "-b", "main")
    _git(repo, "config", "user.email", "test@hushh.ai")
    _git(repo, "config", "user.name", "Test")

    mig_dir = repo / "consent-protocol" / "db" / "migrations"
    mig_dir.mkdir(parents=True)
    (mig_dir / "448_base.sql").write_text("SELECT 1;\n", encoding="utf-8")
    deploy_dir = repo / "deploy"
    deploy_dir.mkdir(parents=True)
    (deploy_dir / "pod-release.json").write_text(
        '{"version": "2026.11-dev.39"}\n', encoding="utf-8"
    )
    _git(repo, "add", ".")
    _git(repo, "commit", "-m", "chore: base")
    _git(repo, "branch", "uat")
    _git(repo, "branch", "dev")
    return repo


def test_clean_ancestry_and_next_calendar_train(tmp_path: Path) -> None:
    mod = _load_module()
    repo = _init_three_lane_repo(tmp_path)
    _git(repo, "checkout", "dev")
    (repo / "consent-protocol" / "db" / "migrations" / "449_dev_feature.sql").write_text(
        "SELECT 2;\n", encoding="utf-8"
    )
    _git(repo, "add", ".")
    _git(repo, "commit", "-m", "feat: dev forward change")

    report = mod.build_parity_report(
        repo,
        dev_ref="dev",
        uat_ref="uat",
        main_ref="main",
        require_clean_upstream=True,
        now_utc=dt.datetime(2026, 11, 24, tzinfo=dt.timezone.utc),
    )
    assert report["status"] == "ready"
    assert report["blockers"] == []
    assert report["code_parity"]["uat_ahead_of_dev"]["count"] == 0
    assert report["code_parity"]["dev_ahead_of_uat"]["count"] == 1
    assert report["schema_parity"]["collision_count"] == 0
    assert report["calendar_trains"]["recommended_next_train"] == "2026.11.40"
    assert report["calendar_trains"]["recommended_tag"] == "train/2026.11.40"


def test_blocks_on_unsynced_uat_commits_and_migration_collision(tmp_path: Path) -> None:
    mod = _load_module()
    repo = _init_three_lane_repo(tmp_path)

    _git(repo, "checkout", "uat")
    (repo / "consent-protocol" / "db" / "migrations" / "459_feed_realtime.sql").write_text(
        "SELECT 'uat';\n", encoding="utf-8"
    )
    _git(repo, "add", ".")
    _git(repo, "commit", "-m", "feat(uat): feed realtime")

    _git(repo, "checkout", "dev")
    (repo / "consent-protocol" / "db" / "migrations" / "459_kyc_redaction.sql").write_text(
        "SELECT 'dev';\n", encoding="utf-8"
    )
    _git(repo, "add", ".")
    _git(repo, "commit", "-m", "feat(dev): kyc redaction")

    report = mod.build_parity_report(
        repo,
        dev_ref="dev",
        uat_ref="uat",
        main_ref="main",
        require_clean_upstream=True,
    )
    assert report["status"] == "blocked"
    assert report["schema_parity"]["collision_count"] == 1
    assert report["schema_parity"]["collisions"][0]["seq"] == 459
    assert report["code_parity"]["uat_ahead_of_dev"]["count"] == 1
    assert any("Migration sequence collision at 459" in item for item in report["blockers"])
    assert any("Upstream UAT has 1 commit(s)" in item for item in report["blockers"])


def test_live_cloud_flags_fail_closed_if_dev_simulation_leaks_to_uat(tmp_path: Path) -> None:
    mod = _load_module()
    repo = _init_three_lane_repo(tmp_path)

    def _fake_fetcher(project: str, _region: str, service: str) -> dict[str, Any] | None:
        if service == "sandbox-edge-gateway":
            return (
                {"status": {"latestReadyRevisionName": "edge-001"}}
                if project != "hushh-pda"
                else None
            )
        env = [{"name": "HUSSH_AGENT_SANDBOX_CUTOVER_ENABLED", "value": "1"}]
        if project == "hushh-pda-uat":
            env.append({"name": "HUSHH_DEV_SIMULATION_ENABLED", "value": "true"})
        return {
            "status": {"latestReadyRevisionName": f"{service}-rev"},
            "spec": {
                "template": {"metadata": {"labels": {}}, "spec": {"containers": [{"env": env}]}}
            },
        }

    report = mod.build_parity_report(
        repo,
        dev_ref="dev",
        uat_ref="uat",
        main_ref="main",
        include_live_cloud=True,
        live_cloud_fetcher=_fake_fetcher,
    )
    assert report["status"] == "blocked"
    assert any(
        "HUSHH_DEV_SIMULATION_ENABLED must never be active on uat" in b for b in report["blockers"]
    )
