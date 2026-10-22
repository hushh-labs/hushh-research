# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Certified observations during holds and governed obsolete-failure retirement."""
from __future__ import annotations

import re
import json
from pathlib import Path
from release_cadence import require, verify_child


ROOT = Path(__file__).resolve().parents[2]


def configuration() -> tuple[dict, dict]:
    policy = json.loads((ROOT / "config/release-cadence.json").read_text())
    require(policy.get("testflight_every") == 2 and policy.get("production_every") == 4,
            "Unexpected release cadence policy")
    require(re.fullmatch(r"automation/[a-z0-9-]+", policy.get("state_branch", "")), "Invalid state ref")
    require(all(type(policy.get(k)) is bool for k in ("enabled", "submit_for_review", "release_after_approval")),
            "Invalid cadence switches")
    require(not policy["release_after_approval"] or policy["submit_for_review"], "Publication needs review submission")
    governance = json.loads((ROOT / "config/ci-governance.json").read_text())
    return policy, governance


def disabled_snapshot(repository: str, controller_id: int, event: dict) -> dict:
    """Observe the last certificate during a hold, without advancing any work."""
    import release_cadence_github as github
    policy, governance = github.configuration()
    require(not policy["enabled"], "Disabled snapshot requires a release hold")
    github.verify_controller(github.run_info(repository, controller_id), repository, governance, event)
    ledger = github.Ledger(repository, policy["state_branch"])
    checkpoint = ledger.verify_checkpoint()
    require(ledger.state is not None and checkpoint is not None,
            "Disabled cadence has no certified ledger to report")
    return {"mode": "disabled", "state": ledger.state, "checkpoint": checkpoint}

def retire_obsolete_failures(ledger, before: int, reviewed_head: str, controller: dict) -> None:
    """Retire reviewed failures only with positive proof that native upload never ran."""
    import release_cadence_github as github
    require(controller["event"] == "workflow_dispatch", "Retirement requires a governed manual controller")
    github.verify_controller(controller, ledger.repository, github.configuration()[1])
    require(reviewed_head == ledger.head and re.fullmatch(r"[0-9a-f]{40}", reviewed_head),
            "Reviewed retirement head differs from the certified ledger")
    requests = ledger.state["requests"]
    require(str(before) in requests and before == max(map(int, requests)), "Retirement frontier must be the latest milestone")
    require(not any(child["state"] in {"running", "dispatching", "deferred"}
                    for request in requests.values() for child in request["lanes"].values()),
            "Retirement cannot race active or deferred releases")
    failures = {"failure", "cancelled", "timed_out", "action_required"}
    targets = [(ordinal, request, lane, child) for ordinal, request in requests.items() if int(ordinal) < before
               for lane, child in request["lanes"].items() if child["state"] in failures]
    require(0 < len(targets) <= 20, "Retirement needs one to twenty reviewed obsolete failures")
    native = {
        "testflight": ("Resolve automatic packaging before allocating macOS", {
            "Build and distribute normal UAT TestFlight build", "Process and distribute uploaded TestFlight build"}),
        "appstore": ("Admit automatic App Store version or defer without a Mac", {
            "Build, upload & prepare iOS App Store release", "Process and prepare uploaded App Store build"}),
    }
    # Validate every target before a single CAS mutation; never turn a live or
    # uncertain upload into a replacement dispatch.
    for ordinal, request, lane, child in targets:
        run = github.run_info(ledger.repository, child["run_id"])
        verify_child(ledger.state, run, ledger.repository, ordinal, str(request["origin_run_id"]))
        require(run["status"] == "completed" and run["conclusion"] == child["state"]
                and run.get("run_attempt", 1) == child.get("run_attempt", 1), "Retirement attempt changed; review again")
        if lane in native:
            failed_step, skipped_names = native[lane]
            jobs = github.api(f"{ledger.base}/actions/runs/{run['id']}/attempts/{run.get('run_attempt', 1)}/jobs?per_page=100")
            require(jobs["total_count"] == len(jobs["jobs"]) and skipped_names <= {job["name"] for job in jobs["jobs"]},
                    "Retirement native job evidence is incomplete")
            failed = [job for job in jobs["jobs"] if job.get("conclusion") != "skipped"]
            require(len(failed) == 1 and failed[0].get("conclusion") == "failure"
                    and [step["name"] for step in failed[0].get("steps", []) if step.get("conclusion") == "failure"] == [failed_step],
                    "Retirement requires a failed packaging preflight and skipped native jobs")
            require(all(not job.get("runner_name") for job in jobs["jobs"] if job["name"] in skipped_names),
                    "Retirement native work was allocated; inspect upload outcome")
        else:
            require(lane == "deploy", "Unsupported retirement lane")
            replacements = [(key, value) for key, value in requests.items() if int(key) > int(ordinal)
                            and value["lanes"].get("deploy", {}).get("state") == "success"]
            require(replacements, "Failed production deployment has no healthy recorded successor")
            key, replacement = max(replacements, key=lambda pair: int(pair[0]))
            identity = replacement["lanes"]["deploy"]["run_id"]
            successor = github.run_info(ledger.repository, identity)
            verify_child(ledger.state, successor, ledger.repository, key, str(replacement["origin_run_id"]))
            require(successor["status"] == "completed" and successor["conclusion"] == "success", "Production successor is not successful")
            value = github.receipt(ledger.repository, identity, "prod")
            require(value.get("sha") == replacement["sha"] and value.get("status") == "healthy" and value.get("scope") == "all"
                    and value.get("verification", {}).get("backend_provenance") == "success"
                    and value.get("verification", {}).get("backend_health") == "success"
                    and value.get("verification", {}).get("frontend_provenance") == "success"
                    and value.get("verification", {}).get("frontend_health") == "success"
                    and value.get("candidate", {}).get("backend_revision") == value.get("final", {}).get("backend_revision")
                    and value.get("final", {}).get("backend_revision")
                    and value.get("candidate", {}).get("frontend_revision") == value.get("final", {}).get("frontend_revision")
                    and value.get("final", {}).get("frontend_revision"), "Production successor receipt mismatch")
    for ordinal, request, lane, child in targets:
        child["retirement"] = {"previous_state": child["state"], "reviewed_head": reviewed_head,
                               "controller_run_id": controller["id"], "operator": controller["actor"]["login"],
                               "superseded_by_ordinal": before, "run_attempt": child.get("run_attempt", 1),
                               "reason": "obsolete_preupload_failure" if lane in native else "healthy_production_successor"}
        child["state"] = "superseded"
    ledger.save()
