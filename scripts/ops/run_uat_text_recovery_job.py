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


# The client also waits for scheduling and cold startup. A 180-second client
# deadline cancelled a run that emitted its completed receipt after 210 seconds.
# Allow startup and observation headroom without increasing the separate
# 120-second task / 90-second recovery limits or adding an execution attempt.
# Provisioning is not a latency guarantee; a true client timeout stays unverified.
EXECUTION_WAIT_SECONDS = 900


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


def execute_job(name: str, *, sha: str, common: list[str]):
    try:
        return subprocess.run(
            ["gcloud", "run", "jobs", "execute", name, "--wait", "--format=json", *common],
            check=True,
            timeout=EXECUTION_WAIT_SECONDS,
            capture_output=True,
            text=True,
        )
    except subprocess.TimeoutExpired:
        # Durable changes may precede the receipt. Record uncertainty before
        # cleanup; never repeat apply or report completion here.
        print(json.dumps({
            "uat_processor_recovery_job": "wait_timed_out",
            "job": name,
            "sha": sha,
            "outcome": "unverified",
        }), flush=True)
        raise


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
            execution = execute_job(name, sha=args.sha, common=common)
            execution_name = json.loads(execution.stdout)["metadata"]["name"].rsplit("/", 1)[-1]
            if not re.fullmatch(r"[a-z0-9-]+", execution_name) or not execution_name.startswith(
                name + "-"
            ):
                raise ValueError("Invalid recovery execution identity")
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
        proof = {
            "uat_processor_recovery_job": "completed",
            "job": name,
            "sha": args.sha,
            "receipts": receipts,
        }
        Path("/tmp/uat-text-recovery-proof.json").write_text(json.dumps(proof))
        print(json.dumps(proof))
    finally:
        subprocess.run(
            ["gcloud", "run", "jobs", "delete", name, *common],
            check=True,
            timeout=120,
            capture_output=True,
        )


if __name__ == "__main__":
    main()
