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
    if "production_baseline_run_id" in policy:
        require(type(policy["production_baseline_run_id"]) is int and policy["production_baseline_run_id"] > 0,
                "Invalid production baseline run")
    governance = json.loads((ROOT / "config/ci-governance.json").read_text())
    return policy, governance


def replayed_receipt(repository: str, run_id: int, prefix: str) -> dict:
    """Reuse the deployment owner's exact-attempt upload and digest checks."""
    from datetime import datetime
    import tempfile
    import release_artifact_receipts as receipts
    import release_cadence_github as github
    from release_cadence import trusted_run
    environment = "uat" if prefix == "uat" else "production"
    lane = {"prefix": prefix, "deploy_job": "Deploy UAT Scope" if prefix == "uat" else "Deploy Production Scope",
            "upload_step": "Upload UAT deploy artifacts" if prefix == "uat" else "Upload production deploy artifacts"}
    _, governance = github.configuration()

    def governed(run, repo, surface):
        actor = (run.get("actor") or {}).get("login")
        retry = (run.get("triggering_actor") or {}).get("login")
        allowed = governance[surface]["manual_dispatch_users"]
        return (trusted_run(run, repo, "deploy-uat.yml" if prefix == "uat" else "deploy-production.yml")
                and run.get("event") == "workflow_dispatch" and run.get("status") == "completed"
                and (actor in allowed or surface == "production" and actor == "github-actions[bot]") and retry in allowed)

    def timestamp(value):
        try:
            result = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return result if result.tzinfo else None
        except (AttributeError, ValueError):
            return None

    try:
        artifact = receipts.resolve_replayed_artifact(
            repository, run_id, f"{prefix}-release-{run_id}", lane, environment,
            api=lambda repo, path: github.api(f"repos/{repo}/actions/{path}"),
            governed_dispatch=governed, timestamp=timestamp)
        with tempfile.TemporaryDirectory(prefix="release-cadence-receipt-") as directory:
            name = f"{prefix}-release-status.json"
            receipts.download_replayed_artifact(repository, artifact, Path(directory), name,
                                                run_command=receipts.retention.run_command, timeout=30)
            result = json.loads(Path(directory, name).read_text())
        require(isinstance(result, dict), "Invalid replayed release receipt")
        return result
    except receipts.retention.UnsafeState as exc:
        raise github.UnsafeRelease("Exact-attempt release receipt is unverified") from exc


def production_baseline(state: dict, policy: dict, repository: str, *, revalidate: bool = False) -> dict | None:
    """A one-time, real production cutover; never reset or invent UAT counts."""
    import release_cadence_github as github
    from release_cadence import SHA, state_digest, trusted_run
    identity = policy.get("production_baseline_run_id")
    existing = state.get("production_baseline")
    if identity is None:
        require(existing is None, "Cannot silently remove the production baseline")
        return None
    require(type(identity) is int and identity > 0, "Invalid production baseline run")
    if "production_baseline" in state:
        require(isinstance(existing, dict) and bool(existing), "Invalid certified production baseline")
        require(set(existing) == {"run_id", "run_attempt", "sha", "ordinal", "origin_run_id", "receipt_sha256"}
                and existing["run_id"] == identity and type(existing["run_attempt"]) is int and existing["run_attempt"] > 0
                and type(existing["origin_run_id"]) is int and existing["origin_run_id"] > 0
                and type(existing["ordinal"]) is int and 0 < existing["ordinal"] <= state["count"]
                and re.fullmatch(r"[0-9a-f]{64}", existing["receipt_sha256"])
                and state["sources"].get(existing["sha"], {}).get("ordinal") == existing["ordinal"],
                "Production baseline differs from certified source accounting")
        if not revalidate:
            return existing
    run = github.run_info(repository, identity)
    _, governance = github.configuration()
    allowed = governance["production"]["manual_dispatch_users"]
    require(run.get("id") == identity and trusted_run(run, repository, "deploy-production.yml") and run.get("event") == "workflow_dispatch"
            and run.get("status") == "completed" and run.get("conclusion") == "success"
            and (run.get("actor") or {}).get("login") in allowed
            and (run.get("triggering_actor") or run.get("actor") or {}).get("login") in allowed,
            "Production baseline needs a successful governed manual deployment")
    require(type(run.get("run_attempt")) is int and run["run_attempt"] > 0, "Invalid production baseline attempt")
    value = github.receipt(repository, identity, "prod")
    require(isinstance(value, dict), "Production baseline receipt is unavailable")
    sha = value.get("sha", "")
    source = state["sources"].get(sha, {})
    ordinal = source.get("ordinal")
    require(isinstance(sha, str) and SHA.fullmatch(sha) and value.get("status") == "healthy" and value.get("scope") == "all"
            and type(ordinal) is int and 0 < ordinal <= state["count"],
            "Production baseline has no complete counted UAT source")
    for lane in ("backend", "frontend"):
        revision = value.get("final", {}).get(f"{lane}_revision")
        # Production binds receipt.sha through each successful exact-source
        # provenance gate; unlike UAT, its final object contains revisions only.
        require(revision
                and revision == value.get("candidate", {}).get(f"{lane}_revision")
                and value.get("verification", {}).get(f"{lane}_provenance") == "success"
                and value.get("verification", {}).get(f"{lane}_health") == "success",
                "Production baseline lacks exact-source service health")
    if existing is not None:
        require((existing["sha"], existing["ordinal"], existing["run_attempt"]) ==
                (sha, ordinal, run["run_attempt"]) and existing["receipt_sha256"] == state_digest(value),
                "Production baseline attempt or receipt changed")
    return {"run_id": identity, "run_attempt": run["run_attempt"], "sha": sha, "ordinal": ordinal,
            "receipt_sha256": state_digest(value)}


def adopt_production_baseline(ledger, policy: dict, controller_id: int) -> None:
    baseline = production_baseline(ledger.state, policy, ledger.repository)
    if baseline is None or "production_baseline" in ledger.state:
        return
    targets = []
    for ordinal, request in ledger.state["requests"].items():
        if int(ordinal) > baseline["ordinal"]:
            continue
        for group in (("deploy", "appstore"), ("testflight",)):
            if not all(lane in request["lanes"] for lane in group):
                continue
            children = [request["lanes"][lane] for lane in group]
            require(not any(child["state"] in {"running", "dispatching", "deferred"}
                            or child["state"] == "pending" and child != {"state": "pending"} for child in children),
                    "Production cutover has started releases needing recovery")
            if all(child == {"state": "pending"} for child in children):
                targets.extend(children)
            else:
                require(not any(child["state"] == "pending" for child in children),
                        "Production cutover cannot retire a half-started pair")
    proof = {**baseline, "origin_run_id": controller_id}
    for child in targets:
        child.update(state="superseded", retirement={"reason": "production_first_cutover", **proof})
    ledger.state["production_baseline"] = proof


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
