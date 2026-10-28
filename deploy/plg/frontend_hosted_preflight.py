"""Prepare local, non-authorizing hosted frontend build inputs.

No provider mutation, build submission, hosted artifact publication, or traffic
operation is performed. The separate fixture caller owns hosted admission.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import frontend_hosted_caller as caller
import frontend_backend_pair as backend_pair
import frontend_backend_target_recipe as backend_target
import frontend_pinned_recipe as pinned
import frontend_release as release
import frontend_secret_inventory as secrets
import frontend_fixture_runtime as fixture


def context(environment):
    release.require(
        environment in release.TARGETS, "Frontend preflight environment invalid"
    )
    workflow = release.WORKFLOWS[environment]
    release.require(
        os.environ.get("GITHUB_ACTIONS") == "true"
        and os.environ.get("GITHUB_REPOSITORY") == "hushh-labs/hushh-research"
        and os.environ.get("GITHUB_EVENT_NAME") == "workflow_dispatch"
        and os.environ.get("GITHUB_REF") == "refs/heads/main"
        and os.environ.get("GITHUB_WORKFLOW_REF")
        == f"hushh-labs/hushh-research/{workflow}@refs/heads/main",
        "Frontend preflight hosted context invalid",
    )
    return release.Attempt(
        environment,
        os.environ.get("GITHUB_SHA", ""),
        os.environ.get("GITHUB_RUN_ID", ""),
        os.environ.get("GITHUB_RUN_ATTEMPT", ""),
    )


def prepare(environment, validation_run, *, runner_temp, backend_run=None):
    """Prepare exclusive local proposal; no secret values or provider writes."""
    if backend_run is None:
        stale_token = os.environ.pop("PLG_QUALIFICATION_ID_TOKEN", "")
        release.require(not stale_token, "Frontend preflight unexpected backend token")
        return _prepare(
            environment,
            validation_run,
            runner_temp=runner_temp,
            backend_run=None,
            token=None,
        )
    token = os.environ.pop("PLG_QUALIFICATION_ID_TOKEN", "")
    release.require(
        type(backend_run) is int and backend_run > 0,
        "Frontend preflight backend run invalid",
    )
    release.require(bool(token), "Frontend preflight backend token unavailable")
    try:
        return _prepare(
            environment,
            validation_run,
            runner_temp=runner_temp,
            backend_run=backend_run,
            token=token,
        )
    finally:
        token = ""


def _prepare(environment, validation_run, *, runner_temp, backend_run, token):
    attempt = context(environment)
    release.require(
        type(validation_run) is int and validation_run > 0,
        "Frontend preflight validation invalid",
    )
    # Reject unreviewed workflow/authority before requesting provider metadata.
    before_authority = release.reviewed_inputs(attempt)
    folder = _owned_folder(attempt, runner_temp)
    # Any failure leaves the exclusive directory untrusted; it cannot be reused.
    pair = (
        backend_pair.inspect(environment, backend_run, id_token=token)
        if backend_run is not None
        else None
    )
    fixture_backend = backend_run is not None
    before = secrets.snapshot(environment, fixture_backend=fixture_backend)
    recipe, prepared = pinned.prepare_local(
        attempt,
        validation_run,
        before["inventory"],
        folder / "source.tar.gz",
        fixture_backend=fixture_backend,
    )
    after = secrets.snapshot(environment, fixture_backend=fixture_backend)
    release.require(
        before == after
        and release.reviewed_inputs(attempt) == before_authority
        and release.frontend_validation.verify(validation_run, release.SOURCE)
        == prepared.get("sourceValidation"),
        "Frontend preflight metadata changed",
    )
    original_recipe = release.source.backend._git(
        "show", f"{attempt.workflow_sha}:deploy/frontend-image.cloudbuild.yaml"
    )
    original_overlays = {
        name: release.source.backend._git("show", f"{attempt.workflow_sha}:{name}")
        for name in release.OVERLAYS
    }
    recipe = _bind_backend(
        attempt,
        pair,
        backend_run,
        token,
        recipe,
        prepared,
        before,
        before_authority,
        validation_run,
        original_recipe,
        original_overlays,
    )
    intent = caller.proposed_build_intent(
        attempt, prepared, before, recipe, original_recipe, original_overlays
    )
    for name, value in (
        ("build.yaml", recipe),
        (
            "prepared.json",
            json.dumps(prepared, sort_keys=True, separators=(",", ":")).encode()
            + b"\n",
        ),
        (
            "intent.json",
            json.dumps(intent, sort_keys=True, separators=(",", ":")).encode() + b"\n",
        ),
    ):
        with (folder / name).open("xb") as stream:
            stream.write(value)
    return {
        "status": "local-proposal",
        "directory": str(folder),
        "artifactPublished": False,
        "providerVerified": False,
        "durableFenceVerified": False,
        "maySubmit": False,
    }


def _owned_folder(attempt, runner_temp):
    root = Path(runner_temp)
    runner_root = Path(os.environ.get("RUNNER_TEMP", ""))
    release.require(
        root.is_absolute() and runner_root.is_absolute(),
        "Frontend preflight directory invalid",
    )
    root = root.resolve(strict=True)
    release.require(
        root == runner_root.resolve(strict=True)
        and root.is_dir()
        and root != root.parent,
        "Frontend preflight directory invalid",
    )
    folder = (
        root
        / f"plg-frontend-preflight-{attempt.environment}-{attempt.run_id}-{attempt.run_attempt}"
    )
    folder.mkdir(mode=0o700)
    return folder


def _bind_backend(
    attempt,
    pair,
    backend_run,
    token,
    recipe,
    prepared,
    before,
    before_authority,
    validation_run,
    original_recipe,
    original_overlays,
):
    environment, fixture_backend = attempt.environment, backend_run is not None
    if pair is not None:
        release.require(
            pair.get("freshHealthProbeAttempted") is True
            and pair.get("freshAllowPolicyReadAttempted") is True,
            "Frontend preflight backend checks missing",
        )
        names = ("deploy/frontend-image.cloudbuild.yaml", *release.OVERLAYS)
        recipe, binding = backend_target.bind(
            recipe,
            pair,
            environment,
            inventory=before["inventory"],
            original_recipe=original_recipe,
            original_overlays=original_overlays,
            expected_hashes={name: before_authority[name] for name in names},
        )
        prepared["backendPair"], prepared["backendBinding"] = pair, binding
        recipe, prepared["fixtureRuntime"] = fixture.reviewed_bundle(
            attempt, pair, recipe, before_authority
        )
        release.require(
            backend_pair.inspect(environment, backend_run, id_token=token) == pair,
            "Frontend preflight backend changed",
        )
        release.require(
            secrets.snapshot(environment, fixture_backend=fixture_backend) == before
            and release.reviewed_inputs(attempt) == before_authority
            and release.frontend_validation.verify(validation_run, release.SOURCE)
            == prepared.get("sourceValidation"),
            "Frontend preflight final metadata changed",
        )
    return recipe
