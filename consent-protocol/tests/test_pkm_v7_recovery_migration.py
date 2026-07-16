import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "db/migrations/098_pkm_v7_recovery_foundation.sql"


def test_recovery_migration_is_registered_and_additive():
    sql = MIGRATION.read_text()
    release = json.loads((ROOT / "db/release_migration_manifest.json").read_text())
    uat = json.loads((ROOT / "db/contracts/uat_integrated_schema.json").read_text())
    dev = json.loads((ROOT / "db/contracts/dev_minimum_schema.json").read_text())

    assert release["ordered_migrations"][-1] == MIGRATION.name
    assert MIGRATION.name in release["groups"]["pkm"]
    assert uat["expected_migration_version"] == 98
    assert dev["expected_migration_version"] == 98
    assert "DROP FUNCTION commit_pkm_domain_mutation_v2" not in sql
    assert "DROP FUNCTION commit_pkm_domain_mutation_v3" not in sql
    assert "ALTER TABLE pkm_manifests" in sql
    assert "pkm_contract_version TEXT NOT NULL DEFAULT '0.0.0'" in sql
    assert "readable_projection_version TEXT NOT NULL DEFAULT '0.0.0'" in sql


def test_recovery_migration_enforces_zero_loss_boundaries():
    sql = MIGRATION.read_text()

    for required in (
        "get_pkm_domain_snapshot_v1",
        "start_or_resume_pkm_upgrade_v1",
        "transition_pkm_upgrade_run_v1",
        "transition_pkm_upgrade_step_v1",
        "issue_pkm_upgrade_claim_v1",
        "archive_pkm_domain_revision_v1",
        "commit_pkm_domain_mutation_v4",
        "rollback_pkm_domain_revision_v1",
        "delete_pkm_domain_v2",
        "prune_expired_pkm_domain_revisions_v1",
        "prune_expired_pkm_recovery_for_user_v1",
        "idx_pkm_upgrade_runs_one_active_per_user",
        "idx_pkm_domain_revisions_one_origin",
        "pkm_domain_revision_segments",
        "pkm_domain_commits",
        "pkm_upgrade_claims",
        "mixed_pkm_domain_revisions",
        "incomplete_pkm_preservation_receipt",
        "pkm_commit_id_binding_mismatch",
        "invalid_pkm_request_fingerprint",
        "pkm_rollback_commit_binding_mismatch",
        "pkm_quarantine_segment_required",
        "pkm_quarantine_must_be_private",
        "pkm_revision_not_bound_to_run",
        "pkm_revision_has_no_ciphertext",
        "pkm_upgrade_step_has_no_committed_upgrade",
        "pkm_upgrade_step_revision_mismatch",
        "idempotent_replay",
        "FOR UPDATE SKIP LOCKED",
    ):
        assert required in sql

    # Scope origin is metadata only. Canonical reserved and dynamic scope
    # strings are intentionally absent from the migration rewrite surface.
    assert "REPLACE(scope" not in sql
    assert "attr." not in sql
    assert "scope_origin_code = 'd'" in sql
    assert "__quarantine_v1" in sql
    assert "SET refresh_status = 'refresh_pending'" in sql


def test_snapshot_checks_the_whole_domain_before_applying_segment_filter():
    sql = MIGRATION.read_text()
    revision_query = sql.split("IF v_max_content_revision IS NOT NULL", 1)[0]

    assert "segment_id = ANY(p_segment_ids)" not in revision_query
    assert "pkm_domain_manifest_missing" in sql
    assert "manifest_version <> v_manifest_revision" in sql


def test_recovery_tables_are_part_of_uat_schema_contract():
    contract = json.loads((ROOT / "db/contracts/uat_integrated_schema.json").read_text())

    for table in (
        "pkm_domain_revisions",
        "pkm_domain_revision_segments",
        "pkm_domain_commits",
        "pkm_upgrade_claims",
    ):
        assert table in contract["required_tables"]
    for function in (
        "get_pkm_domain_snapshot_v1",
        "transition_pkm_upgrade_run_v1",
        "transition_pkm_upgrade_step_v1",
        "commit_pkm_domain_mutation_v4",
        "rollback_pkm_domain_revision_v1",
    ):
        assert function in contract["required_functions"]


def test_protected_uat_gate_requires_live_recovery_rehearsal():
    gate = (ROOT.parent / "scripts/ci/pkm-upgrade-gate.sh").read_text()
    rehearsal = (ROOT / "db/verify/pkm_v7_zero_loss_rehearsal.sql").read_text()

    assert "PKM_UPGRADE_POSTGRES_REHEARSAL_URL" in gate
    assert "PKM_UPGRADE_STRUCTURE_AGENT_EVAL" in gate
    assert "PKM_UPGRADE_RUNTIME_AUDIT_BASE_URL" in gate
    assert "PKM_UPGRADE_RUNTIME_AUDIT_DEFERRED" in gate
    assert "pkm-runtime-audit.sh" in gate
    assert "pkm_v7_zero_loss_rehearsal.sql" in gate
    assert "primary_method" in rehearsal
    assert "get_pkm_domain_snapshot_v1" in rehearsal
    assert "commit_pkm_domain_mutation_v4" in rehearsal
    assert "rollback_pkm_domain_revision_v1" in rehearsal
    assert "legacy_full_blob_upgrade_failed" in rehearsal
    assert "legacy_full_blob_origin_snapshot_missing" in rehearsal
    assert "legacy_full_blob_rollback_failed" in rehearsal
    assert "legacy_full_blob_rollback_snapshot_mismatch" in rehearsal
    assert "rollback_manifest_projection_revision_mismatch" in rehearsal
    assert "rollback_index_revision_mismatch" in rehearsal
    assert "transition_pkm_upgrade_run_v1" in rehearsal
    assert "transition_pkm_upgrade_step_v1" in rehearsal
    assert "cross_owner_transition_was_not_rejected" in rehearsal
    assert "uncommitted_step_completion_was_not_rejected" in rehearsal
    assert "owner_published_projection_changed_during_rollback" in rehearsal
    assert rehearsal.rstrip().endswith("ROLLBACK;")


def test_uat_deploy_runs_protected_pkm_gate_and_reviewer_byok_rehearsal():
    workflow = (ROOT.parent / ".github/workflows/deploy-uat.yml").read_text()
    gate = (ROOT.parent / "scripts/ci/pkm-upgrade-gate.sh").read_text()
    candidate_evaluator = (
        ROOT.parent / "scripts/ci/run-candidate-pkm-structure-agent-eval.sh"
    ).read_text()

    assert "PKM_UPGRADE_PROTECTED_UAT=1" in workflow
    assert "PKM_UPGRADE_STRUCTURE_AGENT_EVAL_DEFERRED=1" in workflow
    assert "PKM_UPGRADE_STRUCTURE_AGENT_EVAL_DEFERRED" in gate
    assert "Verify candidate PKM evaluator in Cloud Run" in workflow
    assert workflow.index("Verify candidate PKM evaluator in Cloud Run") < workflow.index(
        "Promote deployed revisions to UAT traffic"
    )
    assert "--skip-shadow" in candidate_evaluator
    assert "GOOGLE_API_KEY=GOOGLE_API_KEY:latest" not in candidate_evaluator
    assert "HUSHH_GENAI_AUTH_MODE=vertex_adc" in candidate_evaluator
    assert "GOOGLE_GENAI_USE_VERTEXAI=true" in candidate_evaluator
    assert "GOOGLE_CLOUD_PROJECT=${GCP_PROJECT_ID}" in candidate_evaluator
    assert "GOOGLE_CLOUD_LOCATION=global" in candidate_evaluator
    assert "REVIEWER_" not in candidate_evaluator
    assert "PKM_UPGRADE_RUNTIME_AUDIT_DEFERRED=1" in workflow
    assert "verify-reviewer-byok" in workflow
    assert "reviewer_byok_continuity_failed" in workflow
    assert "verify-pkm-runtime-audit" in workflow
    assert "pkm_runtime_audit_failed" in workflow
    assert workflow.index("Promote deployed revisions to UAT traffic") < workflow.index(
        "Verify live PKM, investor, and RIA runtime audits"
    )
    assert workflow.index("Verify live PKM, investor, and RIA runtime audits") < workflow.index(
        "Classify UAT release outcome"
    )
