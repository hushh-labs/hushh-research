# hushh_mcp/services/account_service.py
"""Account deletion orchestration for full-account and persona-scoped cleanup."""

import logging
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
            "kai_plaid_user_profile_cache": text(
                "DELETE FROM kai_plaid_user_profile_cache WHERE user_id = :user_id"
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
            "consent_audit": False,
            "internal_access_events": False,
            "push_tokens": False,
            "invite_links": False,
            "vault_keys": False,
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
                        """
                        DELETE FROM ria_client_invites
                        WHERE target_investor_user_id = :user_id
                           OR accepted_by_user_id = :user_id
                        """
                    ),
                    params,
                )
                results["invite_links"] = True
                conn.execute(text("DELETE FROM consent_audit WHERE user_id = :user_id"), params)
                results["consent_audit"] = True
                conn.execute(
                    text("DELETE FROM internal_access_events WHERE user_id = :user_id"),
                    params,
                )
                results["internal_access_events"] = True
                conn.execute(text("DELETE FROM user_push_tokens WHERE user_id = :user_id"), params)
                results["push_tokens"] = True
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
        # TODO: Implement full export if needed.
        # For now, we reuse the existing specific export endpoints.
        pass
