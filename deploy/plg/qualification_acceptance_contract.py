"""Pure proof contract for the fixed isolated PLG acceptance artifact.

Claims qualify only when the hosted consumer binds this definition and the
producer's executed checks. This module performs no reads or admission itself.
"""

import json
import re
from datetime import datetime
from urllib.parse import urlsplit

import qualification_foundation as foundation
import qualification_runtime as runtime
from qualification_target import (
    ABSENT_TABLES,
    DATABASE,
    PREFIX,
    RUNTIME_ARGS,
    RUNTIME_COMMAND,
    RUNTIME_ROLE,
    RUNTIME_SECRETS,
    SERVICE,
    SOURCE,
    Target,
    require,
)

TARGET = "plg-isolated-qualification"


def _same(actual, expected, code: str) -> None:
    require(
        type(actual) is type(expected)
        and json.dumps(actual, sort_keys=True) == json.dumps(expected, sort_keys=True),
        code,
    )


def _fields(value: dict, code: str, **expected) -> None:
    require(isinstance(value, dict), code)
    for key, item in expected.items():
        _same(value.get(key), item, code)


def _digest(value: str) -> bool:
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None


def _observed(proof: dict, job: dict) -> None:
    try:
        times = [
            datetime.fromisoformat(value.replace("Z", "+00:00"))
            for value in (job["started_at"], proof["observedAt"], job["completed_at"])
        ]
        valid = (
            all(value.tzinfo is not None for value in times) and times[0] <= times[1] <= times[2]
        )
    except (AttributeError, KeyError, TypeError, ValueError):
        valid = False
    require(valid, "qualification_evidence_outside_producer_attempt")


def image(
    proof: dict, target: Target, run: dict, definitions: dict, previous, source_tree: str
) -> str:
    reference = proof.get("reference", "")
    repository = f"gcr.io/{target.project}/consent-protocol"
    require(
        re.fullmatch(re.escape(repository) + r"@sha256:[0-9a-f]{64}", reference) is not None,
        "qualification_immutable_image_required",
    )
    _fields(proof, "qualification_image_source_mismatch", sourceSha=SOURCE)
    if target.environment == "uat":
        require(
            set(proof) == {"reference", "sourceSha", "mode", "promotedFrom", "observedAt"},
            "qualification_uat_rebuild_or_unbound_image",
        )
        _fields(
            proof,
            "qualification_uat_predecessor_image_mismatch",
            mode="promoted-dev",
            promotedFrom=previous.image_reference,
        )
        require(
            reference.rsplit("@", 1)[1] == previous.image_reference.rsplit("@", 1)[1],
            "qualification_uat_executable_digest_changed",
        )
    else:
        require(
            set(proof) == {"reference", "sourceSha", "mode", "build", "observedAt"},
            "qualification_dev_source_build_required",
        )
        _same(proof["mode"], "source-build", "qualification_dev_source_build_required")
        build = proof["build"]
        _fields(
            build,
            "qualification_source_build_provenance_unverified",
            project=target.project,
            status="SUCCESS",
            sourceSha=SOURCE,
            sourceTree=source_tree,
            configSha256=definitions["deploy/backend-image.cloudbuild.yaml"],
            imageTag=f"plg-qual-{SOURCE[:12]}-{run['id']}-{run['run_attempt']}",
            executableReference=reference,
            platform="linux/amd64",
        )
        require(
            re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", build.get("buildId", ""))
            is not None
            and _digest(build.get("sourceArchiveSha256"))
            and re.fullmatch(
                re.escape(repository) + r"@sha256:[0-9a-f]{64}", build.get("indexReference", "")
            )
            is not None,
            "qualification_cloud_build_identity_unverified",
        )
        storage = build.get("storageSource", {})
        require(
            isinstance(storage, dict)
            and set(storage) == {"bucket", "object", "generation"}
            and all(isinstance(storage[key], str) and storage[key] for key in storage)
            and re.fullmatch(r"[1-9][0-9]*", storage["generation"]) is not None,
            "qualification_cloud_build_source_unbound",
        )
    return reference


def schema(proof: dict, target: Target, digest: str) -> None:
    _fields(
        proof,
        "qualification_synthetic_schema_unverified",
        sourceSha=SOURCE,
        foundationSha256=digest,
        instance=target.instance,
        database=DATABASE,
        runtimeRole=RUNTIME_ROLE,
        runtimeRoleConnectionLimit=8,
        systemIdentifier=foundation.CLUSTERS[target.environment]["systemIdentifier"],
        providerContractVersion=2,
        requiredAbsentTables=list(ABSENT_TABLES),
        sourceSchemaVerified=True,
        sourceCatalogsVerified=True,
        replacementAccounts=0,
        ownerRowsCopied=0,
        runtimeEmptyRead=True,
        runtimeGrantsVerified=True,
    )
    require(
        _digest(proof.get("memoryIndexDefinitionSha256")),
        "qualification_memory_index_proof_missing",
    )
    runtime.validate_proof(proof.get("runtimeBootstrapDDL"))


def iam(proof: dict, target: Target) -> dict:
    _fields(
        proof,
        "qualification_private_iam_unverified",
        iamEvidenceKind="allow-policy-bindings",
        authorityScope="target-project-and-ancestors",
        serviceExists=True,
        project=target.project,
        service=SERVICE,
        runtimePrincipal=target.runtime_sa,
        invokerIamDisabled=False,
        publicInvokerBindings=[],
        ancestorPoliciesComplete=True,
        runtimeCloudSqlClient=True,
        runtimeSecretsOnly=True,
        migratorSecretAccess=False,
        additionalRuntimeAuthority=False,
    )
    versions = proof.get("runtimeSecretVersions")
    require(
        isinstance(versions, dict)
        and set(versions) == {PREFIX + name for name in RUNTIME_SECRETS}
        and all(
            isinstance(value, str) and re.fullmatch(r"[1-9][0-9]*", value)
            for value in versions.values()
        ),
        "qualification_runtime_secret_versions_unverified",
    )
    return versions


def capacity(proof: dict, target: Target) -> None:
    _fields(
        proof,
        "qualification_capacity_inventory_unverified",
        inventoryComplete=True,
        retainedRevisionsCounted=True,
        runtimeRoleConnectionLimit=8,
    )
    report = proof.get("report", {})
    _fields(
        report,
        "qualification_capacity_not_admitted",
        environment=target.environment,
        phase="pre-deploy",
        project=target.project,
        database=target.instance,
        admitted=True,
    )
    values = [
        report.get(key)
        for key in (
            "administrative_reserve",
            "projected_connections",
            "admission_limit",
            "verified_max_connections",
        )
    ]
    require(
        all(type(value) is int and value > 0 for value in values)
        and values[0] < values[1] <= values[2] <= values[3]
        and type(report.get("headroom_to_limit")) is int
        and report.get("headroom_to_limit") == values[2] - values[1],
        "qualification_capacity_arithmetic_unverified",
    )
    rows, jobs = report.get("services"), report.get("jobs")
    require(
        isinstance(rows, list) and isinstance(jobs, list), "qualification_capacity_rows_missing"
    )
    candidates = [row for row in rows if row.get("name") == SERVICE + ":new-candidate"]
    require(len(candidates) == 1, "qualification_capacity_candidate_missing")
    _fields(
        candidates[0],
        "qualification_capacity_candidate_mismatch",
        max_instances=1,
        workers_per_instance=1,
        connections_per_worker=5,
        connections=5,
    )
    require(
        all(type(row.get("connections")) is int and row["connections"] >= 0 for row in rows + jobs)
        and values[1] == values[0] + sum(row["connections"] for row in rows + jobs),
        "qualification_capacity_inventory_total_mismatch",
    )
    # The report counts declared pools. S also has non-pooled lock connections.
    # Reserve the genuine SQL-verified aggregate role ceiling, without inventing
    # a fixed number of dedicated consumers or reducing retained reservations.
    counted = sum(
        row["connections"]
        for row in rows
        if row.get("name", "").startswith((SERVICE + "-", SERVICE + ":"))
    )
    require(
        values[1] + max(0, 8 - counted) <= values[2],
        "qualification_capacity_runtime_role_ceiling_not_reserved",
    )


def candidate(
    proof: dict, health: dict, target: Target, run: dict, image: str, versions: dict
) -> None:
    revision = proof.get("revision", "")
    require(
        isinstance(revision, str)
        and len(revision) <= 63
        and re.fullmatch(re.escape(SERVICE) + r"-[a-z0-9-]+", revision) is not None,
        "qualification_revision_identity_invalid",
    )
    _fields(
        proof,
        "qualification_candidate_runtime_unverified",
        runtimePrincipal=target.runtime_sa,
        runtimeSecretVersions=versions,
        cloudSqlInstance=target.instance,
        database=DATABASE,
        runtimeCommand=list(RUNTIME_COMMAND),
        runtimeArgs=list(RUNTIME_ARGS),
    )
    _fields(
        proof.get("runtimeEnvironment", {}),
        "qualification_candidate_background_work_unverified",
        KAI_MARKET_BACKGROUND_REFRESH="false",
    )
    report = proof.get("provenance", {})
    expected = {
        "HUSHH_DEPLOY_ENV": target.environment,
        "HUSHH_DEPLOY_SOURCE": TARGET,
        "HUSHH_DEPLOY_SHA": SOURCE,
        "HUSHH_DEPLOY_RUN_ID": str(run["id"]),
    }
    _fields(
        report,
        "qualification_candidate_provenance_unverified",
        service=SERVICE,
        project=target.project,
        region="us-central1",
        mode="candidate",
        status="healthy",
        ok=True,
        expected=expected,
        failures=[],
        classifications=[],
    )
    checked = report.get("checked_revisions", [])
    require(len(checked) == 1, "qualification_candidate_revision_ambiguous")
    _fields(
        checked[0],
        "qualification_candidate_image_unverified",
        revision=revision,
        env=expected,
        ok=True,
        mismatches=[],
        image_reference=image,
        image_digest=image.rsplit("@", 1)[1],
        image_verified=True,
    )
    _fields(
        checked[0].get("labels", {}),
        "qualification_candidate_labels_unverified",
        **{
            "deploy-env": target.environment,
            "deploy-source": TARGET,
            "deploy-sha": SOURCE,
            "github-run-id": str(run["id"]),
        },
    )
    _health(proof, report.get("candidate_url", ""), health, revision, image)


def _health(proof: dict, url: str, health: dict, revision: str, image: str) -> None:
    origin = proof.get("serviceUrl", "")
    for value in (url, origin):
        parsed = urlsplit(value)
        require(
            parsed.scheme == "https"
            and parsed.hostname
            and parsed.hostname.endswith(".run.app")
            and parsed.netloc == parsed.hostname
            and not (parsed.path or parsed.query or parsed.fragment),
            "qualification_private_probe_origin_invalid",
        )
    _fields(
        health,
        "qualification_private_health_unverified",
        candidateUrl=url,
        audience=origin,
        revision=revision,
        imageReference=image,
        authenticated=True,
        redirects=0,
        provenanceRechecked=True,
        passes=[{"httpStatus": 200, "bodyStatus": "healthy"}] * 2,
    )
    require(
        type(health.get("unauthenticatedStatus")) is int
        and health["unauthenticatedStatus"] in {401, 403},
        "qualification_public_health_accessible",
    )
