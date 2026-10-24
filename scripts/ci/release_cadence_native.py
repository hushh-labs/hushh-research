# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Native release completion proof, including governed existing-upload recovery."""
from __future__ import annotations

import re
from urllib.parse import urlencode

from release_cadence import UnsafeRelease, require, trusted_run

UPLOAD_FIELDS = ("source_sha", "build_number", "marketing_version", "bundle_id")
RESUME = "resume-ios-testflight.yml"


def bind_recovery(upload_run: dict, upload: dict, run_id: int, attempt: int, distribution: dict) -> dict:
    require(distribution.get("internal") == "active" and distribution.get("build_id"),
            "Recovered TestFlight distribution is not active")
    return {**distribution, "schema_version": 1, "upload_run_id": upload_run["id"],
            "upload_run_attempt": upload_run.get("run_attempt", 1),
            "recovery_run_id": run_id, "recovery_run_attempt": attempt,
            **{field: upload[field] for field in UPLOAD_FIELDS}}


def valid_upload(upload: dict | None, sha: str) -> bool:
    return bool(isinstance(upload, dict) and upload.get("source_sha") == sha and upload.get("bundle_id") == "com.hushh.app"
                and re.fullmatch(r"[0-9]+", str(upload.get("build_number", "")))
                and re.fullmatch(r"[0-9]+(?:\.[0-9]+){1,2}", str(upload.get("marketing_version", ""))))


def completed_steps(repository: str, run: dict, name: str, steps: set[str]) -> bool:
    from release_cadence_github import api
    value = api(f"repos/{repository}/actions/runs/{run['id']}/attempts/{run.get('run_attempt', 1)}/jobs?per_page=100")
    require(isinstance(value, dict) and isinstance(value.get("jobs"), list)
            and value.get("total_count") == len(value["jobs"]), "TestFlight job evidence is truncated")
    jobs = [job for job in value["jobs"] if job.get("name") == name]
    return len(jobs) == 1 and jobs[0].get("conclusion") == "success" and steps <= {
        step["name"] for step in jobs[0].get("steps", []) if step.get("conclusion") == "success"}


def completion(repository: str, run: dict, sha: str) -> dict:
    """Read only; never replace the recorded child or grant dispatch authority."""
    from release_cadence_github import api, artifact_json, configuration
    require(run.get("status") == "completed", "TestFlight upload workflow is not terminal")
    upload = artifact_json(repository, run["id"], "testflight-upload-receipt", "testflight-upload-receipt.json")
    require(valid_upload(upload, sha), "TestFlight upload source or build identity mismatch")
    if run.get("conclusion") == "success" and completed_steps(repository, run,
            "Process and distribute uploaded TestFlight build", {
                "Wait for valid TestFlight processing", "Attach the same valid build to both TestFlight groups"}):
        distribution = artifact_json(repository, run["id"], f"one-voice-testflight-evidence-{sha}", "testflight-distribution.json", optional=True)
        if isinstance(distribution, dict) and distribution.get("internal") == "active" and distribution.get("build_id"):
            return {}
    # Recovery is uncommon: cap the single read instead of walking arbitrary
    # history in the short controller. A truncated inventory never proves delivery.
    query = urlencode({"branch": "main", "event": "workflow_dispatch", "created": ">=" + run["created_at"], "per_page": 20})
    inventory = api(f"repos/{repository}/actions/workflows/{RESUME}/runs?{query}")
    require(isinstance(inventory, dict) and type(inventory.get("total_count")) is int
            and isinstance(inventory.get("workflow_runs"), list) and 0 <= inventory["total_count"] <= 20
            and inventory["total_count"] == len(inventory["workflow_runs"]), "TestFlight recovery inventory is truncated")
    _, governance = configuration()
    allowed = governance["uat"]["manual_dispatch_users"]
    for recovery in inventory["workflow_runs"]:
        if not (trusted_run(recovery, repository, RESUME) and recovery.get("event") == "workflow_dispatch"
                and recovery.get("status") == "completed" and recovery.get("conclusion") == "success"
                and (recovery.get("actor") or {}).get("login") in allowed
                and (recovery.get("triggering_actor") or (recovery.get("actor") if recovery.get("run_attempt", 1) == 1 else {}) or {}).get("login") in allowed):
            continue
        value = artifact_json(repository, recovery["id"], "testflight-resumed-distribution", "testflight-distribution.json", optional=True)
        if not isinstance(value, dict) or value.get("upload_run_id") != run["id"]:
            continue
        if value.get("internal") != "active" or not value.get("build_id"):
            continue
        expected = bind_recovery(run, upload, recovery["id"], recovery.get("run_attempt", 1), value)
        if not all(value.get(field) == expected[field] for field in (
                "schema_version", "upload_run_id", "upload_run_attempt", "recovery_run_id", "recovery_run_attempt", *UPLOAD_FIELDS)):
            continue
        if not completed_steps(repository, recovery, "resume", {
            "Validate dispatch and original upload provenance", "Reconcile the existing uploaded build",
                "Resume idempotent group distribution", "Bind recovery evidence to the original upload"}):
            continue
        return {field: value[field] for field in ("recovery_run_id", "recovery_run_attempt")}
    require(False, "TestFlight processing and distribution are unverified; resume the existing upload")
    return {}  # Unreachable; keep the return type explicit for static tooling.


def settle_child(repository: str, request: dict, lane: str, child: dict, run: dict) -> None:
    from release_cadence_github import api, artifact_json
    if lane == "testflight" and run["status"] == "completed":
        child.pop("completion_error", None)
        child.pop("recovery", None)
        child["completion_verified"] = False
        try:
            child["recovery"] = completion(repository, run, request["sha"])
            child.update(state="success", completion_verified=True)
        except UnsafeRelease:
            unreadable = False
            try:
                uploaded = artifact_json(repository, run["id"], "testflight-upload-receipt", "testflight-upload-receipt.json", optional=True)
            except UnsafeRelease:
                uploaded, unreadable = None, True
            if child["state"] == "success" or unreadable or valid_upload(uploaded, request["sha"]):
                child.update(state="failure", completion_error="TestFlight distribution is unverified; resume the existing upload")
    if lane == "appstore" and child["state"] == "success":
        deferred = artifact_json(repository, run["id"], "ios-appstore-deferred", "ios-appstore-deferred.json", optional=True)
        if deferred:
            from datetime import datetime, timedelta, timezone
            require(deferred.get("sha") == request["sha"] and deferred.get("reason") == "apple_review_pending",
                    "Deferred App Store receipt mismatch")
            child.update(state="deferred", retry_after=(datetime.now(timezone.utc) + timedelta(hours=1)).isoformat())
        else:
            jobs = api(f"repos/{repository}/actions/runs/{run['id']}/jobs?filter=latest&per_page=100")
            require(jobs["total_count"] == len(jobs["jobs"]) and any(
                job.get("name") == "Process and prepare uploaded App Store build" and job.get("conclusion") == "success"
                and any(step.get("name") == "Prepare App Store version (set What's New, attach build; one-click submit)"
                        and step.get("conclusion") == "success" for step in job.get("steps", []))
                for job in jobs["jobs"]), "No positive App Store completion proof; a deferred receipt may have expired")


def wait_production(repository: str, run_id: int, sha: str, timeout: int = 3600) -> dict:
    import time
    from release_cadence import WORKFLOWS, trusted_run
    from release_cadence_github import configuration, receipt, recorded_authority, run_info
    deadline = time.monotonic() + timeout
    while True:
        run = run_info(repository, run_id)
        require(trusted_run(run, repository, WORKFLOWS["deploy"]) and run.get("event") == "workflow_dispatch",
                "Untrusted production deployment run")
        if run["status"] == "completed":
            break
        require(time.monotonic() < deadline, "Timed out waiting for production; upload remains blocked")
        time.sleep(15)
    _, governance = configuration()
    if (run.get("actor") or {}).get("login") not in governance["production"]["manual_dispatch_users"]:
        authority_deadline = min(deadline, time.monotonic() + 180)
        while True:
            try:
                request, lane = recorded_authority(repository, run)
                break
            except UnsafeRelease:
                require(time.monotonic() < authority_deadline, "Production controller authority is unavailable; upload blocked")
                time.sleep(5)
        require(lane == "deploy" and request["sha"] == sha, "Wrong automatic production source")
    require(run.get("conclusion") == "success", "Production deployment did not succeed; upload blocked")
    result = receipt(repository, run_id, "prod")
    require(result.get("status") == "healthy" and result.get("sha") == sha, "Production receipt is not healthy for this source")
    final, candidate = result.get("final", {}), result.get("candidate", {})
    require(final.get("backend_revision") and final["backend_revision"] == candidate.get("backend_revision") and
            result.get("verification", {}).get("backend_provenance") == "success" and
            result.get("verification", {}).get("backend_health") == "success", "Production backend receipt mismatch")
    return result
