"""Bind proposed frontend build evidence; never establish hosted acceptance.

Callers must authenticate their workflow, artifact, provider responses, secret
snapshot and durable intent independently. This module neither makes provider
requests nor authorizes Dev, UAT or production traffic.
"""

from __future__ import annotations

import hashlib
import json
import re

import frontend_release as release
import frontend_backend_target_recipe as backend_target
import frontend_pinned_recipe as pinned_recipe
import frontend_secret_pins as secret_pins
import frontend_fixture_runtime as fixture


def _digest(document):
    try:
        raw = json.dumps(
            document, sort_keys=True, separators=(",", ":"), allow_nan=False
        ).encode()
    except (TypeError, ValueError):
        raise release.Refused("Frontend build evidence invalid") from None
    release.require(len(raw) <= 1_048_576, "Frontend build evidence oversized")
    return hashlib.sha256(raw).hexdigest()


def check_validation(prepared, attempt, *, authority_paths=None):
    """Check the shape of proposed source authority; never authenticate it."""
    validation = prepared.get("sourceValidation")
    authority = prepared.get("authorityFiles")
    release.require(
        isinstance(validation, dict)
        and set(validation)
        == {
            "status",
            "scope",
            "sourceSha",
            "runId",
            "runAttempt",
            "artifactId",
            "artifactDigest",
            "trafficAuthorized",
            "environmentAccepted",
            "customerSendingAuthorized",
        }
        and validation.get("status") == "validated"
        and validation.get("scope") == "plg-frontend-source"
        and validation.get("sourceSha") == release.SOURCE
        and all(
            type(validation.get(key)) is int and validation[key] > 0
            for key in ("runId", "runAttempt", "artifactId")
        )
        and isinstance(validation.get("artifactDigest"), str)
        and re.fullmatch(r"sha256:[0-9a-f]{64}", validation["artifactDigest"])
        and all(
            validation.get(key) is False
            for key in (
                "trafficAuthorized",
                "environmentAccepted",
                "customerSendingAuthorized",
            )
        )
        and all(
            prepared.get(key) is False
            for key in (
                "providerVerified",
                "consumptionVerified",
                "environmentAccepted",
                "productionTrafficAuthorized",
            )
        ),
        "Frontend build validation invalid",
    )
    names = ("deploy/frontend-image.cloudbuild.yaml", *release.OVERLAYS)
    release.require(
        isinstance(authority, dict)
        and all(
            name in authority
            for name in (
                *(
                    release.AUTHORITY_PATHS
                    if authority_paths is None
                    else authority_paths
                ),
                *names,
                release.WORKFLOWS[attempt.environment],
            )
        )
        and all(
            isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value)
            for value in authority.values()
        ),
        "Frontend build authority unavailable",
    )
    return authority


def build_document(
    attempt,
    prepared,
    recipe,
    build,
    build_id,
    storage,
    service_account,
    index,
    child,
    original_recipe,
    original_overlays,
    *,
    authority_paths=None,
):
    """Validate supplied build and manifests, and bind their immutable identities."""
    pins, archive, inventory, fixture_backend = _build_inventory(
        attempt, prepared, recipe
    )
    expected_recipe, _expected_overlays, _expected_pins = derive_inputs(
        attempt,
        prepared,
        recipe,
        original_recipe,
        original_overlays,
        inventory,
        fixture_backend,
        authority_paths=authority_paths,
    )
    build_proof = release.check_build(
        build,
        attempt,
        recipe,
        archive["archiveSha256"],
        build_id,
        hashlib.sha256(expected_recipe).hexdigest(),
        storage,
        service_account,
    )
    image = release.verify_image_manifests(index, child, build_proof["indexDigest"])
    return {
        "kind": "proposed-plg-frontend-build-evidence-v1",
        "environment": attempt.environment,
        "project": attempt.project,
        "producer": {
            "workflowSha": attempt.workflow_sha,
            "runId": attempt.run_id,
            "runAttempt": attempt.run_attempt,
        },
        "preparedSha256": _digest(prepared),
        "sourceSha": release.SOURCE,
        "sourceTree": release.SOURCE_TREE,
        "archiveSha256": archive["archiveSha256"],
        "recipeSha256": hashlib.sha256(expected_recipe).hexdigest(),
        "backendTargetVerified": False,
        "secretInventorySha256": _digest(pins.get("versions")),
        "buildId": build_proof["buildId"],
        "storage": storage,
        "serviceAccount": service_account,
        "imageReference": f"gcr.io/{attempt.project}/hushh-webapp@{image['executableDigest']}",
        "indexDigest": image["indexDigest"],
        "platform": image["platform"],
        "hostedVerified": False,
        "providerVerified": False,
        "secretSnapshotVerified": False,
        "environmentAccepted": False,
        "productionTrafficAuthorized": False,
    }


def consume_document(
    document,
    attempt,
    prepared,
    recipe,
    build,
    build_id,
    storage,
    service_account,
    index,
    child,
    original_recipe,
    original_overlays,
):
    """Recompute the evidence; a matching document still grants no authority."""
    expected = build_document(
        attempt,
        prepared,
        recipe,
        build,
        build_id,
        storage,
        service_account,
        index,
        child,
        original_recipe,
        original_overlays,
    )
    release.require(
        type(document) is dict and document == expected,
        "Frontend build evidence changed",
    )
    return {
        "documentValidated": True,
        "hostedVerified": False,
        "providerVerified": False,
        "environmentAccepted": False,
        "productionTrafficAuthorized": False,
    }


def derive_inputs(
    attempt,
    prepared,
    recipe,
    original_recipe,
    original_overlays,
    inventory,
    fixture_backend,
    *,
    authority_paths=None,
):
    """Rederive recipe/runtime bytes; shape-only closure checks confer no authority."""
    pins, archive = prepared["pins"], prepared["archive"]
    authority = check_validation(prepared, attempt, authority_paths=authority_paths)
    names = ("deploy/frontend-image.cloudbuild.yaml", *release.OVERLAYS)
    expected_recipe, expected_overlays, expected_pins = pinned_recipe.derive(
        attempt.environment,
        original_recipe,
        original_overlays,
        inventory,
        {name: authority[name] for name in names},
        fixture_backend=fixture_backend,
    )
    backend_pair = prepared.get("backendPair")
    if backend_pair is not None:
        release.require(fixture_backend, "Frontend fixture backend secret required")
        expected_recipe, binding = backend_target.bind(
            expected_recipe,
            backend_pair,
            attempt.environment,
            inventory=inventory,
            original_recipe=original_recipe,
            original_overlays=original_overlays,
            expected_hashes={name: authority[name] for name in names},
        )
        release.require(
            prepared.get("backendBinding") == binding,
            "Frontend backend binding changed",
        )
        if "fixtureRuntime" in prepared:
            expected_recipe, runtime = fixture.reviewed_bundle(
                attempt, backend_pair, expected_recipe, authority
            )
            release.require(
                prepared["fixtureRuntime"] == runtime,
                "Frontend fixture runtime changed",
            )
    else:
        release.require(
            not fixture_backend
            and "backendBinding" not in prepared
            and "fixtureRuntime" not in prepared,
            "Frontend backend binding invalid",
        )
    release.require(
        recipe == expected_recipe
        and pins == expected_pins
        and archive.get("overlays")
        == {
            name: hashlib.sha256(value).hexdigest()
            for name, value in expected_overlays.items()
        },
        "Frontend build derived inputs changed",
    )
    return expected_recipe, expected_overlays, expected_pins


def _build_inventory(attempt, prepared, recipe):
    release.require(
        type(attempt) is release.Attempt and isinstance(prepared, dict),
        "Frontend build input invalid",
    )
    pins = prepared.get("pins")
    archive = prepared.get("archive")
    release.require(
        prepared.get("kind") == "proposed-frontend-pinned-build-input-v1"
        and prepared.get("workflowSha") == attempt.workflow_sha
        and prepared.get("runId") == attempt.run_id
        and prepared.get("runAttempt") == attempt.run_attempt
        and prepared.get("substitutions") == attempt.substitutions()
        and isinstance(pins, dict)
        and pins.get("environment") == attempt.environment
        and pins.get("project") == attempt.project
        and isinstance(archive, dict)
        and archive.get("sourceSha") == release.SOURCE
        and archive.get("sourceTree") == release.SOURCE_TREE
        and archive.get("overlays") == pins.get("overlaysSha256")
        and isinstance(recipe, bytes)
        and isinstance(pins.get("recipeSha256"), str)
        and isinstance(archive.get("archiveSha256"), str)
        and re.fullmatch(r"[0-9a-f]{64}", archive["archiveSha256"]),
        "Frontend build input mismatch",
    )
    versions = pins.get("versions")
    release.require(
        isinstance(versions, dict), "Frontend build secret inventory invalid"
    )
    inventory = {
        name: None if value is None else {"name": value, "state": "ENABLED"}
        for name, value in versions.items()
    }
    fixture_backend = pins.get("fixtureBackend")
    release.require(
        type(fixture_backend) is bool, "Frontend build fixture mode invalid"
    )
    secret_pins.validate_inventory(
        attempt.environment, inventory, fixture_backend=fixture_backend
    )
    return pins, archive, inventory, fixture_backend
