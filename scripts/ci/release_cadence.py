# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Pure release accounting. GitHub transport and authority live in the adapter."""
from __future__ import annotations

import re
import hashlib
import json
from typing import Any

CONTROLLER = "release-cadence.yml"
WORKFLOWS = {
    "testflight": "ship-ios-testflight.yml",
    "deploy": "deploy-production.yml",
    "appstore": "release-ios-appstore.yml",
}
SHA = re.compile(r"[0-9a-f]{40}")


class UnsafeRelease(ValueError):
    """Missing or inconsistent release authority; never guess or redispatch."""


def state_digest(state: dict) -> str:
    return hashlib.sha256(json.dumps(state, sort_keys=True).encode()).hexdigest()


def require(condition: Any, message: str) -> None:
    if not condition:
        raise UnsafeRelease(message)


def trusted_run(run: dict, repository: str, workflow: str) -> bool:
    return (
        run.get("path") == f".github/workflows/{workflow}"
        and run.get("head_branch") == "main"
        and (run.get("repository") or {}).get("full_name") == repository
        and (run.get("head_repository") or {}).get("full_name") == repository
    )


def verified_uat(run: dict, receipt: dict, repository: str, actors: list[str]) -> str:
    require(trusted_run(run, repository, "deploy-uat.yml"), "Untrusted UAT source")
    require(run.get("event") == "workflow_dispatch", "UAT source is not a dispatch")
    require((run.get("actor") or {}).get("login") in actors, "Ungoverned UAT source actor")
    require(run.get("status") == "completed" and run.get("conclusion") == "success",
            "UAT source has not succeeded")
    sha = receipt.get("sha", "")
    require(isinstance(sha, str) and SHA.fullmatch(sha), "Invalid deployed source SHA")
    require(receipt.get("status") == "healthy", "UAT receipt is not healthy")
    scope = receipt.get("scope")
    require(scope in {"all", "frontend", "backend"}, "No-op or invalid UAT scope")
    final, verification = receipt.get("final", {}), receipt.get("verification", {})
    require(verification.get("provenance_success") == "true", "Unverified UAT provenance")
    for lane in ("backend", "frontend"):
        if scope in {"all", lane}:
            require(final.get(f"{lane}_sha") == sha and final.get(f"{lane}_revision"),
                    f"UAT {lane} does not prove this source")
    # A frontend-only receipt intentionally retains an older, verified backend.
    require(SHA.fullmatch(final.get("backend_sha", "")) and final.get("backend_revision"),
            "UAT receipt has no backend lineage")
    return sha


def new_state(activation_sha: str, activated_at: str) -> dict:
    require(SHA.fullmatch(activation_sha), "Invalid activation anchor")
    return {"schema_version": 1, "activation_sha": activation_sha,
            "activated_at": activated_at, "count": 0, "sources": {}, "requests": {}}


def source_receipt(receipt: dict) -> dict:
    return {"sha": receipt["sha"], "status": receipt["status"], "scope": receipt["scope"],
            "final": receipt["final"], "verification": {
                "provenance_success": receipt["verification"]["provenance_success"]}}


def account(state: dict, run: dict, receipt: dict, sha: str, origin: int, policy: dict) -> bool:
    """Idempotent per source commit, including reruns and duplicate dispatches."""
    if sha in state["sources"]:
        return False
    require(SHA.fullmatch(sha) and receipt.get("sha") == sha, "Source identity changed")
    state["count"] += 1
    ordinal = state["count"]
    source = {"ordinal": ordinal, "run_id": run["id"], "run_attempt": run.get("run_attempt", 1),
              "created_at": run["created_at"], "receipt": source_receipt(receipt)}
    state["sources"][sha] = source
    lanes = []
    if ordinal % policy["testflight_every"] == 0:
        lanes.append("testflight")
    if ordinal % policy["production_every"] == 0:
        lanes.extend(("deploy", "appstore"))
    if lanes:
        state["requests"][str(ordinal)] = {
            "sha": sha, "ordinal": ordinal, "uat_run_id": run["id"], "origin_run_id": origin,
            "submit_for_review": policy["submit_for_review"],
            "release_after_approval": policy["release_after_approval"],
            "lanes": {lane: {"state": "pending"} for lane in lanes},
        }
    return True


def marker(ordinal: str, request: dict, lane: str) -> str:
    return f"Cadence {ordinal} {lane} · {request['origin_run_id']}"


def dispatch_inputs(ordinal: str, request: dict, lane: str) -> dict[str, str]:
    inputs = {"sha": request["sha"], "cadence_origin": str(request["origin_run_id"]),
              "cadence_ordinal": ordinal}
    if lane == "deploy":
        inputs.update(scope="all", backend_image_source="build-from-source", run_predeploy_backup_job="false",
                      enable_one_email_kyc="false", drive_live_mode="preserve", nearby_check_in_cohort="all")
    elif lane == "testflight":
        inputs.update(dry_run="false", marketing_version="", require_hardware="false", run_core_tests="false", notes="")
    else:
        deployment = request["lanes"]["deploy"].get("run_id")
        require(deployment, "Production deployment identity must precede app dispatch")
        inputs.update(backend_target="production", dry_run="false",
                      production_deploy_run_id=str(deployment),
                      marketing_version="", notes="", whats_new="Stability improvements and bug fixes.",
                      submit_for_review=str(request["submit_for_review"]).lower(),
                      release_after_approval=str(request["release_after_approval"]).lower())
    return inputs


def verify_child(state: dict, run: dict, repository: str, ordinal: str, origin: str) -> tuple[dict, str]:
    require(state.get("schema_version") == 1, "Unsupported cadence state")
    require((run.get("actor") or {}).get("login") == "github-actions[bot]", "Not an automation actor")
    request = state["requests"].get(ordinal)
    require(request and str(request["origin_run_id"]) == origin, "Unknown cadence authority")
    require(request.get("ordinal") == int(ordinal), "Wrong cadence ordinal")
    for lane, child in request["lanes"].items():
        if child.get("run_id") == run.get("id"):
            require(trusted_run(run, repository, WORKFLOWS[lane]), "Wrong release workflow or repository")
            require(run.get("event") == "workflow_dispatch", "Wrong release event")
            require(run.get("display_title") == marker(ordinal, request, lane), "Release marker mismatch")
            source = state["sources"].get(request["sha"], {})
            require(source.get("ordinal") == int(ordinal) and source.get("run_id") == request["uat_run_id"],
                    "Missing verified source accounting")
            return request, lane
    raise UnsafeRelease("Dispatch identity is not recorded; no automation authority")
