"""Local frontend proposals and current hosted private-fixture build admission.

Proposal documents carry no authority. Submission requires the genuine current
Main workflow publication and independent reconciliation of prior fixed-fixture
attempts. This grants no shared-service or production release authority.
"""

from __future__ import annotations

import hashlib
import json
import re

import frontend_build_evidence as evidence
import frontend_release as release
import frontend_secret_pins as pins


def _hash(value):
    try:
        raw = json.dumps(
            value, sort_keys=True, separators=(",", ":"), allow_nan=False
        ).encode()
    except (TypeError, ValueError):
        raise release.Refused("Frontend caller input invalid") from None
    release.require(len(raw) <= 1_048_576, "Frontend caller input oversized")
    return hashlib.sha256(raw).hexdigest()


def proposed_build_intent(
    attempt,
    prepared,
    snapshot,
    recipe,
    original_recipe,
    original_overlays,
    *,
    authority_paths=None,
):
    """Bind a proposed snapshot and build inputs, without hosted proof."""
    fixture_backend, inventory, optional = _check_snapshot(attempt, prepared, snapshot)
    _check_prepared(
        attempt,
        prepared,
        snapshot,
        fixture_backend,
        inventory,
        optional,
        authority_paths,
    )
    evidence.derive_inputs(
        attempt,
        prepared,
        recipe,
        original_recipe,
        original_overlays,
        snapshot["inventory"],
        fixture_backend,
        authority_paths=authority_paths,
    )
    return {
        "kind": "proposed-plg-frontend-build-intent-v1",
        "producer": {
            "workflowSha": attempt.workflow_sha,
            "runId": attempt.run_id,
            "runAttempt": attempt.run_attempt,
        },
        "environment": attempt.environment,
        "project": attempt.project,
        "sourceSha": release.SOURCE,
        "sourceTree": release.SOURCE_TREE,
        "preparedSha256": _hash(prepared),
        "snapshotSha256": _hash(snapshot),
        "recipeSha256": hashlib.sha256(recipe).hexdigest(),
        "imageTag": attempt.tag,
        "backendTargetBound": prepared.get("backendPair") is not None,
        "backendTargetVerified": False,
        "artifactPublished": False,
        "hostedVerified": False,
        "providerVerified": False,
        "durableFenceVerified": False,
        "maySubmit": False,
    }


def check_supplied_evidence(*args):
    """Recompute local evidence without granting hosted or provider authority."""
    return evidence.consume_document(*args)


def authorize_submission(attempt, prepared=None, intent=None):
    """Authenticate the current publication and reconcile earlier fixture writes."""
    release.require(type(attempt) is release.Attempt, "Fixture hosted context required")
    import frontend_fixture_acceptance as acceptance
    import frontend_fixture_history as history

    client, run, job = acceptance.current(
        attempt.environment, acceptance.BUILD_STEP, [acceptance.BUILD_UPLOAD]
    )
    _item, published = acceptance.artifact(
        client,
        run,
        job,
        attempt.environment,
        "build-intent",
        acceptance.BUILD_UPLOAD,
        "build-intent.json",
    )
    release.require(
        published == intent and intent.get("preparedSha256") == _hash(prepared),
        "Fixture published build intent changed",
    )
    return history.check(attempt.environment, github=client)


def _check_snapshot(attempt, prepared, snapshot):
    release.require(
        type(attempt) is release.Attempt
        and isinstance(prepared, dict)
        and isinstance(snapshot, dict)
        and snapshot.get("environment") == attempt.environment
        and snapshot.get("project") == attempt.project
        and snapshot.get("snapshotAtomic") is False
        and snapshot.get("buildConsumptionVerified") is False
        and snapshot.get("environmentAccepted") is False
        and snapshot.get("productionTrafficAuthorized") is False,
        "Frontend caller snapshot invalid",
    )
    fixture_backend = snapshot.get("fixtureBackend", False)
    release.require(
        type(fixture_backend) is bool, "Frontend caller fixture mode invalid"
    )
    inventory = pins.validate_inventory(
        attempt.environment, snapshot.get("inventory"), fixture_backend=fixture_backend
    )
    _required, optional = pins.catalog(
        attempt.environment, fixture_backend=fixture_backend
    )
    return fixture_backend, inventory, optional


def _check_prepared(
    attempt, prepared, snapshot, fixture_backend, inventory, optional, authority_paths
):
    proposal = prepared.get("pins")
    archive = prepared.get("archive")
    validation = prepared.get("sourceValidation")
    authority = prepared.get("authorityFiles")
    release.require(
        prepared.get("kind") == "proposed-frontend-pinned-build-input-v1"
        and prepared.get("workflowSha") == attempt.workflow_sha
        and prepared.get("runId") == attempt.run_id
        and prepared.get("runAttempt") == attempt.run_attempt
        and prepared.get("substitutions") == attempt.substitutions()
        and isinstance(proposal, dict)
        and proposal.get("environment") == attempt.environment
        and proposal.get("project") == attempt.project
        and proposal.get("fixtureBackend") == fixture_backend
        and proposal.get("versions") == inventory["versions"]
        and snapshot.get("optionalLatestUnresolved")
        == sorted(name for name in optional if inventory["versions"][name] is None)
        and isinstance(archive, dict)
        and archive.get("sourceSha") == release.SOURCE
        and archive.get("sourceTree") == release.SOURCE_TREE
        and archive.get("overlays") == proposal.get("overlaysSha256")
        and isinstance(archive.get("archiveSha256"), str)
        and re.fullmatch(r"[0-9a-f]{64}", archive["archiveSha256"])
        and isinstance(validation, dict)
        and validation.get("status") == "validated"
        and validation.get("scope") == "plg-frontend-source"
        and validation.get("sourceSha") == release.SOURCE
        and isinstance(authority, dict)
        and all(
            name in authority
            for name in (
                *(
                    release.AUTHORITY_PATHS
                    if authority_paths is None
                    else authority_paths
                ),
                release.WORKFLOWS[attempt.environment],
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
        "Frontend caller prepared inputs invalid",
    )
