from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import re
import secrets
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, Any, Iterable

if TYPE_CHECKING:
    from hushh_mcp.services.phone_transfer_service import ConfirmedTransfer

import asyncpg

from api.utils.firebase_admin import get_firebase_auth_app
from db.connection import get_pool
from hushh_mcp.runtime_settings import (
    personal_agent_enabled,
)
from hushh_mcp.services import account_firebase_mutations
from hushh_mcp.services.account_generation_service import AccountGenerationService
from hushh_mcp.services.phone_holder_release import deleted_full_account_holders

logger = logging.getLogger(__name__)

_IDENTITY_STALE_AFTER = timedelta(hours=24)
_IDENTITY_SYNC_COOLDOWN = timedelta(minutes=5)
_IDENTITY_SYNC_TASKS: dict[str, asyncio.Task[dict[str, Any] | None]] = {}
_IDENTITY_SYNC_IN_FLIGHT: dict[str, asyncio.Future[dict[str, Any] | None]] = {}
_IDENTITY_SYNC_COOLDOWN_UNTIL: dict[str, datetime] = {}
# In-flight personal-agent provisioning kickoffs, deduped per user (phone-verify seam).
_PERSONAL_AGENT_PROVISION_TASKS: dict[str, asyncio.Task[None]] = {}
_ALIAS_CODE_PATTERN = re.compile(r"\s+")

# A verification code must not outlive the sitting; same 15 minutes the claim
# ticket uses. Codes were previously valid forever.
_ALIAS_VERIFICATION_TTL_SECONDS = 15 * 60


def resolve_firebase_email(user_record: Any) -> str | None:
    """The best email Firebase knows for this account.

    The identity shadow used to read `user_record.email` and nothing else, so
    an account whose top-level email was empty was cached with no address at
    all. That is not an edge case here: people sign in with Google, with Apple,
    and with a phone number, and only the first reliably populates the
    top-level field.

    - Apple, especially with Hide My Email, frequently leaves the top-level
      email empty while the provider entry carries the relay address.
    - A phone-first account that later links Google has the address on the
      provider entry before the top-level field catches up.

    Every downstream feature that needs to reach someone by email inherited
    that blank -- including the Save my Soul alert, which silently skipped any
    contact with no address and reported "Emailed 0" without saying why.

    Order: the top-level field, then Google, then Apple, then any provider that
    has one. Providers are only consulted when the field above is empty, so a
    verified top-level address always wins.

    Returns None when the account genuinely has no email anywhere -- a
    phone-only signup. That case is real and cannot be papered over; the caller
    has to handle "this person is not reachable by mail".
    """
    direct = str(getattr(user_record, "email", "") or "").strip()
    if direct:
        return direct

    providers = getattr(user_record, "provider_data", None) or []
    by_provider: dict[str, str] = {}
    for entry in providers:
        email = str(getattr(entry, "email", "") or "").strip()
        if not email or "@" not in email:
            continue
        provider_id = str(getattr(entry, "provider_id", "") or "").strip().lower()
        by_provider.setdefault(provider_id, email)

    for provider_id in ("google.com", "apple.com"):
        if by_provider.get(provider_id):
            return by_provider[provider_id]

    for email in by_provider.values():
        return email
    return None


class ActorIdentityAliasError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        code: str = "ACTOR_IDENTITY_ALIAS_ERROR",
        status_code: int = 400,
    ) -> None:
        self.code = code
        self.status_code = status_code
        super().__init__(message)


class ActorIdentityPhoneClaimConflictError(RuntimeError):
    """A test or metadata claim cannot displace a verified phone owner."""


class ActorIdentitySyncUnavailableError(RuntimeError):
    """Provider or persistence failure is not evidence of an unverified phone."""

    code = "CONTACT_SYNC_IDENTITY_UNAVAILABLE"
    status_code = 503
    message = "Account verification is temporarily unavailable. Please try syncing again."

    def __init__(self) -> None:
        super().__init__(self.message)


class ActorIdentityService:
    @staticmethod
    async def _ensure_actor_spine(conn: asyncpg.Connection, user_id: str) -> None:
        """Create the FK parents required by the identity cache atomically.

        Authenticated users can legitimately exist before they create a vault.
        Migration 019 defines a crypto-empty placeholder row for that state;
        actor_profiles and actor_identity_cache must still follow the canonical
        vault -> profile -> identity FK order.
        """

        now_ms = int(datetime.now(tz=timezone.utc).timestamp() * 1000)
        await conn.execute(
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
              $1,
              'placeholder',
              NULL,
              'passphrase',
              'default',
              NULL,
              NULL,
              NULL,
              $2,
              $2,
              1,
              $2,
              $2
            )
            ON CONFLICT (user_id) DO NOTHING
            """,
            user_id,
            now_ms,
        )
        await conn.execute(
            """
            INSERT INTO actor_profiles (
              user_id,
              personas,
              last_active_persona,
              investor_marketplace_opt_in,
              created_at,
              updated_at
            )
            VALUES (
              $1,
              ARRAY['investor']::text[],
              'investor',
              FALSE,
              NOW(),
              NOW()
            )
            ON CONFLICT (user_id) DO NOTHING
            """,
            user_id,
        )

    @staticmethod
    async def _lock_and_clear_verified_phone_binding(
        conn: asyncpg.Connection,
        *,
        user_id: str,
        phone_number: str,
        allow_owner_transfer: bool = True,
        release_deleted_holders: bool = True,
    ) -> bool:
        """Serialize one verified-phone owner transfer inside its transaction.

        The advisory lock closes the empty-set race where two first claims can
        both observe no prior owner. The ordered row lock also prevents two
        users swapping numbers concurrently from locking each other's identity
        rows in opposite order. Every verified-phone writer in this service
        must use this seam before its identity upsert.
        """

        await conn.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
            f"actor_identity_phone_claim:{phone_number}",
        )
        if not allow_owner_transfer:
            # Background provider hydration is not a new OTP possession claim.
            # Recheck under the same lock used by explicit claims, including
            # claims committed after the Firebase request began.
            bindings = await conn.fetch(
                """
                SELECT user_id, phone_number, phone_verified
                FROM actor_identity_cache
                WHERE user_id = $1 OR phone_number = $2
                ORDER BY user_id
                FOR UPDATE
                """,
                user_id,
                phone_number,
            )
            # An explicit OTP claim is not blocked by a holder whose full-account
            # deletion is admitted; the UPDATE below detaches that dead binding.
            holders = {
                binding["user_id"]
                for binding in bindings
                if binding["user_id"] != user_id
                and binding["phone_number"] == phone_number
                and binding["phone_verified"] is True
            }
            if holders and (
                not release_deleted_holders
                or holders - await deleted_full_account_holders(conn, holders)
            ):
                return False
        await conn.execute(
            """
            WITH locked_bindings AS MATERIALIZED (
              SELECT user_id
              FROM actor_identity_cache
              WHERE user_id = $1 OR phone_number = $2
              ORDER BY user_id
              FOR UPDATE
            )
            UPDATE actor_identity_cache AS identity
            SET
              phone_number = NULL,
              phone_verified = FALSE,
              updated_at = NOW()
            FROM locked_bindings
            WHERE identity.user_id = locked_bindings.user_id
              AND identity.phone_number = $2
              AND identity.user_id <> $1
            """,
            user_id,
            phone_number,
        )
        return True

    async def sync_from_firebase_if_due(
        self,
        user_id: str,
        *,
        force: bool = False,
    ) -> dict[str, Any] | None:
        """Await one lifecycle-bound, cooldown-aware Firebase refresh.

        Authentication attaches this call to Starlette's response background
        lifecycle, so the first caller performs the refresh directly instead
        of spawning work that Cloud Run may freeze. Concurrent callers await
        the same completion future, and a recently successful refresh skips
        even the cache query. Failures clear the cooldown for a later retry.
        """

        normalized_user_id = str(user_id or "").strip()
        if not normalized_user_id or not self._looks_like_firebase_uid(normalized_user_id):
            return None

        scheduled = _IDENTITY_SYNC_TASKS.get(normalized_user_id)
        if scheduled and not scheduled.done():
            return await asyncio.shield(scheduled)

        existing = _IDENTITY_SYNC_IN_FLIGHT.get(normalized_user_id)
        if existing and not existing.done():
            return await asyncio.shield(existing)

        now = datetime.now(timezone.utc)
        cooldown_until = _IDENTITY_SYNC_COOLDOWN_UNTIL.get(normalized_user_id)
        if not force and cooldown_until and cooldown_until > now:
            return None

        loop = asyncio.get_running_loop()
        completion: asyncio.Future[dict[str, Any] | None] = loop.create_future()
        _IDENTITY_SYNC_IN_FLIGHT[normalized_user_id] = completion
        _IDENTITY_SYNC_COOLDOWN_UNTIL[normalized_user_id] = now + _IDENTITY_SYNC_COOLDOWN

        try:
            result = await self.sync_from_firebase(normalized_user_id, force=force)
        except BaseException:
            _IDENTITY_SYNC_COOLDOWN_UNTIL.pop(normalized_user_id, None)
            if not completion.done():
                # Waiters only need to know that no refresh landed; the owner
                # still receives the original cancellation/error below.
                completion.set_result(None)
            raise
        else:
            if result is None:
                _IDENTITY_SYNC_COOLDOWN_UNTIL.pop(normalized_user_id, None)
            if not completion.done():
                completion.set_result(result)
            return result
        finally:
            if _IDENTITY_SYNC_IN_FLIGHT.get(normalized_user_id) is completion:
                _IDENTITY_SYNC_IN_FLIGHT.pop(normalized_user_id, None)

    def schedule_sync_from_firebase(
        self,
        user_id: str,
        *,
        force: bool = False,
    ) -> bool:
        normalized_user_id = str(user_id or "").strip()
        if not normalized_user_id or not self._looks_like_firebase_uid(normalized_user_id):
            return False

        existing = _IDENTITY_SYNC_TASKS.get(normalized_user_id)
        if existing and not existing.done():
            return False
        awaited = _IDENTITY_SYNC_IN_FLIGHT.get(normalized_user_id)
        if awaited and not awaited.done():
            return False

        now = datetime.now(timezone.utc)
        cooldown_until = _IDENTITY_SYNC_COOLDOWN_UNTIL.get(normalized_user_id)
        if not force and cooldown_until and cooldown_until > now:
            return False

        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return False

        _IDENTITY_SYNC_COOLDOWN_UNTIL[normalized_user_id] = now + _IDENTITY_SYNC_COOLDOWN
        task = loop.create_task(self.sync_from_firebase(normalized_user_id, force=force))
        _IDENTITY_SYNC_TASKS[normalized_user_id] = task

        def _cleanup(completed: asyncio.Task[dict[str, Any] | None]) -> None:
            if _IDENTITY_SYNC_TASKS.get(normalized_user_id) is completed:
                _IDENTITY_SYNC_TASKS.pop(normalized_user_id, None)
            try:
                result = completed.result()
                if result is None:
                    _IDENTITY_SYNC_COOLDOWN_UNTIL.pop(normalized_user_id, None)
            except asyncio.CancelledError:
                _IDENTITY_SYNC_COOLDOWN_UNTIL.pop(normalized_user_id, None)
            except Exception as exc:
                _IDENTITY_SYNC_COOLDOWN_UNTIL.pop(normalized_user_id, None)
                logger.debug(
                    "actor_identity_cache background sync skipped error=%s",
                    type(exc).__name__,
                )

        task.add_done_callback(_cleanup)
        return True

    def schedule_provision_personal_agent(
        self, user_id: str, phone_number: str, *, via_ai_connection: bool = False
    ) -> bool:
        """Fire-and-forget: register the user's PENDING personal agent on phone-verify.

        Flag-gated and strictly best-effort -- it never blocks or fails phone
        verification. When ``PERSONAL_AGENT_ENABLED`` is off this is a no-op.
        Deduped by an in-flight task per user; the actual work (HusshID + pending
        registry row) is idempotent and non-destructive.
        """
        if not personal_agent_enabled():
            return False
        # The AI-connection gate owns this trigger now. Provisioning on phone-verify
        # stood a billable pod behind an event that said nothing about whether the
        # agent could think -- a user who never connected a model got a warm pod
        # that answered nothing, forever.
        #
        # `via_ai_connection` is an explicit argument rather than an inspection of
        # the call stack: the caller states which trigger it is, so the two can
        # never both fire for one user and no future caller can be misclassified by
        # where it happens to live.
        from hushh_mcp.runtime_settings import provision_on_ai_connection  # noqa: PLC0415

        if provision_on_ai_connection() and not via_ai_connection:
            logger.info("personal_agent.provision_deferred reason=awaiting_ai_connection")
            return False

        normalized_user_id = str(user_id or "").strip()
        normalized_phone = str(phone_number or "").strip()
        if not normalized_user_id or not normalized_phone:
            return False
        if not self._looks_like_firebase_uid(normalized_user_id):
            return False

        existing = _PERSONAL_AGENT_PROVISION_TASKS.get(normalized_user_id)
        if existing and not existing.done():
            return False

        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return False

        task = loop.create_task(
            self._register_pending_personal_agent(normalized_user_id, normalized_phone)
        )
        _PERSONAL_AGENT_PROVISION_TASKS[normalized_user_id] = task

        def _cleanup(completed: asyncio.Task[None]) -> None:
            if _PERSONAL_AGENT_PROVISION_TASKS.get(normalized_user_id) is completed:
                _PERSONAL_AGENT_PROVISION_TASKS.pop(normalized_user_id, None)
            try:
                completed.result()
            except Exception as exc:
                logger.debug(
                    "personal-agent provisioning kickoff skipped for %s: %s",
                    normalized_user_id,
                    exc,
                )

        task.add_done_callback(_cleanup)
        return True

    async def _register_pending_personal_agent(self, user_id: str, phone_number: str) -> None:
        # Deferred import: no personal-agent dependency at module import time, and
        # nothing runs unless the flag gated the scheduler open.
        from hushh_mcp.services.compute_backend import resolve_compute_backend
        from hushh_mcp.services.personal_agent_provisioning_service import (
            PersonalAgentProvisioningService,
        )
        from hushh_mcp.services.personal_agent_registry_repo import (
            PersonalAgentRegistryRepo,
        )

        # Resolve the SAME backend the owner-authorized route uses
        # (api/routes/one/personal_agent.py). Constructing this service without a
        # backend silently yields NullBackend, so this path would have reported
        # success while creating no host at all -- and it is the path that will run
        # for every signup, where nobody is watching a response body.
        registry = PersonalAgentRegistryRepo()
        service = PersonalAgentProvisioningService(
            registry=registry, backend=resolve_compute_backend()
        )
        await service.register_pending(user_id=user_id, phone_e164=phone_number)

        from hushh_mcp.services.personal_agent_phone_activation import continue_verified_phone

        await continue_verified_phone(
            service=service, registry=registry, user_id=user_id, phone_number=phone_number
        )

    async def _known_actor_ids(self, user_ids: Iterable[str]) -> set[str]:
        normalized_ids = [str(user_id or "").strip() for user_id in user_ids]
        normalized_ids = [user_id for user_id in normalized_ids if user_id]
        if not normalized_ids:
            return set()

        pool = await get_pool()
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT user_id
                FROM actor_profiles
                WHERE user_id = ANY($1::text[])
                """,
                normalized_ids,
            )
        return {
            str(row["user_id"] or "").strip() for row in rows if str(row["user_id"] or "").strip()
        }

    @staticmethod
    def _looks_like_firebase_uid(value: str) -> bool:
        candidate = str(value or "").strip()
        if not candidate:
            return False
        if "@" in candidate or ":" in candidate or "/" in candidate or " " in candidate:
            return False
        lowered = candidate.lower()
        if lowered.startswith(("ria_", "ria-", "dev_", "dev-", "app_", "app-", "agent_", "agent-")):
            return False
        return len(candidate) >= 20

    @staticmethod
    def _normalize_email_alias(value: str | None) -> str:
        email = str(value or "").strip().lower()
        if not email or len(email) > 320 or email.count("@") != 1:
            raise ActorIdentityAliasError(
                "A valid email alias is required.",
                code="EMAIL_ALIAS_INVALID",
                status_code=422,
            )
        local, domain = email.rsplit("@", 1)
        if not local or not domain or "." not in domain or any(char.isspace() for char in email):
            raise ActorIdentityAliasError(
                "A valid email alias is required.",
                code="EMAIL_ALIAS_INVALID",
                status_code=422,
            )
        return email

    @staticmethod
    def _runtime_environment() -> str:
        return (
            str(
                os.getenv("ENVIRONMENT")
                or os.getenv("HUSHH_DEPLOY_ENV")
                or os.getenv("APP_ENV")
                or "development"
            )
            .strip()
            .lower()
        )

    @staticmethod
    def _env_truthy(name: str) -> bool:
        return str(os.getenv(name) or "").strip().lower() in {"1", "true", "yes", "on"}

    @classmethod
    def _may_return_review_alias_code(cls) -> bool:
        environment = cls._runtime_environment()
        if environment in {"prod", "production"}:
            return False
        return cls._env_truthy("APP_REVIEW_MODE") or environment in {
            "dev",
            "development",
            "local",
            "test",
            "testing",
            "uat",
        }

    @staticmethod
    def _alias_verification_secret() -> str:
        return (
            os.getenv("ACCOUNT_EMAIL_ALIAS_VERIFICATION_SECRET")
            or os.getenv("HUSHH_EMAIL_ALIAS_VERIFICATION_SECRET")
            or "hushh-dev-uat-email-alias-verification"
        )

    @classmethod
    def _hash_alias_verification_code(
        cls,
        *,
        user_id: str,
        email_normalized: str,
        verification_code: str,
    ) -> str:
        normalized_code = _ALIAS_CODE_PATTERN.sub("", str(verification_code or "")).lower()
        if not normalized_code:
            raise ActorIdentityAliasError(
                "Verification code is required.",
                code="EMAIL_ALIAS_CODE_REQUIRED",
                status_code=422,
            )
        material = (
            f"{cls._alias_verification_secret()}:{user_id}:{email_normalized}:{normalized_code}"
        )
        return hashlib.sha256(material.encode("utf-8")).hexdigest()

    @staticmethod
    def _normalize_alias_row(row: Any) -> dict[str, Any]:
        payload = dict(row or {})
        return {
            "alias_id": str(payload.get("alias_id") or "").strip(),
            "user_id": str(payload.get("user_id") or "").strip(),
            "email": str(payload.get("email") or "").strip(),
            "email_normalized": str(payload.get("email_normalized") or "").strip(),
            "verification_status": str(payload.get("verification_status") or "").strip(),
            "verification_source": str(payload.get("verification_source") or "").strip(),
            "source_ref": payload.get("source_ref"),
            "verification_requested_at": payload.get("verification_requested_at"),
            "verified_at": payload.get("verified_at"),
            "revoked_at": payload.get("revoked_at"),
            "last_matched_at": payload.get("last_matched_at"),
            "created_at": payload.get("created_at"),
            "updated_at": payload.get("updated_at"),
        }

    async def _get_many_fallback(self, user_ids: list[str]) -> dict[str, dict[str, Any]]:
        pool = await get_pool()
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT
                  ap.user_id,
                  COALESCE(mpp.display_name, rp.display_name, ap.user_id) AS display_name,
                  NULL::TEXT AS email,
                  NULL::TEXT AS phone_number,
                  NULL::TEXT AS photo_url,
                  FALSE AS email_verified,
                  FALSE AS phone_verified,
                  'legacy_fallback'::TEXT AS source,
                  NOW() AS last_synced_at,
                  NOW() AS created_at,
                  NOW() AS updated_at
                FROM actor_profiles ap
                LEFT JOIN marketplace_public_profiles mpp
                  ON mpp.user_id = ap.user_id
                LEFT JOIN ria_profiles rp
                  ON rp.user_id = ap.user_id
                WHERE ap.user_id = ANY($1::text[])
                """,
                user_ids,
            )
        return {
            str(row["user_id"]): self._normalize_row(row)
            for row in rows
            if str(row.get("user_id") or "").strip()
        }

    async def _get_many_without_phone_shadow(
        self, user_ids: list[str]
    ) -> dict[str, dict[str, Any]]:
        pool = await get_pool()
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT
                  user_id,
                  display_name,
                  email,
                  NULL::TEXT AS phone_number,
                  photo_url,
                  email_verified,
                  FALSE AS phone_verified,
                  source,
                  last_synced_at,
                  created_at,
                  updated_at
                FROM actor_identity_cache
                WHERE user_id = ANY($1::text[])
                """,
                user_ids,
            )
        return {
            str(row["user_id"]): self._normalize_row(row)
            for row in rows
            if str(row.get("user_id") or "").strip()
        }

    async def _get_many_without_custom_photo(
        self, user_ids: list[str]
    ) -> dict[str, dict[str, Any]]:
        """Pre-107 projection: drops ONLY custom_photo_url (keeps phone shadow).

        Used when the 047 phone-shadow columns exist but the 107
        custom_photo_url column does not (the migration gap). Routing that case
        to ``_get_many_without_phone_shadow`` would wrongly zero phone_verified
        for every read; this keeps phone-verification state intact and simply
        falls back to the plain Firebase photo_url (no custom avatar can exist
        yet, since ``set_custom_photo_url`` needs the column too).
        """
        pool = await get_pool()
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT
                  user_id,
                  display_name,
                  email,
                  phone_number,
                  photo_url,
                  email_verified,
                  phone_verified,
                  source,
                  last_synced_at,
                  created_at,
                  updated_at
                FROM actor_identity_cache
                WHERE user_id = ANY($1::text[])
                """,
                user_ids,
            )
        return {
            str(row["user_id"]): self._normalize_row(row)
            for row in rows
            if str(row.get("user_id") or "").strip()
        }

    @staticmethod
    def _normalize_row(row: Any) -> dict[str, Any]:
        if not row:
            return {}
        payload = dict(row)
        return {
            "user_id": str(payload.get("user_id") or "").strip(),
            "display_name": str(payload.get("display_name") or "").strip() or None,
            "email": str(payload.get("email") or "").strip() or None,
            "phone_number": str(payload.get("phone_number") or "").strip() or None,
            "photo_url": str(payload.get("photo_url") or "").strip() or None,
            "email_verified": bool(payload.get("email_verified")),
            "phone_verified": bool(payload.get("phone_verified")),
            "source": str(payload.get("source") or "").strip() or "unknown",
            "last_synced_at": payload.get("last_synced_at"),
            "created_at": payload.get("created_at"),
            "updated_at": payload.get("updated_at"),
        }

    @staticmethod
    def _is_stale(identity: dict[str, Any] | None) -> bool:
        if not identity:
            return True
        value = identity.get("last_synced_at")
        if not value:
            return True
        if isinstance(value, datetime):
            timestamp = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        else:
            try:
                timestamp = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
            except Exception:
                return True
            if timestamp.tzinfo is None:
                timestamp = timestamp.replace(tzinfo=timezone.utc)
        return datetime.now(timezone.utc) - timestamp >= _IDENTITY_STALE_AFTER

    @staticmethod
    async def read_provider_phone_fallbacks(conn, *, candidates: dict[str, str]) -> dict[str, str]:
        """Read-only Firebase fallback; never replace a present canonical row.

        Call after lifecycle barriers and before identity row locks. The shared
        claim lock uses the existing writer's exact key/namespace and prevents a
        stale provider number from being projected during a verified transfer.
        These candidates must come from current Firebase records, not a client.
        """
        if len(candidates) > 50:
            raise ValueError("identity projection exceeds page bound")
        valid = {
            uid: phone
            for uid, phone in candidates.items()
            if re.fullmatch(r"\+[1-9][0-9]{6,14}", phone)
        }
        if not valid:
            return {}
        for phone in sorted(set(valid.values())):
            await conn.execute(
                "SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))",
                f"actor_identity_phone_claim:{phone}",
            )
        bindings = await conn.fetch(
            "SELECT user_id,phone_number FROM actor_identity_cache "
            "WHERE phone_verified=TRUE AND phone_number=ANY($1::text[])",
            sorted(set(valid.values())),
            timeout=5,
        )
        return {
            uid: phone
            for uid, phone in valid.items()
            if not any(row["phone_number"] == phone and row["user_id"] != uid for row in bindings)
        }

    async def get_many(self, user_ids: Iterable[str], *, conn=None) -> dict[str, dict[str, Any]]:
        """Read identities; a caller-owned transaction retains authority until commit."""
        normalized_ids = [str(user_id or "").strip() for user_id in user_ids]
        normalized_ids = [user_id for user_id in normalized_ids if user_id]
        if not normalized_ids:
            return {}

        async def read(connection):
            # Both query variants are authored constants; IDs remain bound in $1.
            return await connection.fetch(
                """
                    SELECT
                      user_id,
                      display_name,
                      email,
                      phone_number,
                      COALESCE(custom_photo_url, photo_url) AS photo_url,
                      email_verified,
                      phone_verified,
                      source,
                      last_synced_at,
                      created_at,
                      updated_at
                    FROM actor_identity_cache
                    WHERE user_id = ANY($1::text[])
                    ORDER BY user_id
                    """
                + (" FOR SHARE" if conn is not None else ""),  # nosec B608
                normalized_ids,
                timeout=5,
            )

        try:
            if conn is not None:
                rows = await read(conn)
            else:
                pool = await get_pool()
                async with pool.acquire() as connection:
                    rows = await read(connection)

        except asyncpg.UndefinedTableError:
            if conn is not None:
                raise
            logger.debug("actor_identity_cache missing; using legacy identity fallback")
            return await self._get_many_fallback(normalized_ids)
        except asyncpg.UndefinedColumnError as exc:
            if conn is not None:
                raise
            message = str(exc)
            phone_missing = "phone_number" in message or "phone_verified" in message
            custom_photo_missing = "custom_photo_url" in message
            if not phone_missing and not custom_photo_missing:
                raise
            # A missing custom_photo_url (pre-107) must NOT route to the
            # phone-less projection — that would silently zero phone_verified for
            # EVERY read during the 107 migration gap. Drop only the column that
            # is actually absent so phone-verification state stays intact.
            if custom_photo_missing and not phone_missing:
                logger.debug(
                    "actor_identity_cache custom_photo_url missing; using pre-107 projection"
                )
                return await self._get_many_without_custom_photo(normalized_ids)
            logger.debug("actor_identity_cache phone shadow missing; using pre-047 projection")
            return await self._get_many_without_phone_shadow(normalized_ids)
        return {
            str(row["user_id"]): self._normalize_row(row)
            for row in rows
            if str(row.get("user_id") or "").strip()
        }

    async def get_many_verified_email_aliases(
        self, user_ids: Iterable[str], *, conn
    ) -> dict[str, list[str]]:
        """Bounded, read-only aliases in the reporting caller's lifecycle transaction."""
        ids = sorted({str(uid).strip() for uid in user_ids if str(uid).strip()})
        if len(ids) > 50:
            raise ValueError("Identity alias read exceeds bound")
        if not ids:
            return {}
        rows = await conn.fetch(
            "SELECT user_id,email_normalized FROM actor_verified_email_aliases "
            "WHERE user_id=ANY($1::text[]) AND verification_status='verified' "
            "AND revoked_at IS NULL ORDER BY user_id,email_normalized LIMIT 5001 FOR SHARE",
            ids,
            timeout=5,
        )
        if len(rows) > 5000:
            raise ValueError("Identity alias read exceeds bound")
        result: dict[str, list[str]] = {}
        for row in rows:
            result.setdefault(str(row["user_id"]), []).append(str(row["email_normalized"]))
        return result

    async def upsert_identity(
        self,
        *,
        user_id: str,
        display_name: str | None = None,
        email: str | None = None,
        phone_number: str | None = None,
        photo_url: str | None = None,
        email_verified: bool | None = None,
        phone_verified: bool | None = None,
        source: str = "unknown",
        preserve_verified_phone: bool = False,
    ) -> dict[str, Any] | None:
        normalized_user_id = str(user_id or "").strip()
        if not normalized_user_id:
            return None
        normalized_phone_number = str(phone_number or "").strip() or None

        pool = await get_pool()
        try:
            async with pool.acquire() as conn:
                async with conn.transaction():
                    await self._ensure_actor_spine(conn, normalized_user_id)
                    if phone_verified is True and normalized_phone_number:
                        phone_write_allowed = await self._lock_and_clear_verified_phone_binding(
                            conn,
                            user_id=normalized_user_id,
                            phone_number=normalized_phone_number,
                            # Hydration never carries OTP possession authority.
                            allow_owner_transfer=False,
                            release_deleted_holders=False,
                        )
                        if not phone_write_allowed:
                            normalized_phone_number = None
                            phone_verified = None
                    row = await conn.fetchrow(
                        """
                        INSERT INTO actor_identity_cache (
                          user_id,
                          display_name,
                          email,
                          phone_number,
                          photo_url,
                          email_verified,
                          phone_verified,
                          source,
                          last_synced_at,
                          created_at,
                          updated_at
                        )
                        VALUES (
                          $1,
                          $2,
                          $3,
                          $4,
                          $5,
                          COALESCE($6, FALSE),
                          COALESCE($7, FALSE),
                          $8,
                          NOW(),
                          NOW(),
                          NOW()
                        )
                        ON CONFLICT (user_id) DO UPDATE SET
                          display_name = COALESCE(EXCLUDED.display_name, actor_identity_cache.display_name),
                          email = COALESCE(EXCLUDED.email, actor_identity_cache.email),
                          phone_number = CASE
                            WHEN $9 AND actor_identity_cache.phone_verified = TRUE
                              AND NULLIF(BTRIM(actor_identity_cache.phone_number), '') IS NOT NULL
                            THEN actor_identity_cache.phone_number
                            ELSE COALESCE(EXCLUDED.phone_number, actor_identity_cache.phone_number)
                          END,
                          photo_url = COALESCE(EXCLUDED.photo_url, actor_identity_cache.photo_url),
                          email_verified = COALESCE($6, actor_identity_cache.email_verified),
                          phone_verified = CASE
                            WHEN $9 AND actor_identity_cache.phone_verified = TRUE
                              AND NULLIF(BTRIM(actor_identity_cache.phone_number), '') IS NOT NULL
                            THEN actor_identity_cache.phone_verified
                            ELSE COALESCE($7, actor_identity_cache.phone_verified)
                          END,
                          source = CASE
                            WHEN EXCLUDED.source IS NULL OR EXCLUDED.source = '' THEN actor_identity_cache.source
                            ELSE EXCLUDED.source
                          END,
                          last_synced_at = NOW(),
                          updated_at = NOW()
                        RETURNING
                          user_id,
                          display_name,
                          email,
                          phone_number,
                          COALESCE(custom_photo_url, photo_url) AS photo_url,
                          email_verified,
                          phone_verified,
                          source,
                          last_synced_at,
                          created_at,
                          updated_at
                        """,
                        normalized_user_id,
                        str(display_name or "").strip() or None,
                        str(email or "").strip().lower() or None,
                        normalized_phone_number,
                        str(photo_url or "").strip() or None,
                        email_verified,
                        phone_verified,
                        str(source or "").strip() or "unknown",
                        preserve_verified_phone,
                    )
        except Exception as exc:
            logger.error(
                "actor_identity_cache upsert failed error=%s",
                type(exc).__name__,
            )
            return None

        # A missing-only directory repair restores an index, not a new signup
        # verification event. Keep referral/reward state outside that repair.
        if phone_verified is True and not preserve_verified_phone:
            await self._sync_referral_qualification_best_effort(normalized_user_id)

        return self._normalize_row(row)

    @staticmethod
    async def _sync_referral_qualification_best_effort(user_id: str) -> None:
        """Best-effort hook: let a newly-verified phone progress a referral.

        `sync_referral_qualification_from_onboarding` is otherwise only
        re-invoked from `vault_keys_service` when onboarding itself completes.
        Phone verification can land after that -- `sync_from_firebase` is a
        background, cooldown-gated resync -- and nothing previously re-checked
        a relationship that was parked at `phone_not_verified`. Calling it
        again here, from the write that actually flips `phone_verified` to
        true, closes that ordering gap. It is safe to call for an unreferred
        user or an already-settled relationship (both are documented no-ops),
        and it runs in a worker thread because the referral service uses a
        blocking psycopg2 connection, not asyncpg. Any failure here must never
        surface as a failure of the identity write that triggered it.
        """
        try:
            from hushh_mcp.services.one_referral_service import (
                sync_referral_qualification_from_onboarding,
            )

            await asyncio.to_thread(sync_referral_qualification_from_onboarding, user_id)
        except Exception:
            logger.exception("[actor_identity] referral_qualification_sync_failed user=%s", user_id)

    async def fill_missing_display_name(
        self,
        *,
        user_id: str,
        display_name: str,
        source: str,
    ) -> dict[str, Any] | None:
        """Seed a verified provider name without replacing the owner's chosen name."""

        normalized_user_id = str(user_id or "").strip()
        if not normalized_user_id:
            return None
        value = self.validate_display_name(display_name)
        pool = await get_pool()
        try:
            async with pool.acquire() as conn:
                async with conn.transaction():
                    await self._ensure_actor_spine(conn, normalized_user_id)
                    row = await conn.fetchrow(
                        """
                        INSERT INTO actor_identity_cache (
                          user_id, display_name, source, last_synced_at, created_at, updated_at
                        )
                        VALUES ($1, $2, $3, NOW(), NOW(), NOW())
                        ON CONFLICT (user_id) DO UPDATE SET
                          display_name = CASE
                            WHEN NULLIF(BTRIM(actor_identity_cache.display_name), '') IS NULL
                              THEN EXCLUDED.display_name
                            ELSE actor_identity_cache.display_name
                          END,
                          source = CASE
                            WHEN NULLIF(BTRIM(actor_identity_cache.display_name), '') IS NULL
                              THEN EXCLUDED.source
                            ELSE actor_identity_cache.source
                          END,
                          last_synced_at = NOW(),
                          updated_at = NOW()
                        RETURNING
                          user_id,
                          display_name,
                          email,
                          phone_number,
                          COALESCE(custom_photo_url, photo_url) AS photo_url,
                          email_verified,
                          phone_verified,
                          source,
                          last_synced_at,
                          created_at,
                          updated_at
                        """,
                        normalized_user_id,
                        value,
                        str(source or "").strip() or "provider_profile",
                    )
        except Exception as exc:
            logger.error(
                "actor_identity_cache fill_missing_display_name failed error=%s",
                type(exc).__name__,
            )
            return None
        return self._normalize_row(row)

    async def set_custom_photo_url(
        self,
        user_id: str,
        custom_photo_url: str | None,
    ) -> dict[str, Any] | None:
        """Set (or clear) the app-owned avatar override for an actor.

        The custom photo takes precedence over the Firebase ``photo_url`` on
        reads (see the ``COALESCE`` projections) and is never touched by
        ``upsert_identity``/``sync_from_firebase``, so it survives Firebase
        identity syncs. Passing ``None`` clears the override, reverting to the
        Firebase photo.
        """
        normalized_user_id = str(user_id or "").strip()
        if not normalized_user_id:
            return None
        normalized_custom_photo_url = str(custom_photo_url or "").strip() or None

        update_sql = """
            UPDATE actor_identity_cache
            SET custom_photo_url = $2,
                updated_at = NOW()
            WHERE user_id = $1
            RETURNING
              user_id,
              display_name,
              email,
              phone_number,
              COALESCE(custom_photo_url, photo_url) AS photo_url,
              email_verified,
              phone_verified,
              source,
              last_synced_at,
              created_at,
              updated_at
        """

        pool = await get_pool()
        try:
            async with pool.acquire() as conn:
                row = await conn.fetchrow(
                    update_sql,
                    normalized_user_id,
                    normalized_custom_photo_url,
                )
            if row is None:
                # No identity shadow row yet; create it from Firebase Auth,
                # then retry the custom-photo write.
                await self.sync_from_firebase(normalized_user_id, force=True)
                async with pool.acquire() as conn:
                    row = await conn.fetchrow(
                        update_sql,
                        normalized_user_id,
                        normalized_custom_photo_url,
                    )
        except Exception as exc:
            logger.debug(
                "actor_identity_cache custom photo update skipped for %s: %s",
                normalized_user_id,
                exc,
            )
            return None

        if row is None:
            # Write never landed (no shadow row and the Firebase sync could not
            # create one). Report failure instead of _normalize_row(None) == {},
            # which would surface as a false success and clobber the client cache.
            return None
        return self._normalize_row(row)

    async def can_claim_test_phone(self, *, user_id: str, phone_number: str) -> bool:
        """Choose test-code vs real OTP without granting transfer authority.

        This is only a start-flow hint. Confirmation rechecks ownership under
        the serialized writer lock, including owners committed after this read.
        """
        pool = await get_pool()
        async with pool.acquire() as conn:
            owner = await conn.fetchval(
                """
                SELECT user_id FROM actor_identity_cache
                WHERE phone_number = $1 AND phone_verified = TRUE
                """,
                phone_number,
            )
            if owner not in (None, user_id):
                return owner in await deleted_full_account_holders(conn, (owner,))
        return True

    async def claim_verified_phone(
        self,
        *,
        user_id: str,
        phone_number: str,
        source: str = "firebase_phone_claim",
        transfer: ConfirmedTransfer | None = None,
    ) -> dict[str, Any] | None:
        from hushh_mcp.services.actor_phone_claim import claim_verified_phone

        return await claim_verified_phone(
            self,
            get_pool,
            user_id=user_id,
            phone_number=phone_number,
            source=source,
            transfer=transfer,
        )

    def _schedule_phone_resume(self, user_id: str, phone: str) -> None:
        """Hand the resume to the background; never raises into phone verify."""
        try:
            from hushh_mcp.services.owner_cloud_attach import run_after_phone  # noqa: PLC0415

            run_after_phone(user_id, self._resume_ai_connection, phone)
        except Exception:  # noqa: BLE001 -- the resume must never break phone verify
            logger.warning("personal_agent.phone_resume_unscheduled")

    async def _resume_ai_connection(self, user_id: str, phone: str = "") -> None:
        """Resume pre-phone choices: own-cloud attach, then managed AI; BYOK fires on its proof."""
        try:
            from hushh_mcp.services import ai_connection_gate as gate  # noqa: PLC0415
            from hushh_mcp.services import owner_cloud_attach as attach  # noqa: PLC0415
            from hushh_mcp.services.vault_keys_service import VaultKeysService  # noqa: PLC0415

            await attach.resume_attach_after_phone(user_id, phone)
            state = await VaultKeysService().get_pre_vault_state(user_id)
            if str(state.get("oneRuntimeSetupChoice") or "") != "hushh_managed_vertex":
                return
            verdict = await gate.on_ai_connection_verified(
                user_id=user_id, provider="hushh_managed_vertex", transport="managed_vertex"
            )
            logger.info(
                "personal_agent.ai_connection_resumed_after_phone scheduled=%s reason=%s",
                bool(verdict.get("scheduled")),
                str(verdict.get("reason") or "")[:80],
            )
        except Exception:  # noqa: BLE001 - phone verification must complete regardless
            logger.warning("personal_agent.ai_connection_resume_failed", exc_info=True)

    async def list_verified_email_aliases(self, user_id: str) -> list[dict[str, Any]]:
        normalized_user_id = str(user_id or "").strip()
        if not normalized_user_id:
            return []

        pool = await get_pool()
        try:
            async with pool.acquire() as conn:
                rows = await conn.fetch(
                    """
                    SELECT
                      alias_id,
                      user_id,
                      email,
                      email_normalized,
                      verification_status,
                      verification_source,
                      source_ref,
                      verification_requested_at,
                      verified_at,
                      revoked_at,
                      last_matched_at,
                      created_at,
                      updated_at
                    FROM actor_verified_email_aliases
                    WHERE user_id = $1
                    ORDER BY
                      CASE verification_status
                        WHEN 'verified' THEN 0
                        WHEN 'pending' THEN 1
                        ELSE 2
                      END,
                      COALESCE(verified_at, verification_requested_at, created_at) DESC
                    """,
                    normalized_user_id,
                )
        except asyncpg.UndefinedTableError:
            logger.debug("actor_verified_email_aliases missing; alias list empty")
            return []
        return [self._normalize_alias_row(row) for row in rows]

    async def list_account_identifiers(self, user_id: str, *, refresh: bool = True) -> list[str]:
        """
        Return identifiers that are verified or first-party known for this account.

        Consent review surfaces authenticate the user by Firebase UID, but external
        developer requests can arrive keyed by a Firebase email/phone or a verified
        alias. Keep this set conservative: only the UID, verified Firebase-auth
        shadow values, and verified account-owned email aliases are accepted.
        """
        normalized_user_id = str(user_id or "").strip()
        if not normalized_user_id:
            return []

        identifiers: list[str] = [normalized_user_id]

        def _append(value: Any, *, email: bool = False) -> None:
            normalized = str(value or "").strip()
            if email:
                normalized = normalized.lower()
            if normalized and normalized not in identifiers:
                identifiers.append(normalized)

        identity = await self.sync_from_firebase(normalized_user_id) if refresh else None
        if not identity:
            identity = (await self.get_many([normalized_user_id])).get(normalized_user_id) or {}

        if identity.get("email_verified"):
            _append(identity.get("email"), email=True)
        if identity.get("phone_verified"):
            _append(identity.get("phone_number"))

        for alias in await self.list_verified_email_aliases(normalized_user_id):
            if str(alias.get("verification_status") or "").strip().lower() != "verified":
                continue
            if alias.get("revoked_at") is not None:
                continue
            _append(alias.get("email_normalized") or alias.get("email"), email=True)

        return identifiers

    async def request_email_alias_verification(
        self,
        *,
        user_id: str,
        email: str,
        verification_source: str = "user_verified",
        source_ref: str | None = None,
        include_plaintext_code: bool = False,
    ) -> dict[str, Any]:
        """Start (or restart) the alias ceremony for one account-owned email.

        ``include_plaintext_code=True`` adds a route-internal
        ``verification_code_plaintext`` key so the caller can hand the code to
        a mail sender. It stays opt-in because at least one existing route
        serializes this result verbatim; the plaintext must never be added to
        any HTTP response.
        """
        normalized_user_id = str(user_id or "").strip()
        if not normalized_user_id:
            raise ActorIdentityAliasError(
                "User id is required.",
                code="EMAIL_ALIAS_USER_REQUIRED",
                status_code=422,
            )
        email_normalized = self._normalize_email_alias(email)
        source = str(verification_source or "user_verified").strip() or "user_verified"
        if source not in {"user_verified", "firebase_auth", "admin_seed", "review_seed"}:
            source = "user_verified"

        pool = await get_pool()
        async with pool.acquire() as conn:
            verified_owner = await conn.fetchrow(
                """
                SELECT user_id
                FROM actor_verified_email_aliases
                WHERE email_normalized = $1
                  AND verification_status = 'verified'
                  AND revoked_at IS NULL
                  AND user_id <> $2
                LIMIT 1
                """,
                email_normalized,
                normalized_user_id,
            )
            if verified_owner:
                raise ActorIdentityAliasError(
                    "This email alias is already verified for another account.",
                    code="EMAIL_ALIAS_ALREADY_VERIFIED",
                    status_code=409,
                )

            existing = await conn.fetchrow(
                """
                SELECT
                  alias_id,
                  user_id,
                  email,
                  email_normalized,
                  verification_status,
                  verification_source,
                  source_ref,
                  verification_requested_at,
                  verified_at,
                  revoked_at,
                  last_matched_at,
                  created_at,
                  updated_at
                FROM actor_verified_email_aliases
                WHERE user_id = $1
                  AND email_normalized = $2
                """,
                normalized_user_id,
                email_normalized,
            )
            if (
                existing
                and existing["verification_status"] == "verified"
                and existing["revoked_at"] is None
            ):
                already_verified: dict[str, Any] = {
                    "alias": self._normalize_alias_row(existing),
                    "already_verified": True,
                    "review_verification_code": None,
                }
                if include_plaintext_code:
                    # Already verified, so there is no code to send.
                    already_verified["verification_code_plaintext"] = None
                return already_verified

            verification_code = f"{secrets.randbelow(1_000_000):06d}"
            code_hash = self._hash_alias_verification_code(
                user_id=normalized_user_id,
                email_normalized=email_normalized,
                verification_code=verification_code,
            )
            row = await conn.fetchrow(
                """
                INSERT INTO actor_verified_email_aliases (
                  user_id,
                  email,
                  email_normalized,
                  verification_status,
                  verification_source,
                  source_ref,
                  verification_code_hash,
                  verification_requested_at,
                  verified_at,
                  revoked_at,
                  created_at,
                  updated_at
                )
                VALUES (
                  $1,
                  $2,
                  $3,
                  'pending',
                  $4,
                  $5,
                  $6,
                  NOW(),
                  NULL,
                  NULL,
                  NOW(),
                  NOW()
                )
                ON CONFLICT (user_id, email_normalized) DO UPDATE SET
                  email = EXCLUDED.email,
                  verification_status = 'pending',
                  verification_source = EXCLUDED.verification_source,
                  source_ref = EXCLUDED.source_ref,
                  verification_code_hash = EXCLUDED.verification_code_hash,
                  verification_requested_at = NOW(),
                  verified_at = NULL,
                  revoked_at = NULL,
                  updated_at = NOW()
                RETURNING
                  alias_id,
                  user_id,
                  email,
                  email_normalized,
                  verification_status,
                  verification_source,
                  source_ref,
                  verification_requested_at,
                  verified_at,
                  revoked_at,
                  last_matched_at,
                  created_at,
                  updated_at
                """,
                normalized_user_id,
                email_normalized,
                email_normalized,
                source,
                str(source_ref or "").strip() or None,
                code_hash,
            )

        result: dict[str, Any] = {
            "alias": self._normalize_alias_row(row),
            "already_verified": False,
            "review_verification_code": (
                verification_code if self._may_return_review_alias_code() else None
            ),
        }
        if include_plaintext_code:
            # Route-internal only: the caller pops this and hands it to the
            # mail sender. It must never be serialized into an HTTP response.
            result["verification_code_plaintext"] = verification_code
        return result

    async def confirm_email_alias_verification(
        self,
        *,
        user_id: str,
        email: str,
        verification_code: str,
        accept_without_code: bool = False,
    ) -> dict[str, Any]:
        """Verify a pending alias.

        ``accept_without_code`` is the caller's assertion that it has already
        authorised this confirmation by another means (the non-production claim
        test allowlist). Callers must never derive it from request input.
        """
        normalized_user_id = str(user_id or "").strip()
        if not normalized_user_id:
            raise ActorIdentityAliasError(
                "User id is required.",
                code="EMAIL_ALIAS_USER_REQUIRED",
                status_code=422,
            )
        email_normalized = self._normalize_email_alias(email)
        expected_hash = self._hash_alias_verification_code(
            user_id=normalized_user_id,
            email_normalized=email_normalized,
            verification_code=verification_code,
        )

        pool = await get_pool()
        try:
            async with pool.acquire() as conn:
                row = await conn.fetchrow(
                    """
                    SELECT
                      alias_id,
                      user_id,
                      email,
                      email_normalized,
                      verification_status,
                      verification_source,
                      source_ref,
                      verification_requested_at,
                      verified_at,
                      revoked_at,
                      last_matched_at,
                      created_at,
                      updated_at,
                      verification_code_hash
                    FROM actor_verified_email_aliases
                    WHERE user_id = $1
                      AND email_normalized = $2
                    """,
                    normalized_user_id,
                    email_normalized,
                )
                if not row:
                    raise ActorIdentityAliasError(
                        "Email alias verification has not been requested.",
                        code="EMAIL_ALIAS_VERIFICATION_NOT_FOUND",
                        status_code=404,
                    )
                if row["verification_status"] == "verified" and row["revoked_at"] is None:
                    return self._normalize_alias_row(row)
                # A code with no lifetime is a permanent credential sitting in
                # an inbox. Expire it on the same 15-minute clock the claim
                # ticket uses; the caller can always request a fresh one.
                requested_at = row["verification_requested_at"]
                if requested_at is not None and not accept_without_code:
                    age_seconds = (datetime.now(timezone.utc) - requested_at).total_seconds()
                    if age_seconds > _ALIAS_VERIFICATION_TTL_SECONDS:
                        raise ActorIdentityAliasError(
                            "That code expired. Send a new one.",
                            code="EMAIL_ALIAS_CODE_EXPIRED",
                            status_code=400,
                        )
                stored_hash = str(row["verification_code_hash"] or "")
                code_matches = bool(stored_hash) and secrets.compare_digest(
                    stored_hash, expected_hash
                )
                if not code_matches and not accept_without_code:
                    raise ActorIdentityAliasError(
                        "Email alias verification code is invalid.",
                        code="EMAIL_ALIAS_CODE_INVALID",
                        status_code=400,
                    )

                verified_owner = await conn.fetchrow(
                    """
                    SELECT user_id
                    FROM actor_verified_email_aliases
                    WHERE email_normalized = $1
                      AND verification_status = 'verified'
                      AND revoked_at IS NULL
                      AND user_id <> $2
                    LIMIT 1
                    """,
                    email_normalized,
                    normalized_user_id,
                )
                if verified_owner:
                    raise ActorIdentityAliasError(
                        "This email alias is already verified for another account.",
                        code="EMAIL_ALIAS_ALREADY_VERIFIED",
                        status_code=409,
                    )

                verified = await conn.fetchrow(
                    """
                    UPDATE actor_verified_email_aliases
                    SET
                      verification_status = 'verified',
                      verified_at = NOW(),
                      revoked_at = NULL,
                      verification_code_hash = NULL,
                      updated_at = NOW()
                    WHERE user_id = $1
                      AND email_normalized = $2
                    RETURNING
                      alias_id,
                      user_id,
                      email,
                      email_normalized,
                      verification_status,
                      verification_source,
                      source_ref,
                      verification_requested_at,
                      verified_at,
                      revoked_at,
                      last_matched_at,
                      created_at,
                      updated_at
                    """,
                    normalized_user_id,
                    email_normalized,
                )
        except asyncpg.UniqueViolationError as exc:
            raise ActorIdentityAliasError(
                "This email alias is already verified for another account.",
                code="EMAIL_ALIAS_ALREADY_VERIFIED",
                status_code=409,
            ) from exc
        return self._normalize_alias_row(verified)

    async def sync_verified_phone_from_firebase(
        self, user_id: str, *, missing_only: bool = False
    ) -> dict[str, Any] | None:
        """Repair an incomplete phone shadow using existing provider verification.

        A fresh shadow can predate signup verification. Its cache TTL is not
        proof that another OTP is needed. Complete verified claims keep the
        normal cached path; incomplete ones refresh only this owner's Firebase
        identity through the existing serialized phone writer. Contact-discovery
        admission still belongs to its database policy gate.
        """
        try:
            if missing_only:
                # A stale complete backend OTP claim is still authoritative.
                # Do not let cache freshness trigger a provider replacement.
                identity = (await self.get_many([user_id])).get(user_id)
                if (
                    identity
                    and identity.get("phone_verified") is True
                    and identity.get("phone_number")
                ):
                    return identity
                record = await self._get_firebase_user_record(user_id, require_success=True)
                phone = getattr(record, "phone_number", None)
                if not phone or getattr(record, "disabled", False):
                    return identity
                # The SQL conflict update rechecks completeness after locking,
                # including an OTP claim committed during the provider lookup.
                updated = await self.upsert_identity(
                    user_id=user_id,
                    phone_number=phone,
                    phone_verified=True,
                    source="firebase_auth",
                    preserve_verified_phone=True,
                )
                if updated is None:
                    raise ActorIdentitySyncUnavailableError()
                return updated
            identity = await self.sync_from_firebase(user_id, force=False)
            if (
                identity
                and identity.get("phone_verified") is True
                and str(identity.get("phone_number") or "").strip()
            ):
                return identity
            return await self.sync_from_firebase(user_id, force=True, require_success=True)
        except ActorIdentitySyncUnavailableError:
            raise
        except Exception as exc:
            # Pool acquisition and identity reads can fail before provider
            # refresh. Those failures do not invalidate signup verification.
            logger.debug("contact identity recovery unavailable error=%s", type(exc).__name__)
            raise ActorIdentitySyncUnavailableError() from None

    async def sync_from_firebase(
        self,
        user_id: str,
        *,
        force: bool = False,
        require_success: bool = False,
    ) -> dict[str, Any] | None:
        normalized_user_id = str(user_id or "").strip()
        if not normalized_user_id:
            return None
        # Strict callers already authenticated this exact Firebase UID. The
        # background scheduling heuristic must not reject imported/custom UIDs.
        if not require_success and not self._looks_like_firebase_uid(normalized_user_id):
            return None

        cached = (await self.get_many([normalized_user_id])).get(normalized_user_id)
        if cached and not force and not self._is_stale(cached):
            return cached

        user_record = await self._get_firebase_user_record(
            normalized_user_id, require_success=require_success
        )
        if user_record is None:
            return cached
        updated = await self._upsert_firebase_user_record(
            normalized_user_id, user_record, require_success=require_success
        )
        return updated or cached

    async def sync_contact_sync_requester_from_firebase(self, user_id: str) -> str | None:
        """Return fresh provider email evidence only for phone-less requesters.

        Phone-backed web/native accounts retain their existing cached admission.
        Established Google/Apple accounts can instead prove their identity with
        the provider's current verified email. This does not verify a phone or
        make the requester discoverable by phone. The graph service separately
        rechecks the same email and established-account state at both boundaries.
        """
        try:
            identity = await self.sync_from_firebase(user_id, force=False)
            if identity is None:
                # Imported/custom Firebase UIDs may miss the background sync
                # heuristic. A current app phone claim still keeps the same
                # provider-independent path as every other verified account.
                identity = (await self.get_many([user_id])).get(user_id)
            if (
                identity
                and identity.get("phone_verified") is True
                and str(identity.get("phone_number") or "").strip()
            ):
                return None

            # The route already authenticated this exact UID. Background UID
            # heuristics must not stand in for Firebase's own identity lookup.
            normalized_user_id = str(user_id or "").strip()
            user_record = await self._get_firebase_user_record(
                normalized_user_id, require_success=True
            )
            updated = await self._upsert_firebase_user_record(
                normalized_user_id, user_record, require_success=True
            )
            if updated is None:
                raise ActorIdentitySyncUnavailableError()

            current_email = str(resolve_firebase_email(user_record) or "").strip().lower()
            social_provider = any(
                getattr(provider, "provider_id", None) in {"google.com", "apple.com"}
                for provider in (getattr(user_record, "provider_data", None) or [])
            )
            # Read current provider evidence, never COALESCE-retained display
            # email from the shadow or a client bootstrap hint.
            if (
                social_provider
                and getattr(user_record, "email_verified", False) is True
                and current_email
            ):
                return current_email
            return None
        except ActorIdentitySyncUnavailableError:
            raise
        except Exception as exc:
            logger.debug("contact identity recovery unavailable error=%s", type(exc).__name__)
            raise ActorIdentitySyncUnavailableError() from None

    async def _get_firebase_user_record(self, user_id: str, *, require_success: bool) -> Any | None:
        firebase_app = get_firebase_auth_app()
        if firebase_app is None:
            if require_success:
                raise ActorIdentitySyncUnavailableError()
            return None

        try:
            from firebase_admin import auth as firebase_auth

            # firebase_admin.auth.get_user performs a blocking network round-trip.
            # Run it in a worker thread so it never stalls the asyncio event loop
            # (a blocked loop serialises every concurrent request and manifests as
            # multi-second latency and pool-acquire timeouts elsewhere).
            firebase_uid = user_id
            if re.fullmatch(r"acct_[0-9a-f]{32}", user_id):
                firebase_uid = await asyncio.to_thread(
                    AccountGenerationService.firebase_identity_for_owner, user_id
                )
            user_record = await asyncio.to_thread(
                firebase_auth.get_user, firebase_uid, app=firebase_app
            )
        except Exception as exc:
            logger.debug(
                "actor_identity_cache firebase sync skipped error=%s",
                type(exc).__name__,
            )
            if require_success:
                raise ActorIdentitySyncUnavailableError() from None
            return None

        # Quarantined or unavailable users cannot create fresh identity proof.
        if user_record is None or getattr(user_record, "disabled", False) is True:
            if require_success:
                raise ActorIdentitySyncUnavailableError()
            return None

        return user_record

    async def _upsert_firebase_user_record(
        self, user_id: str, user_record: Any, *, require_success: bool
    ) -> dict[str, Any] | None:
        firebase_phone_number = getattr(user_record, "phone_number", None)
        updated = await self.upsert_identity(
            user_id=user_id,
            display_name=getattr(user_record, "display_name", None),
            email=resolve_firebase_email(user_record),
            phone_number=firebase_phone_number,
            photo_url=getattr(user_record, "photo_url", None),
            email_verified=getattr(user_record, "email_verified", None),
            phone_verified=True if firebase_phone_number else None,
            source="firebase_auth",
            # Provider snapshots can arrive after a newer OTP claim. Metadata
            # refresh may repair an incomplete phone, never replace a committed
            # verified phone. Replacement has an explicit finalization path.
            preserve_verified_phone=True,
        )
        if updated is None and require_success:
            raise ActorIdentitySyncUnavailableError()
        # Preserve the existing qualification refresh when the provider agrees
        # with the committed phone; a mismatched old snapshot grants nothing.
        if (
            firebase_phone_number
            and updated
            and updated.get("phone_verified") is True
            and updated.get("phone_number") == firebase_phone_number
        ):
            await self._sync_referral_qualification_best_effort(user_id)
        return updated

    async def finalize_verified_phone_from_firebase(
        self, user_id: str, expected_phone_number: str
    ) -> dict[str, Any] | None:
        """Persist an explicitly completed native link, not an ambient refresh.

        The requested value alone is not proof: Firebase must currently hold
        that exact verified phone for this authenticated UID. Reuse the normal
        serialized writer, without phone-token authority to transfer an owner.
        """
        phone = str(expected_phone_number or "").strip()
        if not re.fullmatch(r"\+[1-9][0-9]{6,14}", phone):
            raise ValueError("The verified phone number is invalid.")
        identity_uid = user_id
        if re.fullmatch(r"acct_[0-9a-f]{32}", user_id):
            identity_uid = await asyncio.to_thread(
                AccountGenerationService.firebase_identity_for_owner, user_id
            )
        record = await self._get_firebase_user_record(user_id, require_success=True)
        if record is None:
            raise ActorIdentitySyncUnavailableError()
        if (
            str(getattr(record, "uid", "")) != identity_uid
            or str(getattr(record, "phone_number", "") or "").strip() != phone
        ):
            raise ValueError("The verified phone no longer matches this attempt. Please retry.")
        identity = await self.claim_verified_phone(
            user_id=user_id, phone_number=phone, source="firebase_auth"
        )
        if (
            identity is None
            or identity.get("user_id") != user_id
            or identity.get("phone_verified") is not True
            or identity.get("phone_number") != phone
        ):
            raise ActorIdentitySyncUnavailableError()
        return identity

    @staticmethod
    def validate_display_name(display_name: str) -> str:
        """Trim and bound a person-authored display name.

        2-60 characters, no control characters, no URLs or @handles: a name is
        a name, not a link.
        """
        value = " ".join(str(display_name or "").split())
        if len(value) < 2 or len(value) > 60:
            raise ValueError("Display name must be between 2 and 60 characters.")
        if any(ord(ch) < 32 or ord(ch) == 127 for ch in value):
            raise ValueError("Display name contains unsupported characters.")
        lowered = value.lower()
        if "@" in value or "://" in lowered or "www." in lowered or lowered.startswith("http"):
            raise ValueError("Display name cannot contain links or handles.")
        return value

    async def update_display_name(self, user_id: str, display_name: str) -> dict[str, Any] | None:
        """Change the person's display name at its source of truth (Firebase Auth),
        then re-sync the identity shadow so every surface agrees immediately."""
        normalized_user_id = str(user_id or "").strip()
        if not normalized_user_id:
            return None
        value = self.validate_display_name(display_name)
        firebase_app = get_firebase_auth_app()
        if firebase_app is None:
            raise RuntimeError("Identity provider is not configured.")
        await account_firebase_mutations.run(
            normalized_user_id,
            purpose="display_name",
            authority_project=str(getattr(firebase_app, "project_id", "")),
            operation=lambda firebase_uid: account_firebase_mutations.set_display_name(
                firebase_app, firebase_uid, value
            ),
        )
        # From here the provider holds the new name. Nothing below may turn
        # that committed write into "your name wasn't changed": a shadow that
        # fails to catch up is reported as pending, never as a failure.
        try:
            updated = await self.sync_from_firebase(
                normalized_user_id, force=True, require_success=True
            )
            if updated is None:
                # The provider accepted the change; never report the old name back.
                updated = await self.upsert_identity(
                    user_id=normalized_user_id,
                    display_name=value,
                    email=None,
                    phone_number=None,
                    photo_url=None,
                    email_verified=None,
                    phone_verified=None,
                    source="firebase_auth",
                )
        except Exception as exc:  # noqa: BLE001 - post-commit shadow errors are opaque
            logger.warning(
                "identity.display_name.shadow_sync_pending error=%s",
                type(exc).__name__,
            )
            return {
                "user_id": normalized_user_id,
                "display_name": value,
                "shadow_sync": "pending",
            }
        result = dict(updated or {})
        result.setdefault("user_id", normalized_user_id)
        if not str(result.get("display_name") or "").strip():
            result["display_name"] = value
        result["shadow_sync"] = "synced"
        return result

    async def ensure_many(self, user_ids: Iterable[str]) -> dict[str, dict[str, Any]]:
        normalized_ids = [str(user_id or "").strip() for user_id in user_ids]
        normalized_ids = [user_id for user_id in normalized_ids if user_id]
        if not normalized_ids:
            return {}

        identities = await self.get_many(normalized_ids)
        missing_or_stale = [
            user_id
            for user_id in normalized_ids
            if self._is_stale(identities.get(user_id))
            or not (
                identities.get(user_id, {}).get("display_name")
                or identities.get(user_id, {}).get("email")
            )
        ]

        known_actor_ids = await self._known_actor_ids(missing_or_stale)

        for user_id in missing_or_stale:
            if user_id not in known_actor_ids:
                continue
            refreshed = await self.sync_from_firebase(user_id)
            if refreshed:
                identities[user_id] = refreshed

        return identities
