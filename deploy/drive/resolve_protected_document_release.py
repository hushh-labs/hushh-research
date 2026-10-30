#!/usr/bin/env python3
"""Resolve retained hosted-copy maintenance and preserve issued readers."""

from __future__ import annotations

import argparse
import json
import os
import re
import socket
import subprocess
import time
from contextlib import closing
from pathlib import Path
from runpy import run_path

ROOT = Path(__file__).resolve().parents[2]
_READERS = run_path(str(ROOT / "deploy/drive/document_reader_compatibility.py"))
READER_FILES = _READERS["READER_FILES"]
BACKGROUND_READER_FILES = _READERS["BACKGROUND_READER_FILES"]
BACKGROUND_READER_ANCESTOR = _READERS["BACKGROUND_READER_ANCESTOR"]
reader_supported = _READERS["reader_supported"]
inventory_empty = _READERS["inventory_empty"]
SERVICES = ("consent-protocol", "hushh-webapp", "consent-protocol-drive-worker")
LANES = {
    "hushh-pda": ("production", "hushh-pda:us-central1:hushh-vault-db", "hushh_vault"),
    "hushh-pda-uat": ("uat", "hushh-pda-uat:us-central1:hushh-uat-pg", "postgres"),
}


def background_reader_supported(sha: str) -> bool:
    return reader_supported(
        sha,
        BACKGROUND_READER_ANCESTOR,
        required_files=READER_FILES + BACKGROUND_READER_FILES,
    ) is True


def _cloud(*args: str) -> str:
    result = subprocess.run(  # noqa: S603 -- Fixed cloud operations and allowlisted environment resources; no shell.
        ["gcloud", *args], capture_output=True, text=True, check=False
    )
    if result.returncode:
        raise ValueError("Hosted document release evidence could not be verified")
    return result.stdout


def _revision_source(revision: dict) -> dict:
    sha = (revision.get("metadata") or {}).get("labels", {}).get("deploy-sha", "")
    images = [
        item.get("image", "")
        for item in revision.get("spec", {}).get("containers", [])
        if item.get("name") != "clamav"
    ]
    image = images[0] if len(images) == 1 else ""
    if not re.fullmatch(r".+@sha256:[0-9a-f]{64}", image):
        image = revision.get("status", {}).get("imageDigest", "")
    if not re.fullmatch(r"[0-9a-f]{40}", sha) or not re.fullmatch(
        r".+@sha256:[0-9a-f]{64}", image
    ):
        raise ValueError("Previous reader image/source provenance is unavailable")
    return {"sha": sha, "image": image}


def _previous_sources(project: str) -> tuple[dict, dict | None]:
    states = run_path(str(ROOT / "scripts/ci/resolve-cloud-run-serving-state.py"))
    services = json.loads(
        _cloud(
            "run",
            "services",
            "list",
            f"--project={project}",
            "--region=us-central1",
            "--format=json",
        )
    )
    present = {row["metadata"]["name"]: row for row in services}
    previous, backend = {}, None
    for name in SERVICES:
        if name not in present:
            previous[name] = {"revision": "", "sha": "", "image": ""}
            continue
        state = states["resolve_serving_state"](present[name], allow_missing=True)
        if not state.revision:
            previous[name] = {"revision": "", "sha": "", "image": ""}
            continue
        revision = json.loads(
            _cloud(
                "run",
                "revisions",
                "describe",
                state.revision,
                f"--project={project}",
                "--region=us-central1",
                "--format=json",
            )
        )
        previous[name] = {"revision": state.revision, **_revision_source(revision)}
        if name == "consent-protocol":
            backend = revision
    return previous, backend


def _known_source(sha: str) -> bool:
    if not isinstance(sha, str) or not re.fullmatch(r"[0-9a-f]{40}", sha):
        return False
    return (
        subprocess.run(  # noqa: S603 -- Fixed Git read with validated SHA; no shell.
            ["git", "cat-file", "-e", sha],
            capture_output=True,
            check=False,
        ).returncode
        == 0
    )


def _serving_intake_off(project: str, backend: dict | None, ancestor: str) -> bool:
    if backend is None:
        return True
    sha = (backend.get("metadata") or {}).get("labels", {}).get("deploy-sha", "")
    # Only a known pre-API image proves absent issuance capability.
    if not _known_source(sha):
        return False
    if subprocess.run(  # noqa: S603 -- Fixed Git read with validated SHA and authored path; no shell.
        ["git", "cat-file", "-e", f"{sha}:{READER_FILES[0]}"],
        capture_output=True,
        check=False,
    ).returncode:
        return True
    flags = []
    for container in backend.get("spec", {}).get("containers", []):
        for item in container.get("env", []):
            if item.get("name") == "PROTECTED_DOCUMENT_DELIVERY_ENABLED":
                flags.append(item)
    # Mutable Secret Manager :latest says nothing about an existing instance's
    # hydrated environment. Only literal OFF wins the runtime's setdefault.
    return (
        len(flags) == 1
        and flags[0].get("value") == "false"
        and "valueFrom" not in flags[0]
    )


def _database_empty(project: str, *, background_only: bool = False) -> bool:
    """Authoritative read-only bootstrap proof in an owned, bounded SQL proxy."""
    import psycopg2

    _, instance, database = LANES[project]
    username = _cloud(
        "secrets",
        "versions",
        "access",
        "latest",
        "--secret=DB_USER",
        f"--project={project}",
    ).strip()
    password = _cloud(
        "secrets",
        "versions",
        "access",
        "latest",
        "--secret=DB_PASSWORD",
        f"--project={project}",
    ).strip()
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    command = ["cloud-sql-proxy", "--address=127.0.0.1", f"--port={port}", instance]
    if os.environ.get("GOOGLE_GHA_CREDS_PATH"):
        command.append("--credentials-file=" + os.environ["GOOGLE_GHA_CREDS_PATH"])
    group = run_path(str(ROOT / "scripts/ci/process_group.py"))["command_group"]
    with group(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) as (
        proxy,
        stop,
    ):
        try:
            deadline = time.monotonic() + 20
            while True:
                with socket.socket() as probe:
                    if probe.connect_ex(("127.0.0.1", port)) == 0:
                        break
                if proxy.poll() is not None or time.monotonic() >= deadline:
                    raise ValueError("Hosted document bootstrap database proof is unavailable")
                time.sleep(0.1)
            with closing(
                psycopg2.connect(
                    host="127.0.0.1",
                    port=port,
                    dbname=database,
                    user=username,
                    password=password,
                    connect_timeout=5,
                )
            ) as connection:
                connection.set_session(readonly=True, autocommit=True)
                return inventory_empty(connection, background_only=background_only) is True
        finally:
            stop()
            try:
                proxy.wait(timeout=5)
            except subprocess.TimeoutExpired:
                stop(force=True)
                proxy.wait(timeout=5)


def _assert_background_downgrade_safe(project: str, backend: dict | None) -> None:
    # V2 consent/worker admission is not controlled by the v1 intake flag. Only
    # an absent or known pre-v2 API plus a fresh empty inventory proves safety.
    if backend is not None:
        sha = (backend.get("metadata") or {}).get("labels", {}).get("deploy-sha", "")
        if (
            not _known_source(sha)
            or subprocess.run(  # noqa: S603 -- Fixed Git read, validated SHA, no shell.
                ["git", "cat-file", "-e", f"{sha}:{BACKGROUND_READER_FILES[0]}"],
                capture_output=True,
                check=False,
            ).returncode
            == 0
        ):
            raise ValueError("Background document writers require forward recovery")
    if not _database_empty(project, background_only=True):
        raise ValueError("Rollback would remove issued background document readers")


def verify_readers(mode: dict, *, project: str, target: str, ancestor: str) -> dict:
    if not mode["configured"]:
        return {
            **mode,
            "project": project,
            "targetSha": target,
            "previous": {},
            "bootstrapEmpty": False,
        }
    if not reader_supported(target, ancestor):
        raise ValueError("Configured hosted storage requires a reader-capable target source")
    previous, backend = _previous_sources(project)
    if not background_reader_supported(target):
        _assert_background_downgrade_safe(project, backend)
    for value in previous.values():
        value["readerCompatible"] = reader_supported(value["sha"], ancestor)
    compatible = all(value["readerCompatible"] for value in previous.values())
    bootstrap = False
    if not compatible:
        bootstrap = (
            not mode["enabled"]
            and _serving_intake_off(project, backend, ancestor)
            and _database_empty(project)
        )
        if not bootstrap:
            raise ValueError("A reader-capable rollback baseline is required before hosted intake")
    return {
        **mode,
        "project": project,
        "targetSha": target,
        "readerAncestor": ancestor,
        "previous": previous,
        "bootstrapEmpty": bootstrap,
    }


def assert_rollback(report: dict, *, project: str, service: str, revision: str) -> None:
    if report.get("project") != project:
        raise ValueError("Hosted document rollback project does not match")
    if report.get("configured") is False:
        return
    previous = report.get("previous", {}).get(service, {})
    if (
        report.get("project") != project
        or service not in SERVICES
        or previous.get("revision") != revision
    ):
        raise ValueError("Hosted document rollback is outside the verified baseline")
    supported = reader_supported(previous.get("sha", ""), report.get("readerAncestor", ""))
    if not background_reader_supported(previous.get("sha", "")):
        _, current_backend = _previous_sources(project)
        _assert_background_downgrade_safe(project, current_backend)
    if not supported:
        if report.get("enabled") is not False or report.get("bootstrapEmpty") is not True:
            raise ValueError("Hosted document rollback would remove issued readers")
        # Recheck immediately before the existing traffic mutator. A stale
        # empty-bootstrap receipt cannot authorize erasing newly issued access.
        _, current_backend = _previous_sources(project)
        if not _serving_intake_off(
            project, current_backend, report.get("readerAncestor", "")
        ) or not _database_empty(project):
            raise ValueError("Hosted document bootstrap rollback is no longer empty")


def assert_manual_rollback(*, project: str, service: str, revision: str, ancestor: str) -> None:
    if (
        project not in LANES
        or service not in SERVICES
        or not re.fullmatch(r"[a-z][a-z0-9-]{0,62}", revision)
        or not re.fullmatch(r"[0-9a-f]{40}", ancestor)
    ):
        raise ValueError("Manual document rollback identity is invalid")
    target = json.loads(
        _cloud(
            "run",
            "revisions",
            "describe",
            revision,
            f"--project={project}",
            "--region=us-central1",
            "--format=json",
        )
    )
    metadata = target.get("metadata") or {}
    if (
        metadata.get("name") != revision
        or metadata.get("labels", {}).get("serving.knative.dev/service") != service
    ):
        raise ValueError("Manual document rollback revision belongs to another service")
    source = _revision_source(target)
    if reader_supported(source["sha"], ancestor):
        if not background_reader_supported(source["sha"]):
            _, backend = _previous_sources(project)
            _assert_background_downgrade_safe(project, backend)
        return
    if not _known_source(source["sha"]):
        raise ValueError("Manual rollback target source is unavailable")
    if service == "consent-protocol" and not _serving_intake_off(project, target, ancestor):
        raise ValueError("Non-reader rollback target can issue document copies")
    _, backend = _previous_sources(project)
    if not _serving_intake_off(project, backend, ancestor) or not _database_empty(project):
        raise ValueError("Manual rollback would remove issued document readers")
    _assert_background_downgrade_safe(project, backend)


def _rollback_command(args, parser) -> bool:
    if args.rebind_backend_report:
        if not args.rollback_report or args.service or args.revision:
            parser.error("Backend rebinding requires only the existing rollback report")
        try:
            run_path(str(ROOT / "deploy/drive/rebind_protected_document_backend.py"))[
                "rebind_backend"
            ](
                args.rollback_report,
                args.rebind_backend_report,
                project=args.project,
                ancestor=args.required_ancestor,
                cloud=_cloud,
                revision_source=_revision_source,
                reader_supported=reader_supported,
            )
        except Exception:
            parser.exit(1, "Hosted document backend rebinding was not proved\n")
        print("Hosted document backend rollback binding verified")
        return True
    if not args.manual_rollback and not args.rollback_report:
        return False
    try:
        if args.manual_rollback:
            assert_manual_rollback(
                project=args.project,
                service=args.service,
                revision=args.revision,
                ancestor=args.required_ancestor,
            )
        else:
            assert_rollback(
                json.loads(args.rollback_report.read_text()),
                project=args.project,
                service=args.service,
                revision=args.revision,
            )
    except Exception:
        parser.exit(1, "Hosted document rollback compatibility was not proved\n")
    print("Hosted document rollback compatibility verified")
    return True


def resolve(runtime: dict, *, project: str, environment: str) -> dict[str, bool]:
    if not isinstance(runtime, dict):
        raise ValueError("Hosted document runtime configuration is invalid")
    keys = (
        "protected_document_delivery",
        "document_delivery_bucket",
        "document_delivery_bucket_identity",
    )
    if not any(key in runtime for key in keys):
        return {"configured": False, "enabled": False}
    retain = run_path(str(ROOT / "scripts/ops/runtime_config_retention.py")).get(
        "_retained_document_delivery"
    )
    if not callable(retain):
        raise ValueError("The target has no hosted document reader support")
    retained = retain(runtime, project=project, environment=environment)
    return {
        "configured": bool(retained.get("document_delivery_bucket")),
        "enabled": retained.get("protected_document_delivery") is True,
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--project", choices=("hushh-pda", "hushh-pda-uat"), required=True
    )
    parser.add_argument("--environment", choices=("production", "uat"), required=True)
    parser.add_argument("--github-output", type=Path)
    parser.add_argument("--target-sha", default="")
    parser.add_argument("--required-ancestor", default="")
    parser.add_argument("--verify-previous", action="store_true")
    parser.add_argument("--production-restoration", action="store_true")
    retained = parser.add_mutually_exclusive_group()
    retained.add_argument("--staged-worker-run-id", default="")
    retained.add_argument("--activation-run-id", default="")
    retained.add_argument("--cold-release-mode", action="store_true")
    parser.add_argument("--json-output", type=Path)
    rollback = parser.add_mutually_exclusive_group()
    rollback.add_argument("--rollback-report", type=Path)
    rollback.add_argument("--manual-rollback", action="store_true")
    parser.add_argument("--rebind-backend-report", type=Path)
    parser.add_argument("--service", choices=SERVICES)
    parser.add_argument("--revision", default="")
    return parser


def main() -> int:
    parser = _parser()
    args = parser.parse_args()
    if LANES[args.project][0] != args.environment:
        parser.error("Hosted document release project/environment does not match")
    if (args.staged_worker_run_id or args.activation_run_id or args.cold_release_mode) and (
        args.project != "hushh-pda" or args.production_restoration
        or args.rollback_report or args.manual_rollback or args.rebind_backend_report
    ):
        parser.error("Retained worker mode requires an ordinary production verification")
    if _rollback_command(args, parser):
        return 0
    try:
        runtime = json.loads(
            _cloud(
                "secrets",
                "versions",
                "access",
                "latest",
                "--secret=BACKEND_RUNTIME_CONFIG_JSON",
                f"--project={args.project}",
            )
        )
        mode = resolve(
            runtime,
            project=args.project,
            environment=args.environment,
        )
        if args.staged_worker_run_id or args.activation_run_id or args.cold_release_mode:
            mode = run_path(str(ROOT / "deploy/drive/rebind_protected_document_backend.py"))[
                "retained_worker_mode"
            ](mode, target=args.target_sha, stage_run=args.staged_worker_run_id,
              activation_run=args.activation_run_id, cold_release=args.cold_release_mode)
        if args.production_restoration:
            mode = run_path(
                str(ROOT / "deploy/drive/rebind_protected_document_backend.py")
            )["restoration_mode"](
                mode,
                project=args.project,
                target=args.target_sha,
                verify_previous=args.verify_previous,
            )
        if (
            not args.production_restoration
            and mode["configured"]
            and args.target_sha
            and not reader_supported(args.target_sha, args.required_ancestor)
        ):
            raise ValueError("Target reader support is missing")
        if args.verify_previous:
            report = verify_readers(
                mode,
                project=args.project,
                target=args.target_sha,
                ancestor=args.required_ancestor,
            )
            if args.json_output:
                args.json_output.write_text(
                    json.dumps(report, sort_keys=True), encoding="utf-8"
                )
    except Exception:
        parser.exit(
            1, "Hosted document runtime policy is invalid for this environment\n"
        )
    if args.github_output:
        with args.github_output.open("a", encoding="utf-8") as output:
            for key, value in mode.items():
                output.write(f"{key}={str(value).lower()}\n")
    print(json.dumps(mode, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
