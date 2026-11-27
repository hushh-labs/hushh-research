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


def test_live_cloud_closure_verifies_ed25519_verification_keys_and_prod_shared(
    tmp_path: Path,
) -> None:
    mod = _load_module()
    repo = _init_three_lane_repo(tmp_path)

    def _complete_sandbox_env(lane: str) -> list[dict[str, Any]]:
        env: list[dict[str, Any]] = [
            {"name": "HUSSH_AGENT_SANDBOX_CUTOVER_ENABLED", "value": "1"},
            {
                "name": "HUSSH_SANDBOX_EDGE_PUBLIC_URL",
                "value": f"https://edge-{lane}.example.run.app",
            },
            {"name": "PERSONAL_AGENT_ENABLED", "value": "true"},
            {"name": "HUSSH_TRUSTED_DEVICE_ENABLED", "value": "true"},
            {"name": "CONSENT_TOKEN_SIGNING_ALG", "value": "ed25519"},
            {"name": "CONSENT_ED25519_KID", "value": f"hushh-consent-{lane}-1"},
            {"name": "CONSENT_ED25519_PRIVATE_KEY", "valueFrom": {"secretKeyRef": {"name": "s"}}},
            {"name": "CONSENT_ED25519_PUBLIC_KEYS", "valueFrom": {"secretKeyRef": {"name": "s"}}},
            {"name": "OWNER_FEED_SIGNING_ALG", "value": "ed25519"},
            {"name": "OWNER_FEED_ED25519_KID", "value": f"hushh-owner-feed-{lane}-1"},
            {
                "name": "OWNER_FEED_ED25519_PRIVATE_KEY",
                "valueFrom": {"secretKeyRef": {"name": "s"}},
            },
            {
                "name": "OWNER_FEED_ED25519_PUBLIC_KEYS",
                "valueFrom": {"secretKeyRef": {"name": "s"}},
            },
            {"name": "HUSSH_CUSTODY_BROKER_SEAL_KEY", "valueFrom": {"secretKeyRef": {"name": "s"}}},
            {
                "name": "HUSSH_SANDBOX_IDENTITY_MASTER_KEY",
                "valueFrom": {"secretKeyRef": {"name": "s"}},
            },
        ]
        if lane == "uat":
            env.append({"name": "POD_HUB_IDENTITY_AUTH_ENABLED", "value": "true"})
        return env

    def _healthy_fetcher(project: str, _region: str, service: str) -> dict[str, Any] | None:
        lane = {"hushh-pda-dev": "dev", "hushh-pda-uat": "uat", "hushh-pda": "production"}[project]
        if service == "sandbox-edge-gateway":
            if lane == "production":
                return None
            return {
                "status": {
                    "latestReadyRevisionName": f"edge-{lane}-001",
                    "url": f"https://edge-{lane}.example.run.app",
                },
                "spec": {
                    "template": {
                        "spec": {
                            "containers": [
                                {
                                    "env": [
                                        {"name": "CONSENT_ED25519_PUBLIC_KEYS"},
                                        {"name": "OWNER_FEED_ED25519_PUBLIC_KEYS"},
                                    ]
                                }
                            ]
                        }
                    }
                },
            }
        env = _complete_sandbox_env(lane) if lane in ("dev", "uat") else []
        return {
            "status": {
                "latestReadyRevisionName": f"{service}-{lane}-rev",
                "url": f"https://{service}-{lane}.example.run.app",
            },
            "spec": {
                "template": {"metadata": {"labels": {}}, "spec": {"containers": [{"env": env}]}}
            },
        }

    def _healthy_prober(url: str) -> tuple[int, dict[str, Any]]:
        if url.endswith("/verification-keys"):
            lane = "uat" if "-uat." in url else "dev"
            return 200, {"keys": {f"hushh-consent-{lane}-1": "pubkey"}}
        return 200, {"status": "ok"}

    ok_report = mod.build_parity_report(
        repo,
        dev_ref="dev",
        uat_ref="uat",
        main_ref="main",
        include_live_cloud=True,
        live_cloud_fetcher=_healthy_fetcher,
        live_http_prober=_healthy_prober,
    )
    assert ok_report["status"] == "ready", ok_report["blockers"]

    def _broken_vk_prober(url: str) -> tuple[int, dict[str, Any]]:
        if "consent-protocol-uat" in url and url.endswith("/verification-keys"):
            return 503, {}
        return _healthy_prober(url)

    broken_report = mod.build_parity_report(
        repo,
        dev_ref="dev",
        uat_ref="uat",
        main_ref="main",
        include_live_cloud=True,
        live_cloud_fetcher=_healthy_fetcher,
        live_http_prober=_broken_vk_prober,
    )
    assert broken_report["status"] == "blocked"
    assert any("verification-keys endpoint returned 503" in b for b in broken_report["blockers"])


def test_blocks_on_asymmetric_ours_backsync_merge(tmp_path: Path) -> None:
    mod = _load_module()
    repo = _init_three_lane_repo(tmp_path)

    _git(repo, "checkout", "uat")
    svc_dir = repo / "consent-protocol" / "hushh_mcp" / "services"
    svc_dir.mkdir(parents=True, exist_ok=True)
    (svc_dir / "uat_only_fix.py").write_text("UAT_SAFEGUARD = True\n", encoding="utf-8")
    _git(repo, "add", ".")
    _git(repo, "commit", "-m", "fix(connect): uat deleted account safeguard")

    _git(repo, "checkout", "dev")
    svc_dir.mkdir(parents=True, exist_ok=True)
    (svc_dir / "dev_feature.py").write_text("DEV_FEATURE = True\n", encoding="utf-8")
    _git(repo, "add", ".")
    _git(repo, "commit", "-m", "feat(one): dev sandbox feature")

    # Simulate a dangerous 'take ours' merge that records uat as merged while dropping uat_only_fix.py!
    _git(repo, "merge", "-s", "ours", "uat", "-m", "chore(dev): bad ours merge of uat")

    report = mod.build_parity_report(
        repo,
        dev_ref="dev",
        uat_ref="uat",
        main_ref="main",
        require_clean_upstream=True,
    )
    assert report["code_parity"]["uat_ahead_of_dev"]["count"] == 0
    assert report["merge_fidelity"]["violation_count"] == 1
    assert report["status"] == "blocked"
    assert any("Asymmetric merge fidelity violation" in b for b in report["blockers"])


def test_release_manifest_and_serving_parity_enforcement(tmp_path: Path) -> None:
    mod = _load_module()
    repo = _init_three_lane_repo(tmp_path)
    uat_sha = _git(repo, "rev-parse", "uat")

    _git(repo, "checkout", "dev")
    kai_dir = repo / "hushh-webapp" / "components" / "kai"
    kai_dir.mkdir(parents=True, exist_ok=True)
    (kai_dir / "portfolio.tsx").write_text("export const ok = true;\n", encoding="utf-8")
    _git(repo, "add", ".")
    _git(repo, "commit", "-m", "feat(finance): portfolio redesign")

    def _stale_dev_fetcher(project: str, _region: str, service: str) -> dict[str, Any] | None:
        if service == "sandbox-edge-gateway":
            return None
        return {
            "status": {
                "latestReadyRevisionName": f"{service}-001",
                "url": f"https://{service}.example.run.app",
            },
            "spec": {
                "template": {
                    "metadata": {"labels": {"deploy-sha": uat_sha}},
                    "spec": {"containers": [{"env": []}]},
                }
            },
        }

    report = mod.build_parity_report(
        repo,
        dev_ref="dev",
        uat_ref="uat",
        main_ref="main",
        include_live_cloud=True,
        require_serving_parity=True,
        live_cloud_fetcher=_stale_dev_fetcher,
        live_http_prober=lambda _url: (200, {"status": "ok"}),
    )
    assert "finance" in report["release_manifest"]["features"]
    assert report["live_cloud"]["lanes"]["dev"]["branch_ahead_of_serving"] == 1
    assert report["status"] == "blocked"
    assert any("Serving parity on dev" in b for b in report["blockers"])
