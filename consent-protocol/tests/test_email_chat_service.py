"""Gmail chat regressions using synthetic model, session, and provider ports."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from hushh_mcp.services.email_chat_service import (
    _UNAVAILABLE_MESSAGE,
)
from tests.email_oss_cases.accounting import (
    test_amounts_reject_floats_missing_values_and_unbounded_or_lossy_formats as test_amounts_reject_floats_missing_values_and_unbounded_or_lossy_formats,
)
from tests.email_oss_cases.accounting import (
    test_conflicting_transaction_keys_fail_closed as test_conflicting_transaction_keys_fail_closed,
)
from tests.email_oss_cases.accounting import (
    test_currency_source_and_schema_reject_untrusted_shapes as test_currency_source_and_schema_reject_untrusted_shapes,
)

# Explicit case exports stay in the existing blocking manifest owner.
from tests.email_oss_cases.accounting import (
    test_decimal_totals_preserve_precision_refunds_and_independent_currencies as test_decimal_totals_preserve_precision_refunds_and_independent_currencies,
)
from tests.email_oss_cases.accounting import (
    test_explicit_numeric_evidence_accepts_exact_values_without_quantization as test_explicit_numeric_evidence_accepts_exact_values_without_quantization,
)
from tests.email_oss_cases.accounting import (
    test_malformed_localized_scientific_or_partial_number_evidence_is_rejected as test_malformed_localized_scientific_or_partial_number_evidence_is_rejected,
)
from tests.email_oss_cases.accounting import (
    test_missing_amount_cannot_become_zero_even_with_a_real_source_quote as test_missing_amount_cannot_become_zero_even_with_a_real_source_quote,
)
from tests.email_oss_cases.accounting import (
    test_only_explicit_transaction_keys_deduplicate_without_semantic_inference as test_only_explicit_transaction_keys_deduplicate_without_semantic_inference,
)
from tests.email_oss_cases.accounting import (
    test_row_limit_and_empty_result_are_explicit as test_row_limit_and_empty_result_are_explicit,
)
from tests.email_oss_cases.accounting import (
    test_verified_receipt_rows_sum_100_10_plus_0_2_exactly as test_verified_receipt_rows_sum_100_10_plus_0_2_exactly,
)
from tests.email_oss_cases.bindings import (
    test_default_runtime_preserves_non_uat_and_never_falls_back_in_uat as test_default_runtime_preserves_non_uat_and_never_falls_back_in_uat,
)
from tests.email_oss_cases.bindings import (
    test_email_selection_survives_token_refresh_but_not_account_switch as test_email_selection_survives_token_refresh_but_not_account_switch,
)
from tests.email_oss_cases.bindings import (
    test_legacy_mail_offer_is_migrated_only_for_current_owner_conversation_account as test_legacy_mail_offer_is_migrated_only_for_current_owner_conversation_account,
)
from tests.email_oss_cases.bindings import (
    test_oss_delegation_uses_existing_owner_memory_and_no_legacy_planner as test_oss_delegation_uses_existing_owner_memory_and_no_legacy_planner,
)
from tests.email_oss_cases.bindings import (
    test_oss_factory_failure_is_structured_unavailable as test_oss_factory_failure_is_structured_unavailable,
)
from tests.email_oss_cases.bindings import (
    test_owner_gmail_sdk_port_fences_account_switch_and_closes_resource as test_owner_gmail_sdk_port_fences_account_switch_and_closes_resource,
)
from tests.email_oss_cases.bindings import (
    test_vault_token_is_bound_to_its_actual_post_refresh_account as test_vault_token_is_bound_to_its_actual_post_refresh_account,
)
from tests.email_oss_cases.effect_failures import (
    test_draft_rejected_credential_returns_guidance_but_uncertain_effect_stays_failed as test_draft_rejected_credential_returns_guidance_but_uncertain_effect_stays_failed,
)
from tests.email_oss_cases.effect_failures import (
    test_reviewed_send_rejects_unsupported_html_instead_of_silently_dropping_it as test_reviewed_send_rejects_unsupported_html_instead_of_silently_dropping_it,
)
from tests.email_oss_cases.gmail_execution import (
    test_access_required_before_mutation_and_errors_are_content_free_without_retry as test_access_required_before_mutation_and_errors_are_content_free_without_retry,
)
from tests.email_oss_cases.gmail_execution import (
    test_authority_revoked_after_mutation_keeps_uncertain_effect_signal as test_authority_revoked_after_mutation_keeps_uncertain_effect_signal,
)
from tests.email_oss_cases.gmail_execution import (
    test_binary_attachment_is_decoded_bounded_and_never_returned_as_base64 as test_binary_attachment_is_decoded_bounded_and_never_returned_as_base64,
)
from tests.email_oss_cases.gmail_execution import (
    test_cancellation_joins_owned_sdk_worker_before_returning_to_resource_owner as test_cancellation_joins_owned_sdk_worker_before_returning_to_resource_owner,
)
from tests.email_oss_cases.gmail_execution import (
    test_eaia_reply_preserves_thread_message_id_references_and_exact_recipients as test_eaia_reply_preserves_thread_message_id_references_and_exact_recipients,
)
from tests.email_oss_cases.gmail_execution import (
    test_html_charset_and_nested_mime_are_cleaned_without_following_links as test_html_charset_and_nested_mime_are_cleaned_without_following_links,
)
from tests.email_oss_cases.gmail_execution import (
    test_modify_trash_and_invalid_header_never_add_unrequested_effects as test_modify_trash_and_invalid_header_never_add_unrequested_effects,
)
from tests.email_oss_cases.gmail_execution import (
    test_oversized_gmail_search_can_shrink_once_without_advancing_cursor as test_oversized_gmail_search_can_shrink_once_without_advancing_cursor,
)
from tests.email_oss_cases.gmail_execution import (
    test_partial_batch_failure_keeps_order_and_discloses_failed_count as test_partial_batch_failure_keeps_order_and_discloses_failed_count,
)
from tests.email_oss_cases.gmail_execution import (
    test_pinned_original_source_and_license_hashes_are_preserved as test_pinned_original_source_and_license_hashes_are_preserved,
)
from tests.email_oss_cases.gmail_execution import (
    test_recheck_lost_authority_between_list_and_batch_prevents_private_reads as test_recheck_lost_authority_between_list_and_batch_prevents_private_reads,
)
from tests.email_oss_cases.gmail_execution import (
    test_requested_body_uses_vendor_decoder_prefers_plain_and_skips_attachments as test_requested_body_uses_vendor_decoder_prefers_plain_and_skips_attachments,
)
from tests.email_oss_cases.gmail_execution import (
    test_search_page_bound_is_enforced_before_provider as test_search_page_bound_is_enforced_before_provider,
)
from tests.email_oss_cases.gmail_execution import (
    test_single_page_sdk_batch_keeps_cursor_inventory_and_performs_no_body_extraction as test_single_page_sdk_batch_keeps_cursor_inventory_and_performs_no_body_extraction,
)
from tests.email_oss_cases.gmail_execution import (
    test_vendor_draft_and_send_preserve_recipient_roles_and_do_not_send_a_draft as test_vendor_draft_and_send_preserve_recipient_roles_and_do_not_send_a_draft,
)
from tests.email_oss_cases.legacy_history import (
    test_receipt_resume_repairs_unknown_name_before_azure_codec_and_is_repeatable as test_receipt_resume_repairs_unknown_name_before_azure_codec_and_is_repeatable,
)
from tests.email_oss_cases.legacy_history import (
    test_tool_history_never_matches_a_future_call_or_keeps_duplicate_results as test_tool_history_never_matches_a_future_call_or_keeps_duplicate_results,
)
from tests.email_oss_cases.mailbox_review import (
    test_selected_sdk_messages_use_existing_review_ledger_without_search_or_content_reads as test_selected_sdk_messages_use_existing_review_ledger_without_search_or_content_reads,
)
from tests.email_oss_cases.memory import (
    test_browser_and_server_bind_the_same_commit_locator as test_browser_and_server_bind_the_same_commit_locator,
)
from tests.email_oss_cases.memory import (
    test_ingress_projection_and_commit_require_exact_owner_pending_and_real_ledger as test_ingress_projection_and_commit_require_exact_owner_pending_and_real_ledger,
)
from tests.email_oss_cases.memory import (
    test_no_ledger_port_and_authority_change_during_lookup_cannot_ack as test_no_ledger_port_and_authority_change_during_lookup_cannot_ack,
)
from tests.email_oss_cases.memory import (
    test_pending_save_requires_exact_real_commit_not_a_success_claim as test_pending_save_requires_exact_real_commit_not_a_success_claim,
)
from tests.email_oss_cases.memory import (
    test_projection_is_bounded_owner_scoped_and_only_exact_sections_filter as test_projection_is_bounded_owner_scoped_and_only_exact_sections_filter,
)
from tests.email_oss_cases.memory import (
    test_revocation_withdraws_projection_and_pending_effects as test_revocation_withdraws_projection_and_pending_effects,
)
from tests.email_oss_cases.memory import (
    test_sections_in_code_are_not_a_second_preferences_source as test_sections_in_code_are_not_a_second_preferences_source,
)
from tests.email_oss_cases.routing import (
    indexed_router as indexed_router,
)
from tests.email_oss_cases.routing import (
    test_actual_fastembed_selects_pdf_retrieval_and_compound_draft as test_actual_fastembed_selects_pdf_retrieval_and_compound_draft,
)
from tests.email_oss_cases.routing import (
    test_concurrent_first_selections_build_one_process_router as test_concurrent_first_selections_build_one_process_router,
)
from tests.email_oss_cases.routing import (
    test_isolated_read_draft_reply_routes_keep_native_source_lookup as test_isolated_read_draft_reply_routes_keep_native_source_lookup,
)
from tests.email_oss_cases.routing import (
    test_low_confidence_uses_only_email_tools_not_other_domains as test_low_confidence_uses_only_email_tools_not_other_domains,
)
from tests.email_oss_cases.routing import (
    test_real_indexed_router_merges_compound_routes_and_retains_retrieval as test_real_indexed_router_merges_compound_routes_and_retains_retrieval,
)
from tests.email_oss_cases.routing import (
    test_router_failure_does_not_log_private_request_or_exception as test_router_failure_does_not_log_private_request_or_exception,
)
from tests.email_oss_cases.routing import (
    test_uat_startup_requires_successful_router_before_readiness as test_uat_startup_requires_successful_router_before_readiness,
)
from tests.email_oss_cases.runtime import (
    test_ambiguous_unknown_history_name_is_not_repaired as test_ambiguous_unknown_history_name_is_not_repaired,
)
from tests.email_oss_cases.runtime import (
    test_attachment_uses_inventory_scanner_parser_then_final_model_answer as test_attachment_uses_inventory_scanner_parser_then_final_model_answer,
)
from tests.email_oss_cases.runtime import (
    test_authority_is_rechecked_after_model_and_prevents_tool_execution as test_authority_is_rechecked_after_model_and_prevents_tool_execution,
)
from tests.email_oss_cases.runtime import (
    test_gmail_admission_is_per_message_not_per_stream_delta as test_gmail_admission_is_per_message_not_per_stream_delta,
)
from tests.email_oss_cases.runtime import (
    test_history_repairs_names_chronologically_without_global_id_deduplication as test_history_repairs_names_chronologically_without_global_id_deduplication,
)
from tests.email_oss_cases.runtime import (
    test_missing_invoice_amount_never_becomes_zero_in_memory as test_missing_invoice_amount_never_becomes_zero_in_memory,
)
from tests.email_oss_cases.runtime import (
    test_model_limit_is_error_not_tool_result_or_fabricated_final_success as test_model_limit_is_error_not_tool_result_or_fabricated_final_success,
)
from tests.email_oss_cases.runtime import (
    test_native_draft_creation_has_no_send_review as test_native_draft_creation_has_no_send_review,
)
from tests.email_oss_cases.runtime import (
    test_old_client_binds_reads_without_unsupported_review_cards as test_old_client_binds_reads_without_unsupported_review_cards,
)
from tests.email_oss_cases.runtime import (
    test_parallel_calls_keep_each_original_id_and_router_binds_real_subset as test_parallel_calls_keep_each_original_id_and_router_binds_real_subset,
)
from tests.email_oss_cases.runtime import (
    test_parallel_duplicate_drafts_execute_at_most_once as test_parallel_duplicate_drafts_execute_at_most_once,
)
from tests.email_oss_cases.runtime import (
    test_pending_memory_save_requires_actual_acknowledgment as test_pending_memory_save_requires_actual_acknowledgment,
)
from tests.email_oss_cases.runtime import (
    test_pending_review_does_not_send_and_preserves_directive as test_pending_review_does_not_send_and_preserves_directive,
)
from tests.email_oss_cases.runtime import (
    test_send_requires_exact_review_receipt_negative_control as test_send_requires_exact_review_receipt_negative_control,
)
from tests.email_oss_cases.runtime import (
    test_standard_graph_pairs_tool_results_and_returns_natural_final_answer as test_standard_graph_pairs_tool_results_and_returns_natural_final_answer,
)
from tests.email_oss_cases.runtime import (
    test_uncertain_draft_aborts_without_replanning_or_retry as test_uncertain_draft_aborts_without_replanning_or_retry,
)
from tests.email_oss_cases.transport import (
    test_expired_body_deadline_is_checked_on_native_chunks_without_rebuffering as test_expired_body_deadline_is_checked_on_native_chunks_without_rebuffering,
)
from tests.email_oss_cases.transport import (
    test_http_transport_caps_decompression_before_full_allocation as test_http_transport_caps_decompression_before_full_allocation,
)
from tests.email_oss_cases.transport import (
    test_http_transport_checks_declared_size_before_consuming_any_bytes as test_http_transport_checks_declared_size_before_consuming_any_bytes,
)
from tests.email_oss_cases.transport import (
    test_http_transport_stops_encoded_stream_before_sdk_full_read as test_http_transport_stops_encoded_stream_before_sdk_full_read,
)
from tests.email_oss_cases.transport import (
    test_instrumented_httpx_cannot_export_private_mail_urls as test_instrumented_httpx_cannot_export_private_mail_urls,
)
from tests.email_oss_cases.transport import (
    test_real_sdk_single_batch_and_oauth_use_bounded_transport_without_network as test_real_sdk_single_batch_and_oauth_use_bounded_transport_without_network,
)
from tests.email_oss_cases.transport import (
    test_sdk_401_uses_vault_owned_refresh_and_never_retries_an_effect as test_sdk_401_uses_vault_owned_refresh_and_never_retries_an_effect,
)
from tests.email_oss_cases.turn_context import (
    test_excludes_tool_payloads_reasoning_placeholders_and_context_packets as test_excludes_tool_payloads_reasoning_placeholders_and_context_packets,
)
from tests.email_oss_cases.turn_context import (
    test_history_count_and_character_bounds_keep_newest_text_without_invented_fields as test_history_count_and_character_bounds_keep_newest_text_without_invented_fields,
)
from tests.email_oss_cases.turn_context import (
    test_json_shaped_session_is_projected_without_mutating_tool_or_state_fields as test_json_shaped_session_is_projected_without_mutating_tool_or_state_fields,
)
from tests.email_oss_cases.turn_context import (
    test_legacy_unmarked_partial_and_error_turns_cannot_supply_history as test_legacy_unmarked_partial_and_error_turns_cannot_supply_history,
)
from tests.email_oss_cases.turn_context import (
    test_owner_calendar_clock_uses_local_day_and_dst_without_query_rewriting as test_owner_calendar_clock_uses_local_day_and_dst_without_query_rewriting,
)
from tests.email_oss_cases.turn_context import (
    test_projects_only_completed_exclusive_email_turns_in_chronological_order as test_projects_only_completed_exclusive_email_turns_in_chronological_order,
)
from tests.email_oss_cases.turn_context import (
    test_rejects_another_owner_or_conversation as test_rejects_another_owner_or_conversation,
)
from tests.helpers.email_chat_fakes import (
    _TOKEN,
    _FakeGmail,
    _FakeStore,
    _fc_response,
    _service,
    _text_response,
)


async def test_needs_reply_tool_flow():
    store, gmail = _FakeStore(), _FakeGmail()
    svc = _service(
        store=store,
        gmail=gmail,
        responses=[
            _fc_response("list_needs_reply", {"limit": 5}),
            _text_response("You have 1 thread waiting: Q3 plan from Ravi."),
        ],
    )
    result = await svc.handle_turn(
        user_id="u1", message="what needs a reply?", consent_token=_TOKEN
    )
    assert result["response"] == "You have 1 thread waiting: Q3 plan from Ravi."
    assert result["conversationId"] == "conv-new"
    assert result["isComplete"] is True
    assert result["stateChanged"] is False
    # Tool dispatched with the bound user_id and the model-supplied limit.
    assert gmail.calls == [("list_nudges", "u1", 5)]
    assert store.added[-1]["role"] == "assistant"
    assert store.added[-1]["status"] == "complete"


async def test_search_inbox_tool_flow():
    store, gmail = _FakeStore(), _FakeGmail()
    svc = _service(
        store=store,
        gmail=gmail,
        responses=[
            _fc_response("search_inbox", {"query": "from:ravi newer_than:7d", "limit": 3}),
            _text_response("Found 1 match: Invoice from Acme Billing."),
        ],
    )
    result = await svc.handle_turn(
        user_id="u1", message="find emails from ravi", consent_token=_TOKEN
    )
    assert result["response"] == "Found 1 match: Invoice from Acme Billing."
    assert gmail.calls == [("search_inbox", "u1", "from:ravi newer_than:7d", 3)]


async def test_receipt_tools_are_part_of_the_unified_email_specialist():
    store, gmail = _FakeStore(), _FakeGmail()
    svc = _service(
        store=store,
        gmail=gmail,
        responses=[
            _fc_response("list_receipts", {"page": 2, "per_page": 4}),
            _text_response("No receipts are synced yet."),
        ],
    )
    result = await svc.handle_turn(user_id="u1", message="show receipts", consent_token=_TOKEN)
    assert result["response"] == "No receipts are synced yet."
    assert gmail.calls == [("list_receipts", "u1", 2, 4)]

    store, gmail = _FakeStore(), _FakeGmail()
    svc = _service(
        store=store,
        gmail=gmail,
        responses=[
            _fc_response("sync_status", {}),
            _text_response("Receipt sync is healthy."),
        ],
    )
    result = await svc.handle_turn(
        user_id="u1", message="is receipt sync healthy", consent_token=_TOKEN
    )
    assert result["response"] == "Receipt sync is healthy."
    assert gmail.calls == [("get_status", "u1")]


async def test_empty_message_returns_prompt_without_tools():
    store, gmail = _FakeStore(), _FakeGmail()
    svc = _service(store=store, gmail=gmail, responses=[])
    result = await svc.handle_turn(user_id="u1", message=None, consent_token=_TOKEN)
    assert result["isComplete"] is True
    assert "needs a reply" in result["response"].lower()
    assert gmail.calls == []


async def test_unavailable_when_model_not_ready():
    store, gmail = _FakeStore(), _FakeGmail()
    svc = _service(store=store, gmail=gmail, responses=[], ready=False)
    result = await svc.handle_turn(user_id="u1", message="hi", consent_token=_TOKEN)
    assert result["response"] == _UNAVAILABLE_MESSAGE
    assert result["isComplete"] is False
    assert gmail.calls == []


async def test_private_email_runs_shared_loop_with_scoped_broker_and_owner_store(monkeypatch):
    import json
    from dataclasses import replace
    from unittest.mock import AsyncMock

    from hushh_mcp.adk_bridge import _register_builtin_specialists
    from hushh_mcp.adk_bridge.dispatch import bind_specialist_runtime, dispatch
    from hushh_mcp.one_adk import agent_tree as tree
    from hushh_mcp.runtime_providers import owner_gemini
    from hushh_mcp.services import pod_consent_client, pod_memory_service, pod_specialist_runtime
    from hushh_mcp.services.pod_consent_client import ConsentVerdict
    from hushh_mcp.services.pod_hub_client import PodHubClient

    monkeypatch.setenv("HUSSH_POD_MODE", "1")
    monkeypatch.setenv("HUSSH_ID", "pod-owner")
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("GMAIL_CHAT_READS", "true")
    monkeypatch.setenv("CONNECTOR_INTERNAL_OWNER_COHORT", "owner")
    revoked = False

    async def verify(token, *, expected_scope):
        scopes = {"read": "pkm.read", "email-view": "cap.email.inbox.view"}
        valid = scopes.get(token) == expected_scope and not (revoked and token == "email-view")
        return ConsentVerdict(valid, True, "owner", "pod-owner")

    monkeypatch.setattr(pod_consent_client, "verify_consent", verify)
    log = SimpleNamespace(_owner_id="pod-owner", require_open=AsyncMock())
    monkeypatch.setattr(pod_memory_service, "_resolve_log", lambda: log)
    store = _FakeStore()
    stores = []

    def local_store(**kwargs):
        stores.append(kwargs)
        return store

    monkeypatch.setattr(pod_specialist_runtime, "PodAgentChatStore", local_store)
    shared_auth = AsyncMock(side_effect=AssertionError("Pod must not use hub vault authority"))
    monkeypatch.setattr(tree, "validate_first_party_owner_token", shared_auth)
    monkeypatch.setattr(
        "hushh_mcp.adk_bridge.email_agent.validate_first_party_owner_token", shared_auth
    )
    responses = iter(
        [
            _text_response(
                json.dumps({"operation": "search_inbox", "query": "subject:invoice", "limit": 2})
            ),
            _text_response(
                json.dumps({"answer": "One invoice from Billing.", "source_refs": ["mail:1"]})
            ),
        ]
    )
    calls = []

    async def generate(**kwargs):
        calls.append(True)
        return next(responses)

    client = SimpleNamespace(aio=SimpleNamespace(models=SimpleNamespace(generate_content=generate)))
    monkeypatch.setattr(owner_gemini, "build_owner_gemini_client", lambda: client)
    reads = []

    def read(_self, name, token, **kwargs):
        reads.append((name, token, kwargs))
        assert name == "email" and token == "email-view"
        if kwargs["email_read"]["operation"] == "validate":
            return {"current": True}
        return {
            "metadata": {
                "metadata_only": True,
                "truncated": False,
                "untrusted_external_content": [{"source_ref": "mail:1", "subject": "Invoice"}],
            },
            "observation": {"expires_at": 9999999999, "nonce": "0" * 32, "signature": "synthetic"},
        }

    monkeypatch.setattr(PodHubClient, "read_specialist", read)
    _register_builtin_specialists()
    runtime = pod_specialist_runtime.build_pod_specialist_runtime(
        user_id="owner",
        hushh_id="pod-owner",
        consent_token="read",  # noqa: S106
        provider="gemini",
        model="synthetic",
        runtime_mode="user_adc",
        credential=None,
        credential_transport="developer_api",
        vertex_project=None,
        vertex_location=None,
        data_door_grants={"email": "email-view"},
    )
    context = SimpleNamespace(
        user_id="pod-owner",
        invocation_id="sdk-invocation",
        function_call_id="sdk-call",
        state={
            tree.STATE_USER_ID: "owner",
            tree.STATE_CONSENT_TOKEN: "read",
            tree.STATE_CONVERSATION_ID: "thread",
            tree.STATE_EXECUTION_SURFACE: "typed_chat",
        },
    )
    with bind_specialist_runtime(runtime):
        task = await tree._task_from_context(context, "Find my invoice", agent_id="agent_email")
        assert task is not None
        assert task.authority.subject_user_id == "owner"
        assert task.expected_task_id == '["sdk-invocation","sdk-call"]'
        result = await dispatch("agent_email", task)
        assert result.text == "One invoice from Billing."
        assert result.directive is None and not result.state_changed
        assert stores[0]["log"] is log and stores[0]["agent_id"] == "agent_email"
        assert [r[2]["email_read"]["operation"] for r in reads] == [
            "search_inbox",
            "validate",
            "validate",
        ]
        assert len(calls) == 2
        with pytest.raises(PermissionError):
            await dispatch("agent_email", replace(task, expected_task_id="different-call"))
        revoked = True
        with pytest.raises(PermissionError):
            await dispatch("agent_email", task)
        assert len(calls) == 2 and len(reads) == 3
        revoked = False
        context.user_id = "foreign-session"
        assert await tree._task_from_context(context, "read", agent_id="agent_email") is None
        context.user_id = "pod-owner"
        context.state[tree.STATE_CONSENT_TOKEN] = "different-credential"
        assert await tree._task_from_context(context, "read", agent_id="agent_email") is None
        context.state[tree.STATE_CONSENT_TOKEN] = "read"
    with bind_specialist_runtime(replace(runtime, admit_owner=None)):
        assert await tree._task_from_context(context, "read", agent_id="agent_email") is None
    shared_auth.assert_not_awaited()
    with pytest.raises(PermissionError):
        await pod_specialist_runtime.PodEmailReadPort("owner", "email-view").search_inbox(
            user_id="foreign",
            query="invoice",
        )
    assert len(reads) == 3
