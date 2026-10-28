#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Activate a Main-reviewed Dev catalog while preserving the serving application.

No caller-provided pin path or qualification booleans are accepted. Main review
must establish the truth of the pinned native receipts, not merely their hashes.
Uncertain provider outcomes are retained; a retry never follows a changed baseline.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import google.auth
from google.auth.transport.requests import AuthorizedSession
from pod_publication import (
    SERVICE,
    already_active,
    baseline,
    candidate_patch,
    require_baseline,
    require_candidate,
    require_native_revision,
    traffic_targets,
)
from pod_publication_evidence import (
    read_object,
    validate_pin,
    verify_build_artifacts,
    verify_evidence,
    verify_preparation_attempt,
)

ROOT = Path(__file__).resolve().parents[2]
BASE_URL = "https://run.googleapis.com/v2/"


def command(*args: str) -> bytes:
    result = subprocess.run(
        args, cwd=ROOT, capture_output=True, timeout=60, check=False
    )  # noqa: S603 -- fixed tools and validated arguments.
    if result.returncode:
        raise ValueError("Publication authority or provenance check failed")
    return result.stdout


def api(session, method: str, path: str, *, body=None, mask=None) -> dict:
    response = session.request(
        method,
        BASE_URL + path,
        json=body,
        params={"updateMask": mask} if mask else None,
        timeout=30,
        allow_redirects=False,
    )
    if response.status_code != 200:
        raise ValueError(f"Cloud Run {method} refused: HTTP{response.status_code}")
    return response.json()


def settled(session, operation: dict, save) -> dict:
    deadline = time.monotonic() + 300
    while not operation.get("done"):
        if time.monotonic() > deadline:
            raise TimeoutError(
                "Publication outcome uncertain; reconcile the retained operation"
            )
        time.sleep(3)
        operation = api(session, "GET", operation["name"])
    if operation.get("error"):
        raise ValueError(
            "Publication operation failed; inspect its retained native identity"
        )
    save("operation_complete")
    return api(session, "GET", SERVICE)


def health(url: str) -> None:
    from urllib.parse import urlsplit

    parsed = urlsplit(url)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or not parsed.hostname.endswith(".run.app")
        or parsed.username
        or parsed.query
    ):
        raise ValueError("Unexpected native candidate URL")
    # The Dev application is already public; never send the deployment credential to it.
    import requests

    with requests.Session() as public:
        try:
            response = public.get(
                url.rstrip("/") + "/health", timeout=30, allow_redirects=False
            )
        except requests.RequestException as error:
            raise ValueError("Native candidate health is unavailable") from error
        if response.status_code != 200:
            raise ValueError("Catalog candidate health failed")


def reviewed_release(session, pin: dict, *, source: str) -> tuple[dict, list]:
    sys.path.insert(0, str(ROOT / "consent-protocol"))
    spec = importlib.util.spec_from_file_location(
        "pod_release_reuse", ROOT / "scripts/deploy/reuse-pod-release.py"
    )
    if spec is None or spec.loader is None:
        raise ValueError("Existing release contract is unavailable")
    reuse = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(reuse)
    release_pin = reuse.validate_pin(pin["release"], project="hushh-pda-dev")
    if pin["descriptorSourceRevision"] != source:
        raise ValueError("Requested descriptor differs from the reviewed pin")
    reuse.require_unchanged_image_context(release_pin, source)
    object_name = f"pod-releases/{release_pin['sourceRevision']}/{release_pin['runId']}/release.json"
    raw = read_object(session, object_name, limit=reuse.contract.MAX_RELEASE_BYTES)
    release = reuse.validate_archive(release_pin, raw, project="hushh-pda-dev")
    build = session.get(
        "https://cloudbuild.googleapis.com/v1/projects/hushh-pda-dev/builds/"
        + pin["preparationBuildId"],
        timeout=30,
        allow_redirects=False,
    )
    if build.status_code != 200:
        raise ValueError("Native preparation build is unreadable")
    observed = build.json()
    substitutions = observed.get("substitutions", {})
    if (
        observed.get("status") != "SUCCESS"
        or substitutions.get("_DEPLOY_SHA") != source
        or substitutions.get("_GITHUB_RUN_ID") != release_pin["runId"]
        or substitutions.get("_DEPLOY_ENV") != "dev"
        or substitutions.get("_BUILD_POD_IMAGE") != "true"
    ):
        raise ValueError("Native build does not establish this prepared artifact")
    if [s.get("id") for s in observed.get("steps", [])] != [
        "build-pod-image",
        "resolve-pod-image-digest",
        "publish-azure-pod-release",
    ]:
        raise ValueError("Publication requires the isolated preparation build")
    verify_build_artifacts(session, observed, pin, release, raw, reuse.resolver)
    run = json.loads(
        command(
            "gh",
            "api",
            f"repos/hushh-labs/hushh-research/actions/runs/{release_pin['runId']}",
        )
    )
    if (
        run.get("event") != "workflow_dispatch"
        or run.get("head_branch") != "main"
        or run.get("path") != ".github/workflows/deploy-dev.yml"
        or run.get("conclusion") != "success"
    ):
        raise ValueError("Preparation workflow is not a successful Main-owned release")
    command("git", "merge-base", "--is-ancestor", run["head_sha"], "HEAD")
    verify_preparation_attempt(command, run, pin, raw)
    return release, verify_evidence(session, pin, release)


def rollback_owned_publication(
    session, original: dict, expected: dict, promoted: dict, save
) -> None:
    """Restore only this operation's traffic, with fresh native ownership proof."""
    latest = api(session, "GET", SERVICE)
    require_candidate(latest, original, expected, etag=promoted["etag"])
    save("rollback_intent")
    rollback = api(
        session,
        "PATCH",
        SERVICE,
        body={
            "name": SERVICE,
            "etag": latest["etag"],
            "traffic": original["traffic"],
        },
        mask="traffic",
    )
    save("rollback_requested", operation=rollback["name"])
    restored = settled(session, rollback, save)
    if (
        traffic_targets(restored.get("traffic", []))
        != traffic_targets(original["traffic"])
        or restored.get("uid") != original["uid"]
        or restored.get("reconciling")
        or restored.get("terminalCondition", {}).get("state") != "CONDITION_SUCCEEDED"
        or sorted(
            (t["revision"], t["percent"])
            for t in restored.get("trafficStatuses", [])
            if t.get("percent", 0)
        )
        != sorted(
            (t["revision"], t["percent"])
            for t in original.get("trafficStatuses", [])
            if t.get("percent", 0)
        )
    ):
        raise ValueError("Rollback outcome requires reconciliation")
    save("rolled_back")


def activate(session, pin: dict, release: dict, *, sha: str, run: str, save) -> dict:
    original = api(session, "GET", SERVICE)
    if already_active(original, pin["baseline"], release):
        save("already_activated", candidate=baseline(original)["revision"])
        return original
    require_baseline(original, pin["baseline"])
    patch = candidate_patch(original, release, sha=sha, run=run)
    # Etag is supplied on both writes. No read-modify-write retry may follow drift.
    save(
        "candidate_create_intent",
        baseline=pin["baseline"],
        candidate=patch["template"]["revision"],
    )
    operation = api(session, "PATCH", SERVICE, body=patch, mask="template,traffic")
    save("candidate_create_requested", operation=operation["name"])
    candidate = settled(session, operation, save)
    require_candidate(candidate, original, patch, etag=candidate["etag"])
    require_native_revision(
        api(session, "GET", SERVICE + "/revisions/" + patch["template"]["revision"]),
        patch["template"],
    )
    target = next(
        (
            t
            for t in candidate.get("trafficStatuses", [])
            if t.get("tag") == "podpub-" + run
            and t.get("revision") == patch["template"]["revision"]
        ),
        None,
    )
    if target is None:
        raise ValueError("Native zero-traffic candidate URL is unavailable")
    health(target["uri"])
    current = api(session, "GET", SERVICE)
    require_candidate(current, original, patch, etag=candidate["etag"])
    traffic = [
        {
            **t,
            "percent": 100 if t.get("revision") == patch["template"]["revision"] else 0,
        }
        for t in patch["traffic"]
    ]
    save("promotion_intent")
    operation = api(
        session,
        "PATCH",
        SERVICE,
        body={"name": SERVICE, "etag": current["etag"], "traffic": traffic},
        mask="traffic",
    )
    save("promotion_requested", operation=operation["name"])
    promoted = settled(session, operation, save)
    expected = {**patch, "traffic": traffic}
    require_candidate(promoted, original, expected, etag=promoted["etag"])
    try:
        health(promoted["uri"])
    except ValueError:
        # Restore traffic only if this exact publication still owns the service.
        rollback_owned_publication(session, original, expected, promoted, save)
        raise
    save(
        "activated",
        applicationSource=pin["baseline"]["applicationSource"],
        podSource=release["sourceRevision"],
        image=release["image"],
    )
    return promoted


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--inspect", action="store_true")
    args = parser.parse_args()
    sha, run = os.environ.get("GITHUB_SHA", ""), os.environ.get("GITHUB_RUN_ID", "")
    if (
        os.environ.get("GITHUB_REF") != "refs/heads/main"
        or command("git", "rev-parse", "HEAD").decode().strip() != sha
    ):
        raise ValueError(
            "Catalog operations require the exact Main-owned workflow checkout"
        )
    credentials, _ = google.auth.default(
        scopes=["https://www.googleapis.com/auth/cloud-platform"]
    )
    state = {"environment": "dev", "publicationSource": sha, "run": run}

    def save(phase, **fields):
        state.update(phase=phase, **fields)
        args.output.write_text(json.dumps(state, indent=2) + "\n")

    with AuthorizedSession(credentials) as session:
        if args.inspect:
            save("baseline_observed", baseline=baseline(api(session, "GET", SERVICE)))
            return
        path = ROOT / "deploy/pod-publication.json"
        save("activation_preflight")
        command("git", "ls-files", "--error-unmatch", str(path.relative_to(ROOT)))
        command(
            "git",
            "diff",
            "--exit-code",
            "HEAD",
            "--",
            str(path.relative_to(ROOT)),
            "scripts/deploy",
        )
        raw = path.read_bytes()
        if len(raw) > 16384:
            raise ValueError("Reviewed activation pin exceeds its bound")
        pin = validate_pin(json.loads(raw))
        save("qualification_check", pinSha256=hashlib.sha256(raw).hexdigest())
        release, evidence = reviewed_release(session, pin, source=args.source)
        save("qualified", evidence=evidence)
        # An unchanged application still creates one candidate revision.
        command(
            sys.executable,
            "scripts/ci/runtime-capacity-budget.py",
            "--environment",
            "dev",
            "--candidate-service",
            "consent-protocol",
            "--output",
            "json",
        )
        activate(session, pin, release, sha=sha, run=run, save=save)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Provider bodies and application environments may contain private values.
        print(
            f"Pod publication refused ({type(error).__name__}); inspect retained phase/provenance.",
            file=sys.stderr,
        )
        raise SystemExit(1) from None
