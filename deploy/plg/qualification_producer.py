"""Main-owned stages for the fixed isolated qualification, never PROD traffic.

Stage files are producer checkpoints, not admission inputs. Only the hosted
consumer's genuine successful run/artifact can establish isolated acceptance.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import qualification_acceptance as acceptance
import qualification_acceptance_contract as proofs
import qualification_foundation as foundation
import qualification_image as images
import validation
from qualification_target import BASELINE, PREFIX, SOURCE, Target, require

PHASES = (
    "require",
    "source",
    "schema",
    "schema-post",
    "iam-pre",
    "image",
    "capacity",
    "deploy",
    "iam",
    "health",
    "record",
)


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def write(folder: Path, name: str, value: dict) -> None:
    """Never silently replace an interrupted or previously completed stage."""
    with (folder / (name + ".json")).open("x", encoding="utf-8") as handle:
        json.dump(value, handle, indent=2, sort_keys=True)
        handle.write("\n")


def journal(folder: Path, prefix: str):
    sequence = 0

    def checkpoint(value: dict) -> None:
        nonlocal sequence
        sequence += 1
        require(sequence <= 12, "qualification_checkpoint_bound")
        write(folder, f"{prefix}-{sequence:02d}", value)

    return checkpoint


def load(folder: Path, name: str) -> dict:
    path = folder / (name + ".json")
    require(path.stat().st_size <= 1024 * 1024, "qualification_stage_too_large")
    value = json.loads(path.read_bytes())
    require(isinstance(value, dict), "qualification_stage_shape_invalid")
    return value


def context(environment: str) -> dict:
    target = Target(environment)
    require(
        os.environ.get("GITHUB_EVENT_NAME") == "workflow_dispatch"
        and os.environ.get("GITHUB_REF") == "refs/heads/main"
        and os.environ.get("GITHUB_REPOSITORY") == validation.transport.REPOSITORY,
        "qualification_main_dispatch_required",
    )
    attempt = images.Attempt(
        os.environ.get("GITHUB_SHA", ""),
        os.environ.get("GITHUB_RUN_ID", ""),
        os.environ.get("GITHUB_RUN_ATTEMPT", ""),
    )
    git = validation.authority._git
    require(
        git("rev-parse", "HEAD").strip().decode() == attempt.workflow_sha,
        "qualification_authority_checkout_changed",
    )
    policy = json.loads((validation.ROOT / "config/ci-governance.json").read_bytes())
    allowed = policy["production"]["manual_dispatch_users"]
    require(
        all(
            os.environ.get(key) in allowed
            for key in ("GITHUB_ACTOR", "GITHUB_TRIGGERING_ACTOR")
        ),
        "qualification_governed_actor_required",
    )
    return {
        "environment": environment,
        "project": target.project,
        "sourceSha": SOURCE,
        "workflowSha": attempt.workflow_sha,
        "runId": int(attempt.run_id),
        "runAttempt": int(attempt.run_attempt),
    }


def fetch_source() -> None:
    token = os.environ.get("GH_TOKEN", "")
    require(bool(token), "qualification_source_fetch_identity_required")
    header = base64.b64encode(("x-access-token:" + token).encode()).decode()
    environment = dict(
        os.environ,
        GIT_CONFIG_COUNT="1",
        GIT_CONFIG_KEY_0="http.https://github.com/.extraheader",
        GIT_CONFIG_VALUE_0="AUTHORIZATION: basic " + header,
    )
    try:
        result = subprocess.run(  # noqa: S603 -- fixed Git source; token only in child environment.
            ["git", "fetch", "--no-tags", "origin", SOURCE],
            cwd=validation.ROOT,
            env=environment,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=120,
            check=False,
        )
        require(result.returncode == 0, "qualification_exact_source_unavailable")
    finally:
        environment.clear()


def begin(args, folder: Path) -> None:
    current = context(args.environment)
    require(
        args.sha == SOURCE and args.scope == "backend",
        "qualification_fixed_backend_required",
    )
    require(
        os.environ.get("PLG_UNSUPPORTED_LIVE_WORK", "false") == "false",
        "qualification_unrelated_live_work_requested",
    )
    require(
        args.source_validation_run > 0, "qualification_source_validation_run_required"
    )
    require(
        args.schema_action in {"preflight", "initialize", "reconcile-bootstrap"},
        "qualification_schema_action_invalid",
    )
    require(
        (args.environment == "dev" and args.dev_run == 0)
        or (args.environment == "uat" and args.dev_run > 0),
        "qualification_predecessor_run_required",
    )
    folder.mkdir(parents=False, exist_ok=False)
    write(
        folder,
        "context",
        current
        | {
            "sourceValidationRun": args.source_validation_run,
            "devRun": args.dev_run,
            "schemaAction": args.schema_action,
        },
    )
    fetch_source()
    validation.authority.qualify_source(SOURCE)


def recheck(folder: Path, environment: str) -> dict:
    stored = load(folder, "context")
    require(
        all(stored.get(key) == value for key, value in context(environment).items()),
        "qualification_producer_context_changed",
    )
    return stored


def source(folder: Path, current: dict) -> None:
    write(folder, "source", validation.verify(current["sourceValidationRun"], SOURCE))
    previous = (
        acceptance.verify("dev", current["devRun"])
        if current["environment"] == "uat"
        else None
    )
    write(folder, "predecessor", {"pin": None if previous is None else previous.pin()})


def build_image(folder: Path, current: dict) -> None:
    attempt = images.Attempt(
        current["workflowSha"], str(current["runId"]), str(current["runAttempt"])
    )
    write(folder, "image-intent", {"status": "requested", "observedAt": now()})
    checkpoint = journal(folder, "image-operation")
    proof = (
        images.build_dev(attempt, current["sourceValidationRun"], checkpoint=checkpoint)
        if current["environment"] == "dev"
        else images.promote_uat(attempt, current["devRun"])
    )
    write(folder, "image", proof)


def capacity(folder: Path, current: dict) -> None:
    command = [
        sys.executable,
        str(validation.ROOT / "scripts/ci/runtime-capacity-budget.py"),
        "--environment",
        current["environment"],
        "--candidate-service",
        "consent-protocol-plg-qual",
        "--output",
        "json",
    ]
    result = subprocess.run(  # noqa: S603 -- canonical collector and fixed candidate/target.
        command,
        cwd=validation.ROOT,
        capture_output=True,
        timeout=300,
        check=False,
    )
    require(
        result.returncode == 0 and len(result.stdout) <= 1024 * 1024,
        "qualification_actual_capacity_not_admitted",
    )
    proof = {
        "report": json.loads(result.stdout),
        "observedAt": now(),
        "inventoryComplete": True,
        "retainedRevisionsCounted": True,
        "runtimeRoleConnectionLimit": load(folder, "schema")[
            "runtimeRoleConnectionLimit"
        ],
    }
    proofs.capacity(proof, Target(current["environment"]))
    write(folder, "capacity", proof)


def deploy_prerequisites(folder: Path, target: Target, versions: dict) -> None:
    budget = load(folder, "capacity")
    proofs.capacity(budget, target)
    age = (
        datetime.now(timezone.utc) - datetime.fromisoformat(budget["observedAt"])
    ).total_seconds()
    require(0 <= age <= 300, "qualification_capacity_observation_stale")
    proof = load(folder, "iam-pre")
    proofs._fields(
        proof,
        "qualification_iam_prerequisite_unverified",
        project=target.project,
        service="consent-protocol-plg-qual",
        runtimePrincipal=target.runtime_sa,
        iamEvidenceKind="allow-policy-bindings",
        authorityScope="target-project-and-ancestors",
        ancestorPoliciesComplete=True,
        runtimeCloudSqlClient=True,
        runtimeSecretsOnly=True,
        migratorSecretAccess=False,
        additionalRuntimeAuthority=False,
        runtimeSecretVersions={
            PREFIX + name: value for name, value in versions.items()
        },
    )
    require(
        type(proof.get("serviceExists")) is bool,
        "qualification_service_precheck_missing",
    )
    if proof["serviceExists"]:
        proofs.iam(proof, target)
    else:
        proofs._fields(
            proof,
            "qualification_absent_service_precheck_changed",
            invokerIamDisabled=None,
            publicInvokerBindings=None,
        )


def deploy(folder: Path, current: dict) -> None:
    import qualification_candidate as candidates

    target = Target(current["environment"])
    image = load(folder, "image")["reference"]
    attempt = images.Attempt(
        current["workflowSha"], str(current["runId"]), str(current["runAttempt"])
    )
    versions = load(folder, "schema-versions")["versions"]
    deploy_prerequisites(folder, target, versions)
    write(folder, "deploy-intent", {"status": "requested", "observedAt": now()})
    descriptor = candidates.deploy_candidate(
        target, attempt, image, versions, checkpoint=journal(folder, "deploy-operation")
    )
    write(folder, "descriptor", descriptor)
    output = os.environ.get("GITHUB_OUTPUT", "")
    require(bool(output), "qualification_github_output_required")
    with open(output, "a", encoding="utf-8") as handle:
        handle.write("audience=" + descriptor["serviceUrl"] + "\n")


def iam(folder: Path, current: dict) -> None:
    import qualification_iam

    proof = qualification_iam.verify(Target(current["environment"]))
    proofs.iam(proof, Target(current["environment"]))
    write(folder, "iam", proof)


def iam_pre(folder: Path, current: dict) -> None:
    import qualification_iam

    proof = qualification_iam.verify(
        Target(current["environment"]), require_service=False
    )
    write(folder, "iam-pre", proof)


def health(folder: Path, current: dict) -> None:
    import qualification_candidate as candidates

    token = os.environ.pop("PLG_QUALIFICATION_ID_TOKEN", "")
    require(bool(token), "qualification_hosted_id_token_required")
    try:
        result = candidates.verify_and_probe(load(folder, "descriptor"), token)
    finally:
        token = ""
    write(folder, "candidate", result["candidate"])
    write(folder, "health", result["health"])


def record(folder: Path, current: dict) -> None:
    target = Target(current["environment"])
    source_proof = validation.verify(current["sourceValidationRun"], SOURCE)
    require(
        source_proof == load(folder, "source"), "qualification_source_receipt_changed"
    )
    previous = (
        acceptance.verify("dev", current["devRun"])
        if target.environment == "uat"
        else None
    )
    require(
        load(folder, "predecessor")["pin"]
        == (None if previous is None else previous.pin()),
        "qualification_dev_receipt_changed",
    )
    definitions = acceptance.reviewed_definitions(
        current["workflowSha"], target.environment
    )
    tree = validation.authority._git("rev-parse", SOURCE + "^{tree}").decode().strip()
    image, schema = load(folder, "image"), load(folder, "schema-final")
    reference = proofs.image(
        image,
        target,
        {"id": current["runId"], "run_attempt": current["runAttempt"]},
        definitions,
        previous,
        tree,
    )
    proofs.schema(schema, target, foundation.load_contract()[1])
    versions = proofs.iam(load(folder, "iam"), target)
    proofs.capacity(load(folder, "capacity"), target)
    proofs.candidate(
        load(folder, "candidate"),
        load(folder, "health"),
        target,
        {"id": current["runId"]},
        reference,
        versions,
    )
    receipt = {
        "schemaVersion": 1,
        "kind": acceptance.KIND,
        "status": "accepted-isolated",
        "target": acceptance.TARGET,
        "environment": target.environment,
        "sourceSha": SOURCE,
        "baselineSha": BASELINE,
        "repository": validation.transport.REPOSITORY,
        "workflow": f".github/workflows/deploy-{target.environment}.yml",
        "workflowSha": current["workflowSha"],
        "runId": current["runId"],
        "runAttempt": current["runAttempt"],
        "authorityBlobs": definitions,
        "sharedEnvironmentAccepted": False,
        "productionTrafficAuthorized": False,
        "sourceValidation": source_proof,
        "predecessor": None if previous is None else previous.pin(),
        "schema": schema,
        **{
            key: load(folder, key)
            for key in ("image", "iam", "capacity", "candidate", "health")
        },
    }
    write(folder, "acceptance", receipt)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--phase", choices=PHASES, required=True)
    parser.add_argument("--environment", choices=("dev", "uat"), required=True)
    parser.add_argument("--folder", type=Path, required=True)
    parser.add_argument("--sha", default="")
    parser.add_argument("--scope", default="")
    parser.add_argument("--source-validation-run", type=int, default=0)
    parser.add_argument("--dev-run", type=int, default=0)
    parser.add_argument("--schema-action", default="preflight")
    parser.add_argument("--source-root", type=Path)
    args = parser.parse_args()
    try:
        if args.phase == "require":
            begin(args, args.folder)
        else:
            current = recheck(args.folder, args.environment)
            if args.phase in {"schema", "schema-post"}:
                from qualification_schema_executor import execute

                require(
                    args.source_root is not None,
                    "qualification_source_checkout_required",
                )
                post = args.phase == "schema-post"
                operation = args.folder / "post-schema" if post else args.folder
                if post:
                    operation.mkdir(exist_ok=False)
                schema, versions = execute(
                    Target(args.environment),
                    args.source_root,
                    operation,
                    "preflight" if post else current["schemaAction"],
                )
                if post:
                    require(
                        versions == load(args.folder, "schema-versions")["versions"],
                        "qualification_runtime_secret_versions_changed",
                    )
                    write(args.folder, "schema-final", schema)
                else:
                    write(args.folder, "schema", schema)
                    write(args.folder, "schema-versions", {"versions": versions})
            else:
                {
                    "source": source,
                    "image": build_image,
                    "capacity": capacity,
                    "deploy": deploy,
                    "iam-pre": iam_pre,
                    "iam": iam,
                    "health": health,
                    "record": record,
                }[args.phase](args.folder, current)
    except Exception as error:
        if args.folder.is_dir():
            failure = {
                "status": "unverified",
                "safeErrorClass": type(error).__name__,
                "observedAt": now(),
            }
            if re.fullmatch(r"(?:qualification_|iam_)[A-Za-z0-9_]{1,160}", str(error)):
                failure["refusalCode"] = str(error)
            try:
                write(args.folder, "failure-" + args.phase, failure)
            except OSError:
                pass  # Preserve the first exclusive failure rather than overwrite it.
        parser.exit(
            1,
            "qualification_stage_unverified; reconcile its exclusive checkpoint before retry\n",
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
