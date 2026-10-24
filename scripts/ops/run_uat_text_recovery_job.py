#!/usr/bin/env python3
"""Run bounded recovery from the verified UAT serving revision, then remove the job."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import tempfile
import time
from pathlib import Path


def job_spec(service: dict, *, sha: str, run_id: str) -> dict:
    if not re.fullmatch(r"[0-9a-f]{40}", sha) or not re.fullmatch(r"[0-9]+", run_id):
        raise ValueError("Invalid release identity")
    traffic = [entry for entry in service["status"]["traffic"] if entry.get("percent", 0) > 0]
    if (
        len(traffic) != 1
        or traffic[0]["percent"] != 100
        or traffic[0].get("revisionName") != service["status"]["latestReadyRevisionName"]
    ):
        raise ValueError("Recovery requires the verified sole serving revision")
    template = service["spec"]["template"]
    runtime = template["spec"]
    container = runtime["containers"][0]
    env = {entry["name"]: entry.get("value") for entry in container.get("env", [])}
    if env.get("ENVIRONMENT") != "uat" or env.get("HUSHH_DEPLOY_SHA") != sha:
        raise ValueError("Recovery is limited to this UAT release")
    if (
        runtime.get("serviceAccountName")
        != "consent-protocol-runtime@hushh-pda-uat.iam.gserviceaccount.com"
    ):
        raise ValueError("Unexpected runtime identity")
    if not re.fullmatch(
        r"gcr.io/hushh-pda-uat/consent-protocol@sha256:[0-9a-f]{64}", container["image"]
    ):
        raise ValueError("Recovery requires the exact pinned runtime image")
    annotations = template.get("metadata", {}).get("annotations", {})
    allowed_annotations = {
        key: value
        for key, value in annotations.items()
        if key
        in {
            "run.googleapis.com/secrets",
            "run.googleapis.com/execution-environment",
            "run.googleapis.com/cloudsql-instances",
            "run.googleapis.com/vpc-access-connector",
            "run.googleapis.com/vpc-access-egress",
        }
    }
    return {
        "apiVersion": "run.googleapis.com/v1",
        "kind": "Job",
        "metadata": {"name": f"text-policy-recovery-{run_id}"},
        "spec": {
            "template": {
                "metadata": {"annotations": allowed_annotations},
                "spec": {
                    "taskCount": 1,
                    "parallelism": 1,
                    "template": {
                        "spec": {
                            "serviceAccountName": runtime["serviceAccountName"],
                            "maxRetries": 0,
                            "timeoutSeconds": "120",
                            "containers": [
                                {
                                    "image": container["image"],
                                    "command": ["python3"],
                                    "args": [
                                        "scripts/recover_uat_text_requests.py",
                                        "--apply",
                                        "--limit=20",
                                    ],
                                    "env": container.get("env", []),
                                    "resources": {"limits": {"cpu": "1", "memory": "1Gi"}},
                                }
                            ],
                        }
                    },
                },
            }
        },
    }


def expected_policy_generation(spec: dict) -> str:
    """Bind the recovery receipt to the processor inherited by this exact job."""
    from uuid import UUID, uuid5

    entries = spec["spec"]["template"]["spec"]["template"]["spec"]["containers"][0]["env"]
    env = {entry["name"]: entry.get("value") for entry in entries}
    ai = env.get("HUSHH_UAT_MANAGED_AI_PROVIDER")
    text = env.get("HUSHH_UAT_MANAGED_TEXT_PROVIDER")
    selected = ai or text or "azure_openai"
    if selected not in {"azure_openai", "vertex"} or (ai and text and ai != text):
        raise ValueError("Recovery processor bindings disagree")
    policy = json.loads(
        (
            Path(__file__).resolve().parents[2] / "consent-protocol/config/managed-ai-runtime.json"
        ).read_text()
    )["private_drive_text_uat"]
    version = policy["version"] + (":vertex" if selected == "vertex" else "")
    return str(uuid5(UUID(policy["policy_id"]), version))


def wait_for_execution(execution_name: str, common: list[str]) -> bool:
    # Operational allowance: startup 240s + task 120s + settlement 60s.
    # Run 39949039317 took 207s; its 180s waiter deleted an active job.
    # Keep the worker limit, zero retries and exact receipt checks unchanged.
    deadline = time.monotonic() + 420
    while time.monotonic() < deadline:
        observed = subprocess.run(
            [
                "gcloud",
                "run",
                "jobs",
                "executions",
                "describe",
                execution_name,
                "--format=json",
                *common,
            ],
            check=True,
            timeout=30,
            capture_output=True,
            text=True,
        )
        state = json.loads(observed.stdout)
        if state.get("metadata", {}).get("name", "").rsplit("/", 1)[-1] != execution_name:
            raise ValueError("Recovery execution observation changed identity")
        completed = next(
            (
                item
                for item in state.get("status", {}).get("conditions", [])
                if item.get("type") == "Completed"
            ),
            {},
        )
        if completed.get("status") in {"True", "False"}:
            return completed["status"] == "True"
        time.sleep(min(5, max(0, deadline - time.monotonic())))
    raise TimeoutError("UAT recovery execution remains unconfirmed; reconcile before retry")


def recovery_receipts(execution_name: str, expected_generation: str) -> list[dict]:
    receipts = []
    for attempt in range(6):
        logs = subprocess.run(
            [
                "gcloud",
                "logging",
                "read",
                f'resource.type="cloud_run_job" AND labels."run.googleapis.com/execution_name"="{execution_name}" AND (jsonPayload.uat_processor_recovery:* OR textPayload:uat_processor_recovery)',
                "--project=hushh-pda-uat",
                "--freshness=1h",
                "--limit=5",
                "--format=json",
            ],
            check=True,
            timeout=30,
            capture_output=True,
            text=True,
        )
        for entry in json.loads(logs.stdout):
            value = entry.get("jsonPayload")
            if value is None:
                try:
                    value = json.loads(entry.get("textPayload", ""))
                except json.JSONDecodeError:
                    continue
            if isinstance(value, dict) and value.get("uat_processor_recovery") == "completed":
                if (
                    value.get("mode") != "apply"
                    or value.get("limit") != 20
                    or value.get("scan_limit") != 200
                    or value.get("policy_generation") != expected_generation
                ):
                    continue
                counts = value.get("counts", {})
                if set(counts) == {
                    "inspected",
                    "migrated",
                    "resumed",
                    "out_of_scope",
                    "already_current",
                    "legacy",
                    "refused",
                } and all(type(item) is int and 0 <= item <= 200 for item in counts.values()):
                    if counts["migrated"] + counts["resumed"] > 20:
                        continue
                    receipts.append(
                        {
                            "mode": value.get("mode"),
                            "policy_generation": expected_generation,
                            "counts": counts,
                        }
                    )
        if receipts:
            break
        if attempt < 5:
            time.sleep(5)
    if not receipts:
        raise ValueError("UAT processor recovery receipt is not yet available")
    return receipts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--service-json", type=Path, required=True)
    parser.add_argument("--sha", required=True)
    parser.add_argument("--run-id", required=True)
    args = parser.parse_args()
    spec = job_spec(json.loads(args.service_json.read_text()), sha=args.sha, run_id=args.run_id)
    expected_generation = expected_policy_generation(spec)
    name = spec["metadata"]["name"]
    common = ["--project=hushh-pda-uat", "--region=us-central1", "--quiet"]
    retained = subprocess.run(
        [
            "gcloud",
            "run",
            "jobs",
            "list",
            f"--filter=metadata.name={name}",
            "--limit=1",
            "--format=json(metadata.name)",
            *common,
        ],
        check=True,
        timeout=30,
        capture_output=True,
        text=True,
    )
    existing = json.loads(retained.stdout)
    if not isinstance(existing, list) or existing:
        raise ValueError("Recovery Job already exists; reconcile before retry")
    execution_requested = False
    execution_terminal = False
    execution_name = None
    try:
        with tempfile.TemporaryDirectory(prefix="uat-text-recovery-") as directory:
            path = Path(directory) / "job.json"
            path.write_text(json.dumps(spec))
            path.chmod(0o600)
            subprocess.run(
                ["gcloud", "run", "jobs", "replace", str(path), *common],
                check=True,
                timeout=120,
                capture_output=True,
            )
            execution_requested = True
            execution = subprocess.run(
                [
                    "gcloud",
                    "run",
                    "jobs",
                    "execute",
                    name,
                    "--async",
                    "--format=json",
                    *common,
                ],
                check=True,
                timeout=60,
                capture_output=True,
                text=True,
            )
            execution_name = json.loads(execution.stdout)["metadata"]["name"].rsplit("/", 1)[-1]
            if not re.fullmatch(r"[a-z0-9-]+", execution_name) or not execution_name.startswith(
                name + "-"
            ):
                raise ValueError("Invalid recovery execution identity")
        succeeded = wait_for_execution(execution_name, common)
        execution_terminal = True
        if not succeeded:
            raise ValueError("UAT recovery execution did not succeed")
        receipts = recovery_receipts(execution_name, expected_generation)
        proof = {
            "uat_processor_recovery_job": "completed",
            "job": name,
            "sha": args.sha,
            "receipts": receipts,
        }
        Path("/tmp/uat-text-recovery-proof.json").write_text(json.dumps(proof))
        print(json.dumps(proof))
    finally:
        if not execution_requested or execution_terminal:
            subprocess.run(
                ["gcloud", "run", "jobs", "delete", name, *common],
                check=True,
                timeout=120,
                capture_output=True,
            )
        else:
            # Retain the exact bounded worker for reconciliation; deleting its Job
            # can cancel already-started effects. Never call execute again here.
            print(
                json.dumps(
                    {
                        "uat_processor_recovery_job": "unconfirmed",
                        "job": name,
                        "execution": execution_name,
                        "sha": args.sha,
                    }
                )
            )


if __name__ == "__main__":
    main()
