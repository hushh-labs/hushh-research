"""Ordered phases for the hosted provider-account journal regression."""

from types import SimpleNamespace

from tests.hosted_provider_transition_journal_cleanup import (
    _assert_removal_lock_and_archive_provenance,
    _assert_replay_rejects_transition_drift,
    _assert_resolution_rollback_refuses_retained_evidence,
    _define_cleanup_reservation,
    _exercise_cleanup_fences,
    _prepare_cleanup_candidates,
    _prepare_replay_target_owner,
    _qualify_dev_transition_family,
    _replay_and_assert_catalog_preservation,
    _start_replay_target,
    _stop_replay_target,
)
from tests.hosted_provider_transition_journal_legacy import (
    _check_rollback_and_apply_transition,
    _create_new_intent_fixture,
    _prepare_legacy_resume,
    _record_legacy_transition,
    _resume_legacy_transition,
)
from tests.hosted_provider_transition_journal_setup import (
    _seed_policy_and_reservations,
    _seed_provisioned_rows,
    _set_test_environment,
)
from tests.hosted_provider_transition_journal_state import (
    _assert_duplicate_foreign_and_stale_refusals,
    _assert_preparation_history_frozen,
    _assert_retained_admission_shape,
    _persist_unknown_transition,
    _reject_malformed_transition,
    _settle_transition_and_check_effective_account,
)


def run_transition_journal_scenario(pg, monkeypatch, tmp_path):
    ctx = SimpleNamespace(pg=pg, monkeypatch=monkeypatch, tmp_path=tmp_path)
    _set_test_environment(ctx)
    _seed_policy_and_reservations(ctx)
    _seed_provisioned_rows(ctx)
    _check_rollback_and_apply_transition(ctx)
    _record_legacy_transition(ctx)
    _prepare_legacy_resume(ctx)
    _resume_legacy_transition(ctx)
    _create_new_intent_fixture(ctx)
    _assert_retained_admission_shape(ctx)
    _assert_duplicate_foreign_and_stale_refusals(ctx)
    _persist_unknown_transition(ctx)
    _reject_malformed_transition(ctx)
    _settle_transition_and_check_effective_account(ctx)
    _assert_preparation_history_frozen(ctx)
    _define_cleanup_reservation(ctx)
    _prepare_cleanup_candidates(ctx)
    _exercise_cleanup_fences(ctx)
    _assert_removal_lock_and_archive_provenance(ctx)
    _qualify_dev_transition_family(ctx)
    _start_replay_target(ctx)
    try:
        _prepare_replay_target_owner(ctx)
        _assert_replay_rejects_transition_drift(ctx)
        _replay_and_assert_catalog_preservation(ctx)
    finally:
        _stop_replay_target(ctx)
    _assert_resolution_rollback_refuses_retained_evidence(ctx)
