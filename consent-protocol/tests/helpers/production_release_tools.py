"""Synthetic current-tool closure for historical production release rehearsals."""

from pathlib import Path

DRIVE_PRODUCTION_TOOLS = (
    "resolve_prod_release_mode.py",
    "resolve_protected_document_release.py",
    "verify_prod_prerequisites.py",
    "verify_hashcoin_config.sh",
    "setup_native_callback_log_exclusion.sh",
    "deploy_worker_service_prod.sh",
    "sync_runtime_config_prod.sh",
    "staged_worker.py",
    "verify_worker_revision.py",
    "setup_work_drain_scheduler_prod.sh",
    "work_drain_scheduler_snapshot_prod.py",
    "restore_prod_after_release_failure.sh",
)


CI_PRODUCTION_TOOLS = (
    "uat-retention-maintenance.py",
    "retention_publication.py",
    "retention_preflight_evidence.py",
    "production_phone_receipt.py",
    "production_phone_lease.py",
    "production_phone_lease_receipts.py",
    "production_phone_nonproducer.py",
    "production_backend_successor.py",
    "production_backend_successor_proof.py",
    "production_backend_successor_control.py",
    "production_pending_activation.py",
    "production_activation_continuation.py",
    "production_staged_worker.py",
    "production_worker_basis.py",
    "production_backend_inheritance.py",
    "production_retention_context.py",
    "production_restoration_receipt.py",
    "production_restoration_continuation.py",
    "retention_admission.py",
    "tag-last-known-good.sh",
    "resolve-rollback-target.sh",
    "production-capacity-bridge.py",
    "production_capacity_bridge_contract.py",
    "release_artifact_receipts.py",
    "release_cadence.py",
    "release_cadence_github.py",
    "release_cadence_native.py",
    "release_cadence_maintenance.py",
)


def production_release_tools(root: Path, old_paths: tuple[str, ...]) -> list[str]:
    """Pinned current tools must survive checkout of a historical application."""
    return [
        *old_paths,
        *(f"scripts/ci/{name}" for name in CI_PRODUCTION_TOOLS),
        "config/ci-governance.json",
        "config/release-cadence.json",
        "scripts/ci/verify-predecessor-acceptance.py",
        "scripts/ci/release_acceptance_provenance.py",
        "scripts/ci/resolve-deploy-scope.py",
        "scripts/ops/runtime_config_retention.py",
        "scripts/ops/production_drive_candidate_config.py",
        "scripts/ops/scope_commerce_runtime_policy.py",
        "scripts/ops/shared_files_runtime_policy.py",
        "scripts/ops/passkey_domain_policy.py",
        "scripts/ops/upsert_gcp_secret.py",
        *(f"deploy/{name}/bind_secrets.sh" for name in ("email-auth", "plg")),
        "scripts/ci/verify-prod-places-readiness.py",
        "scripts/ci/cloudrun-retention.py",
        "scripts/ci/process_group.py",
        "scripts/ci/cloudrun-rollback.sh",
        "scripts/ci/runtime_capacity_inventory.py",
        "scripts/ci/runtime_capacity_cli.py",
        "scripts/ci/verify-cloudrun-revision-provenance.py",
        "scripts/ci/account-deletion-fence-decision.py",
        "scripts/ci/verify-cloud-scheduler-attempt.py",
        "scripts/ci/cloudrun-rollback.sh",
        "deploy/drive/rollback_after_worker_failure.sh",
        "deploy/drive/rebind_protected_document_backend.py",
        *(
            f"deploy/account-deletion/{name}"
            for name in (
                "install_release_fence.sql",
                "remove_release_fence.sql",
                "activate_release.py",
                "activation_retirement.py",
                "release_source.py",
                "compatibility_restoration.py",
                "restoration_validation.py",
                "restoration_operation.py",
                "restoration_database.py",
                "document_restoration_fence.py",
                "production-restoration.json",
                "release_target.py",
                "setup_cleanup_scheduler.sh",
                "verify_release_boundary.sql",
            )
        ),
        "scripts/ci/managed_provider_readiness.py",
        "scripts/ci/managed_capability_proof.py",
        "scripts/ops/verify-env-secrets-parity.py",
        *(path.relative_to(root).as_posix() for path in (root / "deploy/phone").glob("*.py")),
        *(f"deploy/drive/{name}" for name in DRIVE_PRODUCTION_TOOLS),
        *(
            f"scripts/deploy/{name}"
            for name in (
                "backend-deploy.sh",
                "backend-phone-rollback.sh",
                "verify-managed-vertex-runtime.sh",
                *(path.name for path in (root / "scripts/deploy").glob("backend-*-settings.sh")),
                "commerce-preview-bindings.sh",
                "scope-commerce-secrets.sh",
                "pod-release-env.sh",
                "preserve-pod-release.py",
            )
        ),
    ]
