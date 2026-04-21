#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[4]
VERIFY_PARITY = REPO_ROOT / "scripts" / "ops" / "verify-env-secrets-parity.py"
VERIFY_UAT_RELEASE = REPO_ROOT / "scripts" / "ops" / "verify_uat_release.py"
VERIFY_RUNTIME_CONTRACT = REPO_ROOT / "scripts" / "ci" / "verify-runtime-config-contract.py"
VERIFY_RELEASE_CONTRACT = REPO_ROOT / "scripts" / "ops" / "verify_release_migration_contract.py"
VERIFY_RUNTIME_DB_CONTRACT = REPO_ROOT / "scripts" / "ops" / "verify_runtime_db_contract.sh"
REPO_SCAN = REPO_ROOT / ".codex" / "skills" / "repo-context" / "scripts" / "repo_scan.py"

DEFAULT_UAT_PROJECT = "hushh-pda-uat"
DEFAULT_UAT_REGION = "us-central1"
DEFAULT_UAT_BACKEND_SERVICE = "consent-protocol"
DEFAULT_UAT_FRONTEND_SERVICE = "hushh-webapp"
DEFAULT_UAT_CONTRACT = REPO_ROOT / "consent-protocol" / "db" / "contracts" / "uat_integrated_schema.json"


def _run(
    cmd: list[str],
    *,
    env: dict[str, str] | None = None,
    cwd: Path = REPO_ROOT,
) -> dict[str, Any]:
    result = subprocess.run(
        cmd,
        cwd=str(cwd),
        env=env,
        text=True,
        capture_output=True,
    )
    return {
        "cmd": cmd,
        "returncode": result.returncode,
        "stdout": result.stdout[-4000:],
        "stderr": result.stderr[-4000:],
        "ok": result.returncode == 0,
    }


def _load_json(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _gcloud_secret(project: str, secret: str) -> str:
    result = _run(
        [
            "gcloud",
            "secrets",
            "versions",
            "access",
            "latest",
            "--secret",
            secret,
            "--project",
            project,
        ]
    )
    if not result["ok"]:
        return ""
    return result["stdout"].strip()


def _service_url(project: str, region: str, service: str) -> str:
    result = _run(
        [
            "gcloud",
            "run",
            "services",
            "describe",
            service,
            "--project",
            project,
            "--region",
            region,
            "--format=value(status.url)",
        ]
    )
    return result["stdout"].strip() if result["ok"] else ""


def _service_revision(project: str, region: str, service: str) -> str:
    result = _run(
        [
            "gcloud",
            "run",
            "services",
            "describe",
            service,
            "--project",
            project,
            "--region",
            region,
            "--format=value(status.latestReadyRevisionName)",
        ]
    )
    return result["stdout"].strip() if result["ok"] else ""


def _maybe_load_smoke_overlay(project: str, env: dict[str, str]) -> dict[str, str]:
    loaded: dict[str, str] = {}
    for key in ("UAT_SMOKE_USER_ID", "UAT_SMOKE_PASSPHRASE"):
        if env.get(key):
            continue
        value = _gcloud_secret(project, key)
        if value:
            env[key] = value
            loaded[key] = "secret-manager"
    return loaded


def _append_unique(target: list[str], values: list[str]) -> None:
    for value in values:
        if value and value not in target:
            target.append(value)


def _advisory_from_audit(audit_payload: dict[str, Any] | None) -> list[str]:
    if not isinstance(audit_payload, dict):
        return []
    data = audit_payload.get("data") or {}
    findings = data.get("findings") or {}
    relevant: list[str] = []
    for severity in ("high", "medium"):
        for issue in findings.get(severity, []):
            text = str(issue).lower()
            if "workflow pack" in text or "command" in text or "owner" in text:
                relevant.append("doc_skill_drift")
                break
    return list(dict.fromkeys(relevant))


def _render_text(payload: dict[str, Any]) -> str:
    lines = [
        f"Surface: {payload['surface']}",
        f"Status: {payload['status']}",
        f"Can push branch: {payload['can_push_branch']}",
        f"Blocking classifications: {', '.join(payload['blocking_classifications']) or 'none'}",
        f"Advisory classifications: {', '.join(payload['advisory_classifications']) or 'none'}",
    ]
    if payload.get("next_actions"):
        lines.append("Next actions:")
        lines.extend(f"- {item}" for item in payload["next_actions"])
    reports = payload.get("reports") or {}
    if reports:
        lines.append("Reports:")
        for name, data in reports.items():
            report_path = str(data.get("report_path") or "").strip()
            if report_path:
                lines.append(f"- {name}: {report_path}")
    return "\n".join(lines)


def _build_next_actions(blocking: list[str]) -> list[str]:
    actions: list[str] = []
    if "secret_missing" in blocking:
        actions.append("Sync or create canonical Secret Manager values before retrying runtime verification.")
    if "runtime_mount_legacy" in blocking:
        actions.append("Redeploy the changed Cloud Run surface so canonical env names replace legacy mounts.")
    if "runtime_mount_missing" in blocking:
        actions.append("Fix deploy/runtime env injection for the missing canonical keys, then redeploy the affected surface.")
    if "runtime_behavior_failed" in blocking:
        actions.append("Inspect the semantic verification report and fix the live runtime behavior after env parity is green.")
    if "smoke_overlay_dependency_leak" in blocking:
        actions.append("Restore or load the maintainer-only smoke overlay for UAT verification without adding it back to canonical runtime files.")
    if "db_contract_drift" in blocking:
        actions.append("Resolve DB release-contract drift before treating the surface as deployable.")
    if "runtime_contract_drift" in blocking:
        actions.append("Fix the canonical runtime settings contract before relying on CI or deploy verification.")
    if "core_ci_failed" in blocking:
        actions.append("Fix the failing core CI lane and rerun the authoritative checks twice before pushing the branch.")
    return actions


def _surface_uat(args: argparse.Namespace, scratch_dir: Path) -> dict[str, Any]:
    project = args.project or DEFAULT_UAT_PROJECT
    region = args.region or DEFAULT_UAT_REGION
    backend_service = args.backend_service or DEFAULT_UAT_BACKEND_SERVICE
    frontend_service = args.frontend_service or DEFAULT_UAT_FRONTEND_SERVICE
    backend_url = args.backend_url or _service_url(project, region, backend_service)
    frontend_url = args.frontend_url or _service_url(project, region, frontend_service)
    parity_report_path = Path(args.parity_report_path or scratch_dir / "uat-runtime-parity.json")
    semantic_report_path = Path(args.semantic_report_path or scratch_dir / "uat-semantic.json")
    db_report_path = Path(args.db_report_path or scratch_dir / "uat-db-contract.json")

    parity_cmd = [
        sys.executable,
        str(VERIFY_PARITY),
        "--project",
        project,
        "--region",
        region,
        "--backend-service",
        backend_service,
        "--frontend-service",
        frontend_service,
        "--require-gmail",
        "--require-voice",
        "--assert-runtime-env-contract",
        "--report-path",
        str(parity_report_path),
    ]
    parity_result = _run(parity_cmd)
    parity_report = _load_json(parity_report_path) or {}

    db_cmd = [
        "bash",
        str(VERIFY_RUNTIME_DB_CONTRACT),
        "--project",
        project,
        "--region",
        region,
        "--service",
        backend_service,
        "--contract-file",
        str(DEFAULT_UAT_CONTRACT),
        "--report-path",
        str(db_report_path),
    ]
    db_result = _run(db_cmd)
    db_report = _load_json(db_report_path) or {}

    semantic_env = dict(os.environ)
    loaded_overlay = _maybe_load_smoke_overlay(project, semantic_env)
    semantic_cmd = [
        sys.executable,
        str(VERIFY_UAT_RELEASE),
        "--backend-url",
        backend_url,
        "--frontend-url",
        frontend_url,
        "--report-path",
        str(semantic_report_path),
    ]
    semantic_result = _run(semantic_cmd, env=semantic_env)
    semantic_report = _load_json(semantic_report_path) or {}

    blocking: list[str] = []
    advisory: list[str] = []
    _append_unique(blocking, list(parity_report.get("classifications") or []))
    if semantic_report.get("status") == "blocked":
        _append_unique(blocking, ["runtime_behavior_failed"])
        failures = set(semantic_report.get("failures") or [])
        if "smoke_auth" in failures:
            _append_unique(blocking, ["smoke_overlay_dependency_leak"])
    if db_result["returncode"] != 0:
        _append_unique(blocking, ["db_contract_drift"])
    if parity_result["returncode"] != 0 and not parity_report:
        _append_unique(blocking, ["runtime_mount_missing"])

    return {
        "surface": "uat",
        "status": "healthy" if not blocking else "blocked",
        "can_push_branch": not blocking,
        "blocking_classifications": blocking,
        "advisory_classifications": advisory,
        "next_actions": _build_next_actions(blocking),
        "context": {
            "project": project,
            "region": region,
            "backend_service": backend_service,
            "frontend_service": frontend_service,
            "backend_url": backend_url,
            "frontend_url": frontend_url,
            "backend_revision": _service_revision(project, region, backend_service),
            "frontend_revision": _service_revision(project, region, frontend_service),
            "loaded_overlay": loaded_overlay,
        },
        "reports": {
            "parity": {
                "report_path": str(parity_report_path),
                "returncode": parity_result["returncode"],
            },
            "semantic": {
                "report_path": str(semantic_report_path),
                "returncode": semantic_result["returncode"],
            },
            "db_contract": {
                "report_path": str(db_report_path),
                "returncode": db_result["returncode"],
            },
        },
        "raw": {
            "parity": {"result": parity_result, "report": parity_report},
            "semantic": {"result": semantic_result, "report": semantic_report},
            "db_contract": {"result": db_result, "report": db_report},
        },
    }


def _surface_runtime(_: argparse.Namespace, scratch_dir: Path) -> dict[str, Any]:
    runtime_contract = _run([sys.executable, str(VERIFY_RUNTIME_CONTRACT)])
    release_contract = _run([sys.executable, str(VERIFY_RELEASE_CONTRACT)])
    audit_report_path = scratch_dir / "codex-audit.json"
    audit_result = _run(
        [sys.executable, str(REPO_SCAN), "audit", "--json"],
    )
    audit_payload = None
    if audit_result["ok"]:
        try:
            audit_payload = json.loads(audit_result["stdout"])
        except json.JSONDecodeError:
            audit_payload = None
    if audit_payload is not None:
        audit_report_path.write_text(json.dumps(audit_payload, indent=2), encoding="utf-8")

    blocking: list[str] = []
    advisory: list[str] = []
    if runtime_contract["returncode"] != 0:
        _append_unique(blocking, ["runtime_contract_drift"])
    if release_contract["returncode"] != 0:
        _append_unique(blocking, ["db_contract_drift"])
    _append_unique(advisory, _advisory_from_audit(audit_payload))

    return {
        "surface": "runtime",
        "status": "healthy" if not blocking else "blocked",
        "can_push_branch": not blocking,
        "blocking_classifications": blocking,
        "advisory_classifications": advisory,
        "next_actions": _build_next_actions(blocking),
        "reports": {
            "runtime_contract": {"returncode": runtime_contract["returncode"]},
            "release_contract": {"returncode": release_contract["returncode"]},
            "codex_audit": {"report_path": str(audit_report_path) if audit_payload else ""},
        },
        "raw": {
            "runtime_contract": runtime_contract,
            "release_contract": release_contract,
            "codex_audit": {"result": audit_result, "report": audit_payload},
        },
    }


def _surface_ci(_: argparse.Namespace, scratch_dir: Path) -> dict[str, Any]:
    ci_result = _run(["./bin/hushh", "ci"], cwd=REPO_ROOT)
    audit_report_path = scratch_dir / "codex-audit.json"
    audit_result = _run([sys.executable, str(REPO_SCAN), "audit", "--json"])
    audit_payload = None
    if audit_result["ok"]:
        try:
            audit_payload = json.loads(audit_result["stdout"])
        except json.JSONDecodeError:
            audit_payload = None
    if audit_payload is not None:
        audit_report_path.write_text(json.dumps(audit_payload, indent=2), encoding="utf-8")

    blocking: list[str] = []
    advisory: list[str] = []
    if ci_result["returncode"] != 0:
        _append_unique(blocking, ["core_ci_failed"])
    _append_unique(advisory, _advisory_from_audit(audit_payload))

    return {
        "surface": "ci",
        "status": "healthy" if not blocking else "blocked",
        "can_push_branch": not blocking,
        "blocking_classifications": blocking,
        "advisory_classifications": advisory,
        "next_actions": _build_next_actions(blocking),
        "reports": {
            "ci": {"returncode": ci_result["returncode"]},
            "codex_audit": {"report_path": str(audit_report_path) if audit_payload else ""},
        },
        "raw": {
            "ci": ci_result,
            "codex_audit": {"result": audit_result, "report": audit_payload},
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Run structured Codex RCA for core runtime surfaces.")
    parser.add_argument("--surface", required=True, choices=("uat", "runtime", "ci"))
    parser.add_argument("--project")
    parser.add_argument("--region")
    parser.add_argument("--backend-service")
    parser.add_argument("--frontend-service")
    parser.add_argument("--backend-url")
    parser.add_argument("--frontend-url")
    parser.add_argument("--parity-report-path")
    parser.add_argument("--semantic-report-path")
    parser.add_argument("--db-report-path")
    parser.add_argument("--report-path")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--text", action="store_true")
    args = parser.parse_args()

    with tempfile.TemporaryDirectory(prefix=f"codex-rca-{args.surface}-") as scratch:
        scratch_dir = Path(scratch)
        if args.surface == "uat":
            payload = _surface_uat(args, scratch_dir)
        elif args.surface == "runtime":
            payload = _surface_runtime(args, scratch_dir)
        else:
            payload = _surface_ci(args, scratch_dir)

        if args.report_path:
            report_path = Path(args.report_path)
            report_path.parent.mkdir(parents=True, exist_ok=True)
            report_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")

        if args.json:
            print(json.dumps(payload, indent=2))
        else:
            print(_render_text(payload))

        return 0 if payload["status"] == "healthy" else 1


if __name__ == "__main__":
    raise SystemExit(main())
