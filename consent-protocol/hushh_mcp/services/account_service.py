# hushh_mcp/services/account_service.py
"""Account deletion orchestration for full-account and persona-scoped cleanup."""

import asyncio
import hashlib
import json
import logging
import os
from collections.abc import Iterable
from datetime import datetime, timezone
from time import monotonic
from typing import Any, Dict, Literal

from sqlalchemy import text

from db.db_client import get_db, get_db_connection
from hushh_mcp.consent.audit_logger import get_trace_id
from hushh_mcp.services.account_answer_erasure import guard_answer_erasure
from hushh_mcp.services.account_deletion_lifecycle_service import (
    AccountDeletionLifecycleService,
    _postgres_sqlstate,
    settle_cleanup_database_call,
)
from hushh_mcp.services.account_deletion_provider_cleanup import (
    ProviderCredentialSnapshot,
    release_provider_grants_after_erasure,
    snapshot_provider_credentials_in_transaction,
)
from hushh_mcp.services.account_deletion_provider_journal import ProviderCleanupClaim
from hushh_mcp.services.account_export_stream import EXPORT_SECTIONS, AccountExportStream
from hushh_mcp.services.account_external_connector_erasure import (
    ACCOUNT_ERASURE_RETAINED_TABLES as ACCOUNT_ERASURE_RETAINED_TABLES,
)
from hushh_mcp.services.account_external_connector_erasure import (
    clear_external_connector_data,
)
from hushh_mcp.services.account_personal_agent_erasure import (
    PERSONAL_AGENT_DEPROVISION_REQUIRED_CODE as PERSONAL_AGENT_DEPROVISION_REQUIRED_CODE,
)
from hushh_mcp.services.account_personal_agent_erasure import (
    PERSONAL_AGENT_DEPROVISION_REQUIRED_MESSAGE as PERSONAL_AGENT_DEPROVISION_REQUIRED_MESSAGE,
)
from hushh_mcp.services.account_personal_agent_erasure import (
    PersonalAgentDeprovisioningRequiredError as PersonalAgentDeprovisioningRequiredError,
)
from hushh_mcp.services.account_personal_agent_erasure import (
    assert_external_resources_absent,
    personal_agent_erasure_queries,
)
from hushh_mcp.services.account_push_erasure import (
    erase_push_registrations,
    push_registration_erasure_queries,
)
from hushh_mcp.services.account_recovery_erasure import recovery_erasure_queries
from hushh_mcp.services.connection_graph_service import (
    list_connection_graph_viewer_ids,
    lock_connection_graph_users,
)
from hushh_mcp.services.hushh_tech_uat_database_attestation import (
    UAT_DATABASE_ATTESTATION_SQL,
    UAT_INSTANCE,
    is_attested_hushh_tech_uat_database,
    parse_connected_database_identity,
)

logger = logging.getLogger(__name__)

DeleteAccountTarget = Literal["investor", "ria", "both"]
# Emitted when the erasure transaction raised and was rolled back. A commit that
# fails on a dropped connection can still be ambiguous, so clients confirm the
# outcome through the tombstone-aware status route before keeping the session.
ACCOUNT_DELETION_FAILED_CODE = "ACCOUNT_DELETION_FAILED"
# A deploy's release fence (deploy/account-deletion/install_release_fence.sql)
# refused the erasure: nothing was deleted and it succeeds once the release ends.
ACCOUNT_DELETION_PAUSED_CODE = "ACCOUNT_DELETION_PAUSED"
_RELEASE_FENCE_MESSAGE = "during a lifecycle release"
# Cancel blocked SQL in PostgreSQL, where cancellation also unwinds the
# transaction. An asyncio timeout alone would leave a DB thread holding locks.
_ACCOUNT_ERASURE_SQL_LIMITS = text(
    "SELECT set_config('lock_timeout', '3000ms', TRUE), "
    "set_config('statement_timeout', '20000ms', TRUE)"
)
_RECOVERY_ERASURE_BATCH_SIZE = 100


def _is_release_fence_refusal(exc: BaseException) -> bool:
    return _postgres_sqlstate(exc) == "55000" and _RELEASE_FENCE_MESSAGE in str(exc)


TRANSACTIONAL_ACCOUNT_ERASURE_TABLES = frozenset(
    {
        "byoc_setup_jobs",
        "personal_agent_registry",
        "one_location_visibility_preferences",
        "one_location_visibility_exclusions",
        "kai_location_referrals",
        "pod_lifecycle_events",
    }
)


class AccountService:
    """
    Service for account-level operations.

    WARNING: This service performs SYSTEM-LEVEL cleanup that bypasses
    normal consent flows since the user is deleting their entire account.

    DEPRECATED TABLES REMOVED:
    - user_investor_profiles (identity confirmation via external services)
    - chat_conversations / chat_messages (chat functionality removed)
    - kai_sessions (session tracking removed)
    """

    def __init__(self):
        self._db = None
        self._table_exists_cache: dict[str, bool] = {}
        self._delete_by_user_queries = {
            "pod_migration_jobs": text("DELETE FROM pod_migration_jobs WHERE user_id = :user_id"),
            "webauthn_credentials": text(
                "DELETE FROM webauthn_credentials WHERE user_id = :user_id"
            ),
            "webauthn_challenges": text("DELETE FROM webauthn_challenges WHERE user_id = :user_id"),
            "world_model_embeddings": text(
                "DELETE FROM world_model_embeddings WHERE user_id = :user_id"
            ),
            "connected_system_intent_approval_challenges": text(
                "DELETE FROM connected_system_intent_approval_challenges WHERE user_id = :user_id"
            ),
            "connection_voice_preferences": text(
                "DELETE FROM connection_voice_preferences WHERE user_id = :user_id"
            ),
            "gmail_personal_information_request_preferences": text(
                "DELETE FROM gmail_personal_information_request_preferences WHERE user_id = :user_id"
            ),
            "gmail_personal_information_request_scan_states": text(
                "DELETE FROM gmail_personal_information_request_scan_states WHERE user_id = :user_id"
            ),
            "gmail_personal_information_requests": text(
                "DELETE FROM gmail_personal_information_requests WHERE user_id = :user_id"
            ),
            "google_calendar_action_proposals": text(
                "DELETE FROM google_calendar_action_proposals WHERE user_id = :user_id"
            ),
            "google_email_send_actions": text(
                "DELETE FROM google_email_send_actions WHERE user_id = :user_id"
            ),
            "google_oauth_attempts": text(
                "DELETE FROM google_oauth_attempts WHERE user_id = :user_id"
            ),
            "google_provider_connections": text(
                "DELETE FROM google_provider_connections WHERE user_id = :user_id"
            ),
            "google_service_grants": text(
                "DELETE FROM google_service_grants WHERE user_id = :user_id"
            ),
            "one_marketing_preferences": text(
                "DELETE FROM one_marketing_preferences WHERE user_id = :user_id"
            ),
            "pwm_research_preferences": text(
                "DELETE FROM pwm_research_preferences WHERE user_id = :user_id"
            ),
            "one_adk_sessions": text("DELETE FROM one_adk_sessions WHERE user_id = :user_id"),
            "one_agent_message_feedback": text(
                "DELETE FROM one_agent_message_feedback WHERE user_id = :user_id"
            ),
            "one_email_kyc_preferences": text(
                "DELETE FROM one_email_kyc_preferences WHERE user_id = :user_id"
            ),
            "one_kyc_client_connectors": text(
                "DELETE FROM one_kyc_client_connectors WHERE user_id = :user_id"
            ),
            "one_location_nearby_check_in_preferences": text(
                "DELETE FROM one_location_nearby_check_in_preferences WHERE user_id = :user_id"
            ),
            "one_location_sos_voice_preferences": text(
                "DELETE FROM one_location_sos_voice_preferences WHERE user_id = :user_id"
            ),
            "one_model_preferences": text(
                "DELETE FROM one_model_preferences WHERE user_id = :user_id"
            ),
            "one_private_text_processing_approvals": text(
                "DELETE FROM one_private_text_processing_approvals WHERE user_id = :user_id"
            ),
            "one_profile_discovery_jobs": text(
                "DELETE FROM one_profile_discovery_jobs WHERE user_id = :user_id"
            ),
            "pkm_embeddings": text("DELETE FROM pkm_embeddings WHERE user_id = :user_id"),
            "ria_business_contacts": text(
                "DELETE FROM ria_business_contacts WHERE user_id = :user_id"
            ),
            "ria_claim_dossiers": text("DELETE FROM ria_claim_dossiers WHERE user_id = :user_id"),
            "ria_license_verifications": text(
                "DELETE FROM ria_license_verifications WHERE user_id = :user_id"
            ),
            "one_product_activity_observations": text(
                "DELETE FROM one_product_activity_observations WHERE user_id=:user_id"
            ),
            "one_product_value_receipts": text(
                "DELETE FROM one_product_value_receipts WHERE user_id=:user_id"
            ),
            "one_product_activity_epochs": text(
                "DELETE FROM one_product_activity_epochs WHERE user_id=:user_id"
            ),
            "email_auth_challenges": text(
                """DELETE FROM email_auth_challenges WHERE expected_uid=:user_id
                   OR to_jsonb(email_auth_challenges)->>'user_id'=:user_id
                   OR destination_hash IN (SELECT destination_hash FROM email_auth_enrollments
                                            WHERE user_id=:user_id)"""
            ),
            "email_auth_enrollments": text(
                "DELETE FROM email_auth_enrollments WHERE user_id=:user_id"
            ),
            "contact_sync_lookup_budgets": text(
                "DELETE FROM contact_sync_lookup_budgets WHERE user_id = :user_id"
            ),
            "account_legal_acceptances": text(
                "DELETE FROM account_legal_acceptances WHERE user_id = :user_id"
            ),
            "actor_identity_cache": text(
                "DELETE FROM actor_identity_cache WHERE user_id = :user_id"
            ),
            "actor_verified_email_aliases": text(
                "DELETE FROM actor_verified_email_aliases WHERE user_id = :user_id"
            ),
            "actor_profiles": text("DELETE FROM actor_profiles WHERE user_id = :user_id"),
            "one_action_directive_ledger": text(
                "DELETE FROM one_action_directive_ledger WHERE user_id = :user_id"
            ),
            # Sealed arguments of connector calls awaiting review. A reset keeps the
            # actor_profiles row, so the FK cascade alone would leave them behind.
            "one_mcp_pending_calls": text(
                "DELETE FROM one_mcp_pending_calls WHERE user_id = :user_id"
            ),
            # Reset preserves vault_keys, so its FK cascade cannot clear this
            # pending hosted-memory review. No reviewed intent survives reset.
            "live_memory_hosted_source_envelopes": text(
                "DELETE FROM live_memory_hosted_source_envelopes WHERE user_id = :user_id"
            ),
            "live_memory_hosted_pilot_grants": text(
                "DELETE FROM live_memory_hosted_pilot_grants WHERE user_id = :user_id"
            ),
            "agent_chat_messages": text("DELETE FROM agent_chat_messages WHERE user_id = :user_id"),
            "agent_chat_conversations": text(
                "DELETE FROM agent_chat_conversations WHERE user_id = :user_id"
            ),
            # Direct-message history is participant-bound, not a `user_id`
            # table.  Erase child ciphertext before its pair conversation so
            # both sides' copies disappear during an account purge/reset.
            "messages": text(
                """
                DELETE FROM messages
                WHERE conversation_id IN (
                  SELECT id FROM conversations
                  WHERE participant_a_user_id = :user_id
                     OR participant_b_user_id = :user_id
                )
                """
            ),
            "conversations": text(
                """
                DELETE FROM conversations
                WHERE participant_a_user_id = :user_id
                   OR participant_b_user_id = :user_id
                """
            ),
            "direct_message_blocks": text(
                """
                DELETE FROM direct_message_blocks
                WHERE blocker_user_id = :user_id
                   OR blocked_user_id = :user_id
                """
            ),
            "consent_export_refresh_jobs": text(
                "DELETE FROM consent_export_refresh_jobs WHERE user_id = :user_id"
            ),
            "consent_exports": text("DELETE FROM consent_exports WHERE user_id = :user_id"),
            "connected_system_audit_events": text(
                "DELETE FROM connected_system_audit_events WHERE user_id = :user_id"
            ),
            "connected_system_intents": text(
                "DELETE FROM connected_system_intents WHERE user_id = :user_id"
            ),
            "connected_system_record_bindings": text(
                "DELETE FROM connected_system_record_bindings WHERE user_id = :user_id"
            ),
            "connected_system_owner_signing_keys": text(
                "DELETE FROM connected_system_owner_signing_keys WHERE user_id = :user_id"
            ),
            "connected_system_zk_contexts": text(
                "DELETE FROM connected_system_zk_contexts WHERE user_id = :user_id"
            ),
            "developer_oauth_tokens": text(
                "DELETE FROM developer_oauth_tokens WHERE subject_firebase_uid = :user_id"
            ),
            "developer_oauth_authorizations": text(
                "DELETE FROM developer_oauth_authorizations WHERE subject_firebase_uid = :user_id"
            ),
            "developer_oauth_audit_events": text(
                """
                DELETE FROM developer_oauth_audit_events
                WHERE subject_firebase_uid = :user_id
                   OR app_id IN (
                     SELECT app_id FROM developer_apps
                     WHERE owner_firebase_uid = :user_id
                   )
                """
            ),
            "developer_applications": text(
                """
                DELETE FROM developer_applications AS application
                WHERE application.id IN (
                  SELECT owned.application_id
                  FROM developer_apps AS owned
                  WHERE owned.owner_firebase_uid = :user_id
                    AND owned.application_id IS NOT NULL
                )
                  AND NOT EXISTS (
                    SELECT 1
                    FROM developer_apps AS other
                    WHERE other.application_id = application.id
                      AND other.owner_firebase_uid IS DISTINCT FROM :user_id
                  )
                """
            ),
            "developer_apps": text(
                "DELETE FROM developer_apps WHERE owner_firebase_uid = :user_id"
            ),
            "internal_access_events": text(
                "DELETE FROM internal_access_events WHERE user_id = :user_id"
            ),
            "fabric_consent_requests": text(
                "DELETE FROM fabric_consent_requests WHERE user_id = :user_id"
            ),
            "fabric_subscription_grants": text(
                "DELETE FROM fabric_subscription_grants WHERE user_id = :user_id"
            ),
            "pwm_documents": text("DELETE FROM pwm_documents WHERE user_id = :user_id"),
            "kai_analyze_runs": text("DELETE FROM kai_analyze_runs WHERE user_id = :user_id"),
            "kai_run_state": text("DELETE FROM kai_run_state WHERE user_id = :user_id"),
            "kai_gmail_connections": text(
                "DELETE FROM kai_gmail_connections WHERE user_id = :user_id"
            ),
            "gmail_owner_send_actions": text(
                "DELETE FROM gmail_owner_send_actions WHERE user_id = :user_id"
            ),
            "kai_gmail_receipts": text("DELETE FROM kai_gmail_receipts WHERE user_id = :user_id"),
            "kai_gmail_sync_runs": text("DELETE FROM kai_gmail_sync_runs WHERE user_id = :user_id"),
            "one_kyc_workflows": text("DELETE FROM one_kyc_workflows WHERE user_id = :user_id"),
            "marketplace_public_profiles": text(
                "DELETE FROM marketplace_public_profiles WHERE user_id = :user_id"
            ),
            "marketplace_investor_actions": text(
                "DELETE FROM marketplace_investor_actions "
                "WHERE actor_user_id = :user_id OR target_user_id = :user_id"
            ),
            "marketplace_delivery_envelopes": text(
                """
                DELETE FROM marketplace_delivery_envelopes
                WHERE owner_user_id = :user_id OR buyer_user_id = :user_id
                """
            ),
            "marketplace_access_requests": text(
                """
                DELETE FROM marketplace_access_requests
                WHERE owner_user_id = :user_id OR buyer_user_id = :user_id
                """
            ),
            "marketplace_recipient_keys": text(
                "DELETE FROM marketplace_recipient_keys WHERE user_id = :user_id"
            ),
            "wallet_card_access_audit": text(
                "DELETE FROM wallet_card_access_audit WHERE actor_user_id = :user_id"
            ),
            "wallet_card_requests": text(
                "DELETE FROM wallet_card_requests WHERE requester_user_id = :user_id OR target_user_id = :user_id"
            ),
            "wallet_card_access_grants": text(
                "DELETE FROM wallet_card_access_grants WHERE owner_user_id = :user_id OR recipient_user_id = :user_id"
            ),
            "wallet_profile_access_grants": text(
                "DELETE FROM wallet_profile_access_grants WHERE owner_user_id = :user_id OR recipient_user_id = :user_id"
            ),
            "wallet_profile_share_requests": text(
                "DELETE FROM wallet_profile_share_requests WHERE owner_user_id = :user_id"
            ),
            "wallet_card_share_requests": text(
                "DELETE FROM wallet_card_share_requests WHERE owner_user_id = :user_id"
            ),
            "wallet_card_registrations": text(
                "DELETE FROM wallet_card_registrations WHERE owner_user_id = :user_id"
            ),
            "pkm_packets": text("DELETE FROM pkm_packets WHERE owner_user_id = :user_id"),
            # A paid, undelivered packet is money owed back to the buyer: move it
            # to refund_pending (the reconcile refunds it, then removes the row)
            # and delete everything that carries no unsettled payment.
            "pkm_packet_orders": text(
                """
                WITH settle AS (
                  UPDATE pkm_packet_orders SET status = 'refund_pending', updated_at = NOW()
                  WHERE (buyer_user_id = :user_id OR owner_user_id = :user_id)
                    AND status = 'paid' AND owner_earning_status = 'none'
                  RETURNING id
                )
                DELETE FROM pkm_packet_orders
                WHERE (buyer_user_id = :user_id OR owner_user_id = :user_id)
                  AND status <> 'refund_pending'
                  AND NOT (status = 'paid' AND owner_earning_status = 'none')
                """
            ),
            "directory_listing_claims": text(
                "DELETE FROM directory_listing_claims WHERE user_id = :user_id"
            ),
            "pkm_credit_ledger": text("DELETE FROM pkm_credit_ledger WHERE user_id = :user_id"),
            "pkm_owner_payout_accounts": text(
                "DELETE FROM pkm_owner_payout_accounts WHERE user_id = :user_id"
            ),
            "stripe_owner_payout_accounts": text(
                "DELETE FROM stripe_owner_payout_accounts WHERE user_id = :user_id"
            ),
            "drive_request_owner_pricing": text(
                "DELETE FROM drive_request_owner_pricing WHERE user_id = :user_id"
            ),
            # The Stripe subscription id moves to an identity-free table so the
            # work drain cancels it at Stripe: a deleted person is never billed.
            "pkm_credit_subscriptions": text(
                """
                WITH moved AS (
                  DELETE FROM pkm_credit_subscriptions WHERE user_id = :user_id
                  RETURNING stripe_subscription_id, status
                )
                INSERT INTO pkm_credit_subscription_cancellations (stripe_subscription_id)
                SELECT stripe_subscription_id FROM moved
                WHERE stripe_subscription_id IS NOT NULL AND status <> 'canceled'
                ON CONFLICT DO NOTHING
                """
            ),
            "marketplace_opportunity_signals": text(
                "DELETE FROM marketplace_opportunity_signals WHERE user_id = :user_id"
            ),
            "pkm_data": text("DELETE FROM pkm_data WHERE user_id = :user_id"),
            "pkm_default_available_projections": text(
                "DELETE FROM pkm_default_available_projections WHERE user_id = :user_id"
            ),
            "pkm_migration_state": text("DELETE FROM pkm_migration_state WHERE user_id = :user_id"),
            "pkm_upgrade_claims": text("DELETE FROM pkm_upgrade_claims WHERE user_id = :user_id"),
            "pkm_domain_commits": text("DELETE FROM pkm_domain_commits WHERE user_id = :user_id"),
            **recovery_erasure_queries(),
            "pkm_upgrade_runs": text("DELETE FROM pkm_upgrade_runs WHERE user_id = :user_id"),
            "pkm_upgrade_steps": text(
                """
                DELETE FROM pkm_upgrade_steps
                WHERE run_id IN (
                  SELECT run_id FROM pkm_upgrade_runs WHERE user_id = :user_id
                )
                """
            ),
            "kai_receipt_memory_artifacts": text(
                "DELETE FROM kai_receipt_memory_artifacts WHERE user_id = :user_id"
            ),
            "one_location_access_requests": text(
                """
                DELETE FROM one_location_access_requests
                WHERE owner_user_id = :user_id
                   OR requester_user_id = :user_id
                   OR referred_by_user_id = :user_id
                """
            ),
            "one_location_auto_approve_preferences": text(
                "DELETE FROM one_location_auto_approve_preferences WHERE user_id = :user_id"
            ),
            "one_location_visibility_preferences": text(
                "DELETE FROM one_location_visibility_preferences WHERE owner_user_id = :user_id"
            ),
            "one_location_visibility_exclusions": text(
                """
                DELETE FROM one_location_visibility_exclusions
                WHERE owner_user_id = :user_id
                   OR excluded_user_id = :user_id
                """
            ),
            "one_location_map_preferences": text(
                "DELETE FROM one_location_map_preferences WHERE user_id = :user_id"
            ),
            "one_location_network_connections": text(
                """
                DELETE FROM one_location_network_connections
                WHERE user_a_id = :user_id
                   OR user_b_id = :user_id
                   OR inviter_user_id = :user_id
                   OR invitee_user_id = :user_id
                """
            ),
            "one_location_envelopes": text(
                """
                DELETE FROM one_location_envelopes
                WHERE owner_user_id = :user_id
                   OR recipient_user_id = :user_id
                """
            ),
            "one_location_events": text(
                """
                DELETE FROM one_location_events
                WHERE owner_user_id = :user_id
                   OR actor_user_id = :user_id
                   OR recipient_user_id = :user_id
                """
            ),
            "one_location_nearby_presences": text(
                """
                DELETE FROM one_location_nearby_presences
                WHERE owner_user_id = :user_id
                """
            ),
            "one_location_nearby_visits": text(
                """
                DELETE FROM one_location_nearby_visits
                WHERE owner_user_id = :user_id
                """
            ),
            # Deleting the rows is not the whole deletion: an average that still
            # counts a departed person's rating has not forgotten them. The
            # aggregate for every place they rated is recomputed from what is
            # left, in the same pass.
            "one_location_place_ratings": text(
                """
                WITH removed AS (
                  DELETE FROM one_location_place_ratings
                  WHERE author_user_id = :user_id
                  RETURNING place_id
                ), touched AS (
                  SELECT DISTINCT place_id FROM removed
                )
                UPDATE one_location_place_rating_aggregates AS agg
                SET
                  rating_count = COALESCE(fresh.rating_count, 0),
                  rating_sum = COALESCE(fresh.rating_sum, 0),
                  updated_at = NOW()
                FROM touched
                LEFT JOIN LATERAL (
                  SELECT COUNT(*) AS rating_count, SUM(rating) AS rating_sum
                  FROM one_location_place_ratings
                  WHERE place_id = touched.place_id AND aggregatable
                ) AS fresh ON TRUE
                WHERE agg.place_id = touched.place_id
                """
            ),
            "one_location_sms_contacts": text(
                """
                DELETE FROM one_location_sms_contacts
                WHERE owner_user_id = :user_id
                   OR contact_user_id = :user_id
                """
            ),
            "one_location_public_invite_submissions": text(
                """
                DELETE FROM one_location_public_invite_submissions
                WHERE owner_user_id = :user_id
                   OR matched_user_id = :user_id
                """
            ),
            "one_location_public_invites": text(
                "DELETE FROM one_location_public_invites WHERE owner_user_id = :user_id"
            ),
            "one_wallet_cards": text("DELETE FROM one_wallet_cards WHERE user_id = :user_id"),
            "one_location_circle_invites": text(
                """
                DELETE FROM one_location_circle_invites
                WHERE owner_user_id = :user_id
                   OR claimed_by_user_id = :user_id
                """
            ),
            "one_location_circle_member_invites": text(
                """
                DELETE FROM one_location_circle_member_invites
                WHERE inviter_user_id = :user_id
                   OR invitee_user_id = :user_id
                """
            ),
            "one_location_circle_memberships": text(
                "DELETE FROM one_location_circle_memberships WHERE user_id = :user_id"
            ),
            # Scope proposals hold plain (no ON DELETE) foreign keys into
            # connection_requests, so they must be cleared first — including
            # rows owned by OTHER users that reference this user's requests,
            # or the request delete below fails the whole account deletion.
            "connection_scope_proposal_events": text(
                """
                DELETE FROM connection_scope_proposal_events
                WHERE actor_user_id = :user_id
                   OR connection_scope_proposal_id IN (
                        SELECT id FROM connection_scope_proposals
                        WHERE owner_user_id = :user_id
                           OR receiver_user_id = :user_id
                           OR connection_request_id IN (
                                SELECT id FROM connection_requests
                                WHERE requester_user_id = :user_id
                                   OR addressee_user_id = :user_id
                           )
                   )
                """
            ),
            "connection_scope_proposals": text(
                """
                DELETE FROM connection_scope_proposals
                WHERE owner_user_id = :user_id
                   OR receiver_user_id = :user_id
                   OR connection_request_id IN (
                        SELECT id FROM connection_requests
                        WHERE requester_user_id = :user_id
                           OR addressee_user_id = :user_id
                   )
                """
            ),
            "connection_requests": text(
                """
                DELETE FROM connection_requests
                WHERE requester_user_id = :user_id
                   OR addressee_user_id = :user_id
                """
            ),
            "connections": text(
                """
                DELETE FROM connections
                WHERE user_a_id = :user_id
                   OR user_b_id = :user_id
                """
            ),
            "trusted_connections": text(
                """
                DELETE FROM trusted_connections
                WHERE owner_user_id = :user_id
                   OR trusted_user_id = :user_id
                """
            ),
            "trusted_device_challenges": text(
                "DELETE FROM trusted_device_challenges WHERE user_id = :user_id"
            ),
            "trusted_device_authorizations": text(
                "DELETE FROM trusted_device_authorizations WHERE user_id = :user_id"
            ),
            "trusted_device_audit_events": text(
                "DELETE FROM trusted_device_audit_events WHERE user_id = :user_id"
            ),
            "trusted_devices": text("DELETE FROM trusted_devices WHERE user_id = :user_id"),
            "one_location_recipient_keys": text(
                "DELETE FROM one_location_recipient_keys WHERE user_id = :user_id"
            ),
            "one_location_referrals": text(
                """
                DELETE FROM one_location_referrals
                WHERE owner_user_id = :user_id
                   OR referring_user_id = :user_id
                   OR referred_user_id = :user_id
                """
            ),
            "kai_location_referrals": text(
                """
                DELETE FROM kai_location_referrals
                WHERE owner_user_id = :user_id
                   OR referrer_user_id = :user_id
                   OR candidate_user_id = :user_id
                """
            ),
            "one_location_share_grants": text(
                """
                DELETE FROM one_location_share_grants
                WHERE owner_user_id = :user_id
                   OR recipient_user_id = :user_id
                """
            ),
            "runtime_persona_state": text(
                "DELETE FROM runtime_persona_state WHERE user_id = :user_id"
            ),
            "one_referral_risk_reviews": text(
                """
                DELETE FROM one_referral_risk_reviews AS review
                WHERE review.relationship_id IN (
                  SELECT relationship.id
                  FROM one_referral_relationships AS relationship
                  JOIN one_referral_attributions AS attribution
                    ON attribution.id = relationship.attribution_id
                  JOIN one_referral_codes AS referral_code
                    ON referral_code.id = attribution.referral_code_id
                  WHERE relationship.referrer_user_id = :user_id
                     OR relationship.referred_user_id = :user_id
                     OR attribution.referrer_user_id = :user_id
                     OR attribution.bound_user_id = :user_id
                     OR referral_code.owner_user_id = :user_id
                )
                """
            ),
            "one_referral_events": text(
                """
                DELETE FROM one_referral_events AS event
                WHERE event.user_id = :user_id
                   OR event.relationship_id IN (
                     SELECT relationship.id
                     FROM one_referral_relationships AS relationship
                     JOIN one_referral_attributions AS attribution
                       ON attribution.id = relationship.attribution_id
                     JOIN one_referral_codes AS referral_code
                       ON referral_code.id = attribution.referral_code_id
                     WHERE relationship.referrer_user_id = :user_id
                        OR relationship.referred_user_id = :user_id
                        OR attribution.referrer_user_id = :user_id
                        OR attribution.bound_user_id = :user_id
                        OR referral_code.owner_user_id = :user_id
                   )
                """
            ),
            "one_referral_relationships": text(
                """
                DELETE FROM one_referral_relationships AS relationship
                WHERE relationship.referrer_user_id = :user_id
                   OR relationship.referred_user_id = :user_id
                   OR relationship.attribution_id IN (
                     SELECT attribution.id
                     FROM one_referral_attributions AS attribution
                     JOIN one_referral_codes AS referral_code
                       ON referral_code.id = attribution.referral_code_id
                     WHERE attribution.referrer_user_id = :user_id
                        OR attribution.bound_user_id = :user_id
                        OR referral_code.owner_user_id = :user_id
                   )
                """
            ),
            "one_referral_attributions": text(
                """
                DELETE FROM one_referral_attributions AS attribution
                WHERE attribution.referrer_user_id = :user_id
                   OR attribution.bound_user_id = :user_id
                   OR attribution.referral_code_id IN (
                     SELECT referral_code.id
                     FROM one_referral_codes AS referral_code
                     WHERE referral_code.owner_user_id = :user_id
                   )
                """
            ),
            "one_referral_codes": text(
                "DELETE FROM one_referral_codes WHERE owner_user_id = :user_id"
            ),
            "one_agent_engagement_sessions": text(
                "DELETE FROM one_agent_engagement_sessions WHERE user_id = :user_id"
            ),
            "ria_pick_legacy_retirements": text(
                """
                DELETE FROM ria_pick_legacy_retirements
                WHERE owner_user_id = :user_id
                   OR ria_profile_id IN (
                     SELECT id FROM ria_profiles WHERE user_id = :user_id
                   )
                """
            ),
            **push_registration_erasure_queries(),
            "circle_chat_messages": text(
                "DELETE FROM circle_chat_messages WHERE sender_user_id = :user_id"
            ),
            "circle_chat_recipients": text(
                "DELETE FROM circle_chat_recipients WHERE recipient_user_id = :user_id"
            ),
            "circle_chat_preferences": text(
                "DELETE FROM circle_chat_preferences WHERE user_id = :user_id"
            ),
            "feed_events": text("DELETE FROM feed_events WHERE user_id = :user_id"),
            **personal_agent_erasure_queries(),
            "vault_key_wrappers": text("DELETE FROM vault_key_wrappers WHERE user_id = :user_id"),
            "world_model_index_v2": text(
                "DELETE FROM world_model_index_v2 WHERE user_id = :user_id"
            ),
        }
        self._safe_export_queries = {
            "actor_profile": text(
                """
                SELECT user_id, personas, last_active_persona, investor_marketplace_opt_in, created_at, updated_at
                FROM actor_profiles
                WHERE user_id = :user_id
                """
            ),
            "runtime_persona_state": text(
                """
                SELECT user_id, last_active_persona, updated_at
                FROM runtime_persona_state
                WHERE user_id = :user_id
                """
            ),
            "encrypted_vault_keys": text(
                """
                SELECT user_id, vault_status, primary_method, primary_wrapper_id,
                       recovery_encrypted_vault_key, recovery_salt, recovery_iv,
                       created_at, updated_at
                FROM vault_keys
                WHERE user_id = :user_id
                ORDER BY created_at DESC
                """
            ),
            "encrypted_pkm_manifests": text(
                """
                SELECT user_id, domain, manifest_version, structure_decision,
                       summary_projection, top_level_scope_paths, domain_contract_version,
                       readable_summary_version, pkm_contract_version,
                       readable_projection_version, latest_upgrade_commit_id,
                       upgraded_at, created_at, updated_at
                FROM pkm_manifests
                WHERE user_id = :user_id
                ORDER BY updated_at DESC
                """
            ),
            "encrypted_pkm_index": text(
                """
                SELECT user_id, available_domains, domain_summaries, computed_tags,
                       total_attributes, model_version, last_upgraded_at, created_at, updated_at
                FROM pkm_index
                WHERE user_id = :user_id
                ORDER BY updated_at DESC
                """
            ),
            "encrypted_pkm_blobs": text(
                """
                SELECT user_id, domain, segment_id, ciphertext, iv, tag,
                       content_revision, manifest_revision, created_at, updated_at
                FROM pkm_blobs
                WHERE user_id = :user_id
                ORDER BY updated_at DESC
                """
            ),
            "encrypted_pkm_recovery_revisions": text(
                """
                SELECT revision_id, user_id, domain, source_content_revision,
                       source_manifest_revision, is_origin, archive_reason,
                       source_commit_id, manifest_snapshot, path_rows_snapshot,
                       scope_rows_snapshot, index_domain_summary_snapshot,
                       index_domain_present, retention_expires_at, restored_count,
                       last_restored_at, created_at
                FROM pkm_domain_revisions
                WHERE user_id = :user_id
                ORDER BY created_at DESC
                """
            ),
            "encrypted_pkm_recovery_segments": text(
                """
                SELECT segments.revision_id, segments.segment_id, segments.ciphertext,
                       segments.iv, segments.tag, segments.algorithm,
                       segments.original_content_revision,
                       segments.original_manifest_revision, segments.size_bytes,
                       segments.created_at
                FROM pkm_domain_revision_segments AS segments
                JOIN pkm_domain_revisions AS revisions
                  ON revisions.revision_id = segments.revision_id
                WHERE revisions.user_id = :user_id
                ORDER BY segments.created_at DESC, segments.segment_id
                """
            ),
            "consent_audit": text(
                """
                SELECT id, token_id, user_id, agent_id, scope, action, issued_at, poll_timeout_at
                FROM consent_audit
                WHERE user_id = :user_id
                ORDER BY issued_at DESC
                LIMIT 500
                """
            ),
            "verified_email_aliases": text(
                """
                SELECT alias_id, user_id, email, email_normalized, verification_status,
                       verification_source, source_ref, verification_requested_at,
                       verified_at, revoked_at, last_matched_at, created_at, updated_at
                FROM actor_verified_email_aliases
                WHERE user_id = :user_id
                ORDER BY COALESCE(verified_at, verification_requested_at, created_at) DESC
                """
            ),
        }

    @property
    def db(self):
        """Get database client."""
        if self._db is None:
            self._db = get_db()
        return self._db

    def _load_actor_profile(self, user_id: str) -> dict[str, Any] | None:
        try:
            with get_db_connection() as conn:
                row = (
                    conn.execute(
                        text(
                            """
                            SELECT personas, last_active_persona, investor_marketplace_opt_in
                            FROM actor_profiles
                            WHERE user_id = :user_id
                            """
                        ),
                        {"user_id": user_id},
                    )
                    .mappings()
                    .first()
                )
                if row is None:
                    return None
                return {
                    "personas": list(row["personas"] or []),
                    "last_active_persona": str(row["last_active_persona"] or "investor"),
                    "investor_marketplace_opt_in": bool(row["investor_marketplace_opt_in"]),
                }
        except Exception as exc:
            logger.warning("actor_profiles lookup failed for %s: %s", user_id, exc)
            return None

    @staticmethod
    def _normalized_target(target: str | None) -> DeleteAccountTarget:
        if target == "investor":
            return "investor"
        if target == "ria":
            return "ria"
        return "both"

    def _table_exists(self, conn, table_name: str) -> bool:
        cached = self._table_exists_cache.get(table_name)
        if cached is not None:
            return cached

        exists = bool(
            conn.execute(
                text("SELECT to_regclass(:regclass_name) IS NOT NULL"),
                {"regclass_name": f"public.{table_name}"},
            ).scalar()
        )
        self._table_exists_cache[table_name] = exists
        return exists

    def _column_exists(self, conn, table_name: str, column_name: str) -> bool:
        cache_key = f"{table_name}.{column_name}"
        cached = self._table_exists_cache.get(cache_key)
        if cached is not None:
            return cached

        exists = bool(
            conn.execute(
                text(
                    """
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public'
                      AND table_name = :table_name
                      AND column_name = :column_name
                    """
                ),
                {"table_name": table_name, "column_name": column_name},
            ).scalar()
        )
        self._table_exists_cache[cache_key] = exists
        return exists

    def _delete_user_rows_if_table_exists(
        self,
        conn,
        *,
        table_name: str,
        params: dict[str, Any],
    ) -> None:
        if not self._table_exists(conn, table_name):
            logger.info("Skipping cleanup for missing table: %s", table_name)
            return
        query = self._delete_by_user_queries.get(table_name)
        if query is None:
            raise ValueError(f"Unsafe or unsupported cleanup table requested: {table_name}")
        started = monotonic()
        try:
            if table_name in {"pkm_domain_revision_segments", "pkm_domain_revisions"}:
                # Bound both ciphertext and parent/FK work in the same atomic
                # transaction. Advance over the existing keys so later batches
                # do not revisit all of this transaction's deleted tuples.
                batch_params = {**params, "after_revision_id": None, "after_segment_id": ""}
                batches = 0
                while True:
                    result = conn.execute(query, batch_params)
                    batches += 1
                    if result.rowcount == 0:
                        break
                    rows = result.fetchall()
                    if len(rows) < _RECOVERY_ERASURE_BATCH_SIZE:
                        break
                    batch_params["after_revision_id"] = str(rows[-1][0])
                    batch_params["after_segment_id"] = rows[-1][1]
                phase = "segments" if table_name.endswith("segments") else "revisions"
                logger.info(
                    "account.erasure_recovery_%s_complete feature=account_deletion trace_id=%s batches=%d elapsed_ms=%d",
                    phase,
                    get_trace_id(),
                    batches,
                    (monotonic() - started) * 1000,
                )
            else:
                conn.execute(query, params)
        except Exception:
            logger.error(
                "account.erasure_statement_failed feature=account_deletion trace_id=%s table=%s elapsed_ms=%d",
                get_trace_id(),
                table_name,
                (monotonic() - started) * 1000,
            )
            raise

    def _delete_optional_user_tables(
        self,
        conn,
        *,
        table_names: list[str],
        params: dict[str, Any],
        results: dict[str, bool],
    ) -> None:
        for table_name in table_names:
            self._delete_user_rows_if_table_exists(conn, table_name=table_name, params=params)
            results[table_name] = True

    def _delete_one_referral_graph(
        self,
        conn,
        *,
        params: dict[str, Any],
        results: dict[str, bool],
    ) -> None:
        """Delete migration-165 referral state without crossing its RESTRICT edge."""
        deletion_order = (
            "one_referral_risk_reviews",
            "one_referral_events",
            "one_referral_relationships",
            "one_referral_attributions",
            "one_referral_codes",
            "one_agent_engagement_sessions",
        )
        table_presence = {
            table_name: self._table_exists(conn, table_name) for table_name in deletion_order
        }
        if not any(table_presence.values()):
            results.update({table_name: True for table_name in deletion_order})
            return
        missing_tables = tuple(
            table_name for table_name, exists in table_presence.items() if not exists
        )
        if missing_tables:
            raise RuntimeError(
                "incomplete migration-165 referral schema: " + ", ".join(missing_tables)
            )

        # relationship.attribution_id is ON DELETE RESTRICT. Remove audit/risk
        # children and every relationship involving the deleting account (or
        # one of its owned/bound attributions) before touching attribution or
        # code rows. This also removes the other user's cross-account linkage.
        for table_name in deletion_order:
            conn.execute(self._delete_by_user_queries[table_name], params)
            results[table_name] = True

    def _assert_personal_agent_external_resources_absent(
        self, conn, *, params: dict[str, Any], finalize_erasure: bool = False
    ) -> dict[str, bool]:
        """Verify absence under this account transaction's existing owner locks."""
        return assert_external_resources_absent(
            conn, params=params, table_exists=self._table_exists, finalize_erasure=finalize_erasure
        )

    def assert_personal_agent_external_resources_absent(self, user_id: str) -> None:
        """Observe absence under existing database locks; perform no cleanup.

        This is a preflight observation, not a reservation against a later
        provisioning request. Callers must perform no deletion after it returns.
        """
        if not user_id:
            raise ValueError("user_id is required")
        with get_db_connection() as conn:
            # Match erasure writers before taking registry/setup row locks.
            AccountDeletionLifecycleService._lock_user_ids_in_transaction(conn, user_ids=(user_id,))
            self._assert_personal_agent_external_resources_absent(conn, params={"user_id": user_id})

    def _delete_personal_agent_state(
        self, conn, *, params: dict[str, Any], results: dict[str, bool]
    ) -> None:
        """Keep absence assertion and account-state deletion in one transaction."""
        table_presence = self._assert_personal_agent_external_resources_absent(
            conn, params=params, finalize_erasure=True
        )
        results["personal_agent_external_resources_absent"] = True
        for table_name, present in table_presence.items():
            if present:
                conn.execute(self._delete_by_user_queries[table_name], params)
            results[table_name] = True
        self._delete_optional_user_tables(
            conn, table_names=["personal_agent_cloud_removals"], params=params, results=results
        )

    @staticmethod
    def _lock_fabric_receipt_users(conn, *, user_ids: Iterable[str]) -> None:
        """Serialize account cleanup before Fabric grant/read/receipt writers."""
        for user_id in sorted(
            {normalized for candidate in user_ids if (normalized := str(candidate or "").strip())}
        ):
            conn.execute(
                text("SELECT pg_advisory_xact_lock(hashtext(:lock_key))"),
                {"lock_key": f"fabric_receipts:{user_id}"},
            )

    def _delete_owned_named_circles(
        self,
        conn,
        *,
        user_id: str,
        results: dict[str, bool],
    ) -> None:
        """Delete owned Circles without orphaning grant audit or SMS state."""
        core_tables = (
            "one_location_circles",
            "one_location_circle_memberships",
            "one_location_circle_invite_codes",
        )
        if not all(self._table_exists(conn, table_name) for table_name in core_tables):
            for table_name in core_tables:
                results[table_name] = True
            results["one_location_circle_member_invites"] = True
            results["connection_origins"] = True
            return

        params = {"user_id": user_id}
        member_invites_exist = self._table_exists(
            conn,
            "one_location_circle_member_invites",
        )
        # A shared bearer code may already be known by any departing member.
        # Lock every active Circle in deterministic order, then revoke its code
        # and cancel invitations authored by this account before membership
        # rows are removed later in account cleanup. PostgreSQL is the shared
        # coordination tier; this Circle-first seam can move to a distributed
        # lock without changing account-deletion semantics.
        circle_lock_query = (
            text(
                """
                SELECT
                  circle.id,
                  circle.owner_user_id = :user_id AS is_owner,
                  EXISTS (
                    SELECT 1
                    FROM one_location_circle_memberships membership
                    WHERE membership.circle_id = circle.id
                      AND membership.user_id = :user_id
                      AND membership.status = 'active'
                  ) AS has_active_membership
                FROM one_location_circles circle
                WHERE circle.owner_user_id = :user_id
                   OR EXISTS (
                     SELECT 1
                     FROM one_location_circle_memberships membership
                     WHERE membership.circle_id = circle.id
                       AND membership.user_id = :user_id
                       AND membership.status = 'active'
                   )
                   OR EXISTS (
                     SELECT 1
                     FROM one_location_circle_member_invites member_invite
                     WHERE member_invite.circle_id = circle.id
                       AND (
                         member_invite.inviter_user_id = :user_id
                         OR member_invite.invitee_user_id = :user_id
                       )
                       AND member_invite.status = 'pending'
                   )
                ORDER BY circle.id
                FOR UPDATE OF circle
                """
            )
            if member_invites_exist
            else text(
                """
                SELECT
                  circle.id,
                  circle.owner_user_id = :user_id AS is_owner,
                  EXISTS (
                    SELECT 1
                    FROM one_location_circle_memberships membership
                    WHERE membership.circle_id = circle.id
                      AND membership.user_id = :user_id
                      AND membership.status = 'active'
                  ) AS has_active_membership
                FROM one_location_circles circle
                WHERE circle.owner_user_id = :user_id
                   OR EXISTS (
                     SELECT 1
                     FROM one_location_circle_memberships membership
                     WHERE membership.circle_id = circle.id
                       AND membership.user_id = :user_id
                       AND membership.status = 'active'
                   )
                ORDER BY circle.id
                FOR UPDATE OF circle
                """
            )
        )
        departing_circle_rows = conn.execute(circle_lock_query, params).mappings().all()
        departing_circle_ids = [
            str(row.get("id") or "").strip()
            for row in departing_circle_rows
            if str(row.get("id") or "").strip()
            and (bool(row.get("is_owner")) or bool(row.get("has_active_membership")))
        ]
        if departing_circle_ids:
            conn.execute(
                text(
                    """
                    UPDATE one_location_circle_invite_codes
                    SET status = 'revoked', revoked_at = NOW(),
                        updated_at = NOW()
                    WHERE circle_id =
                          ANY(CAST(:departing_circle_ids AS UUID[]))
                      AND status = 'active'
                    """
                ),
                {
                    **params,
                    "departing_circle_ids": departing_circle_ids,
                },
            )
        if member_invites_exist:
            conn.execute(
                text(
                    """
                    UPDATE one_location_circle_member_invites
                    SET status = 'cancelled', cancelled_at = NOW(),
                        updated_at = NOW()
                    WHERE inviter_user_id = :user_id
                      AND status = 'pending'
                    """
                ),
                params,
            )
        circle_rows = [row for row in departing_circle_rows if bool(row.get("is_owner"))]
        circle_ids = {
            str(row.get("id") or "").strip()
            for row in circle_rows
            if str(row.get("id") or "").strip()
        }
        affected_member_rows = (
            conn.execute(
                text(
                    """
                    SELECT DISTINCT membership.user_id
                    FROM one_location_circles circle
                    JOIN one_location_circle_memberships membership
                      ON membership.circle_id = circle.id
                     AND membership.status = 'active'
                    WHERE circle.owner_user_id = :user_id
                    """
                ),
                params,
            )
            .mappings()
            .all()
        )
        affected_member_ids = {
            str(row.get("user_id") or "").strip()
            for row in affected_member_rows
            if str(row.get("user_id") or "").strip()
        }

        if circle_ids and self._table_exists(conn, "connection_origins"):
            from hushh_mcp.services.connection_graph_service import (
                ConnectionGraphService,
            )
            from hushh_mcp.services.one_location_circle_service import (
                OneLocationCircleService,
            )

            for circle_id in sorted(circle_ids):
                ConnectionGraphService.revoke_named_circle_origins(
                    conn,
                    source_circle_id=circle_id,
                )
                OneLocationCircleService._reconcile_circle_sourced_grants(
                    conn,
                    circle_id=circle_id,
                )

        if self._table_exists(conn, "one_location_events") and self._table_exists(
            conn, "one_location_share_grants"
        ):
            conn.execute(
                text(
                    """
                    DELETE FROM one_location_events event
                    USING one_location_share_grants share_grant,
                          one_location_circles circle
                    WHERE event.grant_id = share_grant.id
                      AND share_grant.source_circle_id = circle.id
                      AND circle.owner_user_id = :user_id
                    """
                ),
                params,
            )

        if self._table_exists(conn, "one_location_circle_member_invites"):
            conn.execute(
                text(
                    """
                    DELETE FROM one_location_circle_member_invites member_invite
                    WHERE member_invite.inviter_user_id = :user_id
                       OR member_invite.invitee_user_id = :user_id
                       OR member_invite.circle_id IN (
                         SELECT circle.id
                         FROM one_location_circles circle
                         WHERE circle.owner_user_id = :user_id
                       )
                    """
                ),
                params,
            )

        conn.execute(
            text(
                """
                DELETE FROM one_location_circle_invite_codes invite_code
                WHERE invite_code.created_by_user_id = :user_id
                   OR invite_code.circle_id IN (
                     SELECT circle.id
                     FROM one_location_circles circle
                     WHERE circle.owner_user_id = :user_id
                   )
                """
            ),
            params,
        )
        if self._table_exists(conn, "connection_origins"):
            conn.execute(
                text(
                    """
                    DELETE FROM connection_origins origin
                    USING one_location_circles circle
                    WHERE origin.source_circle_id = circle.id
                      AND circle.owner_user_id = :user_id
                      AND origin.origin_kind = 'named_circle'
                      AND origin.status = 'revoked'
                    """
                ),
                params,
            )
        if self._table_exists(conn, "one_location_circles") and self._column_exists(
            conn, "one_location_circles", "is_system"
        ):
            # Migration 160 added `one_location_circles_block_system_delete`, a
            # trigger that refuses to hard- or soft-delete a Circle with
            # is_system=true (the SMS/Emergency Circle) so an ordinary product
            # code path can't silently switch off a user's SOS roster. That
            # protection has no meaning once the SAME owner's account is being
            # fully deleted or reset to fresh: the identity the Circle served
            # is being wiped along with it, so demote it first in this same
            # transaction and let the delete below proceed normally.
            conn.execute(
                text(
                    """
                    UPDATE one_location_circles
                    SET is_system = FALSE
                    WHERE owner_user_id = :user_id
                      AND is_system
                    """
                ),
                params,
            )
        # Migration 163 widened that same trigger to fire on `system_kind IS
        # NOT NULL` as well, because Trusted is deliberately NOT `is_system`.
        # Clearing only the flag therefore stopped being enough to open the
        # escape hatch: 163 backfills `system_kind = 'sms'` onto every existing
        # SMS Circle, so the row demoted above still trips the trigger on the
        # DELETE below, and a Trusted Circle trips it having never been
        # `is_system` at all. That is incident #5574 -- account deletion 500s --
        # arriving a second time by a different column.
        #
        # Guarded on the column so a database that predates 163 still deletes.
        if self._table_exists(conn, "one_location_circles") and self._column_exists(
            conn, "one_location_circles", "system_kind"
        ):
            conn.execute(
                text(
                    """
                    UPDATE one_location_circles
                    SET system_kind = NULL
                    WHERE owner_user_id = :user_id
                      AND system_kind IS NOT NULL
                    """
                ),
                params,
            )
        conn.execute(
            text(
                """
                DELETE FROM one_location_circles
                WHERE owner_user_id = :user_id
                """
            ),
            params,
        )

        if self._table_exists(conn, "one_location_sms_contacts"):
            from hushh_mcp.services.one_location_circle_service import (
                OneLocationCircleService,
            )

            for member_user_id in sorted(affected_member_ids):
                OneLocationCircleService._cleanup_ineligible_sms_contacts(
                    conn,
                    user_id=member_user_id,
                )

        results["one_location_circle_invite_codes"] = True
        results["one_location_circle_member_invites"] = True
        results["connection_origins"] = True
        results["one_location_circles"] = True

    async def delete_account(
        self,
        user_id: str,
        target: DeleteAccountTarget = "both",
    ) -> Dict[str, Any]:
        """Delete either the whole account or one persona."""
        requested_target = self._normalized_target(target)
        actor_profile = await asyncio.to_thread(self._load_actor_profile, user_id)
        personas = (
            [persona for persona in actor_profile["personas"] if persona in {"investor", "ria"}]
            if actor_profile
            else ["investor"]
        )

        if requested_target != "both" and requested_target not in personas:
            return {
                "success": False,
                "error": f"{requested_target.upper()} persona not found for this account.",
                "requested_target": requested_target,
                "deleted_target": None,
                "account_deleted": False,
                "remaining_personas": personas,
            }

        if requested_target == "both":
            return await self._delete_full_account(
                user_id,
                requested_target=requested_target,
            )

        remaining_personas = [persona for persona in personas if persona != requested_target]
        if not remaining_personas:
            return await self._delete_full_account(
                user_id,
                requested_target=requested_target,
            )

        if requested_target == "ria":
            return await self._delete_ria_persona(
                user_id=user_id,
                remaining_personas=remaining_personas,
                investor_marketplace_opt_in=bool(
                    actor_profile["investor_marketplace_opt_in"] if actor_profile else False
                ),
                requested_target=requested_target,
            )

        return await self._delete_investor_persona(
            user_id=user_id,
            remaining_personas=remaining_personas,
            requested_target=requested_target,
        )

    @staticmethod
    def _clear_external_connector_data(conn, user_id, results, *, permanent):
        clear_external_connector_data(
            conn,
            user_id,
            results,
            permanent=permanent,
            lock_graph_users=lock_connection_graph_users,
        )

    @staticmethod
    def _clear_live_memory_source_journal(conn, user_id, results, *, permanent):
        owner_hash = "sha256:" + hashlib.sha256(user_id.encode("utf-8")).hexdigest()
        if conn.execute(
            text("SELECT to_regclass('public.live_memory_source_events') IS NOT NULL")
        ).scalar():
            conn.execute(
                text("DELETE FROM public.live_memory_source_events WHERE owner_hash=:owner_hash"),
                {"owner_hash": owner_hash},
            )
        if conn.execute(
            text("SELECT to_regclass('public.live_memory_source_streams') IS NOT NULL")
        ).scalar():
            if permanent:
                conn.execute(
                    text(
                        "DELETE FROM public.live_memory_source_streams WHERE owner_hash=:owner_hash"
                    ),
                    {"owner_hash": owner_hash},
                )
            else:
                # Keep a monotonic watermark so a pre-reset cursor must rebuild.
                conn.execute(
                    text("""INSERT INTO public.live_memory_source_streams
                            (owner_hash,last_sequence,first_retained_sequence)
                            VALUES (:owner_hash,1,2)
                            ON CONFLICT (owner_hash) DO UPDATE SET
                              last_sequence=live_memory_source_streams.last_sequence+1,
                              first_retained_sequence=live_memory_source_streams.last_sequence+2,
                              updated_at=clock_timestamp()"""),
                    {"owner_hash": owner_hash},
                )
        results["live_memory_source_journal"] = True

    def _clear_user_data_tables(self, conn, user_id: str, results: dict[str, bool]) -> None:
        """Clear all per-user data tables EXCEPT the account spine.

        Shared by full-account deletion and account reset. Deletes finance, Gmail,
        PKM, connected systems, consent audit, KYC, location, marketplace, and
        relationship rows. Does NOT touch vault_keys, vault_key_wrappers,
        actor_profiles, actor_identity_cache, or actor_verified_email_aliases so the
        One identity and vault survive a reset.
        """
        params = {"user_id": user_id}
        if self._table_exists(conn, "shared_files_storage"):
            row = (
                conn.execute(
                    text(
                        "SELECT state,receipt,writes FROM shared_files_storage WHERE user_id=:user_id FOR UPDATE"
                    ),
                    params,
                )
                .mappings()
                .first()
            )
            if row:
                receipt = row["receipt"]
                receipt = json.loads(receipt) if isinstance(receipt, str) else receipt
                writes = row["writes"]
                writes = json.loads(writes) if isinstance(writes, str) else writes
                if (
                    row["state"] != "erased"
                    or writes
                    or not isinstance(receipt, dict)
                    or receipt.get("complete") is not True
                ):
                    raise ValueError("SHARED_FILES_ERASURE_REQUIRED")
                conn.execute(
                    text("DELETE FROM shared_files_storage WHERE user_id=:user_id"), params
                )
            results["shared_files_storage"] = True

        self._clear_external_connector_data(conn, user_id, results, permanent=False)
        if self._table_exists(conn, "pwm_claim_invitations"):
            conn.execute(
                text(
                    "DELETE FROM pwm_claim_invitations WHERE inviter_user_id=:user_id OR recipient_user_id=:user_id"
                ),
                params,
            )
            results["pwm_claim_invitations"] = True
        if self._table_exists(conn, "one_product_activity_epochs"):
            conn.execute(
                text(
                    "UPDATE one_product_activity_epochs SET generation=gen_random_uuid(),started_at=NOW() WHERE user_id=:user_id"
                ),
                params,
            )
            results["one_product_activity_epochs"] = True
        self._delete_optional_user_tables(
            conn,
            table_names=[
                "pwm_research_preferences",
                "one_adk_sessions",
                "one_product_activity_observations",
                "one_product_value_receipts",
                "one_action_directive_ledger",
                "pod_lifecycle_events",
                "one_mcp_pending_calls",
                "one_private_text_processing_approvals",
                "live_memory_hosted_source_envelopes",
                "live_memory_hosted_pilot_grants",
                "agent_chat_messages",
                "agent_chat_conversations",
                "wallet_card_access_audit",
                "wallet_profile_access_grants",
                "wallet_card_requests",
                "wallet_card_access_grants",
                "wallet_profile_share_requests",
                "wallet_card_share_requests",
                "wallet_card_registrations",
                "messages",
                "conversations",
                "direct_message_blocks",
                "kai_gmail_receipts",
                "kai_gmail_sync_runs",
                # Retired intake still has historical mail records to erase.
                "one_kyc_workflows",
                "kai_gmail_connections",
                # Sends ride vault_keys' ON DELETE CASCADE on a full deletion, but
                # a reset keeps vault_keys: a scheduled send must not outlive it.
                "gmail_owner_send_actions",
                "kai_receipt_memory_artifacts",
                "kai_analyze_runs",
                "kai_run_state",
                "consent_export_refresh_jobs",
                "consent_exports",
                "connected_system_audit_events",
                "connected_system_record_bindings",
                "connected_system_intents",
                "connected_system_owner_signing_keys",
                "connected_system_zk_contexts",
                # fabric_receipts is deliberately retained: it is an append-only,
                # signed audit chain and the current schema has no chain-safe
                # subject-redaction primitive. The Fabric lock is held before
                # these authority/data rows are removed so no subscriber read,
                # grant, revoke, or receipt append crosses the cleanup boundary.
                "fabric_consent_requests",
                "fabric_subscription_grants",
                "pwm_documents",
                "marketplace_delivery_envelopes",
                "marketplace_access_requests",
                "marketplace_recipient_keys",
                "pkm_packets",
                "pkm_packet_orders",
                "directory_listing_claims",
                "pkm_credit_ledger",
                "pkm_credit_subscriptions",
                "pkm_owner_payout_accounts",
                "stripe_owner_payout_accounts",
                "drive_request_owner_pricing",
                "marketplace_opportunity_signals",
                "trusted_device_challenges",
                "trusted_device_authorizations",
                "trusted_device_audit_events",
                "trusted_devices",
                "pkm_default_available_projections",
                "pkm_upgrade_claims",
                "pkm_domain_commits",
                "pkm_domain_revision_segments",
                "pkm_domain_revisions",
                "pkm_upgrade_steps",
                "pkm_upgrade_runs",
                # The preference world model is private intelligence about the owner,
                # keyed by user_id. It belongs in the pod, so a reset must not leave a
                # copy behind on the control plane.
                "wallet_card_access_audit",
                "wallet_card_access_grants",
                "wallet_card_share_requests",
                "wallet_card_registrations",
                "one_wallet_cards",
            ],
            params=params,
            results=results,
        )
        conn.execute(text("DELETE FROM pkm_events WHERE user_id = :user_id"), params)
        results["pkm_events"] = True
        conn.execute(text("DELETE FROM pkm_scope_registry WHERE user_id = :user_id"), params)
        results["pkm_scope_registry"] = True
        conn.execute(text("DELETE FROM pkm_manifest_paths WHERE user_id = :user_id"), params)
        results["pkm_manifest_paths"] = True
        conn.execute(text("DELETE FROM pkm_manifests WHERE user_id = :user_id"), params)
        results["pkm_manifests"] = True
        conn.execute(text("DELETE FROM pkm_blobs WHERE user_id = :user_id"), params)
        results["pkm_blobs"] = True
        conn.execute(text("DELETE FROM pkm_index WHERE user_id = :user_id"), params)
        results["pkm_index"] = True
        self._delete_user_rows_if_table_exists(
            conn, table_name="world_model_index_v2", params=params
        )
        results["world_model_index_v2"] = True
        self._delete_user_rows_if_table_exists(
            conn, table_name="pkm_migration_state", params=params
        )
        results["pkm_migration_state"] = True
        self._delete_user_rows_if_table_exists(conn, table_name="pkm_data", params=params)
        results["pkm_data"] = True
        conn.execute(
            text(
                """
                DELETE FROM ria_client_invites
                WHERE target_investor_user_id = :user_id
                   OR accepted_by_user_id = :user_id
                """
            ),
            params,
        )
        results["invite_links"] = True
        if self._table_exists(conn, "relationship_share_events"):
            conn.execute(
                text(
                    """
                    DELETE FROM relationship_share_events
                    WHERE provider_user_id = :user_id
                       OR receiver_user_id = :user_id
                    """
                ),
                params,
            )
        results["relationship_share_events"] = True
        if self._table_exists(conn, "relationship_share_grants"):
            conn.execute(
                text(
                    """
                    DELETE FROM relationship_share_grants
                    WHERE provider_user_id = :user_id
                       OR receiver_user_id = :user_id
                    """
                ),
                params,
            )
        results["relationship_share_grants"] = True
        if self._table_exists(conn, "ria_pick_share_artifacts"):
            conn.execute(
                text(
                    """
                    DELETE FROM ria_pick_share_artifacts
                    WHERE provider_user_id = :user_id
                       OR receiver_user_id = :user_id
                    """
                ),
                params,
            )
        results["ria_pick_share_artifacts"] = True
        if self._table_exists(conn, "advisor_investor_relationships"):
            if self._table_exists(conn, "ria_profiles"):
                conn.execute(
                    text(
                        """
                        DELETE FROM advisor_investor_relationships
                        WHERE investor_user_id = :user_id
                           OR ria_profile_id IN (
                             SELECT id FROM ria_profiles WHERE user_id = :user_id
                           )
                        """
                    ),
                    params,
                )
            else:
                conn.execute(
                    text(
                        "DELETE FROM advisor_investor_relationships WHERE investor_user_id = :user_id"
                    ),
                    params,
                )
        results["relationships"] = True
        self._delete_user_rows_if_table_exists(
            conn, table_name="marketplace_investor_actions", params=params
        )
        results["marketplace_investor_actions"] = True
        self._delete_user_rows_if_table_exists(
            conn, table_name="marketplace_public_profiles", params=params
        )
        results["marketplace_profile"] = True
        conn.execute(text("DELETE FROM consent_audit WHERE user_id = :user_id"), params)
        results["consent_audit"] = True
        self._delete_user_rows_if_table_exists(
            conn, table_name="internal_access_events", params=params
        )
        results["internal_access_events"] = True
        erase_push_registrations(conn, params, self._table_exists)
        results["push_tokens"] = True
        self._delete_owned_named_circles(
            conn,
            user_id=user_id,
            results=results,
        )
        for table_name in (
            "one_location_auto_approve_preferences",
            "one_location_visibility_exclusions",
            "one_location_visibility_preferences",
            "one_location_map_preferences",
            "one_location_network_connections",
            "one_location_events",
            "one_location_nearby_presences",
            "one_location_nearby_visits",
            "one_location_place_ratings",
            "one_location_sms_contacts",
            "one_location_referrals",
            "kai_location_referrals",
            "one_location_public_invite_submissions",
            "one_location_public_invites",
            "one_location_circle_invites",
            "one_location_circle_member_invites",
            "one_location_circle_memberships",
            "connection_scope_proposal_events",
            "connection_scope_proposals",
            "connection_requests",
            "connections",
            "trusted_connections",
            "one_location_access_requests",
            "one_location_envelopes",
            "one_location_share_grants",
            "one_location_recipient_keys",
            # Feed is a derived projection. Clear it after every source table so
            # present or future source-cleanup fan-out cannot recreate a row.
            "circle_chat_messages",
            "circle_chat_recipients",
            "circle_chat_preferences",
            "feed_events",
        ):
            self._delete_user_rows_if_table_exists(conn, table_name=table_name, params=params)
            results[table_name] = True

    @staticmethod
    def read_reset_evidence(user_id: str) -> Dict[str, Any] | None:
        """Fresh, uncached read of the two columns ``reset_account`` stamps.

        Used to *verify* a reset after the fact -- a client's word that it
        called the route is not evidence. Returns ``None`` when the account
        has no vault row (nothing to reset, or already deleted).
        """
        normalized = str(user_id or "").strip()
        if not normalized:
            return None
        with get_db_connection() as conn:
            row = conn.execute(
                text(
                    "SELECT setup_completed, setup_state_updated_at "
                    "FROM vault_keys WHERE user_id = :uid"
                ),
                {"uid": normalized},
            ).fetchone()
        if row is None:
            return None
        updated = row.setup_state_updated_at
        return {
            "setup_completed": bool(row.setup_completed)
            if row.setup_completed is not None
            else None,
            "setup_state_updated_at_ms": int(updated) if updated is not None else None,
        }

    async def _erase_shared_files_if_present(
        self, user_id: str, *, backend_only: bool = False
    ) -> Dict[str, Any] | None:
        from hushh_mcp.services.shared_files.erasure import erase_if_present

        return await erase_if_present(
            user_id,
            backend_only=backend_only,
            table_exists=self._table_exists,
            connection_factory=get_db_connection,
        )

    async def reset_account(self, user_id: str) -> Dict[str, Any]:
        """Reset the One account to a fresh, just-onboarded state.

        Clears all personal data (PKM, finance, Gmail, connected systems, consents,
        KYC, location, marketplace, relationships) but KEEPS the One identity: the
        Firebase user, vault_keys + vault_key_wrappers (unlock methods), and the
        actor_profiles spine. The dashboard re-provisions lazily on next use, and the
        user re-runs onboarding.
        """
        cleanup = await self._erase_shared_files_if_present(user_id)
        if cleanup is not None:
            return {**cleanup, "account_reset": False}
        logger.warning("♻️ ACCOUNT RESET requested for %s", user_id)
        results: dict[str, bool] = {}
        try:
            with get_db_connection() as conn:
                params = {"user_id": user_id}
                self._lock_fabric_receipt_users(conn, user_ids=(user_id,))
                lock_connection_graph_users(conn, user_ids=[user_id])
                self._clear_user_data_tables(conn, user_id, results)

                # Re-seed the profile spine to a clean One default so the dashboard
                # rebuilds from a known state.
                conn.execute(
                    text(
                        """
                        UPDATE actor_profiles
                        SET personas = ARRAY['investor']::text[],
                            last_active_persona = 'investor',
                            investor_marketplace_opt_in = FALSE,
                            contact_discoverable = FALSE,
                            contact_sync_consent_enabled_at = NULL,
                            contact_sync_consent_rule_version =
                                contact_sync_consent_rule_version + 1,
                            contact_sync_consent_contract_version = NULL,
                            updated_at = NOW()
                        WHERE user_id = :user_id
                        """
                    ),
                    params,
                )
                results["actor_profile_reset"] = True
                conn.execute(
                    text(
                        """
                        UPDATE runtime_persona_state
                        SET last_active_persona = 'investor',
                            updated_at = NOW()
                        WHERE user_id = :user_id
                        """
                    ),
                    params,
                )
                results["runtime_persona_state"] = True

                # Reset setup progress so the user re-runs setup. Keeps the
                # vault row (identity + unlock methods) intact; only clears the
                # setup/tour flags carried on it.
                conn.execute(
                    text(
                        """
                        UPDATE vault_keys
                        SET setup_completed = NULL,
                            setup_skipped = NULL,
                            setup_completed_at = NULL,
                            nav_setup_completed_at = NULL,
                            nav_setup_skipped_at = NULL,
                            onboarding_journey_version = NULL,
                            onboarding_phase = NULL,
                            onboarding_active_capability = NULL,
                            onboarding_resume_route = NULL,
                            onboarding_callback_state = NULL,
                            onboarding_journey_updated_at = NULL,
                            setup_state_updated_at = :now_ms,
                            updated_at = :now_ms
                        WHERE user_id = :user_id
                        """
                    ),
                    {
                        "user_id": user_id,
                        "now_ms": int(datetime.now(timezone.utc).timestamp() * 1000),
                    },
                )
                results["onboarding_reset"] = True
                self._clear_live_memory_source_journal(conn, user_id, results, permanent=False)

            logger.info("✅ ACCOUNT RESET completed for %s", user_id)
            return {
                "success": True,
                "account_deleted": False,
                "account_reset": True,
                "details": results,
            }
        except Exception:
            logger.exception("❌ Account reset failed for %s", user_id)
            return {
                "success": False,
                "error": "account_reset_failed",
                "account_deleted": False,
                "account_reset": False,
                "details": results,
            }

    async def erase_uat_backend_account(self, user_id: str) -> Dict[str, Any]:
        """Maintainer-only erasure; not exposed by any account HTTP route.

        Firebase and provider grants may be shared with production. Erase the
        UAT-owned records and retain its resurrection barrier, but never
        delete, quarantine, or revoke those external authorities.
        """
        return await self._delete_full_account(user_id, requested_target="both", backend_only=True)

    async def _delete_full_account(
        self,
        user_id: str,
        *,
        requested_target: DeleteAccountTarget,
        backend_only: bool = False,
    ) -> Dict[str, Any]:
        """Prepare durable cleanup, or execute the attested UAT-only local reset."""
        if backend_only and (
            os.getenv("ENVIRONMENT", "").strip().lower() == "production"
            or os.getenv("APP_RUNTIME_PROFILE", "").strip().lower() == "production"
            or os.getenv("CLOUDSQL_INSTANCE_CONNECTION_NAME", "") != UAT_INSTANCE
        ):
            raise ValueError("backend_only_erasure_requires_uat_database")
        if not backend_only:
            return await self._prepare_full_account_cleanup(
                user_id, requested_target=requested_target
            )
        cleanup = await self._erase_shared_files_if_present(user_id, backend_only=backend_only)
        if cleanup is not None:
            return cleanup
        return await self._settle_full_account_transaction(
            user_id, requested_target=requested_target, backend_only=backend_only
        )

    async def _prepare_full_account_cleanup(
        self, user_id: str, *, requested_target: DeleteAccountTarget
    ) -> Dict[str, Any]:
        """Persist approval and custody before returning; the existing worker continues."""

        def prepare():
            with get_db_connection() as conn:
                conn.execute(_ACCOUNT_ERASURE_SQL_LIMITS)
                self._lock_fabric_receipt_users(conn, user_ids=(user_id,))
                guard_answer_erasure(conn, user_id=user_id)
                identity = user_id
                if self._table_exists(conn, "account_generations"):
                    from hushh_mcp.services.account_generation_service import (
                        AccountGenerationService,
                    )

                    identity = AccountGenerationService.identity_in_transaction(conn, user_id)
                return AccountDeletionLifecycleService.prepare_provider_cleanup_in_transaction(
                    conn,
                    user_id=user_id,
                    firebase_uid=identity,
                    table_exists=self._table_exists,
                    requested_target=requested_target,
                )

        try:
            prepared = await settle_cleanup_database_call(prepare)
        except PersonalAgentDeprovisioningRequiredError:
            from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo

            provider = None
            try:
                registry = PersonalAgentRegistryRepo()
                owner = await registry.get(user_id)
                provider = (owner or {}).get("deployment_target")
                if provider not in {"user_gcp", "user_azure"} and owner:
                    from hushh_mcp.services.azure_teardown_store import AzureTeardownStore

                    if await AzureTeardownStore(registry).can_offer_failed_setup_cleanup(
                        user_id, owner
                    ):
                        provider = "user_azure"
            except Exception as exc:
                logger.warning(
                    "account_deletion.cloud_review_unavailable error=%s", type(exc).__name__
                )
            return {
                "success": False,
                "account_deleted": False,
                "error_code": PERSONAL_AGENT_DEPROVISION_REQUIRED_CODE,
                "error": PERSONAL_AGENT_DEPROVISION_REQUIRED_CODE,
                "cleanup_provider": provider,
            }
        except Exception as exc:
            logger.warning("account_deletion.preparation_refused error=%s", type(exc).__name__)
            return {
                "success": False,
                "account_deleted": False,
                "error_code": ACCOUNT_DELETION_PAUSED_CODE
                if _is_release_fence_refusal(exc)
                else "ACCOUNT_DELETION_CLEANUP_UNAVAILABLE",
                "error": type(exc).__name__,
            }
        return {
            "success": True,
            "account_deleted": False,
            "cleanup_pending": True,
            "requested_target": requested_target,
            "cleanup_operation": {
                "id": prepared.cleanup_id,
                "owner_id": user_id,
                "state": prepared.state,
                "credential_count": prepared.credential_count,
            },
        }

    async def _settle_full_account_transaction(
        self,
        user_id: str,
        *,
        requested_target: DeleteAccountTarget,
        backend_only: bool = False,
        provider_cleanup: ProviderCleanupClaim | None = None,
    ) -> Dict[str, Any]:
        # Keep the connection, locks, erasure and commit/rollback on one worker
        # thread. Blocking the event loop here previously killed the UAT worker
        # for a missed Gunicorn heartbeat and left the HTTP outcome uncertain.
        async def erase_and_release() -> Dict[str, Any]:
            extra = {"provider_cleanup": provider_cleanup} if provider_cleanup is not None else {}
            result, provider_credentials = await asyncio.to_thread(
                self._delete_full_account_transaction,
                user_id,
                requested_target=requested_target,
                backend_only=backend_only,
                **extra,
            )
            if result["success"] and provider_cleanup is not None:
                result["details"]["provider_grant_release"] = {"status": "confirmed_before_erasure"}
                result["details"]["cleanup_operation_id"] = provider_cleanup.cleanup_id
            elif result["success"]:
                result["details"]["provider_grant_release"] = (
                    {"status": "preserved_backend_only"}
                    if backend_only
                    else await release_provider_grants_after_erasure(provider_credentials)
                )
            return result

        # A disconnected/cancelled caller cannot cancel psycopg2. Settle both
        # the transaction and post-commit cleanup before propagating cancellation
        # so no worker or encrypted provider snapshot is silently abandoned.
        operation = asyncio.create_task(erase_and_release())
        cancellation = None
        while True:
            try:
                result = await asyncio.shield(operation)
                break
            except asyncio.CancelledError as exc:
                if operation.cancelled():
                    raise
                cancellation = exc
        if cancellation is not None:
            raise cancellation
        return result

    async def finalize_provider_cleanup(self, claim: ProviderCleanupClaim) -> Dict[str, Any]:
        """Settle the already-approved operation after durable provider proof."""
        from hushh_mcp.services import account_deletion_provider_journal as journal

        if not await settle_cleanup_database_call(journal.is_ready, claim):
            raise journal.ProviderCleanupNotReady("provider cleanup remains unconfirmed")
        cleanup = await self._erase_shared_files_if_present(claim.owner_id, backend_only=False)
        if cleanup is not None:
            return cleanup
        return await self._settle_full_account_transaction(
            claim.owner_id,
            requested_target=self._normalized_target(claim.requested_target),
            provider_cleanup=claim,
        )

    def _delete_full_account_transaction(
        self,
        user_id: str,
        *,
        requested_target: DeleteAccountTarget,
        backend_only: bool = False,
        provider_cleanup: ProviderCleanupClaim | None = None,
    ) -> tuple[Dict[str, Any], ProviderCredentialSnapshot]:
        logger.warning("🚨 FULL ACCOUNT DELETION requested for %s", user_id)
        results = {
            "actor_identity_cache": False,
            "actor_verified_email_aliases": False,
            "actor_profiles": False,
            "pkm_data": False,
            "pkm_index": False,
            "pkm_blobs": False,
            "pkm_manifests": False,
            "pkm_manifest_paths": False,
            "pkm_scope_registry": False,
            "pkm_events": False,
            "pkm_default_available_projections": False,
            "pkm_migration_state": False,
            "pkm_upgrade_runs": False,
            "pkm_upgrade_steps": False,
            "pkm_upgrade_claims": False,
            "pkm_domain_commits": False,
            "pkm_domain_revision_segments": False,
            "pkm_domain_revisions": False,
            "world_model_index_v2": False,
            "messages": False,
            "conversations": False,
            "direct_message_blocks": False,
            "kai_analyze_runs": False,
            "kai_run_state": False,
            "kai_gmail_connections": False,
            "kai_gmail_receipts": False,
            "kai_gmail_sync_runs": False,
            "one_kyc_workflows": False,
            "kai_receipt_memory_artifacts": False,
            "pwm_documents": False,
            "consent_exports": False,
            "consent_export_refresh_jobs": False,
            "connected_system_audit_events": False,
            "connected_system_intents": False,
            "connected_system_record_bindings": False,
            "connected_system_owner_signing_keys": False,
            "connected_system_zk_contexts": False,
            "consent_audit": False,
            "internal_access_events": False,
            "fabric_consent_requests": False,
            "fabric_subscription_grants": False,
            "push_tokens": False,
            "invite_links": False,
            "relationships": False,
            "relationship_share_events": False,
            "relationship_share_grants": False,
            "ria_pick_share_artifacts": False,
            "marketplace_investor_actions": False,
            "marketplace_profile": False,
            "marketplace_delivery_envelopes": False,
            "marketplace_access_requests": False,
            "marketplace_recipient_keys": False,
            "pkm_packets": False,
            "pkm_packet_orders": False,
            "directory_listing_claims": False,
            "pkm_credit_ledger": False,
            "pkm_credit_subscriptions": False,
            "pkm_owner_payout_accounts": False,
            "stripe_owner_payout_accounts": False,
            "drive_request_owner_pricing": False,
            "marketplace_opportunity_signals": False,
            "one_referral_risk_reviews": False,
            "one_referral_events": False,
            "one_product_activity_observations": False,
            "one_product_value_receipts": False,
            "one_product_activity_epochs": False,
            "one_marketing_preferences": False,
            "one_referral_relationships": False,
            "one_referral_attributions": False,
            "one_referral_codes": False,
            "one_agent_engagement_sessions": False,
            "one_location_auto_approve_preferences": False,
            "one_location_visibility_exclusions": False,
            "one_location_visibility_preferences": False,
            "one_location_map_preferences": False,
            "one_location_network_connections": False,
            "one_location_events": False,
            "one_location_nearby_presences": False,
            "one_location_nearby_visits": False,
            "one_location_place_ratings": False,
            "one_location_sms_contacts": False,
            "one_location_referrals": False,
            "kai_location_referrals": False,
            "one_location_access_requests": False,
            "one_location_envelopes": False,
            "one_location_public_invite_submissions": False,
            "one_location_public_invites": False,
            "one_location_circle_invites": False,
            "one_location_circle_invite_codes": False,
            "one_location_circle_member_invites": False,
            "one_location_circle_memberships": False,
            "one_location_circles": False,
            "connection_requests": False,
            "connections": False,
            "connection_origins": False,
            "trusted_connections": False,
            "trusted_device_challenges": False,
            "trusted_device_authorizations": False,
            "trusted_device_audit_events": False,
            "trusted_devices": False,
            "one_location_share_grants": False,
            "one_location_recipient_keys": False,
            "feed_events": False,
            "one_profile_discovery_jobs": False,
            "circle_chat_messages": False,
            "circle_chat_recipients": False,
            "circle_chat_preferences": False,
            "runtime_persona_state": False,
            "ria_pick_legacy_retirements": False,
            "developer_oauth_tokens": False,
            "developer_oauth_authorizations": False,
            "developer_oauth_audit_events": False,
            "developer_applications": False,
            "developer_apps": False,
            "byoc_setup_jobs": False,
            "pod_lifecycle_events": False,
            "personal_agent_registry": False,
            "personal_agent_external_resources_absent": False,
            "vault_key_wrappers": False,
            "vault_keys": False,
            "account_deletion_tombstone": False,
        }

        provider_credentials = ProviderCredentialSnapshot(user_id=user_id)
        backend_cleanup = None
        graph_viewer_ids: set[str] = set()
        try:
            with get_db_connection() as conn:
                # Apply before acquiring any lifecycle/domain lock. A blocked
                # statement must roll back and release the privacy barrier
                # before the HTTP transport or worker watchdog gives up.
                conn.execute(_ACCOUNT_ERASURE_SQL_LIMITS)
                if backend_only:
                    row = conn.execute(text(UAT_DATABASE_ATTESTATION_SQL)).mappings().first()
                    if not row or not is_attested_hushh_tech_uat_database(
                        parse_connected_database_identity(row)
                    ):
                        raise ValueError("backend_erasure_connected_database_not_uat")
                params = {"user_id": user_id}
                # The authenticated account UID is the only identity this
                # full-erasure authority may tombstone. Phone-orphan cleanup
                # has its own exact-token, phone-only, account-empty intent
                # path and must never be smuggled through this service hook.
                all_cleanup_user_ids = (user_id,)
                self._lock_fabric_receipt_users(
                    conn,
                    user_ids=all_cleanup_user_ids,
                )
                if provider_cleanup is not None:
                    if backend_only or provider_cleanup.owner_id != user_id:
                        raise ValueError("provider cleanup owner changed")
                    from hushh_mcp.services import account_deletion_provider_journal as journal

                    journal.begin_local_erasure(conn, provider_cleanup)
                    cleanup_user_ids = ()
                elif backend_only:
                    backend_cleanup = (
                        AccountDeletionLifecycleService.record_backend_only_erasure_in_transaction(
                            conn, user_id=user_id
                        )
                    )
                    cleanup_user_ids = ()
                else:
                    cleanup_user_ids = (
                        AccountDeletionLifecycleService.record_pending_many_in_transaction(
                            conn,
                            user_ids=all_cleanup_user_ids,
                        )
                    )
                results["account_deletion_tombstone"] = True
                results["firebase_cleanup_intent_count"] = len(cleanup_user_ids)
                # Admission owns its own deadlines; restore the erasure budget
                # before destructive statements, including bounded recovery batches.
                conn.execute(_ACCOUNT_ERASURE_SQL_LIMITS)
                guard_answer_erasure(conn, user_id=user_id)
                self._delete_personal_agent_state(
                    conn,
                    params=params,
                    results=results,
                )
                # Copy encrypted provider credentials before their rows go, so
                # the grants can be released at the provider after commit.
                if not backend_only and provider_cleanup is None:
                    provider_credentials = snapshot_provider_credentials_in_transaction(
                        conn,
                        user_id=user_id,
                        table_exists=lambda table_name: self._table_exists(conn, table_name),
                    )
                self._clear_external_connector_data(conn, user_id, results, permanent=True)
                # The graph writer barrier is held here. Capture survivors
                # before deleting edges/memberships, then wake them only after
                # the erasure transaction has successfully committed.
                graph_viewer_ids = list_connection_graph_viewer_ids(
                    conn,
                    user_id=user_id,
                    include_pending_requests=True,
                    table_exists=lambda table_name: self._table_exists(conn, table_name),
                )
                self._clear_live_memory_source_journal(conn, user_id, results, permanent=True)
                self._delete_optional_user_tables(
                    conn,
                    table_names=[
                        "one_adk_sessions",
                        "one_product_activity_observations",
                        "one_product_value_receipts",
                        "one_product_activity_epochs",
                        "one_marketing_preferences",
                        # Remove challenge bindings before their enrollment lookup.
                        "email_auth_challenges",
                        "email_auth_enrollments",
                        "one_action_directive_ledger",
                        "webauthn_credentials",
                        "webauthn_challenges",
                        "world_model_embeddings",
                        "connected_system_intent_approval_challenges",
                        "connection_voice_preferences",
                        "gmail_owner_send_actions",
                        "gmail_personal_information_request_preferences",
                        "gmail_personal_information_request_scan_states",
                        "gmail_personal_information_requests",
                        "google_calendar_action_proposals",
                        "google_email_send_actions",
                        "google_oauth_attempts",
                        "google_service_grants",
                        "google_provider_connections",
                        "one_agent_message_feedback",
                        "one_email_kyc_preferences",
                        "one_kyc_client_connectors",
                        "one_location_nearby_check_in_preferences",
                        "one_location_sos_voice_preferences",
                        "one_model_preferences",
                        "one_private_text_processing_approvals",
                        "one_profile_discovery_jobs",
                        "pkm_embeddings",
                        "ria_business_contacts",
                        "ria_claim_dossiers",
                        "ria_license_verifications",
                        "one_mcp_pending_calls",
                        "live_memory_hosted_source_envelopes",
                        "live_memory_hosted_pilot_grants",
                        "agent_chat_messages",
                        "agent_chat_conversations",
                        "wallet_card_access_audit",
                        "wallet_profile_access_grants",
                        "wallet_card_requests",
                        "wallet_card_access_grants",
                        "wallet_profile_share_requests",
                        "wallet_card_share_requests",
                        "wallet_card_registrations",
                        "messages",
                        "conversations",
                        "direct_message_blocks",
                        "kai_gmail_receipts",
                        "kai_gmail_sync_runs",
                        # Erase before actor_profiles can orphan the legacy rows.
                        "one_kyc_workflows",
                        "kai_gmail_connections",
                        "kai_receipt_memory_artifacts",
                        "kai_analyze_runs",
                        "kai_run_state",
                        "consent_export_refresh_jobs",
                        "consent_exports",
                        "connected_system_audit_events",
                        "connected_system_record_bindings",
                        "connected_system_intent_approval_challenges",
                        "connected_system_intents",
                        "connected_system_owner_signing_keys",
                        "connected_system_zk_contexts",
                        "fabric_consent_requests",
                        "fabric_subscription_grants",
                        "pwm_documents",
                        "marketplace_delivery_envelopes",
                        "marketplace_access_requests",
                        "marketplace_recipient_keys",
                        "pkm_packets",
                        "pkm_packet_orders",
                        "directory_listing_claims",
                        "pkm_credit_ledger",
                        "pkm_credit_subscriptions",
                        "pkm_owner_payout_accounts",
                        "stripe_owner_payout_accounts",
                        "drive_request_owner_pricing",
                        "marketplace_opportunity_signals",
                        "trusted_device_challenges",
                        "trusted_device_authorizations",
                        "trusted_device_audit_events",
                        "trusted_devices",
                        "pkm_default_available_projections",
                        "pkm_upgrade_claims",
                        "pkm_domain_commits",
                        "pkm_domain_revision_segments",
                        "pkm_domain_revisions",
                        "pkm_upgrade_steps",
                        "pkm_upgrade_runs",
                        "ria_pick_legacy_retirements",
                        "developer_oauth_tokens",
                        "developer_oauth_authorizations",
                        "developer_oauth_audit_events",
                        "developer_applications",
                        "developer_apps",
                        # Identity-keyed rows that otherwise go only through a
                        # parent cascade, and parked passkey tables when present.
                        "ria_claim_dossiers",
                        "webauthn_challenges",
                        "webauthn_credentials",
                    ],
                    params=params,
                    results=results,
                )
                self._delete_one_referral_graph(
                    conn,
                    params=params,
                    results=results,
                )
                conn.execute(text("DELETE FROM pkm_events WHERE user_id = :user_id"), params)
                results["pkm_events"] = True
                conn.execute(
                    text("DELETE FROM pkm_scope_registry WHERE user_id = :user_id"), params
                )
                results["pkm_scope_registry"] = True
                conn.execute(
                    text("DELETE FROM pkm_manifest_paths WHERE user_id = :user_id"), params
                )
                results["pkm_manifest_paths"] = True
                conn.execute(text("DELETE FROM pkm_manifests WHERE user_id = :user_id"), params)
                results["pkm_manifests"] = True
                conn.execute(text("DELETE FROM pkm_blobs WHERE user_id = :user_id"), params)
                results["pkm_blobs"] = True
                conn.execute(text("DELETE FROM pkm_index WHERE user_id = :user_id"), params)
                results["pkm_index"] = True
                self._delete_user_rows_if_table_exists(
                    conn, table_name="world_model_index_v2", params=params
                )
                results["world_model_index_v2"] = True
                self._delete_user_rows_if_table_exists(
                    conn, table_name="pkm_migration_state", params=params
                )
                results["pkm_migration_state"] = True
                self._delete_user_rows_if_table_exists(conn, table_name="pkm_data", params=params)
                results["pkm_data"] = True
                conn.execute(
                    text(
                        """
                        DELETE FROM ria_client_invites
                        WHERE target_investor_user_id = :user_id
                           OR accepted_by_user_id = :user_id
                        """
                    ),
                    params,
                )
                results["invite_links"] = True

                if self._table_exists(conn, "relationship_share_events"):
                    conn.execute(
                        text(
                            """
                            DELETE FROM relationship_share_events
                            WHERE provider_user_id = :user_id
                               OR receiver_user_id = :user_id
                            """
                        ),
                        params,
                    )
                results["relationship_share_events"] = True
                if self._table_exists(conn, "relationship_share_grants"):
                    conn.execute(
                        text(
                            """
                            DELETE FROM relationship_share_grants
                            WHERE provider_user_id = :user_id
                               OR receiver_user_id = :user_id
                            """
                        ),
                        params,
                    )
                results["relationship_share_grants"] = True
                if self._table_exists(conn, "ria_pick_share_artifacts"):
                    conn.execute(
                        text(
                            """
                            DELETE FROM ria_pick_share_artifacts
                            WHERE provider_user_id = :user_id
                               OR receiver_user_id = :user_id
                            """
                        ),
                        params,
                    )
                results["ria_pick_share_artifacts"] = True
                if self._table_exists(conn, "advisor_investor_relationships"):
                    if self._table_exists(conn, "ria_profiles"):
                        conn.execute(
                            text(
                                """
                                DELETE FROM advisor_investor_relationships
                                WHERE investor_user_id = :user_id
                                   OR ria_profile_id IN (
                                     SELECT id FROM ria_profiles WHERE user_id = :user_id
                                   )
                                """
                            ),
                            params,
                        )
                    else:
                        conn.execute(
                            text(
                                """
                                DELETE FROM advisor_investor_relationships
                                WHERE investor_user_id = :user_id
                                """
                            ),
                            params,
                        )
                results["relationships"] = True
                self._delete_user_rows_if_table_exists(
                    conn, table_name="marketplace_investor_actions", params=params
                )
                results["marketplace_investor_actions"] = True
                self._delete_user_rows_if_table_exists(
                    conn, table_name="marketplace_public_profiles", params=params
                )
                results["marketplace_profile"] = True
                conn.execute(text("DELETE FROM consent_audit WHERE user_id = :user_id"), params)
                results["consent_audit"] = True
                self._delete_user_rows_if_table_exists(
                    conn, table_name="internal_access_events", params=params
                )
                results["internal_access_events"] = True
                erase_push_registrations(conn, params, self._table_exists)
                results["push_tokens"] = True
                self._delete_owned_named_circles(
                    conn,
                    user_id=user_id,
                    results=results,
                )
                for table_name in (
                    # This budget is deliberately preserved by persona reset so
                    # reset cannot become a rate-limit bypass. A full account
                    # deletion removes the identity, so its FK-free budget row
                    # must be purged here as well.
                    "contact_sync_lookup_budgets",
                    # Terms/Privacy acceptance history: FK-free (it precedes the
                    # actor profile) and kept across reset, so only here.
                    "account_legal_acceptances",
                    "one_location_auto_approve_preferences",
                    # Cross-user exclusions must go before their owner preference.
                    "one_location_visibility_exclusions",
                    "one_location_visibility_preferences",
                    "one_location_map_preferences",
                    "one_location_network_connections",
                    "one_location_events",
                    "one_location_nearby_presences",
                    "one_location_nearby_visits",
                    "one_location_place_ratings",
                    "one_location_sms_contacts",
                    "one_location_referrals",
                    "kai_location_referrals",
                    "one_location_public_invite_submissions",
                    "one_location_public_invites",
                    "one_location_circle_invites",
                    "one_location_circle_member_invites",
                    "one_location_circle_memberships",
                    "connection_scope_proposal_events",
                    "connection_scope_proposals",
                    "connection_requests",
                    "connections",
                    "trusted_connections",
                    "one_location_access_requests",
                    "one_location_envelopes",
                    "one_location_share_grants",
                    "one_location_recipient_keys",
                    "wallet_card_access_audit",
                    "wallet_card_access_grants",
                    "wallet_card_share_requests",
                    "wallet_card_registrations",
                    "one_wallet_cards",
                    # Last derived-data cleanup, before the identity/vault spine.
                    "circle_chat_messages",
                    "circle_chat_recipients",
                    "circle_chat_preferences",
                    "feed_events",
                ):
                    self._delete_user_rows_if_table_exists(
                        conn,
                        table_name=table_name,
                        params=params,
                    )
                    results[table_name] = True
                self._delete_user_rows_if_table_exists(
                    conn,
                    table_name="actor_verified_email_aliases",
                    params=params,
                )
                results["actor_verified_email_aliases"] = True
                self._delete_user_rows_if_table_exists(
                    conn, table_name="actor_identity_cache", params=params
                )
                results["actor_identity_cache"] = True
                self._delete_user_rows_if_table_exists(
                    conn, table_name="runtime_persona_state", params=params
                )
                results["runtime_persona_state"] = True
                # Preserve profile IDs until relationship cleanup has used them.
                # Explicitly erase the profile rather than relying on the actor FK.
                if self._table_exists(conn, "ria_profiles"):
                    conn.execute(text("DELETE FROM ria_profiles WHERE user_id = :user_id"), params)
                results["ria_profiles"] = True
                self._delete_user_rows_if_table_exists(
                    conn, table_name="actor_profiles", params=params
                )
                results["actor_profiles"] = True
                self._delete_user_rows_if_table_exists(
                    conn, table_name="vault_key_wrappers", params=params
                )
                results["vault_key_wrappers"] = True
                if self._table_exists(conn, "shared_files_storage"):
                    conn.execute(
                        text(
                            "DELETE FROM shared_files_storage WHERE user_id=:user_id AND state='erased' AND writes='{}'::jsonb AND receipt->>'complete'='true'"
                        ),
                        params,
                    )
                    results["shared_files_storage"] = True
                conn.execute(text("DELETE FROM vault_keys WHERE user_id = :user_id"), params)
                results["vault_keys"] = True
                if provider_cleanup is not None:
                    journal.settle_local_erasure(conn, provider_cleanup)
                elif backend_cleanup is not None:
                    from hushh_mcp.services import account_deletion_provider_journal as journal

                    journal.settle_local_erasure(conn, backend_cleanup)

            logger.info("✅ FULL ACCOUNT DELETION completed for %s", user_id)
        except PersonalAgentDeprovisioningRequiredError:
            logger.warning(
                "Account deletion blocked until personal-agent resources are deprovisioned for %s",
                user_id,
            )
            return {
                "success": False,
                "error": PERSONAL_AGENT_DEPROVISION_REQUIRED_CODE,
                "error_code": PERSONAL_AGENT_DEPROVISION_REQUIRED_CODE,
                "message": PERSONAL_AGENT_DEPROVISION_REQUIRED_MESSAGE,
                "requested_target": requested_target,
                "deleted_target": None,
                "account_deleted": False,
                "remaining_personas": [],
                "details": results,
            }, provider_credentials
        except Exception as exc:
            logger.error("Full account deletion failed error=%s", type(exc).__name__)
            return {
                "success": False,
                "error": str(exc),
                "error_code": (
                    ACCOUNT_DELETION_PAUSED_CODE if _is_release_fence_refusal(exc) else None
                ),
                "requested_target": requested_target,
                "deleted_target": None,
                "account_deleted": False,
                "remaining_personas": [],
                "details": results,
            }, provider_credentials

        # Outside the erasure try-block on purpose: the deletion has committed,
        # and releasing provider grants is bounded best effort that never raises.
        if graph_viewer_ids:
            try:
                from hushh_mcp.services.connections_service import _notify_connection_graph_changed

                _notify_connection_graph_changed(user_ids=graph_viewer_ids)
            except Exception:  # a failed doorbell cannot undo committed erasure
                logger.warning("account.graph_sync_failed", exc_info=True)
        return {
            "success": True,
            "requested_target": requested_target,
            "deleted_target": "both",
            "account_deleted": True,
            "remaining_personas": [],
            "details": results,
        }, provider_credentials

    async def _delete_ria_persona(
        self,
        *,
        user_id: str,
        remaining_personas: list[str],
        investor_marketplace_opt_in: bool,
        requested_target: DeleteAccountTarget,
    ) -> Dict[str, Any]:
        logger.warning("🚨 RIA persona deletion requested for %s", user_id)
        results = {
            "ria_pick_legacy_retirements": False,
            "ria_profile": False,
            "actor_profile": False,
            "runtime_persona_state": False,
            "marketplace_profile": False,
        }

        try:
            with get_db_connection() as conn:
                params = {"user_id": user_id}
                self._delete_user_rows_if_table_exists(
                    conn,
                    table_name="ria_pick_legacy_retirements",
                    params=params,
                )
                results["ria_pick_legacy_retirements"] = True
                conn.execute(text("DELETE FROM ria_profiles WHERE user_id = :user_id"), params)
                results["ria_profile"] = True
                conn.execute(
                    text(
                        """
                        UPDATE actor_profiles
                        SET personas = :personas,
                            last_active_persona = :last_active_persona,
                            updated_at = NOW()
                        WHERE user_id = :user_id
                        """
                    ),
                    {
                        "user_id": user_id,
                        "personas": remaining_personas,
                        "last_active_persona": remaining_personas[0],
                    },
                )
                results["actor_profile"] = True
                conn.execute(
                    text(
                        """
                        UPDATE runtime_persona_state
                        SET last_active_persona = :last_active_persona,
                            updated_at = NOW()
                        WHERE user_id = :user_id
                        """
                    ),
                    {"user_id": user_id, "last_active_persona": remaining_personas[0]},
                )
                results["runtime_persona_state"] = True

                if investor_marketplace_opt_in:
                    conn.execute(
                        text(
                            """
                            INSERT INTO marketplace_public_profiles (
                              user_id,
                              profile_type,
                              display_name,
                              is_discoverable,
                              verification_badge,
                              strategy_summary,
                              updated_at
                            )
                            VALUES (
                              :user_id,
                              'investor',
                              :display_name,
                              TRUE,
                              NULL,
                              NULL,
                              NOW()
                            )
                            ON CONFLICT (user_id) DO UPDATE
                            SET profile_type = 'investor',
                                display_name = EXCLUDED.display_name,
                                is_discoverable = TRUE,
                                verification_badge = NULL,
                                strategy_summary = NULL,
                                updated_at = NOW()
                            """
                        ),
                        {"user_id": user_id, "display_name": f"Investor {user_id[:8]}"},
                    )
                else:
                    conn.execute(
                        text("DELETE FROM marketplace_public_profiles WHERE user_id = :user_id"),
                        params,
                    )
                results["marketplace_profile"] = True

            return {
                "success": True,
                "requested_target": requested_target,
                "deleted_target": "ria",
                "account_deleted": False,
                "remaining_personas": remaining_personas,
                "details": results,
            }
        except Exception as exc:
            logger.exception("❌ RIA persona deletion failed for %s", user_id)
            return {
                "success": False,
                "error": str(exc),
                "requested_target": requested_target,
                "deleted_target": None,
                "account_deleted": False,
                "remaining_personas": remaining_personas,
                "details": results,
            }

    async def _delete_investor_persona(
        self,
        *,
        user_id: str,
        remaining_personas: list[str],
        requested_target: DeleteAccountTarget,
    ) -> Dict[str, Any]:
        logger.warning("🚨 Investor persona deletion requested for %s", user_id)
        results = {
            "pkm_data": False,
            "pkm_index": False,
            "pkm_blobs": False,
            "pkm_manifests": False,
            "pkm_manifest_paths": False,
            "pkm_scope_registry": False,
            "pkm_events": False,
            "pkm_default_available_projections": False,
            "pkm_migration_state": False,
            "pkm_upgrade_runs": False,
            "pkm_upgrade_steps": False,
            "pkm_upgrade_claims": False,
            "pkm_domain_commits": False,
            "pkm_domain_revision_segments": False,
            "pkm_domain_revisions": False,
            "investor_relationships": False,
            "investor_invites": False,
            "investor_marketplace_profile": False,
            "consent_audit": False,
            "internal_access_events": False,
            "actor_profile": False,
            "runtime_persona_state": False,
        }

        try:
            with get_db_connection() as conn:
                params = {"user_id": user_id}
                conn.execute(text("DELETE FROM pkm_events WHERE user_id = :user_id"), params)
                results["pkm_events"] = True
                conn.execute(
                    text("DELETE FROM pkm_scope_registry WHERE user_id = :user_id"), params
                )
                results["pkm_scope_registry"] = True
                conn.execute(
                    text("DELETE FROM pkm_manifest_paths WHERE user_id = :user_id"), params
                )
                results["pkm_manifest_paths"] = True
                conn.execute(text("DELETE FROM pkm_manifests WHERE user_id = :user_id"), params)
                results["pkm_manifests"] = True
                conn.execute(text("DELETE FROM pkm_blobs WHERE user_id = :user_id"), params)
                results["pkm_blobs"] = True
                conn.execute(text("DELETE FROM pkm_index WHERE user_id = :user_id"), params)
                results["pkm_index"] = True
                self._delete_user_rows_if_table_exists(
                    conn, table_name="pkm_default_available_projections", params=params
                )
                results["pkm_default_available_projections"] = True
                self._delete_user_rows_if_table_exists(
                    conn, table_name="pkm_upgrade_claims", params=params
                )
                results["pkm_upgrade_claims"] = True
                self._delete_user_rows_if_table_exists(
                    conn, table_name="pkm_domain_commits", params=params
                )
                results["pkm_domain_commits"] = True
                self._delete_user_rows_if_table_exists(
                    conn, table_name="pkm_domain_revision_segments", params=params
                )
                results["pkm_domain_revision_segments"] = True
                self._delete_user_rows_if_table_exists(
                    conn, table_name="pkm_domain_revisions", params=params
                )
                results["pkm_domain_revisions"] = True
                if self._table_exists(conn, "pkm_upgrade_steps"):
                    conn.execute(self._delete_by_user_queries["pkm_upgrade_steps"], params)
                results["pkm_upgrade_steps"] = True
                self._delete_user_rows_if_table_exists(
                    conn, table_name="pkm_upgrade_runs", params=params
                )
                results["pkm_upgrade_runs"] = True
                self._delete_user_rows_if_table_exists(
                    conn, table_name="pkm_migration_state", params=params
                )
                results["pkm_migration_state"] = True
                self._delete_user_rows_if_table_exists(conn, table_name="pkm_data", params=params)
                results["pkm_data"] = True
                conn.execute(
                    text(
                        "DELETE FROM advisor_investor_relationships WHERE investor_user_id = :user_id"
                    ),
                    params,
                )
                results["investor_relationships"] = True
                conn.execute(
                    text(
                        """
                        DELETE FROM ria_client_invites
                        WHERE target_investor_user_id = :user_id
                           OR accepted_by_user_id = :user_id
                        """
                    ),
                    params,
                )
                results["investor_invites"] = True
                conn.execute(
                    text(
                        """
                        DELETE FROM marketplace_public_profiles
                        WHERE user_id = :user_id
                          AND profile_type = 'investor'
                        """
                    ),
                    params,
                )
                results["investor_marketplace_profile"] = True
                conn.execute(
                    text(
                        """
                        DELETE FROM consent_audit
                        WHERE user_id = :user_id
                          AND COALESCE(scope, '') NOT LIKE 'attr.ria.%'
                        """
                    ),
                    params,
                )
                results["consent_audit"] = True
                conn.execute(
                    text("DELETE FROM internal_access_events WHERE user_id = :user_id"),
                    params,
                )
                results["internal_access_events"] = True
                conn.execute(
                    text(
                        """
                        UPDATE actor_profiles
                        SET personas = :personas,
                            last_active_persona = :last_active_persona,
                            investor_marketplace_opt_in = FALSE,
                            updated_at = NOW()
                        WHERE user_id = :user_id
                        """
                    ),
                    {
                        "user_id": user_id,
                        "personas": remaining_personas,
                        "last_active_persona": remaining_personas[0],
                    },
                )
                results["actor_profile"] = True
                conn.execute(
                    text(
                        """
                        UPDATE runtime_persona_state
                        SET last_active_persona = :last_active_persona,
                            updated_at = NOW()
                        WHERE user_id = :user_id
                        """
                    ),
                    {"user_id": user_id, "last_active_persona": remaining_personas[0]},
                )
                results["runtime_persona_state"] = True

            return {
                "success": True,
                "requested_target": requested_target,
                "deleted_target": "investor",
                "account_deleted": False,
                "remaining_personas": remaining_personas,
                "details": results,
            }
        except Exception as exc:
            logger.exception("❌ Investor persona deletion failed for %s", user_id)
            return {
                "success": False,
                "error": str(exc),
                "requested_target": requested_target,
                "deleted_target": None,
                "account_deleted": False,
                "remaining_personas": remaining_personas,
                "details": results,
            }

    def prepare_export(self, user_id: str) -> AccountExportStream:
        """Prepare the HTTP export without collecting its encrypted history in RAM."""
        return AccountExportStream(
            user_id=user_id,
            connection_factory=get_db_connection,
            table_exists=self._table_exists,
            queries=self._safe_export_queries,
        ).prepare()

    async def export_data(self, user_id: str) -> Dict[str, Any]:
        """
        Compatibility dictionary export for internal callers.

        HTTP downloads use prepare_export so retained ciphertext is not materialized.
        """
        try:
            with get_db_connection() as conn:
                params = {"user_id": user_id}
                export_payload = {}
                for key, table, many in EXPORT_SECTIONS:
                    fetch = (
                        self._fetch_optional_many_rows if many else self._fetch_optional_single_row
                    )
                    export_payload[key] = fetch(
                        conn, table_name=table, query_name=key, params=params
                    )
            return {
                "success": True,
                "requested_target": "account",
                "exported_at": datetime.now(timezone.utc).isoformat(),
                "data": export_payload,
            }
        except Exception:
            logger.exception("❌ Account export failed for %s", user_id)
            return {"success": False, "error": "Account export failed"}

    def _fetch_optional_single_row(
        self, conn, *, table_name: str, query_name: str, params: dict[str, Any]
    ) -> dict[str, Any] | None:
        if not self._table_exists(conn, table_name):
            logger.info("Skipping export for missing table: %s", table_name)
            return None
        query = self._safe_export_queries[query_name]
        row = conn.execute(query, params).mappings().first()
        return dict(row) if row else None

    def _fetch_optional_many_rows(
        self, conn, *, table_name: str, query_name: str, params: dict[str, Any]
    ) -> list[dict[str, Any]]:
        if not self._table_exists(conn, table_name):
            logger.info("Skipping export for missing table: %s", table_name)
            return []
        query = self._safe_export_queries[query_name]
        rows = conn.execute(query, params).mappings().all()
        return [dict(row) for row in rows]
