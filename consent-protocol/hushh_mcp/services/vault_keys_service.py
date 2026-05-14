# hushh_mcp/services/vault_keys_service.py
"""
Vault Keys Service
==================

Service layer for vault_keys + vault_key_wrappers operations.

This service stores encrypted wrappers for the same vault DEK across enrolled
unlock methods (passphrase, biometric, passkey/PRF) plus recovery wrapper.
The backend never sees plaintext vault key material.
"""

from __future__ import annotations

import logging
import os
import time
from datetime import datetime
from typing import Any, Dict, Optional
from urllib.parse import urlparse

from sqlalchemy import text
from starlette.concurrency import run_in_threadpool

from db.db_client import get_db

logger = logging.getLogger(__name__)

ALLOWED_METHODS = {
    "passphrase",
    "generated_default_native_biometric",
    "generated_default_web_prf",
    "generated_default_native_passkey_prf",
}


class VaultKeysService:
    """Service layer for multi-wrapper vault key operations."""

    VAULT_STATE_CACHE_TTL_SECONDS = 180

    def __init__(self):
        self._supabase = None
        self._vault_state_cache: dict[str, tuple[float, Dict[str, Any]]] = {}

    def _get_supabase(self):
        """Get database client (private - ONLY for internal service use)."""
        if self._supabase is None:
            self._supabase = get_db()
        return self._supabase

    def _get_cached_vault_state(self, user_id: str) -> Optional[Dict[str, Any]]:
        cached = self._vault_state_cache.get(user_id)
        if not cached:
            return None
        cached_at, payload = cached
        if time.time() - cached_at > self.VAULT_STATE_CACHE_TTL_SECONDS:
            self._vault_state_cache.pop(user_id, None)
            return None
        return payload

    def _set_cached_vault_state(self, user_id: str, payload: Optional[Dict[str, Any]]) -> None:
        if payload is None:
            self._vault_state_cache.pop(user_id, None)
            return
        self._vault_state_cache[user_id] = (time.time(), payload)

    def _invalidate_vault_state_cache(self, user_id: str) -> None:
        self._vault_state_cache.pop(user_id, None)

    @staticmethod
    def _mask_user_id(user_id: str) -> str:
        if not user_id:
            return "<unknown>"
        if len(user_id) <= 8:
            return user_id
        return f"{user_id[:4]}...{user_id[-4:]}"

    @staticmethod
    def _clean_text(value: Optional[str], *, allow_none: bool = False) -> Optional[str]:
        if value is None:
            return None if allow_none else ""
        cleaned = value.strip()
        lowered = cleaned.lower()
        if lowered in {"", "null", "undefined", "none"}:
            return None if allow_none else ""
        return cleaned

    @staticmethod
    def _clean_base64ish(value: Optional[str], *, allow_none: bool = False) -> Optional[str]:
        text = VaultKeysService._clean_text(value, allow_none=allow_none)
        if text is None:
            return None
        return "".join(text.split())

    @staticmethod
    def _normalize_method(method: Optional[str]) -> str:
        normalized = (VaultKeysService._clean_text(method) or "").lower()
        if normalized not in ALLOWED_METHODS:
            raise ValueError(f"Unsupported vault method: {method}")
        return normalized

    @staticmethod
    def _normalize_wrapper_id(wrapper_id: Optional[str]) -> str:
        cleaned = VaultKeysService._clean_text(wrapper_id) or "default"
        normalized = cleaned.strip()
        if not normalized:
            return "default"
        return normalized

    @staticmethod
    def _is_passkey_method(method: str) -> bool:
        return method in {"generated_default_web_prf", "generated_default_native_passkey_prf"}

    @staticmethod
    def _normalize_vault_status(value: Optional[str]) -> str:
        normalized = (value or "").strip().lower()
        if normalized in {"placeholder", "active"}:
            return normalized
        return "active"

    @staticmethod
    def _normalize_bool_or_none(value: Any) -> Optional[bool]:
        if value is None:
            return None
        if isinstance(value, bool):
            return value
        if isinstance(value, (int, float)):
            return bool(value)
        if isinstance(value, str):
            lowered = value.strip().lower()
            if lowered in {"true", "1", "yes"}:
                return True
            if lowered in {"false", "0", "no"}:
                return False
        return None

    @staticmethod
    def _normalize_int_ms_or_none(value: Any) -> Optional[int]:
        if value is None:
            return None
        try:
            return int(value)
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _now_ms() -> int:
        return int(datetime.now().timestamp() * 1000)

    @classmethod
    def _serialize_user_entry(cls, row: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "userId": row.get("user_id"),
            "vaultStatus": cls._normalize_vault_status(row.get("vault_status")),
            "firstLoginAt": cls._normalize_int_ms_or_none(row.get("first_login_at")),
            "lastLoginAt": cls._normalize_int_ms_or_none(row.get("last_login_at")),
            "loginCount": int(row.get("login_count") or 0),
            "preOnboardingCompleted": cls._normalize_bool_or_none(
                row.get("pre_onboarding_completed")
            ),
            "preOnboardingSkipped": cls._normalize_bool_or_none(row.get("pre_onboarding_skipped")),
            "preOnboardingCompletedAt": cls._normalize_int_ms_or_none(
                row.get("pre_onboarding_completed_at")
            ),
            "preNavTourCompletedAt": cls._normalize_int_ms_or_none(
                row.get("pre_nav_tour_completed_at")
            ),
            "preNavTourSkippedAt": cls._normalize_int_ms_or_none(
                row.get("pre_nav_tour_skipped_at")
            ),
            "preStateUpdatedAt": cls._normalize_int_ms_or_none(row.get("pre_state_updated_at")),
            "createdAt": cls._normalize_int_ms_or_none(row.get("created_at")),
            "updatedAt": cls._normalize_int_ms_or_none(row.get("updated_at")),
        }

    async def ensure_user_entry(self, user_id: str) -> Dict[str, Any]:
        return await run_in_threadpool(self._ensure_user_entry_sync, user_id)

    def _ensure_user_entry_sync(self, user_id: str) -> Dict[str, Any]:
        """
        Ensure a vault_keys row exists for authenticated user presence tracking.

        New users get a placeholder row; existing rows update login markers.
        """
        user_id_clean = (user_id or "").strip()
        if not user_id_clean:
            raise ValueError("userId is required")

        supabase = self._get_supabase()
        now_ms = self._now_ms()

        existing_response = (
            supabase.table("vault_keys")
            .select(
                "user_id,vault_status,first_login_at,last_login_at,login_count,"
                "pre_onboarding_completed,pre_onboarding_skipped,pre_onboarding_completed_at,"
                "pre_nav_tour_completed_at,pre_nav_tour_skipped_at,pre_state_updated_at,"
                "created_at,updated_at"
            )
            .eq("user_id", user_id_clean)
            .limit(1)
            .execute()
        )

        if not existing_response.data:
            create_payload = {
                "user_id": user_id_clean,
                "vault_status": "placeholder",
                "vault_key_hash": None,
                "primary_method": "passphrase",
                "primary_wrapper_id": "default",
                "recovery_encrypted_vault_key": None,
                "recovery_salt": None,
                "recovery_iv": None,
                "first_login_at": now_ms,
                "last_login_at": now_ms,
                "login_count": 1,
                "created_at": now_ms,
                "updated_at": now_ms,
            }
            insert_result = supabase.table("vault_keys").insert(create_payload).execute()
            if not insert_result.data:
                # Race-safe fallback if another request inserted concurrently.
                existing_response = (
                    supabase.table("vault_keys")
                    .select(
                        "user_id,vault_status,first_login_at,last_login_at,login_count,"
                        "pre_onboarding_completed,pre_onboarding_skipped,pre_onboarding_completed_at,"
                        "pre_nav_tour_completed_at,pre_nav_tour_skipped_at,pre_state_updated_at,"
                        "created_at,updated_at"
                    )
                    .eq("user_id", user_id_clean)
                    .limit(1)
                    .execute()
                )
                if not existing_response.data:
                    raise RuntimeError("Failed to ensure user entry in vault_keys")
                row = existing_response.data[0]
                return self._serialize_user_entry(row)
            row = insert_result.data[0]
            return self._serialize_user_entry(row)

        current = existing_response.data[0]
        current_first_login = (
            self._normalize_int_ms_or_none(current.get("first_login_at")) or now_ms
        )
        current_login_count = int(current.get("login_count") or 0)
        update_payload = {
            "first_login_at": current_first_login,
            "last_login_at": now_ms,
            "login_count": current_login_count + 1,
            "updated_at": now_ms,
        }
        update_response = (
            supabase.table("vault_keys")
            .update(update_payload)
            .eq("user_id", user_id_clean)
            .execute()
        )
        if update_response.data:
            return self._serialize_user_entry(update_response.data[0])

        refreshed = (
            supabase.table("vault_keys")
            .select(
                "user_id,vault_status,first_login_at,last_login_at,login_count,"
                "pre_onboarding_completed,pre_onboarding_skipped,pre_onboarding_completed_at,"
                "pre_nav_tour_completed_at,pre_nav_tour_skipped_at,pre_state_updated_at,"
                "created_at,updated_at"
            )
            .eq("user_id", user_id_clean)
            .limit(1)
            .execute()
        )
        if not refreshed.data:
            raise RuntimeError("Failed to refresh user entry in vault_keys")
        return self._serialize_user_entry(refreshed.data[0])

    async def get_pre_vault_state(self, user_id: str) -> Dict[str, Any]:
        return await run_in_threadpool(self._get_pre_vault_state_sync, user_id)

    def _get_pre_vault_state_sync(self, user_id: str) -> Dict[str, Any]:
        """
        Return placeholder/active row metadata used for DB-first onboarding/tour gating.
        """
        state = self._ensure_user_entry_sync(user_id)
        return {
            "userId": state["userId"],
            "vaultStatus": state["vaultStatus"],
            "hasVault": state["vaultStatus"] == "active",
            "firstLoginAt": state["firstLoginAt"],
            "lastLoginAt": state["lastLoginAt"],
            "loginCount": state["loginCount"],
            "preOnboardingCompleted": state["preOnboardingCompleted"],
            "preOnboardingSkipped": state["preOnboardingSkipped"],
            "preOnboardingCompletedAt": state["preOnboardingCompletedAt"],
            "preNavTourCompletedAt": state["preNavTourCompletedAt"],
            "preNavTourSkippedAt": state["preNavTourSkippedAt"],
            "preStateUpdatedAt": state["preStateUpdatedAt"],
        }

    async def update_pre_vault_state(
        self,
        *,
        user_id: str,
        pre_onboarding_completed: Optional[bool] = None,
        pre_onboarding_skipped: Optional[bool] = None,
        pre_onboarding_completed_at: Optional[int] = None,
        pre_nav_tour_completed_at: Optional[int] = None,
        pre_nav_tour_skipped_at: Optional[int] = None,
    ) -> Dict[str, Any]:
        return await run_in_threadpool(
            self._update_pre_vault_state_sync,
            user_id,
            pre_onboarding_completed,
            pre_onboarding_skipped,
            pre_onboarding_completed_at,
            pre_nav_tour_completed_at,
            pre_nav_tour_skipped_at,
        )

    def _update_pre_vault_state_sync(
        self,
        user_id: str,
        pre_onboarding_completed: Optional[bool] = None,
        pre_onboarding_skipped: Optional[bool] = None,
        pre_onboarding_completed_at: Optional[int] = None,
        pre_nav_tour_completed_at: Optional[int] = None,
        pre_nav_tour_skipped_at: Optional[int] = None,
    ) -> Dict[str, Any]:
        """
        Persist DB-first pre-vault onboarding/tour markers with basic consistency checks.
        """
        current = self._ensure_user_entry_sync(user_id)
        user_id_clean = (user_id or "").strip()
        if not user_id_clean:
            raise ValueError("userId is required")

        next_completed = (
            pre_onboarding_completed
            if pre_onboarding_completed is not None
            else current["preOnboardingCompleted"]
        )
        next_skipped = (
            pre_onboarding_skipped
            if pre_onboarding_skipped is not None
            else current["preOnboardingSkipped"]
        )
        next_completed_at = (
            pre_onboarding_completed_at
            if pre_onboarding_completed_at is not None
            else current["preOnboardingCompletedAt"]
        )
        next_tour_completed_at = (
            pre_nav_tour_completed_at
            if pre_nav_tour_completed_at is not None
            else current["preNavTourCompletedAt"]
        )
        next_tour_skipped_at = (
            pre_nav_tour_skipped_at
            if pre_nav_tour_skipped_at is not None
            else current["preNavTourSkippedAt"]
        )

        if next_skipped is True and next_completed is not True:
            raise ValueError("pre_onboarding_skipped requires pre_onboarding_completed")
        if next_completed_at is not None and next_completed is not True:
            raise ValueError("pre_onboarding_completed_at requires pre_onboarding_completed=true")
        if next_tour_completed_at is not None and next_tour_skipped_at is not None:
            raise ValueError(
                "pre_nav_tour_completed_at and pre_nav_tour_skipped_at are mutually exclusive"
            )

        now_ms = self._now_ms()
        supabase = self._get_supabase()
        update_payload = {
            "pre_onboarding_completed": next_completed,
            "pre_onboarding_skipped": next_skipped,
            "pre_onboarding_completed_at": next_completed_at,
            "pre_nav_tour_completed_at": next_tour_completed_at,
            "pre_nav_tour_skipped_at": next_tour_skipped_at,
            "pre_state_updated_at": now_ms,
            "updated_at": now_ms,
        }
        updated = (
            supabase.table("vault_keys")
            .update(update_payload)
            .eq("user_id", user_id_clean)
            .execute()
        )
        if not updated.data:
            raise RuntimeError("Failed to update pre-vault state")
        return self._serialize_user_entry(updated.data[0])

    @staticmethod
    def _get_allowed_passkey_rp_ids() -> set[str]:
        # Always allow localhost variants for local tooling and tests.
        allowed = {"localhost", "127.0.0.1"}

        def normalize_host(raw: Optional[str]) -> Optional[str]:
            cleaned = (raw or "").strip().lower()
            if not cleaned:
                return None
            try:
                if "://" in cleaned:
                    parsed = urlparse(cleaned)
                    host = (parsed.hostname or "").strip().lower()
                else:
                    host = cleaned.split("/")[0].split(":")[0].strip().lower()
            except Exception:
                return None
            if not host:
                return None
            if host == "127.0.0.1":
                return "localhost"
            return host

        def collect_from_csv(raw: Optional[str]) -> set[str]:
            hosts: set[str] = set()
            for item in (raw or "").split(","):
                host = normalize_host(item)
                if host:
                    hosts.add(host)
            return hosts

        configured = (os.getenv("PASSKEY_ALLOWED_RP_IDS") or "").strip()
        if configured:
            allowed.update(collect_from_csv(configured))
            return allowed

        # If explicit RP IDs are not configured, derive from frontend/CORS settings
        # so domain migrations (run.app <-> custom domain) remain functional.
        from hushh_mcp.runtime_settings import get_app_runtime_settings

        allowed.update(collect_from_csv(get_app_runtime_settings().app_frontend_origin))
        allowed.update(collect_from_csv(os.getenv("CORS_ALLOWED_ORIGINS")))

        # Keep legacy production fallback for older deployments that only use defaults.
        allowed.add("hushh-webapp-1006304528804.us-central1.run.app")
        return allowed

    @classmethod
    def _normalize_wrapper(cls, wrapper: Dict[str, Any]) -> Dict[str, Any]:
        method = cls._normalize_method(wrapper.get("method"))
        wrapper_id = cls._normalize_wrapper_id(
            wrapper.get("wrapperId") or wrapper.get("wrapper_id")
        )
        encrypted_vault_key = (
            cls._clean_base64ish(
                wrapper.get("encryptedVaultKey") or wrapper.get("encrypted_vault_key")
            )
            or ""
        )
        salt = cls._clean_base64ish(wrapper.get("salt")) or ""
        iv = cls._clean_base64ish(wrapper.get("iv")) or ""

        if not encrypted_vault_key or not salt or not iv:
            raise ValueError(f"Wrapper for method '{method}' is missing required ciphertext fields")

        passkey_credential_id = cls._clean_text(
            wrapper.get("passkeyCredentialId") or wrapper.get("passkey_credential_id"),
            allow_none=True,
        )
        passkey_prf_salt = cls._clean_base64ish(
            wrapper.get("passkeyPrfSalt") or wrapper.get("passkey_prf_salt"),
            allow_none=True,
        )
        passkey_rp_id = cls._clean_text(
            wrapper.get("passkeyRpId") or wrapper.get("passkey_rp_id"), allow_none=True
        )
        passkey_provider = cls._clean_text(
            wrapper.get("passkeyProvider") or wrapper.get("passkey_provider"),
            allow_none=True,
        )
        passkey_device_label = cls._clean_text(
            wrapper.get("passkeyDeviceLabel") or wrapper.get("passkey_device_label"),
            allow_none=True,
        )
        passkey_last_used_at_raw = wrapper.get("passkeyLastUsedAt") or wrapper.get(
            "passkey_last_used_at"
        )
        passkey_last_used_at: Optional[int] = None
        if passkey_last_used_at_raw is not None:
            try:
                passkey_last_used_at = int(passkey_last_used_at_raw)
            except (TypeError, ValueError) as exc:
                raise ValueError("passkeyLastUsedAt must be an integer timestamp") from exc

        if cls._is_passkey_method(method) and (
            not passkey_credential_id or not passkey_prf_salt or not passkey_rp_id
        ):
            raise ValueError(
                f"{method} wrapper requires passkey credential metadata including rp id"
            )
        if cls._is_passkey_method(method):
            allowed_rps = cls._get_allowed_passkey_rp_ids()
            if allowed_rps and (passkey_rp_id or "").lower() not in allowed_rps:
                raise ValueError(f"{method} wrapper rp id is not allowed for this environment")

        return {
            "method": method,
            "wrapper_id": wrapper_id,
            "encrypted_vault_key": encrypted_vault_key,
            "salt": salt,
            "iv": iv,
            "passkey_credential_id": passkey_credential_id,
            "passkey_prf_salt": passkey_prf_salt,
            "passkey_rp_id": passkey_rp_id,
            "passkey_provider": passkey_provider,
            "passkey_device_label": passkey_device_label,
            "passkey_last_used_at": passkey_last_used_at,
        }

    async def check_vault_exists(self, user_id: str, *, ensure_entry: bool = True) -> bool:
        return await run_in_threadpool(self._check_vault_exists_sync, user_id, ensure_entry)

    def _check_vault_exists_sync(self, user_id: str, ensure_entry: bool = True) -> bool:
        """Check if a vault exists for the user."""
        if ensure_entry:
            state = self._ensure_user_entry_sync(user_id)
            status = state["vaultStatus"]
        else:
            supabase = self._get_supabase()
            header = (
                supabase.table("vault_keys")
                .select("vault_status")
                .eq("user_id", user_id)
                .limit(1)
                .execute()
            )
            if not header.data:
                return False
            status = self._normalize_vault_status(header.data[0].get("vault_status"))

        if status != "active":
            return False

        supabase = self._get_supabase()
        passphrase_wrapper = (
            supabase.table("vault_key_wrappers")
            .select("user_id")
            .eq("user_id", user_id)
            .eq("method", "passphrase")
            .limit(1)
            .execute()
        )
        return bool(passphrase_wrapper.data)

    async def get_vault_state(self, user_id: str) -> Optional[Dict[str, Any]]:
        """Return vault state with recovery wrapper and all enrolled method wrappers."""
        cached = self._get_cached_vault_state(user_id)
        if cached is not None:
            return cached

        supabase = self._get_supabase()

        header_response = (
            supabase.table("vault_keys")
            .select(
                "vault_status,vault_key_hash,primary_method,primary_wrapper_id,"
                "recovery_encrypted_vault_key,recovery_salt,recovery_iv"
            )
            .eq("user_id", user_id)
            .limit(1)
            .execute()
        )

        if not header_response.data or len(header_response.data) == 0:
            self._set_cached_vault_state(user_id, None)
            return None

        header = header_response.data[0]
        if self._normalize_vault_status(header.get("vault_status")) != "active":
            self._set_cached_vault_state(user_id, None)
            return None

        wrapper_response = (
            supabase.table("vault_key_wrappers")
            .select(
                "method,wrapper_id,encrypted_vault_key,salt,iv,passkey_credential_id,passkey_prf_salt,passkey_rp_id,passkey_provider,passkey_device_label,passkey_last_used_at"
            )
            .eq("user_id", user_id)
            .execute()
        )

        wrappers: list[dict[str, Any]] = []
        for row in wrapper_response.data or []:
            wrappers.append(
                {
                    "method": self._clean_text(row.get("method")) or "passphrase",
                    "wrapperId": self._normalize_wrapper_id(
                        self._clean_text(row.get("wrapper_id"), allow_none=True)
                    ),
                    "encryptedVaultKey": self._clean_base64ish(row.get("encrypted_vault_key"))
                    or "",
                    "salt": self._clean_base64ish(row.get("salt")) or "",
                    "iv": self._clean_base64ish(row.get("iv")) or "",
                    "passkeyCredentialId": self._clean_text(
                        row.get("passkey_credential_id"), allow_none=True
                    ),
                    "passkeyPrfSalt": self._clean_base64ish(
                        row.get("passkey_prf_salt"), allow_none=True
                    ),
                    "passkeyRpId": self._clean_text(row.get("passkey_rp_id"), allow_none=True),
                    "passkeyProvider": self._clean_text(
                        row.get("passkey_provider"), allow_none=True
                    ),
                    "passkeyDeviceLabel": self._clean_text(
                        row.get("passkey_device_label"), allow_none=True
                    ),
                    "passkeyLastUsedAt": row.get("passkey_last_used_at"),
                }
            )

        wrappers.sort(key=lambda item: (item["method"], item.get("wrapperId") or "default"))

        payload = {
            "vaultKeyHash": self._clean_base64ish(header.get("vault_key_hash")) or "",
            "primaryMethod": self._clean_text(header.get("primary_method")) or "passphrase",
            "primaryWrapperId": self._normalize_wrapper_id(
                self._clean_text(header.get("primary_wrapper_id"), allow_none=True)
            ),
            "recoveryEncryptedVaultKey": self._clean_base64ish(
                header.get("recovery_encrypted_vault_key")
            )
            or "",
            "recoverySalt": self._clean_base64ish(header.get("recovery_salt")) or "",
            "recoveryIv": self._clean_base64ish(header.get("recovery_iv")) or "",
            "wrappers": wrappers,
        }
        self._set_cached_vault_state(user_id, payload)
        return payload

    async def setup_vault_state(
        self,
        *,
        user_id: str,
        vault_key_hash: str,
        primary_method: str,
        recovery_encrypted_vault_key: str,
        recovery_salt: str,
        recovery_iv: str,
        wrappers: list[dict[str, Any]],
        primary_wrapper_id: Optional[str] = None,
    ) -> bool:
        """Create/update vault state atomically by replacing wrappers in one DB transaction."""
        supabase = self._get_supabase()

        user_id_clean = (user_id or "").strip()
        if not user_id_clean:
            raise ValueError("userId is required")

        vault_key_hash_clean = self._clean_base64ish(vault_key_hash) or ""
        if not vault_key_hash_clean:
            raise ValueError("vaultKeyHash is required")

        primary = self._normalize_method(primary_method)
        primary_wrapper = self._normalize_wrapper_id(primary_wrapper_id)

        normalized_wrappers = [self._normalize_wrapper(wrapper) for wrapper in wrappers]
        if not normalized_wrappers:
            raise ValueError("At least one wrapper is required")

        methods = [wrapper["method"] for wrapper in normalized_wrappers]
        unique_methods = set(methods)
        wrapper_keys = {
            (wrapper["method"], wrapper["wrapper_id"]) for wrapper in normalized_wrappers
        }
        if len(wrapper_keys) != len(normalized_wrappers):
            raise ValueError("Duplicate wrapper method + wrapperId pairs are not allowed")

        if "passphrase" not in unique_methods:
            raise ValueError("Passphrase wrapper is mandatory")

        primary_wrapper_exists = any(
            wrapper["method"] == primary and wrapper["wrapper_id"] == primary_wrapper
            for wrapper in normalized_wrappers
        )
        if not primary_wrapper_exists:
            raise ValueError("primaryMethod + primaryWrapperId must be present in wrappers")

        recovery_encrypted = self._clean_base64ish(recovery_encrypted_vault_key) or ""
        recovery_salt_clean = self._clean_base64ish(recovery_salt) or ""
        recovery_iv_clean = self._clean_base64ish(recovery_iv) or ""
        if not recovery_encrypted or not recovery_salt_clean or not recovery_iv_clean:
            raise ValueError("Recovery wrapper fields are required")

        now_ms = int(datetime.now().timestamp() * 1000)

        key_data = {
            "user_id": user_id_clean,
            "vault_status": "active",
            "vault_key_hash": vault_key_hash_clean,
            "primary_method": primary,
            "primary_wrapper_id": primary_wrapper,
            "recovery_encrypted_vault_key": recovery_encrypted,
            "recovery_salt": recovery_salt_clean,
            "recovery_iv": recovery_iv_clean,
            "first_login_at": now_ms,
            "last_login_at": now_ms,
            "login_count": 1,
            "created_at": now_ms,
            "updated_at": now_ms,
        }
        wrapper_rows = [
            {
                "user_id": user_id_clean,
                "method": wrapper["method"],
                "wrapper_id": wrapper["wrapper_id"],
                "encrypted_vault_key": wrapper["encrypted_vault_key"],
                "salt": wrapper["salt"],
                "iv": wrapper["iv"],
                "passkey_credential_id": wrapper["passkey_credential_id"],
                "passkey_prf_salt": wrapper["passkey_prf_salt"],
                "passkey_rp_id": wrapper["passkey_rp_id"],
                "passkey_provider": wrapper["passkey_provider"],
                "passkey_device_label": wrapper["passkey_device_label"],
                "passkey_last_used_at": wrapper["passkey_last_used_at"],
                "created_at": now_ms,
                "updated_at": now_ms,
            }
            for wrapper in normalized_wrappers
        ]

        with supabase.engine.begin() as conn:
            upsert_key_result = conn.execute(
                text(
                    """
                    INSERT INTO vault_keys (
                        user_id,
                        vault_status,
                        vault_key_hash,
                        primary_method,
                        primary_wrapper_id,
                        recovery_encrypted_vault_key,
                        recovery_salt,
                        recovery_iv,
                        first_login_at,
                        last_login_at,
                        login_count,
                        created_at,
                        updated_at
                    )
                    VALUES (
                        :user_id,
                        :vault_status,
                        :vault_key_hash,
                        :primary_method,
                        :primary_wrapper_id,
                        :recovery_encrypted_vault_key,
                        :recovery_salt,
                        :recovery_iv,
                        :first_login_at,
                        :last_login_at,
                        :login_count,
                        :created_at,
                        :updated_at
                    )
                    ON CONFLICT (user_id) DO UPDATE SET
                        vault_status = 'active',
                        vault_key_hash = EXCLUDED.vault_key_hash,
                        primary_method = EXCLUDED.primary_method,
                        primary_wrapper_id = EXCLUDED.primary_wrapper_id,
                        recovery_encrypted_vault_key = EXCLUDED.recovery_encrypted_vault_key,
                        recovery_salt = EXCLUDED.recovery_salt,
                        recovery_iv = EXCLUDED.recovery_iv,
                        updated_at = EXCLUDED.updated_at
                    RETURNING user_id
                    """
                ),
                key_data,
            )
            if upsert_key_result.fetchone() is None:
                raise RuntimeError("Failed to upsert vault_keys row.")

            conn.execute(
                text("DELETE FROM vault_key_wrappers WHERE user_id = :user_id"),
                {"user_id": user_id_clean},
            )

            inserted_wrapper_count = 0
            for row in wrapper_rows:
                wrapper_result = conn.execute(
                    text(
                        """
                        INSERT INTO vault_key_wrappers (
                            user_id,
                            method,
                            wrapper_id,
                            encrypted_vault_key,
                            salt,
                            iv,
                            passkey_credential_id,
                            passkey_prf_salt,
                            passkey_rp_id,
                            passkey_provider,
                            passkey_device_label,
                            passkey_last_used_at,
                            created_at,
                            updated_at
                        )
                        VALUES (
                            :user_id,
                            :method,
                            :wrapper_id,
                            :encrypted_vault_key,
                            :salt,
                            :iv,
                            :passkey_credential_id,
                            :passkey_prf_salt,
                            :passkey_rp_id,
                            :passkey_provider,
                            :passkey_device_label,
                            :passkey_last_used_at,
                            :created_at,
                            :updated_at
                        )
                        ON CONFLICT (user_id, method, wrapper_id) DO UPDATE SET
                            encrypted_vault_key = EXCLUDED.encrypted_vault_key,
                            salt = EXCLUDED.salt,
                            iv = EXCLUDED.iv,
                            passkey_credential_id = EXCLUDED.passkey_credential_id,
                            passkey_prf_salt = EXCLUDED.passkey_prf_salt,
                            passkey_rp_id = EXCLUDED.passkey_rp_id,
                            passkey_provider = EXCLUDED.passkey_provider,
                            passkey_device_label = EXCLUDED.passkey_device_label,
                            passkey_last_used_at = EXCLUDED.passkey_last_used_at,
                            updated_at = EXCLUDED.updated_at
                        RETURNING method
                        """
                    ),
                    row,
                )
                if wrapper_result.fetchone() is None:
                    raise RuntimeError(f"Failed to insert wrapper method '{row['method']}'.")
                inserted_wrapper_count += 1

            if inserted_wrapper_count != len(wrapper_rows):
                raise RuntimeError(
                    "Inserted wrapper count mismatch "
                    f"({inserted_wrapper_count}/{len(wrapper_rows)})."
                )

        logger.info(
            "✅ Vault state setup for user %s (%s wrappers)",
            self._mask_user_id(user_id_clean),
            len(wrapper_rows),
        )
        self._invalidate_vault_state_cache(user_id_clean)
        return True

    async def upsert_wrapper(
        self,
        *,
        user_id: str,
        vault_key_hash: str,
        method: str,
        encrypted_vault_key: str,
        salt: str,
        iv: str,
        wrapper_id: Optional[str] = None,
        passkey_credential_id: Optional[str] = None,
        passkey_prf_salt: Optional[str] = None,
        passkey_rp_id: Optional[str] = None,
        passkey_provider: Optional[str] = None,
        passkey_device_label: Optional[str] = None,
        passkey_last_used_at: Optional[int] = None,
    ) -> bool:
        """Add or update a single wrapper for an existing vault state."""
        supabase = self._get_supabase()

        user_id_clean = (user_id or "").strip()
        if not user_id_clean:
            raise ValueError("userId is required")

        method_norm = self._normalize_method(method)
        vault_key_hash_clean = self._clean_base64ish(vault_key_hash) or ""
        if not vault_key_hash_clean:
            raise ValueError("vaultKeyHash is required")

        existing = (
            supabase.table("vault_keys")
            .select("vault_key_hash")
            .eq("user_id", user_id_clean)
            .limit(1)
            .execute()
        )
        if not existing.data:
            raise ValueError("Vault not found")

        existing_hash = self._clean_base64ish(existing.data[0].get("vault_key_hash")) or ""
        if existing_hash != vault_key_hash_clean:
            raise ValueError("vaultKeyHash mismatch")

        wrapper = self._normalize_wrapper(
            {
                "method": method_norm,
                "wrapperId": wrapper_id,
                "encryptedVaultKey": encrypted_vault_key,
                "salt": salt,
                "iv": iv,
                "passkeyCredentialId": passkey_credential_id,
                "passkeyPrfSalt": passkey_prf_salt,
                "passkeyRpId": passkey_rp_id,
                "passkeyProvider": passkey_provider,
                "passkeyDeviceLabel": passkey_device_label,
                "passkeyLastUsedAt": passkey_last_used_at,
            }
        )
        now_ms = int(datetime.now().timestamp() * 1000)

        data = {
            "user_id": user_id_clean,
            "method": wrapper["method"],
            "wrapper_id": wrapper["wrapper_id"],
            "encrypted_vault_key": wrapper["encrypted_vault_key"],
            "salt": wrapper["salt"],
            "iv": wrapper["iv"],
            "passkey_credential_id": wrapper["passkey_credential_id"],
            "passkey_prf_salt": wrapper["passkey_prf_salt"],
            "passkey_rp_id": wrapper["passkey_rp_id"],
            "passkey_provider": wrapper["passkey_provider"],
            "passkey_device_label": wrapper["passkey_device_label"],
            "passkey_last_used_at": wrapper["passkey_last_used_at"],
            "created_at": now_ms,
            "updated_at": now_ms,
        }

        upsert_result = (
            supabase.table("vault_key_wrappers")
            .upsert(data, on_conflict="user_id,method,wrapper_id")
            .execute()
        )
        if not upsert_result.data:
            raise RuntimeError(f"Wrapper upsert returned no rows for method '{method_norm}'.")

        logger.info(
            "✅ Upserted wrapper '%s' for user %s",
            method_norm,
            self._mask_user_id(user_id_clean),
        )
        self._invalidate_vault_state_cache(user_id_clean)
        return True

    async def set_primary_method(
        self,
        *,
        user_id: str,
        primary_method: str,
        primary_wrapper_id: Optional[str] = None,
    ) -> bool:
        """Set default unlock method for UX prompt among enrolled wrappers."""
        supabase = self._get_supabase()
        user_id_clean = (user_id or "").strip()
        if not user_id_clean:
            raise ValueError("userId is required")

        primary = self._normalize_method(primary_method)
        primary_wrapper = self._normalize_wrapper_id(primary_wrapper_id)

        wrapper_response = (
            supabase.table("vault_key_wrappers")
            .select("method,wrapper_id")
            .eq("user_id", user_id_clean)
            .eq("method", primary)
            .eq("wrapper_id", primary_wrapper)
            .limit(1)
            .execute()
        )
        if not wrapper_response.data:
            raise ValueError("Primary method/wrapper must be an enrolled wrapper")

        now_ms = int(datetime.now().timestamp() * 1000)
        update_result = (
            supabase.table("vault_keys")
            .update(
                {
                    "primary_method": primary,
                    "primary_wrapper_id": primary_wrapper,
                    "updated_at": now_ms,
                }
            )
            .eq("user_id", user_id_clean)
            .execute()
        )
        if not update_result.data:
            raise RuntimeError("Failed to set primary method; no vault row updated.")

        logger.info(
            "✅ Set primary method '%s' for user %s",
            primary,
            self._mask_user_id(user_id_clean),
        )
        self._invalidate_vault_state_cache(user_id_clean)
        return True

    async def get_vault_status(self, user_id: str, consent_token: str) -> Dict[str, Any]:
        """Get status for all vault domains."""
        # Validate consent token
        from hushh_mcp.consent.token import validate_token
        from hushh_mcp.constants import ConsentScope

        valid, reason, token_obj = validate_token(consent_token)

        if not valid:
            raise ValueError(f"Invalid consent token: {reason}")

        if token_obj.scope != ConsentScope.VAULT_OWNER.value:
            raise ValueError(f"VAULT_OWNER scope required, got: {token_obj.scope}")

        if token_obj.user_id != user_id:
            raise ValueError("Token user_id does not match requested user_id")

        supabase = self._get_supabase()

        kai_has_data = False
        kai_field_count = 0
        try:
            wm_response = (
                supabase.table("pkm_index")
                .select("domain_summaries")
                .eq("user_id", user_id)
                .limit(1)
                .execute()
            )
            if wm_response.data:
                summaries = wm_response.data[0].get("domain_summaries") or {}
                kai_has_data = "financial" in summaries
                prefs_summary = summaries.get("financial", {})
                kai_field_count = (
                    prefs_summary.get("field_count", 0) if isinstance(prefs_summary, dict) else 0
                )
        except Exception as e:  # pragma: no cover
            logger.warning(f"Failed to check pkm_index for vault status: {e}")

        domains = {
            "kai": {
                "hasData": kai_has_data,
                "onboarded": kai_has_data,
                "fieldCount": kai_field_count,
            }
        }

        total_active = 1 if kai_has_data else 0
        total = 1

        logger.info(f"✅ Vault status for {user_id}: {total_active}/{total} domains active")

        return {"domains": domains, "totalActive": total_active, "total": total}
