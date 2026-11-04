"""Verify deployment callers, authority checks, and release evidence wiring."""

from pathlib import Path


def validate_deploy_workflows(repo_root: Path, governance: dict, errors: list[str]) -> None:
    workflows = repo_root / ".github/workflows"
    uat_caller = workflows / "deploy-uat.yml"
    uat_implementation = workflows / "deploy-uat-implementation.yml"
    production_workflow = workflows / "deploy-production.yml"
    required_workflows = (uat_caller, uat_implementation, production_workflow)
    for workflow in required_workflows:
        if not workflow.exists():
            errors.append(f"missing governed deploy workflow: {workflow.relative_to(repo_root)}")
    if not all(workflow.exists() for workflow in required_workflows):
        return

    uat_caller_text = uat_caller.read_text(encoding="utf-8")
    for marker in [
        "workflow_dispatch:",
        "uses: hushh-labs/hushh-research/.github/workflows/deploy-uat-implementation.yml@main",
    ]:
        if marker not in uat_caller_text:
            errors.append(f".github/workflows/deploy-uat.yml: missing governed caller marker `{marker}`")

    uat_workflow_text = uat_implementation.read_text(encoding="utf-8")
    production_workflow_text = production_workflow.read_text(encoding="utf-8")
    common_markers = [
        "GITHUB_REF_NAME",
        "scripts/ci/assert-governed-actor.py",
        "scripts/ci/require-deploy-sha-on-main.sh",
        "scripts/ci/cloudrun-rollback.sh",
        "exit 1",
    ]
    for environment, workflow, workflow_text, trigger in [
        ("uat", uat_implementation, uat_workflow_text, "workflow_call:"),
        ("production", production_workflow, production_workflow_text, "workflow_dispatch:"),
    ]:
        policy = governance.get(environment, {})
        environment_name = policy.get("environment") or policy.get("owner_environment")
        for marker in [
            trigger,
            *common_markers,
            f"environment: {environment_name}",
            f"--surface {environment}",
            str(policy.get("required_post_merge_check")),
        ]:
            if marker not in workflow_text:
                errors.append(f"{workflow.relative_to(repo_root)}: missing governed deploy marker `{marker}`")

    for marker in [
        "scripts/ci/resolve-deploy-scope.py",
        "scripts/ci/verify-cloudrun-revision-provenance.py",
        "Write UAT release status artifact",
        "Upload UAT deploy artifacts",
    ]:
        if marker not in uat_workflow_text:
            errors.append(f"{uat_implementation.relative_to(repo_root)}: missing UAT release proof marker `{marker}`")

    _validate_production_proof(production_workflow_text, errors)


def _validate_production_proof(production_workflow_text: str, errors: list[str]) -> None:
    for marker in [
        "Verify production backend deployment provenance",
        "Verify production frontend deployment provenance",
        "scripts/ci/verify-cloudrun-revision-provenance.py",
        "Write production release status artifact",
        "Upload production deploy artifacts",
        "/tmp/prod-release-status.json",
    ]:
        if marker not in production_workflow_text:
            errors.append(
                f".github/workflows/deploy-production.yml: missing production release proof marker `{marker}`"
            )
    promotion_failure_start = production_workflow_text.find(
        'if [ "$PROMOTE_OUTCOME" = "failure" ]; then'
    )
    promotion_failure_end = production_workflow_text.find(
        'if [ "$DEPLOY_BACKEND" = "true" ] && [ "$PROMOTE_OUTCOME" = "success" ]',
        promotion_failure_start,
    )
    if promotion_failure_start < 0 or promotion_failure_end < 0:
        errors.append(
            ".github/workflows/deploy-production.yml: missing partial-promotion failure classification"
        )
    else:
        body = production_workflow_text[promotion_failure_start:promotion_failure_end]
        for marker in ["backend_failure=true", "frontend_failure=true"]:
            if marker not in body:
                errors.append(
                    ".github/workflows/deploy-production.yml: partial promotion failure must "
                    f"mark selected services for rollback (`{marker}`)"
                )
