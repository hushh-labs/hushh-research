# hushh_mcp/services/vault_db.py
"""
Vault Database Service
======================

Unified database service layer for agent-mediated vault access.

ARCHITECTURE:
    API Route → Agent → Tool → Operon → VaultDBService → Database

CONSENT-FIRST:
    All operations validate consent tokens before database access.
    No direct database queries should bypass this service.

BYOK (Bring Your Own Key):
    This service ONLY stores and retrieves ciphertext.
    Encryption/decryption happens client-side.
    The database and backend NEVER see plaintext user data.

DEPRECATION NOTICE:
    This service uses legacy vault_* tables (vault_food, vault_professional, etc.).
    New code should use PersonalKnowledgeModelService with PKM encrypted blob/index storage
    (store_domain_data, get_encrypted_data, get_domain_data).
    Migration path:
    - VaultDBService (legacy) → PersonalKnowledgeModelService blob API (preferred)
    - vault_* tables → PKM encrypted blob + PKM index

Usage:
    # DEPRECATED - use PersonalKnowledgeModelService instead
    from hushh_mcp.services.vault_db import VaultDBService

    # PREFERRED - use PersonalKnowledgeModelService blob API
    from hushh_mcp.services.personal_knowledge_model_service import get_pkm_service

    service = get_pkm_service()
    await service.store_domain_data(user_id, domain, encrypted_blob, summary)
"""

import logging
from datetime import datetime
from typing import Any, Dict, List, Optional

from hushh_mcp.consent.token import validate_token_with_db
from hushh_mcp.constants import ConsentScope
from hushh_mcp.types import EncryptedPayload

logger = logging.getLogger(__name__)

# DEPRECATED: Domain to table mapping — EMPTY.
# All legacy vault_* tables (vault_food, vault_professional, vault_kai_preferences,
# vault_kai) have been removed.  Use PersonalKnowledgeModelService for all domain data.
DOMAIN_TABLES: dict[str, str] = {}

# DEPRECATED: Domain to scope mapping — EMPTY.
DOMAIN_READ_SCOPES: dict[str, list] = {}

DOMAIN_WRITE_SCOPES: dict[str, list] = {}


class ConsentValidationError(Exception):
    """Raised when consent validation fails."""

    def __init__(self, message: str, reason: str = "unknown"):
        super().__init__(message)
        self.reason = reason


class VaultDBService:
    """
    Unified database service for agent-mediated vault access.

    This service provides a single interface for all vault database operations,
    ensuring consistent consent validation and audit logging.
    """

    def __init__(self):
        self._supabase = None

    def _get_supabase(self):
        """Get database client (private - ONLY for internal service use)."""
        if self._supabase is None:
            from db.db_client import get_db

            self._supabase = get_db()
        return self._supabase

    async def _validate_consent(
        self,
        consent_token: str,
        user_id: str,
        required_scopes: List[ConsentScope],
        operation: str = "access",
    ) -> None:
        """
        Validate consent token for the requested operation.

        Args:
            consent_token: The HCT consent token
            user_id: The user ID making the request
            required_scopes: List of acceptable scopes (any match passes)
            operation: Description of the operation for logging

        Raises:
            ConsentValidationError: If validation fails
        """
        if not consent_token:
            raise ConsentValidationError(
                f"Missing consent token for {operation}", reason="missing_token"
            )

        # Validate token with DB revocation check
        valid, reason, token_obj = await validate_token_with_db(consent_token)

        if not valid:
            logger.warning(f"Invalid consent token for {operation}: {reason}")
            raise ConsentValidationError(f"Invalid consent token: {reason}", reason="invalid_token")

        # Check scope
        token_scope = (
            ConsentScope(token_obj.scope) if isinstance(token_obj.scope, str) else token_obj.scope
        )
        if token_scope not in required_scopes:
            logger.warning(
                f"Insufficient scope for {operation}: {token_scope} not in {required_scopes}"
            )
            raise ConsentValidationError(
                f"Insufficient scope: {token_scope}. Required one of: {required_scopes}",
                reason="insufficient_scope",
            )

        # Check user ID matches
        if token_obj.user_id != user_id:
            logger.warning(f"User ID mismatch for {operation}: {token_obj.user_id} != {user_id}")
            raise ConsentValidationError(
                "Token user ID does not match requested user ID", reason="user_mismatch"
            )

        logger.debug(f"✅ Consent validated for {operation} (user={user_id}, scope={token_scope})")

    async def _log_audit(
        self, user_id: str, action: str, domain: str, details: Optional[Dict[str, Any]] = None
    ) -> None:
        """Log operation to audit trail."""
        try:
            supabase = self._get_supabase()
            supabase.table("consent_audit").insert(
                {
                    "user_id": user_id,
                    "action": action,
                    "scope": f"vault.{domain}",
                    "scope_description": str(details) if details else None,
                    "issued_at": int(datetime.now().timestamp() * 1000),
                    "agent_id": "vault_service",
                }
            ).execute()
        except Exception as e:
            # Don't fail the operation if audit logging fails
            logger.error(f"Failed to log audit: {e}")

    # =========================================================================
    # Read Operations
    # =========================================================================

    async def get_encrypted_fields(
        self,
        user_id: str,
        domain: str,  # DEPRECATED: Use dynamic domains instead of fixed literals
        consent_token: str,
        field_names: Optional[List[str]] = None,
    ) -> Dict[str, EncryptedPayload]:
        """
        Retrieve encrypted fields from vault.

        Args:
            user_id: The user ID
            domain: The vault domain (food, professional, financial, etc.)
            consent_token: Valid consent token with read scope
            field_names: Optional list of specific fields to retrieve

        Returns:
            Dictionary mapping field names to encrypted payloads

        Raises:
            ConsentValidationError: If consent validation fails
        """
        # Validate consent
        await self._validate_consent(
            consent_token=consent_token,
            user_id=user_id,
            required_scopes=DOMAIN_READ_SCOPES.get(domain, [ConsentScope.VAULT_OWNER]),
            operation=f"read_{domain}",
        )

        table = DOMAIN_TABLES.get(domain)
        if not table:
            raise ValueError(f"Unknown domain: {domain}")

        supabase = self._get_supabase()

        # Build Supabase query
        query = (
            supabase.table(table)
            .select("field_name,ciphertext,iv,tag,algorithm")
            .eq("user_id", user_id)
        )

        if field_names:
            # Supabase doesn't support ANY() directly, so we use .in_() for array matching
            # Or filter in Python if needed
            response = query.execute()
            rows = [row for row in response.data if row.get("field_name") in field_names]
        else:
            response = query.execute()
            rows = response.data

        # Build result dictionary
        result = {}
        for row in rows:
            result[row["field_name"]] = EncryptedPayload(
                ciphertext=row["ciphertext"],
                iv=row["iv"],
                tag=row["tag"],
                algorithm=row.get("algorithm") or "aes-256-gcm",
                encoding="base64",
            )

        logger.info(f"✅ Retrieved {len(result)} fields from {domain} for {user_id}")

        # Log audit
        await self._log_audit(
            user_id=user_id, action="READ", domain=domain, details={"field_count": len(result)}
        )

        return result

    # =========================================================================
    # Write Operations
    # =========================================================================

    async def store_encrypted_field(
        self,
        user_id: str,
        domain: str,  # DEPRECATED: Use dynamic domains instead of fixed literals
        field_name: str,
        payload: EncryptedPayload,
        consent_token: str,
    ) -> bool:
        """
        Store an encrypted field in vault.

        Args:
            user_id: The user ID
            domain: The vault domain
            field_name: Name of the field to store
            payload: Encrypted payload (ciphertext, iv, tag)
            consent_token: Valid consent token with write scope

        Returns:
            True if stored successfully

        Raises:
            ConsentValidationError: If consent validation fails
        """
        # Validate consent
        await self._validate_consent(
            consent_token=consent_token,
            user_id=user_id,
            required_scopes=DOMAIN_WRITE_SCOPES.get(domain, [ConsentScope.VAULT_OWNER]),
            operation=f"write_{domain}",
        )

        table = DOMAIN_TABLES.get(domain)
        if not table:
            raise ValueError(f"Unknown domain: {domain}")

        supabase = self._get_supabase()

        # Upsert using Supabase (handles ON CONFLICT automatically)
        timestamp = int(datetime.now().timestamp() * 1000)
        data = {
            "user_id": user_id,
            "field_name": field_name,
            "ciphertext": payload.ciphertext,
            "iv": payload.iv,
            "tag": payload.tag,
            "algorithm": payload.algorithm,
            "created_at": timestamp,  # Required for new rows
            "updated_at": timestamp,
        }

        supabase.table(table).upsert(data, on_conflict="user_id,field_name").execute()

        logger.info(f"✅ Stored {field_name} in {domain} for {user_id}")

        # Log audit
        await self._log_audit(
            user_id=user_id, action="WRITE", domain=domain, details={"field_name": field_name}
        )

        return True

    async def store_encrypted_fields(
        self,
        user_id: str,
        domain: str,  # DEPRECATED: Use dynamic domains instead of fixed literals
        fields: Dict[str, EncryptedPayload],
        consent_token: str,
    ) -> int:
        """
        Store multiple encrypted fields in vault.

        Args:
            user_id: The user ID
            domain: The vault domain
            fields: Dictionary mapping field names to encrypted payloads
            consent_token: Valid consent token with write scope

        Returns:
            Number of fields stored

        Raises:
            ConsentValidationError: If consent validation fails
        """
        # Validate consent once for all fields
        await self._validate_consent(
            consent_token=consent_token,
            user_id=user_id,
            required_scopes=DOMAIN_WRITE_SCOPES.get(domain, [ConsentScope.VAULT_OWNER]),
            operation=f"write_{domain}",
        )

        table = DOMAIN_TABLES.get(domain)
        if not table:
            raise ValueError(f"Unknown domain: {domain}")

        supabase = self._get_supabase()

        # Batch upsert using Supabase (no transactions, but atomic per batch)
        timestamp = int(datetime.now().timestamp() * 1000)
        data = [
            {
                "user_id": user_id,
                "field_name": field_name,
                "ciphertext": payload.ciphertext,
                "iv": payload.iv,
                "tag": payload.tag,
                "algorithm": payload.algorithm,
                "created_at": timestamp,  # Required for new rows (schema has no default)
                "updated_at": timestamp,
            }
            for field_name, payload in fields.items()
        ]

        # Supabase handles batch upsert
        supabase.table(table).upsert(data, on_conflict="user_id,field_name").execute()

        stored_count = len(data)

        logger.info(f"✅ Stored {stored_count} fields in {domain} for {user_id}")

        # Log audit
        await self._log_audit(
            user_id=user_id,
            action="WRITE_BATCH",
            domain=domain,
            details={"field_count": stored_count, "fields": list(fields.keys())},
        )

        return stored_count

    # =========================================================================
    # Delete Operations
    # =========================================================================

    async def delete_encrypted_fields(
        self,
        user_id: str,
        domain: str,  # DEPRECATED: Use dynamic domains instead of fixed literals
        consent_token: str,
        field_names: Optional[List[str]] = None,
    ) -> int:
        """
        Delete encrypted fields from vault.

        Args:
            user_id: The user ID
            domain: The vault domain
            consent_token: Valid consent token with write scope
            field_names: Optional list of specific fields to delete (None = delete all)

        Returns:
            Number of fields deleted

        Raises:
            ConsentValidationError: If consent validation fails
        """
        # Validate consent (write scope required for deletion)
        await self._validate_consent(
            consent_token=consent_token,
            user_id=user_id,
            required_scopes=DOMAIN_WRITE_SCOPES.get(domain, [ConsentScope.VAULT_OWNER]),
            operation=f"delete_{domain}",
        )

        table = DOMAIN_TABLES.get(domain)
        if not table:
            raise ValueError(f"Unknown domain: {domain}")

        supabase = self._get_supabase()

        if field_names:
            # Delete specific fields - need to delete each one
            deleted_count = 0
            for field_name in field_names:
                response = (
                    supabase.table(table)
                    .delete()
                    .eq("user_id", user_id)
                    .eq("field_name", field_name)
                    .execute()
                )
                # Count deleted rows from response
                if response.data:
                    deleted_count += len(response.data)
                else:
                    # If no data returned, assume 1 if no error
                    deleted_count += 1
        else:
            # Delete all fields for user
            response = supabase.table(table).delete().eq("user_id", user_id).execute()
            # Supabase returns deleted data, count it
            deleted_count = len(response.data) if response.data else 0

        logger.info(f"✅ Deleted {deleted_count} fields from {domain} for {user_id}")

        # Log audit
        await self._log_audit(
            user_id=user_id,
            action="DELETE",
            domain=domain,
            details={"deleted_count": deleted_count, "fields": field_names},
        )

        return deleted_count

    # =========================================================================
    # Utility Methods
    # =========================================================================

    async def check_vault_exists(
        self,
        user_id: str,
        domain: str,  # Accept any domain, validate against DOMAIN_TABLES at runtime
    ) -> bool:
        """
        Check if user has any data in the specified vault domain.

        NOTE: This method is DEPRECATED. Use PersonalKnowledgeModelService.get_domain_data() or check PKM metadata instead.

        This does NOT require consent as it only checks existence,
        not the actual encrypted data.

        Args:
            user_id: User's ID
            domain: Domain key (validated against DOMAIN_TABLES)

        Returns:
            True if user has data in the domain, False otherwise

        Raises:
            ValueError: If domain is not in DOMAIN_TABLES
        """
        table = DOMAIN_TABLES.get(domain)
        if not table:
            raise ValueError(
                f"Unknown domain: {domain}. Valid domains: {list(DOMAIN_TABLES.keys())}"
            )

        supabase = self._get_supabase()

        # Check if any rows exist
        response = (
            supabase.table(table)
            .select("user_id", count="exact")
            .eq("user_id", user_id)
            .limit(1)
            .execute()
        )

        # Check if count is available or if data exists
        if hasattr(response, "count") and response.count is not None:
            return response.count > 0
        elif response.data:
            return len(response.data) > 0
        return False

    async def get_field_names(
        self,
        user_id: str,
        domain: str,  # DEPRECATED: Use dynamic domains instead of fixed literals
        consent_token: str,
    ) -> List[str]:
        """
        Get list of field names stored for a user in a domain.

        Requires read consent.
        """
        await self._validate_consent(
            consent_token=consent_token,
            user_id=user_id,
            required_scopes=DOMAIN_READ_SCOPES.get(domain, [ConsentScope.VAULT_OWNER]),
            operation=f"list_{domain}",
        )

        table = DOMAIN_TABLES.get(domain)
        if not table:
            raise ValueError(f"Unknown domain: {domain}")

        supabase = self._get_supabase()

        response = supabase.table(table).select("field_name").eq("user_id", user_id).execute()

        return [row["field_name"] for row in response.data]

    # =========================================================================
    # DEPRECATED Methods (for backwards compatibility only)
    # =========================================================================

    async def _get_domain_preferences_deprecated(
        self, user_id: str, domain: str
    ) -> Dict[str, Dict[str, str]]:
        """
        ⚠️ DEPRECATED: Get domain preferences WITHOUT consent validation.

        WARNING: This method exists ONLY for backwards compatibility with
        legacy mobile app routes that lack proper authentication.

        DO NOT use this method in new code. Use get_encrypted_fields() instead.

        This method will be REMOVED when the deprecated /db/ routes are removed.
        """
        import warnings

        warnings.warn(
            "Using deprecated _get_domain_preferences_deprecated without consent validation",
            DeprecationWarning,
            stacklevel=2,
        )

        table = DOMAIN_TABLES.get(domain)
        if not table:
            return {}

        supabase = self._get_supabase()

        response = (
            supabase.table(table)
            .select("field_name,ciphertext,iv,tag,algorithm")
            .eq("user_id", user_id)
            .execute()
        )

        if not response.data:
            return {}

        preferences = {}
        for row in response.data:
            preferences[row.get("field_name")] = {
                "ciphertext": row.get("ciphertext"),
                "iv": row.get("iv"),
                "tag": row.get("tag"),
                "algorithm": row.get("algorithm") or "aes-256-gcm",
                "encoding": "base64",
            }

        logger.warning(f"⚠️ DEPRECATED: Unauthenticated access to {domain} for {user_id}")
        return preferences
