# hushh_mcp/services/account_service.py
"""Account deletion orchestration for full-account and persona-scoped cleanup."""

import logging
from datetime import datetime, timezone
from typing import Any, Dict, Literal

from sqlalchemy import text

from db.db_client import get_db, get_db_connection

logger = logging.getLogger(__name__)

DeleteAccountTarget = Literal["investor", "ria", "both"]


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
        self._supabase = None
        self._table_exists_cache: dict[str, bool] = {}
        self._delete_by_user_queries = {
            "actor_identity_cache": text(
                "DELETE FROM actor_identity_cache WHERE user_id = :user_id"
            ),
            "actor_profiles": text("DELETE FROM actor_profiles WHERE user_id = :user_id"),
            "consent_export_refresh_jobs": text(
                "DELETE FROM consent_export_refresh_jobs WHERE user_id = :user_id"
            ),
            "consent_exports": text("DELETE FROM consent_exports WHERE user_id = :user_id"),
            "internal_access_events": text(
                "DELETE FROM internal_access_events WHERE user_id = :user_id"
            ),
            "kai_funding_ach_relationships": text(
                "DELETE FROM kai_funding_ach_relationships WHERE user_id = :user_id"
            ),
            "kai_funding_alpaca_connect_sessions": text(
                "DELETE FROM kai_funding_alpaca_connect_sessions WHERE user_id = :user_id"
            ),
            "kai_funding_brokerage_accounts": text(
                "DELETE FROM kai_funding_brokerage_accounts WHERE user_id = :user_id"
            ),
            "kai_funding_consent_records": text(
                "DELETE FROM kai_funding_consent_records WHERE user_id = :user_id"
            ),
            "kai_funding_plaid_accounts": text(
                "DELETE FROM kai_funding_plaid_accounts WHERE user_id = :user_id"
            ),
            "kai_funding_plaid_items": text(
                "DELETE FROM kai_funding_plaid_items WHERE user_id = :user_id"
            ),
            "kai_funding_reconciliation_runs": text(
                "DELETE FROM kai_funding_reconciliation_runs WHERE user_id = :user_id"
            ),
            "kai_funding_support_escalations": text(
                "DELETE FROM kai_funding_support_escalations WHERE user_id = :user_id"
            ),
            "kai_funding_trade_events": text(
                "DELETE FROM kai_funding_trade_events WHERE user_id = :user_id"
            ),
            "kai_funding_trade_intents": text(
                "DELETE FROM kai_funding_trade_intents WHERE user_id = :user_id"
            ),
            "kai_funding_transfer_events": text(
                "DELETE FROM kai_funding_transfer_events WHERE user_id = :user_id"
            ),
            "kai_funding_transfers": text(
                "DELETE FROM kai_funding_transfers WHERE user_id = :user_id"
            ),
            "kai_gmail_connections": text(
                "DELETE FROM kai_gmail_connections WHERE user_id = :user_id"
            ),
            "kai_gmail_receipts": text("DELETE FROM kai_gmail_receipts WHERE user_id = :user_id"),
            "kai_gmail_sync_runs": text("DELETE FROM kai_gmail_sync_runs WHERE user_id = :user_id"),
            "kai_portfolio_source_preferences": text(
                "DELETE FROM kai_portfolio_source_preferences WHERE user_id = :user_id"
            ),
            "kai_plaid_link_sessions": text(
                "DELETE FROM kai_plaid_link_sessions WHERE user_id = :user_id"
            ),
            "kai_plaid_refresh_runs": text(
                "DELETE FROM kai_plaid_refresh_runs WHERE user_id = :user_id"
            ),
            "marketplace_public_profiles": text(
                "DELETE FROM marketplace_public_profiles WHERE user_id = :user_id"
            ),
            "pkm_data": text("DELETE FROM pkm_data WHERE user_id = :user_id"),
            "pkm_upgrade_runs": text("DELETE FROM pkm_upgrade_runs WHERE user_id = :user_id"),
            "kai_plaid_user_profile_cache": text(
                "DELETE FROM kai_plaid_user_profile_cache WHERE user_id = :user_id"
            ),
            "kai_receipt_memory_artifacts": text(
                "DELETE FROM kai_receipt_memory_artifacts WHERE user_id = :user_id"
            ),
            "one_kyc_workflows": text("DELETE FROM one_kyc_workflows WHERE user_id = :user_id"),
            "runtime_persona_state": text(
                "DELETE FROM runtime_persona_state WHERE user_id = :user_id"
            ),
            "user_push_tokens": text("DELETE FROM user_push_tokens WHERE user_id = :user_id"),
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
                       readable_summary_version, upgraded_at, created_at, updated_at
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
            "consent_audit": text(
                """
                SELECT id, token_id, user_id, agent_id, scope, action, issued_at, poll_timeout_at
                FROM consent_audit
                WHERE user_id = :user_id
                ORDER BY issued_at DESC
                LIMIT 500
                """
            ),
            "one_kyc_workflows": text(
                """
                SELECT workflow_id, user_id, status, gmail_thread_id, sender_email,
                       counterparty_label, required_fields, requested_scope,
                       consent_request_id, draft_status, last_error_code,
                       created_at, updated_at
                FROM one_kyc_workflows
                WHERE user_id = :user_id
                ORDER BY created_at DESC
                """
            ),
        }

    @property
    def supabase(self):
        """Get database client."""
        if self._supabase is None:
            self._supabase = get_db()
        return self._supabase

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
        if target in {"investor", "ria"}:
            return target
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
        conn.execute(query, params)

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

    async def delete_account(
        self,
        user_id: str,
        target: DeleteAccountTarget = "both",
    ) -> Dict[str, Any]:
        """Delete either the whole account or one persona."""
        requested_target = self._normalized_target(target)
        actor_profile = self._load_actor_profile(user_id)
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
            return await self._delete_full_account(user_id, requested_target=requested_target)

        remaining_personas = [persona for persona in personas if persona != requested_target]
        if not remaining_personas:
            return await self._delete_full_account(user_id, requested_target=requested_target)

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

    async def _delete_full_account(
        self,
        user_id: str,
        *,
        requested_target: DeleteAccountTarget,
    ) -> Dict[str, Any]:
        logger.warning("🚨 FULL ACCOUNT DELETION requested for %s", user_id)
        results = {
            "actor_identity_cache": False,
            "actor_profiles": False,
            "pkm_data": False,
            "pkm_index": False,
            "pkm_blobs": False,
            "pkm_manifests": False,
            "pkm_manifest_paths": False,
            "pkm_scope_registry": False,
            "pkm_events": False,
            "pkm_upgrade_runs": False,
            "plaid_items": False,
            "plaid_refresh_runs": False,
            "plaid_link_sessions": False,
            "plaid_profile_cache": False,
            "kai_portfolio_source_preferences": False,
            "kai_gmail_connections": False,
            "kai_gmail_receipts": False,
            "kai_gmail_sync_runs": False,
            "kai_receipt_memory_artifacts": False,
            "kai_funding_trade_events": False,
            "kai_funding_trade_intents": False,
            "kai_funding_transfer_events": False,
            "kai_funding_support_escalations": False,
            "kai_funding_transfers": False,
            "kai_funding_ach_relationships": False,
            "kai_funding_consent_records": False,
            "kai_funding_plaid_accounts": False,
            "kai_funding_plaid_items": False,
            "kai_funding_brokerage_accounts": False,
            "kai_funding_alpaca_connect_sessions": False,
            "kai_funding_reconciliation_runs": False,
            "consent_exports": False,
            "consent_export_refresh_jobs": False,
            "consent_audit": False,
            "internal_access_events": False,
            "push_tokens": False,
            "invite_links": False,
            "relationships": False,
            "relationship_share_events": False,
            "relationship_share_grants": False,
            "ria_pick_share_artifacts": False,
            "ria_pick_uploads": False,
            "marketplace_profile": False,
            "one_kyc_workflows": False,
            "runtime_persona_state": False,
            "vault_keys": False,
        }

        try:
            with get_db_connection() as conn:
                params = {"user_id": user_id}
                self._delete_optional_user_tables(
                    conn,
                    table_names=[
                        "kai_funding_trade_events",
                        "kai_funding_trade_intents",
                        "kai_funding_transfer_events",
                        "kai_funding_support_escalations",
                        "kai_funding_transfers",
                        "kai_funding_ach_relationships",
                        "kai_funding_consent_records",
                        "kai_funding_plaid_accounts",
                        "kai_funding_plaid_items",
                        "kai_funding_brokerage_accounts",
                        "kai_funding_alpaca_connect_sessions",
                        "kai_funding_reconciliation_runs",
                        "kai_gmail_receipts",
                        "kai_gmail_sync_runs",
                        "kai_gmail_connections",
                        "kai_receipt_memory_artifacts",
                        "kai_portfolio_source_preferences",
                        "consent_export_refresh_jobs",
                        "consent_exports",
                        "pkm_upgrade_runs",
                    ],
                    params=params,
                    results=results,
                )
                conn.execute(
                    text("DELETE FROM kai_plaid_refresh_runs WHERE user_id = :user_id"), params
                )
                results["plaid_refresh_runs"] = True
                conn.execute(
                    text("DELETE FROM kai_plaid_link_sessions WHERE user_id = :user_id"), params
                )
                results["plaid_link_sessions"] = True
                conn.execute(text("DELETE FROM kai_plaid_items WHERE user_id = :user_id"), params)
                results["plaid_items"] = True
                self._delete_user_rows_if_table_exists(
                    conn,
                    table_name="kai_plaid_user_profile_cache",
                    params=params,
                )
                results["plaid_profile_cache"] = True
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
                if self._table_exists(conn, "ria_pick_uploads"):
                    if self._table_exists(conn, "ria_profiles"):
                        conn.execute(
                            text(
                                """
                                DELETE FROM ria_pick_uploads
                                WHERE uploaded_by_user_id = :user_id
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
                                "DELETE FROM ria_pick_uploads WHERE uploaded_by_user_id = :user_id"
                            ),
                            params,
                        )
                results["ria_pick_uploads"] = True
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
                    conn, table_name="marketplace_public_profiles", params=params
                )
                results["marketplace_profile"] = True
                conn.execute(text("DELETE FROM consent_audit WHERE user_id = :user_id"), params)
                results["consent_audit"] = True
                self._delete_user_rows_if_table_exists(
                    conn, table_name="internal_access_events", params=params
                )
                results["internal_access_events"] = True
                self._delete_user_rows_if_table_exists(
                    conn, table_name="user_push_tokens", params=params
                )
                results["push_tokens"] = True
                self._delete_user_rows_if_table_exists(
                    conn,
                    table_name="one_kyc_workflows",
                    params=params,
                )
                results["one_kyc_workflows"] = True
                self._delete_user_rows_if_table_exists(
                    conn, table_name="actor_identity_cache", params=params
                )
                results["actor_identity_cache"] = True
                self._delete_user_rows_if_table_exists(
                    conn, table_name="runtime_persona_state", params=params
                )
                results["runtime_persona_state"] = True
                self._delete_user_rows_if_table_exists(
                    conn, table_name="actor_profiles", params=params
                )
                results["actor_profiles"] = True
                conn.execute(text("DELETE FROM vault_keys WHERE user_id = :user_id"), params)
                results["vault_keys"] = True

            logger.info("✅ FULL ACCOUNT DELETION completed for %s", user_id)
            return {
                "success": True,
                "requested_target": requested_target,
                "deleted_target": "both",
                "account_deleted": True,
                "remaining_personas": [],
                "details": results,
            }
        except Exception as exc:
            logger.exception("❌ Full account deletion failed for %s", user_id)
            return {
                "success": False,
                "error": str(exc),
                "requested_target": requested_target,
                "deleted_target": None,
                "account_deleted": False,
                "remaining_personas": [],
                "details": results,
            }

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
            "ria_profile": False,
            "actor_profile": False,
            "runtime_persona_state": False,
            "marketplace_profile": False,
        }

        try:
            with get_db_connection() as conn:
                params = {"user_id": user_id}
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
            "plaid_items": False,
            "plaid_refresh_runs": False,
            "plaid_link_sessions": False,
            "plaid_profile_cache": False,
            "investor_relationships": False,
            "investor_invites": False,
            "investor_marketplace_profile": False,
            "consent_audit": False,
            "internal_access_events": False,
            "one_kyc_workflows": False,
            "actor_profile": False,
            "runtime_persona_state": False,
        }

        try:
            with get_db_connection() as conn:
                params = {"user_id": user_id}
                conn.execute(
                    text("DELETE FROM kai_plaid_refresh_runs WHERE user_id = :user_id"), params
                )
                results["plaid_refresh_runs"] = True
                conn.execute(
                    text("DELETE FROM kai_plaid_link_sessions WHERE user_id = :user_id"), params
                )
                results["plaid_link_sessions"] = True
                conn.execute(text("DELETE FROM kai_plaid_items WHERE user_id = :user_id"), params)
                results["plaid_items"] = True
                self._delete_user_rows_if_table_exists(
                    conn,
                    table_name="kai_plaid_user_profile_cache",
                    params=params,
                )
                results["plaid_profile_cache"] = True
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
                self._delete_user_rows_if_table_exists(
                    conn,
                    table_name="one_kyc_workflows",
                    params=params,
                )
                results["one_kyc_workflows"] = True
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

    async def export_data(self, user_id: str) -> Dict[str, Any]:
        """
        Export all user data.

        Returns a dictionary containing:
        - Vault Keys (Encrypted)
        - PKM Index
        - PKM Data (Encrypted)
        - Identity (Encrypted)
        """
        try:
            with get_db_connection() as conn:
                params = {"user_id": user_id}
                export_payload = {
                    "actor_profile": self._fetch_optional_single_row(
                        conn, table_name="actor_profiles", query_name="actor_profile", params=params
                    ),
                    "runtime_persona_state": self._fetch_optional_single_row(
                        conn,
                        table_name="runtime_persona_state",
                        query_name="runtime_persona_state",
                        params=params,
                    ),
                    "encrypted_vault_keys": self._fetch_optional_many_rows(
                        conn,
                        table_name="vault_keys",
                        query_name="encrypted_vault_keys",
                        params=params,
                    ),
                    "encrypted_pkm_manifests": self._fetch_optional_many_rows(
                        conn,
                        table_name="pkm_manifests",
                        query_name="encrypted_pkm_manifests",
                        params=params,
                    ),
                    "encrypted_pkm_index": self._fetch_optional_many_rows(
                        conn,
                        table_name="pkm_index",
                        query_name="encrypted_pkm_index",
                        params=params,
                    ),
                    "encrypted_pkm_blobs": self._fetch_optional_many_rows(
                        conn,
                        table_name="pkm_blobs",
                        query_name="encrypted_pkm_blobs",
                        params=params,
                    ),
                    "consent_audit": self._fetch_optional_many_rows(
                        conn, table_name="consent_audit", query_name="consent_audit", params=params
                    ),
                }
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
