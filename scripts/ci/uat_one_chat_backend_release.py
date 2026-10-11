#!/usr/bin/env python3
"""Deploy only UAT's existing backend for the One chat Vertex cutover."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.request
from copy import deepcopy
from pathlib import Path
from typing import Any

PROJECT = "hushh-pda-uat"
REGION = "us-central1"
SERVICE = "consent-protocol"
RUNTIME_SA = "consent-protocol-runtime@hushh-pda-uat.iam.gserviceaccount.com"
CHAT_PROJECT = "hussh-511311"
SOURCE = "deploy-uat-one-chat"

# A service-only release is valid only when every accumulated change since
# the currently serving backend revision belongs to this cutover.
ALLOWED_PATHS = frozenset(
    {
        ".github/workflows/deploy-uat.yml",
        ".github/workflows/deploy-uat-one-chat.yml",
        ".codex/skills/repo-operations/references/admin-release-sop.md",
        "consent-protocol/api/routes/one/agent_chat.py",
        "consent-protocol/hushh_mcp/one_adk/agent_tree.py",
        "consent-protocol/hushh_mcp/runtime_providers/__init__.py",
        "consent-protocol/hushh_mcp/runtime_providers/factory.py",
        "consent-protocol/scripts/verify_managed_vertex_runtime.py",
        "consent-protocol/tests/services/test_runtime_providers.py",
        "consent-protocol/tests/test_managed_vertex_readiness_script.py",
        "consent-protocol/tests/test_conversation_titles.py",
        "consent-protocol/tests/test_one_adk_agent_tree.py",
        "consent-protocol/tests/test_uat_deploy_no_traffic_contract.py",
        "consent-protocol/tests/test_one_chat_service_only_release.py",
        "deploy/backend.cloudbuild.yaml",
        "deploy/README.md",
        "hushh-webapp/scripts/ci/select-uat-target.mjs",
        "hushh-webapp/__tests__/services/uat-target-selection.test.ts",
        "scripts/ci/uat_one_chat_backend_release.py",
    }
)


def backend_release_input(path: str) -> bool:
    """Only bytes that enter this image or govern its build need the delta gate."""
    if path.startswith("consent-protocol/"):
        relative = path.removeprefix("consent-protocol/")
        return not relative.startswith(
            ("tests/", "docs/", ".github/")
        ) and not relative.endswith(".md")
    return (
        path.startswith("contracts/")
        or path.startswith("scripts/ci/")
        or path
        in {
            ".gcloudignore",
            "deploy/backend-image.cloudbuild.yaml",
        }
    )


def command(
    *args: str, capture: bool = False, check: bool = True
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(  # noqa: S603 - fixed programs and validated release inputs
        list(args),
        check=check,
        text=True,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
    )


def output(*args: str) -> str:
    return command(*args, capture=True).stdout.strip()


def gcloud_json(*args: str) -> dict[str, Any]:
    value = json.loads(output("gcloud", *args, "--format=json"))
    if not isinstance(value, dict):
        raise RuntimeError("gcloud returned a non-object response")
    return value


def service_state() -> dict[str, Any]:
    return gcloud_json(
        "run",
        "services",
        "describe",
        SERVICE,
        f"--project={PROJECT}",
        f"--region={REGION}",
    )


def revision_state(revision: str) -> dict[str, Any]:
    return gcloud_json(
        "run",
        "revisions",
        "describe",
        revision,
        f"--project={PROJECT}",
        f"--region={REGION}",
    )


def serving_revision(service: dict[str, Any]) -> str:
    traffic = [
        entry
        for entry in (service.get("status") or {}).get("traffic") or []
        if int(entry.get("percent") or 0) > 0
    ]
    if len(traffic) != 1 or int(traffic[0].get("percent") or 0) != 100:
        raise RuntimeError("UAT backend must have exactly one serving revision at 100%")
    revision = str(traffic[0].get("revisionName") or "")
    if not revision:
        raise RuntimeError("UAT backend traffic has no pinned revision")
    return revision


def release_paths(base_sha: str, target_sha: str) -> list[str]:
    command("git", "merge-base", "--is-ancestor", base_sha, target_sha)
    paths = output("git", "diff", "--name-only", base_sha, target_sha).splitlines()
    disallowed = sorted(
        path
        for path in paths
        if backend_release_input(path) and path not in ALLOWED_PATHS
    )
    if disallowed:
        raise RuntimeError(
            f"Service-only UAT release refuses changed paths: {disallowed}"
        )
    if "consent-protocol/api/routes/one/agent_chat.py" not in paths:
        raise RuntimeError("Service-only UAT release has no One chat backend change")
    return paths


def preflight(target_sha: str) -> tuple[str, str]:
    if output("git", "rev-parse", "HEAD") != target_sha:
        raise RuntimeError("Checkout does not match exact requested main SHA")
    service = service_state()
    old_revision = serving_revision(service)
    template = (service.get("spec") or {}).get("template") or {}
    identity = str((template.get("spec") or {}).get("serviceAccountName") or "")
    if identity != RUNTIME_SA:
        raise RuntimeError("UAT backend runtime identity drifted")
    revision = revision_state(old_revision)
    labels = (revision.get("metadata") or {}).get("labels") or {}
    if (revision.get("spec") or {}).get("serviceAccountName") != RUNTIME_SA:
        raise RuntimeError("Serving backend revision identity drifted")
    if labels.get("account-deletion-contract") != "v201":
        raise RuntimeError("Serving backend lifecycle contract drifted")
    base_sha = str(labels.get("deploy-sha") or "")
    if len(base_sha) != 40 or any(char not in "0123456789abcdef" for char in base_sha):
        raise RuntimeError("Serving backend has no exact deploy SHA")
    release_paths(base_sha, target_sha)
    return old_revision, base_sha


def build_image(target_sha: str, temp: Path) -> str:
    image_tag = f"uat-{target_sha}"
    command(
        "gcloud",
        "builds",
        "submit",
        f"--project={PROJECT}",
        "--config=deploy/backend-image.cloudbuild.yaml",
        f"--substitutions=_IMAGE_TAG={image_tag}",
    )
    repository = f"gcr.io/{PROJECT}/consent-protocol"
    digest = output(
        "gcloud",
        "container",
        "images",
        "describe",
        f"{repository}:{image_tag}",
        f"--project={PROJECT}",
        "--format=value(image_summary.digest)",
    )
    if not digest.startswith("sha256:") or len(digest) != 71:
        raise RuntimeError("Backend image has no immutable SHA-256 digest")
    parent_image = f"{repository}@{digest}"
    command("gcloud", "auth", "configure-docker", "gcr.io", "--quiet")
    manifest = command(
        "docker", "buildx", "imagetools", "inspect", "--raw", parent_image, capture=True
    )
    manifest_path = temp / "uat-one-chat-image-manifest.json"
    manifest_path.write_text(manifest.stdout, encoding="utf-8")
    return output(
        "python3",
        "scripts/ci/resolve-cloud-run-image.py",
        "--image-reference",
        parent_image,
        "--manifest-json",
        str(manifest_path),
        "--sha",
        target_sha,
        "--json-output",
        str(temp / "uat-one-chat-image.json"),
    )


def candidate_from_service(
    service: dict[str, Any], old_revision: str, tag: str
) -> tuple[str, str]:
    status = service.get("status") or {}
    candidate = str(status.get("latestReadyRevisionName") or "")
    if not candidate or candidate == old_revision:
        raise RuntimeError("New UAT backend revision is not ready")
    traffic = status.get("traffic") or []
    if (
        sum(
            int(entry.get("percent") or 0)
            for entry in traffic
            if entry.get("revisionName") == old_revision
        )
        != 100
    ):
        raise RuntimeError("Candidate unexpectedly changed backend traffic")
    tagged = [
        entry
        for entry in traffic
        if entry.get("tag") == tag and entry.get("revisionName") == candidate
    ]
    if len(tagged) != 1:
        raise RuntimeError("Candidate traffic tag is unavailable")
    url = str(tagged[0].get("url") or "")
    if not url.startswith("https://"):
        raise RuntimeError("Candidate has no HTTPS tag URL")
    return candidate, url


def stable_runtime_spec(revision: dict[str, Any]) -> dict[str, Any]:
    """Compare every revision setting except the image and intended env delta."""
    spec = deepcopy(revision.get("spec") or {})
    mutable_env = {
        "HUSHH_ONE_CHAT_VERTEX_PROJECT",
        "HUSHH_DEPLOY_ENV",
        "HUSHH_DEPLOY_SOURCE",
        "HUSHH_DEPLOY_SHA",
        "HUSHH_DEPLOY_RUN_ID",
    }
    for container in spec.get("containers") or []:
        container.pop("image", None)
        container["env"] = sorted(
            (
                item
                for item in container.get("env") or []
                if item.get("name") not in mutable_env
            ),
            key=lambda item: item.get("name") or "",
        )
    return spec


def deploy_candidate(
    image: str, target_sha: str, run_id: str, attempt: str, old_revision: str
) -> tuple[str, str]:
    if serving_revision(service_state()) != old_revision:
        raise RuntimeError("UAT backend traffic changed after preflight")
    tag = f"one-chat-{run_id}-{attempt}"
    command(
        "gcloud",
        "run",
        "services",
        "update",
        SERVICE,
        f"--project={PROJECT}",
        f"--region={REGION}",
        f"--image={image}",
        "--update-env-vars="
        + ",".join(
            (
                f"HUSHH_ONE_CHAT_VERTEX_PROJECT={CHAT_PROJECT}",
                "HUSHH_DEPLOY_ENV=uat",
                f"HUSHH_DEPLOY_SOURCE={SOURCE}",
                f"HUSHH_DEPLOY_SHA={target_sha}",
                f"HUSHH_DEPLOY_RUN_ID={run_id}",
            )
        ),
        "--update-labels="
        + ",".join(
            (
                "managed-by=hushh-github-actions",
                "deploy-env=uat",
                f"deploy-source={SOURCE}",
                f"deploy-sha={target_sha}",
                f"github-run-id={run_id}",
                "account-deletion-contract=v201",
            )
        ),
        "--no-traffic",
        f"--tag={tag}",
        "--quiet",
    )
    candidate, url = candidate_from_service(service_state(), old_revision, tag)
    revision = revision_state(candidate)
    previous = revision_state(old_revision)
    labels = (revision.get("metadata") or {}).get("labels") or {}
    containers = (revision.get("spec") or {}).get("containers") or []
    env = {
        entry.get("name"): entry.get("value")
        for container in containers
        for entry in container.get("env") or []
    }
    ready = any(
        entry.get("type") == "Ready" and str(entry.get("status")).lower() == "true"
        for entry in (revision.get("status") or {}).get("conditions") or []
    )
    if not all(
        (
            ready,
            bool(containers) and containers[0].get("image") == image,
            labels.get("deploy-sha") == target_sha,
            labels.get("deploy-source") == SOURCE,
            labels.get("github-run-id") == run_id,
            labels.get("account-deletion-contract") == "v201",
            env.get("HUSHH_ONE_CHAT_VERTEX_PROJECT") == CHAT_PROJECT,
            env.get("HUSHH_DEPLOY_SHA") == target_sha,
            (revision.get("spec") or {}).get("serviceAccountName") == RUNTIME_SA,
            stable_runtime_spec(revision) == stable_runtime_spec(previous),
        )
    ):
        raise RuntimeError("Candidate revision readiness or provenance failed")
    command(
        "python3",
        "scripts/ci/verify-cloudrun-revision-provenance.py",
        "--project",
        PROJECT,
        "--region",
        REGION,
        "--service",
        SERVICE,
        "--expected-env",
        "uat",
        "--expected-source",
        SOURCE,
        "--expected-sha",
        target_sha,
        "--expected-run-id",
        run_id,
        "--candidate-revision",
        candidate,
        "--candidate-tag",
        tag,
        "--expected-image-reference",
        image,
        "--report-path",
        str(Path(os.environ["RUNNER_TEMP"]) / "uat-one-chat-candidate-provenance.json"),
    )
    for attempt in range(5):
        try:
            with urllib.request.urlopen(
                f"{url.rstrip('/')}/health", timeout=15
            ) as response:  # noqa: S310 - verified Cloud Run HTTPS URL
                if response.status == 200:
                    return candidate, url
        except Exception:  # noqa: BLE001 - bounded retry before promotion
            if attempt == 4:
                raise RuntimeError("Candidate backend health probe failed") from None
            time.sleep(3)
    raise RuntimeError("Candidate backend health probe failed")


def probe_runtime(image: str, run_id: str, attempt: str) -> dict[str, Any]:
    job = f"one-chat-ready-{run_id}-{attempt}"
    created = False
    try:
        command(
            "gcloud",
            "run",
            "jobs",
            "deploy",
            job,
            f"--project={PROJECT}",
            f"--region={REGION}",
            f"--image={image}",
            f"--service-account={RUNTIME_SA}",
            "--clear-secrets",
            "--command=python3",
            "--args=scripts/verify_managed_vertex_runtime.py",
            "--set-env-vars=^|^"
            + "|".join(
                (
                    "HUSHH_GENAI_AUTH_MODE=vertex_adc",
                    "GOOGLE_GENAI_USE_VERTEXAI=true",
                    f"GOOGLE_CLOUD_PROJECT={PROJECT}",
                    "GENAI_GOOGLE_CLOUD_PROJECT=hushh-vertex-personal54",
                    f"HUSHH_ONE_CHAT_VERTEX_PROJECT={CHAT_PROJECT}",
                    "HUSHH_MANAGED_VERTEX_PROBE_MODE=one_chat",
                    "GOOGLE_CLOUD_LOCATION=global",
                    "HUSHH_VERTEX_LOCATIONS=global,us,eu",
                    "HUSSH_GEMINI_TEXT_MODEL=gemini-3.6-flash",
                )
            ),
            "--max-retries=0",
            "--task-timeout=90s",
            "--quiet",
        )
        created = True
        execution = command(
            "gcloud",
            "run",
            "jobs",
            "execute",
            job,
            f"--project={PROJECT}",
            f"--region={REGION}",
            "--wait",
            "--quiet",
            check=False,
        )
        execution_name = output(
            "gcloud",
            "run",
            "jobs",
            "executions",
            "list",
            f"--job={job}",
            f"--project={PROJECT}",
            f"--region={REGION}",
            "--limit=1",
            "--sort-by=~metadata.creationTimestamp",
            "--format=value(metadata.name)",
        )
        if not execution_name:
            raise RuntimeError("One chat readiness execution is missing")
        line = ""
        for _ in range(6):
            line = command(
                "gcloud",
                "logging",
                "read",
                "resource.type=cloud_run_job AND "
                f'labels."run.googleapis.com/execution_name"="{execution_name}" AND '
                "textPayload:managed_vertex_probe_result",
                f"--project={PROJECT}",
                "--limit=1",
                "--format=value(textPayload)",
                "--freshness=1h",
                capture=True,
                check=False,
            ).stdout.strip()
            if line:
                break
            time.sleep(10)
        marker = "managed_vertex_probe_result"
        if marker not in line:
            raise RuntimeError("One chat readiness verdict is missing")
        verdict = json.loads(line.split(marker, 1)[1].strip())
        if (
            execution.returncode != 0
            or verdict.get("one_chat_project") != CHAT_PROJECT
            or verdict.get("one_chat_probe_ok") is not True
        ):
            raise RuntimeError(
                "UAT runtime identity could not use the One chat Vertex target"
            )
        return verdict
    finally:
        if created:
            command(
                "gcloud",
                "run",
                "jobs",
                "delete",
                job,
                f"--project={PROJECT}",
                f"--region={REGION}",
                "--quiet",
            )


def promote(
    candidate: str, old_revision: str, target_sha: str, run_id: str, temp: Path
) -> None:
    if serving_revision(service_state()) != old_revision:
        raise RuntimeError("UAT backend traffic changed before promotion")
    command(
        "gcloud",
        "run",
        "services",
        "update-traffic",
        SERVICE,
        f"--project={PROJECT}",
        f"--region={REGION}",
        f"--to-revisions={candidate}=100",
        "--quiet",
    )
    if serving_revision(service_state()) != candidate:
        raise RuntimeError("Backend traffic did not move to the verified candidate")
    command(
        "python3",
        "scripts/ci/verify-cloudrun-revision-provenance.py",
        "--project",
        PROJECT,
        "--region",
        REGION,
        "--service",
        SERVICE,
        "--expected-env",
        "uat",
        "--expected-source",
        SOURCE,
        "--expected-sha",
        target_sha,
        "--expected-run-id",
        run_id,
        "--report-path",
        str(temp / "uat-one-chat-provenance.json"),
    )


def live_traffic() -> dict[str, int]:
    return {
        str(entry.get("revisionName") or ""): int(entry.get("percent") or 0)
        for entry in (service_state().get("status") or {}).get("traffic") or []
        if int(entry.get("percent") or 0) > 0
    }


def remove_candidate_tag(tag: str) -> bool:
    before = service_state()
    tagged = [
        entry
        for entry in (before.get("status") or {}).get("traffic") or []
        if entry.get("tag") == tag
    ]
    if not tagged:
        return False
    traffic_before = live_traffic()
    command(
        "gcloud",
        "run",
        "services",
        "update-traffic",
        SERVICE,
        f"--project={PROJECT}",
        f"--region={REGION}",
        f"--remove-tags={tag}",
        "--quiet",
    )
    after = service_state()
    if any(
        entry.get("tag") == tag
        for entry in (after.get("status") or {}).get("traffic") or []
    ):
        raise RuntimeError("Candidate tag remains reachable after cleanup")
    if live_traffic() != traffic_before:
        raise RuntimeError("Candidate tag cleanup changed backend traffic")
    return True


def main() -> int:
    target_sha = os.environ["TARGET_SHA"]
    run_id = os.environ["GITHUB_RUN_ID"]
    attempt = os.environ.get("GITHUB_RUN_ATTEMPT", "1")
    temp = Path(os.environ["RUNNER_TEMP"])
    evidence = temp / "uat-one-chat-release.json"
    report: dict[str, Any] = {
        "project": PROJECT,
        "region": REGION,
        "service": SERVICE,
        "target_sha": target_sha,
        "run_id": run_id,
        "status": "blocked",
    }
    old_revision = ""
    candidate = ""
    tag = f"one-chat-{run_id}-{attempt}"
    try:
        if not (
            len(target_sha) == 40 and all(c in "0123456789abcdef" for c in target_sha)
        ):
            raise RuntimeError("Target must be an exact lowercase Git SHA")
        if not (run_id.isdecimal() and attempt.isdecimal()):
            raise RuntimeError("GitHub run ID and attempt must be numeric")
        old_revision, base_sha = preflight(target_sha)
        report.update(old_revision=old_revision, base_sha=base_sha)
        print(
            f"Service-only preflight passed from {base_sha} to {target_sha}", flush=True
        )
        image = build_image(target_sha, temp)
        report["image"] = image
        candidate, url = deploy_candidate(
            image, target_sha, run_id, attempt, old_revision
        )
        report.update(candidate_revision=candidate, candidate_url=url)
        report["probe"] = probe_runtime(image, run_id, attempt)
        report["temporary_probe_job_deleted"] = True
        promote(candidate, old_revision, target_sha, run_id, temp)
        report["candidate_tag_removed"] = remove_candidate_tag(tag)
        report["final_traffic"] = live_traffic()
        if report["final_traffic"] != {candidate: 100}:
            raise RuntimeError("Final backend traffic is not 100% verified candidate")
        report["final_serving_revision"] = candidate
        report["status"] = "success"
        return 0
    except Exception as exc:  # noqa: BLE001 - preserve release evidence and rollback
        report["error"] = f"{type(exc).__name__}: {exc}"
        print(report["error"], file=sys.stderr)
        if old_revision:
            try:
                service = service_state()
                tagged = [
                    entry
                    for entry in (service.get("status") or {}).get("traffic") or []
                    if entry.get("tag") == tag
                ]
                if tagged and not candidate:
                    candidate = str(tagged[0].get("revisionName") or "")
                    if candidate:
                        report["candidate_revision"] = candidate
                report["candidate_tag_removed"] = remove_candidate_tag(tag)
            except Exception as cleanup_error:  # noqa: BLE001 - retain rollback attempt
                report["candidate_tag_cleanup_error"] = str(cleanup_error)
        if old_revision and candidate:
            try:
                traffic = live_traffic()
                if set(traffic) - {old_revision, candidate}:
                    raise RuntimeError(
                        "Unknown revision receives backend traffic; refusing rollback"
                    )
                if traffic.get(candidate, 0) > 0:
                    command(
                        "gcloud",
                        "run",
                        "services",
                        "update-traffic",
                        SERVICE,
                        f"--project={PROJECT}",
                        f"--region={REGION}",
                        f"--to-revisions={old_revision}=100",
                        "--quiet",
                    )
                    if live_traffic() != {old_revision: 100}:
                        raise RuntimeError(
                            "Rollback did not restore 100% old backend traffic"
                        )
                    report["rollback"] = True
                    report["status"] = "rolled_back"
            except Exception as rollback_error:  # noqa: BLE001 - include failure in receipt
                report["rollback_error"] = str(rollback_error)
                report["status"] = "rollback_failed"
        if (
            "candidate_tag_cleanup_error" in report
            and report["status"] != "rollback_failed"
        ):
            report["status"] = "cleanup_failed"
        return 1
    finally:
        if "final_traffic" not in report or report["status"] != "success":
            try:
                report["final_traffic"] = live_traffic()
                if (
                    len(report["final_traffic"]) == 1
                    and 100 in report["final_traffic"].values()
                ):
                    report["final_serving_revision"] = next(
                        iter(report["final_traffic"])
                    )
            except Exception as exc:  # noqa: BLE001 - retain primary release result
                report["final_traffic_error"] = f"{type(exc).__name__}: {exc}"
        evidence.write_text(
            json.dumps(report, indent=2, sort_keys=True), encoding="utf-8"
        )


if __name__ == "__main__":
    raise SystemExit(main())
