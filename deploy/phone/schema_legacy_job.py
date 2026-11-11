# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Source evidence for one retained pre-phone readiness job, not job authority."""

from __future__ import annotations

from bootstrap_ports import REPOSITORY, _authorities

NAME = "consent-protocol-genai-readiness"
UID = "1cdd34e3-9019-4066-8bb7-6f844ceba980"
CREATED = "2026-07-27T21:59:22.725962Z"
SPEC_DIGEST = "5c31e1861398c3010c34963ace9f2233ed5694195702ea8757585c4389b00d16"
IMAGE = "gcr.io/hushh-pda/consent-protocol@sha256:2efb469915aea7f258f749ff606c5210ef187dcb8e459dfa369f23ded365f44c"
SOURCE = "d717ea6a93f738ea76a2c580d0b249c8507f2d24"
RUN = 36955100443
HEAD = "e50816875267a4e68c408da9a8d62805749d435d"
ARTIFACT = 11205938981
DIGEST = "sha256:14925cd662dd78824946dbe22f6c00d9ce6157e518959175dd343d84fb0719d4"
STEPS = (
    "Resolve UAT-verified backend image for promotion",
    "Build and pin backend image before lifecycle migration",
    "Verify backend candidate readiness and exact-SHA provenance",
    "Verify production backend deployment provenance",
)


def require(value):
    if not value:
        raise ValueError("phone_schema_legacy_job_source_unqualified")


def qualify_documents(release, image, candidate, provenance):
    from release_acceptance_provenance import validate_serving_provenance

    revision = candidate.get("metadata", {}).get("name")
    require(
        release.get("status") == "healthy"
        and release.get("sha") == SOURCE
        and release.get("scope") == "backend"
        and revision == "consent-protocol-00226-hif"
        and release.get("candidate", {}).get("backend_revision") == revision
        and release.get("final", {}).get("backend_revision") == revision
        and all(
            release.get("verification", {}).get(k) == "success"
            for k in (
                "runtime_parity",
                "connected_systems",
                "backend_provenance",
                "backend_health",
                "account_deletion_activation",
            )
        )
        and release.get("verification", {}).get("account_deletion_activated") == "true"
        and image.get("sha") == SOURCE
        and image.get("status") == "pinned"
        and image.get("image_reference") == image.get("index_reference") == IMAGE
        and candidate.get("metadata", {}).get("labels", {}).get("deploy-sha") == SOURCE
        and candidate.get("metadata", {}).get("labels", {}).get("github-run-id") == str(RUN)
        and candidate.get("status", {}).get("imageDigest") == IMAGE
        and len(candidate.get("spec", {}).get("containers", [])) == 1
        and candidate["spec"]["containers"][0].get("image") == IMAGE
    )
    validate_serving_provenance(
        {"run_id": RUN, "provenance": {"backend": provenance}},
        environment="production",
        sha=SOURCE,
        service="backend",
        revision=revision,
        project="hushh-pda",
        service_name="consent-protocol",
    )


def original_source():
    """Authenticate the original governed attempt and immutable release archive."""
    import production_phone_receipt as phone

    authority = _authorities()
    api, receipts = authority.uncached_api, authority.release_artifact_receipts
    run = api(REPOSITORY, f"runs/{RUN}")
    require(
        run.get("id") == RUN
        and run.get("run_attempt") == 1
        and run.get("head_sha") == HEAD
        and run.get("status") == "completed"
        and run.get("conclusion") == "success"
        and authority.governed_dispatch(run, REPOSITORY, "production")
    )
    artifact, job = receipts.current_attempt_artifact(
        REPOSITORY,
        run,
        authority.LANES["production"],
        api=api,
        timestamp=authority._github_timestamp,
    )
    require(
        artifact.get("id") == ARTIFACT
        and artifact.get("digest") == DIGEST
        and job.get("conclusion") == "success"
    )
    for name in STEPS:
        steps = [s for s in job.get("steps", []) if s.get("name") == name]
        require(
            len(steps) == 1
            and steps[0].get("status") == "completed"
            and steps[0].get("conclusion") == "success"
        )
    archive = receipts.immutable_archive(
        REPOSITORY,
        artifact,
        run_command=authority.retention.run_command,
        timeout=90,
    )
    qualify_documents(
        *(
            phone._document(archive, name)
            for name in (
                "prod-release-status.json",
                "prod-backend-image.json",
                "prod-backend-candidate.json",
                "prod-backend-provenance.json",
            )
        )
    )
    require(api(REPOSITORY, f"runs/{RUN}") == run)
    return {
        "run_id": RUN,
        "run_attempt": 1,
        "workflow_sha": HEAD,
        "artifact_id": ARTIFACT,
        "artifact_digest": DIGEST,
    }


def resolve(job, *, check, images=None):
    from schema_producers import fingerprint

    metadata = job.get("metadata", {})
    task = (
        job.get("spec", {}).get("template", {}).get("spec", {}).get("template", {}).get("spec", {})
    )
    containers = task.get("containers", [])
    require(
        metadata.get("name") == NAME
        and metadata.get("uid") == UID
        and metadata.get("creationTimestamp") == CREATED
        and fingerprint(job.get("spec")) == SPEC_DIGEST
        and len(containers) == 1
        and containers[0].get("image") == IMAGE
        and containers[0].get("command") == ["python3"]
        and containers[0].get("args") == ["scripts/verify_managed_vertex_runtime.py"]
        and (images or {}).get(IMAGE, SOURCE) == SOURCE
    )
    require(check(SOURCE) is False)
    return SOURCE, original_source()
