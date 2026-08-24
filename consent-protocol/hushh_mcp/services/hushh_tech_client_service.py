"""UAT-only Hushh Tech product client foundation.

Hushh Research remains the identity and consent authority.  This service adds a
small product-client seam for single-use PKCE launch, verified synthetic legacy
linking, revocation, and production-shaped shadow metadata.  It does not read a
Supabase project and it cannot be enabled in production.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import time
import uuid
from dataclasses import dataclass
from typing import Any, Protocol

from db.connection import get_pool
from hushh_mcp.services.developer_oauth_service import (
    OAuthValidationError,
    normalize_redirect_uri,
)
from hushh_mcp.services.hushh_tech_legacy_proof import (
    LegacySessionProofError,
    LegacySessionProofVerifier,
    SyntheticFixtureLegacySessionProofVerifier,
)

_LAUNCH_TTL_MS = 60 * 1000
_LAUNCH_REPLAY_REVIEW_MS = 24 * 60 * 60 * 1000
_PKCE_CHALLENGE_PATTERN = re.compile(r"^[A-Za-z0-9_-]{43}$")
_PKCE_VERIFIER_PATTERN = re.compile(r"^[A-Za-z0-9._~-]{43,128}$")
_UID_PATTERN = re.compile(r"^[A-Za-z0-9:_-]{1,128}$")
_SHADOW_RECORD_TYPES = frozenset({"profile", "onboarding", "access_state", "report_asset"})
_SYNTHETIC_LEGACY_PROJECT = "hushh-tech-uat-synthetic"


def _now_ms() -> int:
    return int(time.time() * 1000)


def _env_truthy(name: str) -> bool:
    return str(os.getenv(name, "")).strip().lower() in {"1", "true", "yes", "on"}


def _csv(name: str) -> tuple[str, ...]:
    return tuple(value.strip() for value in str(os.getenv(name, "")).split(",") if value.strip())


def hushh_tech_client_enabled() -> bool:
    """Return true only for an explicit UAT/test rollout."""
    environment = str(os.getenv("ENVIRONMENT", "development")).strip().lower()
    if environment == "production":
        return False
    if not (_env_truthy("HUSSH_TECH_CLIENT_ENABLED") and environment in {"uat", "test"}):
        return False
    rate_limit_storage_uri = str(os.getenv("RATE_LIMIT_STORAGE_URI", "")).strip().lower()
    if environment == "uat" and not rate_limit_storage_uri.startswith(("redis://", "rediss://")):
        return False
    return bool(
        str(os.getenv("HUSSH_TECH_LAUNCH_PEPPER", "")).strip()
        and str(os.getenv("HUSSH_TECH_DEVELOPER_APP_ID", "")).strip()
        and str(os.getenv("HUSSH_TECH_ALLOWED_AUDIENCE", "")).strip()
        and _csv("HUSSH_TECH_ALLOWED_REDIRECT_URIS")
        and _csv("HUSSH_TECH_UAT_FIREBASE_UID_ALLOWLIST")
        and str(os.getenv("HUSSH_TECH_PROXY_AUDIENCE", "")).strip()
        and _csv("HUSSH_TECH_TRUSTED_PROXY_SERVICE_ACCOUNTS")
    )


class HushhTechClientError(ValueError):
    """Typed product-client state safe to return through both gateways."""

    def __init__(self, state: str, message: str, *, status_code: int = 400):
        self.state = state
        self.message = message
        self.status_code = status_code
        super().__init__(message)


def require_hushh_tech_client_admission(firebase_uid: str) -> None:
    """Fail before any product-client write unless the UID is in the UAT cohort."""
    if not hushh_tech_client_enabled():
        raise HushhTechClientError(
            "FEATURE_DISABLED",
            "Hushh Tech entry is not enabled.",
            status_code=404,
        )
    clean_uid = str(firebase_uid or "").strip()
    if not _UID_PATTERN.fullmatch(clean_uid):
        raise HushhTechClientError(
            "UNAUTHENTICATED",
            "A valid Firebase session is required.",
            status_code=401,
        )
    if clean_uid not in set(_csv("HUSSH_TECH_UAT_FIREBASE_UID_ALLOWLIST")):
        raise HushhTechClientError(
            "FEATURE_DISABLED",
            "Hushh Tech entry is not enabled for this account.",
            status_code=403,
        )


@dataclass(frozen=True)
class LaunchAuthorization:
    authorization_id: str
    code: str
    audience: str
    redirect_uri: str
    expires_at_ms: int


class HushhTechClientStore(Protocol):
    async def insert_launch_authorization(self, row: dict[str, Any]) -> None: ...

    async def consume_launch_authorization(
        self,
        *,
        code_hash: str,
        code_challenge: str,
        audience: str,
        redirect_uri: str,
        now_ms: int,
    ) -> dict[str, Any] | None: ...

    async def get_active_link(self, *, firebase_uid: str, app_id: str) -> dict[str, Any] | None: ...

    async def link_account(
        self,
        *,
        firebase_uid: str,
        legacy_project: str,
        legacy_user_uuid: str,
        app_id: str,
        proof_session_id: str,
        metadata: dict[str, Any],
        now_ms: int,
    ) -> dict[str, Any]: ...

    async def revoke_link(
        self,
        *,
        firebase_uid: str,
        app_id: str,
        now_ms: int,
    ) -> dict[str, Any] | None: ...

    async def fixture_source_hash(
        self,
        *,
        legacy_project: str,
        legacy_user_uuid: str,
    ) -> str | None: ...

    async def get_shadow_record(
        self,
        *,
        legacy_project: str,
        legacy_user_uuid: str,
        record_type: str,
    ) -> dict[str, Any] | None: ...


def _json_object(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return dict(value)
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return {}
        return dict(parsed) if isinstance(parsed, dict) else {}
    return {}


class PostgresHushhTechClientStore:
    """Cloud SQL implementation; migration 170 is the schema authority."""

    async def insert_launch_authorization(self, row: dict[str, Any]) -> None:
        pool = await get_pool()
        async with pool.acquire() as connection:
            async with connection.transaction():
                await connection.execute(
                    """
                    DELETE FROM hushh_tech_launch_authorizations
                    WHERE expires_at_ms < $1
                    """,
                    int(row["created_at_ms"]) - _LAUNCH_REPLAY_REVIEW_MS,
                )
                await connection.execute(
                    """
                    INSERT INTO hushh_tech_launch_authorizations (
                        authorization_id, code_hash, firebase_uid, audience,
                        redirect_uri, code_challenge, code_challenge_method,
                        firebase_valid_after_ms, created_at_ms, expires_at_ms,
                        consumed_at_ms
                    )
                    VALUES ($1,$2,$3,$4,$5,$6,'S256',$7,$8,$9,NULL)
                    """,
                    row["authorization_id"],
                    row["code_hash"],
                    row["firebase_uid"],
                    row["audience"],
                    row["redirect_uri"],
                    row["code_challenge"],
                    row["firebase_valid_after_ms"],
                    row["created_at_ms"],
                    row["expires_at_ms"],
                )

    async def consume_launch_authorization(
        self,
        *,
        code_hash: str,
        code_challenge: str,
        audience: str,
        redirect_uri: str,
        now_ms: int,
    ) -> dict[str, Any] | None:
        pool = await get_pool()
        async with pool.acquire() as connection:
            row = await connection.fetchrow(
                """
                UPDATE hushh_tech_launch_authorizations
                SET consumed_at_ms = $5
                WHERE code_hash = $1
                  AND code_challenge = $2
                  AND code_challenge_method = 'S256'
                  AND audience = $3
                  AND redirect_uri = $4
                  AND consumed_at_ms IS NULL
                  AND expires_at_ms > $5
                RETURNING authorization_id, firebase_uid, audience, redirect_uri,
                          firebase_valid_after_ms, created_at_ms, expires_at_ms,
                          consumed_at_ms
                """,
                code_hash,
                code_challenge,
                audience,
                redirect_uri,
                now_ms,
            )
        return dict(row) if row else None

    async def get_active_link(self, *, firebase_uid: str, app_id: str) -> dict[str, Any] | None:
        pool = await get_pool()
        async with pool.acquire() as connection:
            row = await connection.fetchrow(
                """
                SELECT * FROM hushh_tech_account_links
                WHERE firebase_uid = $1
                  AND created_by_app_id = $2
                  AND legacy_project = $3
                  AND status = 'active'
                LIMIT 1
                """,
                firebase_uid,
                app_id,
                _SYNTHETIC_LEGACY_PROJECT,
            )
        return dict(row) if row else None

    @staticmethod
    async def _lock_identity(connection: Any, *values: str) -> None:
        for value in sorted(values):
            await connection.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
                value,
            )

    async def link_account(
        self,
        *,
        firebase_uid: str,
        legacy_project: str,
        legacy_user_uuid: str,
        app_id: str,
        proof_session_id: str,
        metadata: dict[str, Any],
        now_ms: int,
    ) -> dict[str, Any]:
        pool = await get_pool()
        link_id = f"htl_{uuid.uuid4().hex}"
        async with pool.acquire() as connection:
            async with connection.transaction():
                await self._lock_identity(
                    connection,
                    f"firebase:{legacy_project}:{firebase_uid}",
                    f"legacy:{legacy_project}:{legacy_user_uuid}",
                )
                proof_consumed = await self._insert_link_event(
                    connection,
                    event_id=f"hte_{uuid.uuid4().hex}",
                    link_id=None,
                    firebase_uid=firebase_uid,
                    legacy_project=legacy_project,
                    legacy_user_uuid=legacy_user_uuid,
                    event_type="attempted",
                    app_id=app_id,
                    proof_session_id=proof_session_id,
                    metadata=metadata,
                    now_ms=now_ms,
                )
                if not proof_consumed:
                    return {"outcome": "proof_replayed", "link": None}
                rows = await connection.fetch(
                    """
                    SELECT * FROM hushh_tech_account_links
                    WHERE legacy_project = $1 AND status = 'active'
                      AND (legacy_user_uuid = $2 OR firebase_uid = $3)
                    FOR UPDATE
                    """,
                    legacy_project,
                    legacy_user_uuid,
                    firebase_uid,
                )
                active = [dict(row) for row in rows]
                exact = next(
                    (
                        row
                        for row in active
                        if row["legacy_user_uuid"] == legacy_user_uuid
                        and row["firebase_uid"] == firebase_uid
                        and row["created_by_app_id"] == app_id
                    ),
                    None,
                )
                if exact is not None:
                    await self._insert_link_event(
                        connection,
                        event_id=f"hte_{uuid.uuid4().hex}",
                        link_id=str(exact["link_id"]),
                        firebase_uid=firebase_uid,
                        legacy_project=legacy_project,
                        legacy_user_uuid=legacy_user_uuid,
                        event_type="relink_attempt",
                        app_id=app_id,
                        proof_session_id=None,
                        metadata=metadata,
                        now_ms=now_ms,
                    )
                    return {"outcome": "already_linked", "link": exact}
                if active:
                    await self._insert_link_event(
                        connection,
                        event_id=f"hte_{uuid.uuid4().hex}",
                        link_id=None,
                        firebase_uid=firebase_uid,
                        legacy_project=legacy_project,
                        legacy_user_uuid=legacy_user_uuid,
                        event_type="conflict",
                        app_id=app_id,
                        proof_session_id=None,
                        metadata={**metadata, "conflict_count": len(active)},
                        now_ms=now_ms,
                    )
                    return {"outcome": "conflict", "link": None}
                previous = await connection.fetchrow(
                    """
                    SELECT link_id FROM hushh_tech_account_links
                    WHERE legacy_project = $1
                      AND legacy_user_uuid = $2
                      AND firebase_uid = $3
                      AND created_by_app_id = $4
                      AND status = 'revoked'
                    ORDER BY revoked_at_ms DESC
                    LIMIT 1
                    FOR UPDATE
                    """,
                    legacy_project,
                    legacy_user_uuid,
                    firebase_uid,
                    app_id,
                )
                event_metadata = dict(metadata)
                if previous:
                    event_metadata["recovered_from_link_id"] = str(previous["link_id"])
                row = await connection.fetchrow(
                    """
                    INSERT INTO hushh_tech_account_links (
                        link_id, legacy_project, legacy_user_uuid, firebase_uid,
                        status, linked_at_ms, revoked_at_ms, created_by_app_id, provenance
                    ) VALUES ($1,$2,$3,$4,'active',$5,NULL,$6,$7::jsonb)
                    RETURNING *
                    """,
                    link_id,
                    legacy_project,
                    legacy_user_uuid,
                    firebase_uid,
                    now_ms,
                    app_id,
                    json.dumps(metadata, sort_keys=True, separators=(",", ":")),
                )
                await self._insert_link_event(
                    connection,
                    event_id=f"hte_{uuid.uuid4().hex}",
                    link_id=link_id,
                    firebase_uid=firebase_uid,
                    legacy_project=legacy_project,
                    legacy_user_uuid=legacy_user_uuid,
                    event_type="recovered" if previous else "activated",
                    app_id=app_id,
                    proof_session_id=None,
                    metadata=event_metadata,
                    now_ms=now_ms,
                )
        return {
            "outcome": "recovered" if previous else "linked",
            "link": dict(row) if row else {},
        }

    @staticmethod
    async def _insert_link_event(
        connection: Any,
        *,
        event_id: str,
        link_id: str | None,
        firebase_uid: str,
        legacy_project: str,
        legacy_user_uuid: str,
        event_type: str,
        app_id: str,
        proof_session_id: str | None,
        metadata: dict[str, Any],
        now_ms: int,
    ) -> bool:
        inserted = await connection.fetchval(
            """
            INSERT INTO hushh_tech_link_events (
                event_id, link_id, firebase_uid, legacy_project,
                legacy_user_uuid, event_type, app_id, proof_session_id,
                metadata, created_at_ms
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
            ON CONFLICT (proof_session_id) DO NOTHING
            RETURNING event_id
            """,
            event_id,
            link_id,
            firebase_uid,
            legacy_project,
            legacy_user_uuid,
            event_type,
            app_id,
            proof_session_id,
            json.dumps(metadata, sort_keys=True, separators=(",", ":")),
            now_ms,
        )
        return bool(inserted)

    async def revoke_link(
        self,
        *,
        firebase_uid: str,
        app_id: str,
        now_ms: int,
    ) -> dict[str, Any] | None:
        pool = await get_pool()
        async with pool.acquire() as connection:
            async with connection.transaction():
                row = await connection.fetchrow(
                    """
                    UPDATE hushh_tech_account_links
                    SET status = 'revoked', revoked_at_ms = $3
                    WHERE firebase_uid = $1
                      AND created_by_app_id = $2
                      AND legacy_project = $4
                      AND status = 'active'
                    RETURNING *
                    """,
                    firebase_uid,
                    app_id,
                    now_ms,
                    _SYNTHETIC_LEGACY_PROJECT,
                )
                if not row:
                    return None
                await self._insert_link_event(
                    connection,
                    event_id=f"hte_{uuid.uuid4().hex}",
                    link_id=str(row["link_id"]),
                    firebase_uid=firebase_uid,
                    legacy_project=str(row["legacy_project"]),
                    legacy_user_uuid=str(row["legacy_user_uuid"]),
                    event_type="revoked",
                    app_id=app_id,
                    proof_session_id=None,
                    metadata={"reason": "owner_requested"},
                    now_ms=now_ms,
                )
        return dict(row)

    async def fixture_source_hash(
        self,
        *,
        legacy_project: str,
        legacy_user_uuid: str,
    ) -> str | None:
        pool = await get_pool()
        async with pool.acquire() as connection:
            value = await connection.fetchval(
                """
                SELECT source_hash FROM hushh_tech_shadow_records
                WHERE legacy_project = $1 AND legacy_user_uuid = $2
                  AND record_type = 'profile'
                  AND source_deleted = FALSE
                LIMIT 1
                """,
                legacy_project,
                legacy_user_uuid,
            )
        return str(value) if value else None

    async def get_shadow_record(
        self,
        *,
        legacy_project: str,
        legacy_user_uuid: str,
        record_type: str,
    ) -> dict[str, Any] | None:
        pool = await get_pool()
        async with pool.acquire() as connection:
            row = await connection.fetchrow(
                """
                SELECT record_id, record_type, payload, source_hash,
                       source_deleted, imported_at_ms, updated_at_ms
                FROM hushh_tech_shadow_records
                WHERE legacy_project = $1 AND legacy_user_uuid = $2
                  AND record_type = $3 AND source_deleted = FALSE
                LIMIT 1
                """,
                legacy_project,
                legacy_user_uuid,
                record_type,
            )
        if not row:
            return None
        result = dict(row)
        result["payload"] = _json_object(result.get("payload"))
        return result


class HushhTechClientService:
    def __init__(
        self,
        store: HushhTechClientStore | None = None,
        legacy_proof_verifier: LegacySessionProofVerifier | None = None,
    ) -> None:
        self.store = store or PostgresHushhTechClientStore()
        self.legacy_proof_verifier = (
            legacy_proof_verifier or SyntheticFixtureLegacySessionProofVerifier()
        )

    @staticmethod
    def _require_enabled() -> None:
        if not hushh_tech_client_enabled():
            raise HushhTechClientError(
                "FEATURE_DISABLED",
                "Hushh Tech entry is not enabled.",
                status_code=404,
            )

    @staticmethod
    def _require_cohort(firebase_uid: str) -> None:
        clean_uid = str(firebase_uid or "").strip()
        if not _UID_PATTERN.fullmatch(clean_uid):
            raise HushhTechClientError(
                "UNAUTHENTICATED",
                "A valid Firebase session is required.",
                status_code=401,
            )
        if clean_uid not in set(_csv("HUSSH_TECH_UAT_FIREBASE_UID_ALLOWLIST")):
            raise HushhTechClientError(
                "FEATURE_DISABLED",
                "Hushh Tech entry is not enabled for this account.",
                status_code=403,
            )

    @staticmethod
    def _validated_audience(value: str) -> str:
        audience = str(value or "").strip()
        if not audience or audience != str(os.getenv("HUSSH_TECH_ALLOWED_AUDIENCE", "")).strip():
            raise HushhTechClientError(
                "UNAUTHENTICATED",
                "The product audience is not allowed.",
                status_code=401,
            )
        return audience

    @staticmethod
    def _validated_redirect_uri(value: str) -> str:
        try:
            redirect_uri = normalize_redirect_uri(value)
            allowed = {
                normalize_redirect_uri(item) for item in _csv("HUSSH_TECH_ALLOWED_REDIRECT_URIS")
            }
        except OAuthValidationError as exc:
            raise HushhTechClientError(
                "UNAUTHENTICATED",
                "The product redirect is not allowed.",
                status_code=401,
            ) from exc
        if redirect_uri not in allowed:
            raise HushhTechClientError(
                "UNAUTHENTICATED",
                "The product redirect is not allowed.",
                status_code=401,
            )
        return redirect_uri

    @staticmethod
    def _code_hash(code: str) -> str:
        pepper = str(os.getenv("HUSSH_TECH_LAUNCH_PEPPER", "")).encode("utf-8")
        return hmac.new(pepper, code.encode("utf-8"), hashlib.sha256).hexdigest()

    @staticmethod
    def _pkce_digest(verifier: str) -> str:
        digest = hashlib.sha256(verifier.encode("ascii")).digest()
        return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")

    async def authorize_launch(
        self,
        *,
        firebase_uid: str,
        audience: str,
        redirect_uri: str,
        code_challenge: str,
        code_challenge_method: str,
        firebase_valid_after_ms: int,
        now_ms: int | None = None,
    ) -> LaunchAuthorization:
        require_hushh_tech_client_admission(firebase_uid)
        clean_audience = self._validated_audience(audience)
        clean_redirect = self._validated_redirect_uri(redirect_uri)
        if code_challenge_method != "S256" or not _PKCE_CHALLENGE_PATTERN.fullmatch(code_challenge):
            raise HushhTechClientError(
                "UNAUTHENTICATED",
                "PKCE S256 is required.",
                status_code=400,
            )
        created_at_ms = _now_ms() if now_ms is None else int(now_ms)
        code = secrets.token_urlsafe(32)
        authorization = LaunchAuthorization(
            authorization_id=f"htla_{uuid.uuid4().hex}",
            code=code,
            audience=clean_audience,
            redirect_uri=clean_redirect,
            expires_at_ms=created_at_ms + _LAUNCH_TTL_MS,
        )
        await self.store.insert_launch_authorization(
            {
                "authorization_id": authorization.authorization_id,
                "code_hash": self._code_hash(code),
                "firebase_uid": firebase_uid,
                "audience": clean_audience,
                "redirect_uri": clean_redirect,
                "code_challenge": code_challenge,
                "firebase_valid_after_ms": max(0, int(firebase_valid_after_ms)),
                "created_at_ms": created_at_ms,
                "expires_at_ms": authorization.expires_at_ms,
            }
        )
        return authorization

    async def exchange_launch(
        self,
        *,
        code: str,
        code_verifier: str,
        audience: str,
        redirect_uri: str,
        now_ms: int | None = None,
    ) -> dict[str, Any]:
        self._require_enabled()
        if not (20 <= len(str(code or "")) <= 256) or not _PKCE_VERIFIER_PATTERN.fullmatch(
            str(code_verifier or "")
        ):
            raise HushhTechClientError(
                "UNAUTHENTICATED",
                "The launch code is invalid or expired.",
                status_code=401,
            )
        clean_audience = self._validated_audience(audience)
        clean_redirect = self._validated_redirect_uri(redirect_uri)
        current_ms = _now_ms() if now_ms is None else int(now_ms)
        row = await self.store.consume_launch_authorization(
            code_hash=self._code_hash(str(code)),
            code_challenge=self._pkce_digest(str(code_verifier)),
            audience=clean_audience,
            redirect_uri=clean_redirect,
            now_ms=current_ms,
        )
        if not row:
            raise HushhTechClientError(
                "UNAUTHENTICATED",
                "The launch code is invalid or expired.",
                status_code=401,
            )
        self._require_cohort(str(row.get("firebase_uid") or ""))
        return row

    async def get_link_status(self, *, firebase_uid: str, app_id: str) -> dict[str, Any]:
        require_hushh_tech_client_admission(firebase_uid)
        link = await self.store.get_active_link(firebase_uid=firebase_uid, app_id=app_id)
        if not link:
            return {"state": "LINK_REQUIRED", "linked": False}
        return {
            "state": "READY",
            "linked": True,
            "link_id": str(link.get("link_id") or ""),
            "legacy_project": str(link.get("legacy_project") or ""),
            "linked_at_ms": int(link.get("linked_at_ms") or 0),
        }

    async def verify_and_link_account(
        self,
        *,
        firebase_uid: str,
        app_id: str,
        legacy_session_proof: str,
        legacy_proof_signing_key: str,
        now_ms: int | None = None,
    ) -> dict[str, Any]:
        require_hushh_tech_client_admission(firebase_uid)
        current_ms = _now_ms() if now_ms is None else int(now_ms)
        try:
            proof = self.legacy_proof_verifier.verify(
                legacy_session_proof,
                signing_key=legacy_proof_signing_key,
                now_ms=current_ms,
            )
        except LegacySessionProofError as exc:
            raise HushhTechClientError(
                "LINK_REQUIRED",
                "A verified legacy session is required.",
                status_code=exc.status_code,
            ) from exc
        expected_audience = str(os.getenv("HUSSH_TECH_ALLOWED_AUDIENCE", "")).strip()
        if not (
            hmac.compare_digest(proof.firebase_uid, firebase_uid)
            and hmac.compare_digest(proof.app_id, app_id)
            and hmac.compare_digest(proof.audience, expected_audience)
        ):
            raise HushhTechClientError(
                "LINK_REQUIRED",
                "The verified legacy session belongs to another product session.",
                status_code=403,
            )
        fixture_hash = await self.store.fixture_source_hash(
            legacy_project=proof.legacy_project,
            legacy_user_uuid=proof.legacy_user_uuid,
        )
        if not fixture_hash or not hmac.compare_digest(fixture_hash, proof.source_hash):
            raise HushhTechClientError(
                "LINK_REQUIRED",
                "A verified synthetic legacy account is required.",
                status_code=403,
            )
        result = await self.store.link_account(
            firebase_uid=firebase_uid,
            legacy_project=proof.legacy_project,
            legacy_user_uuid=proof.legacy_user_uuid,
            app_id=app_id,
            proof_session_id=proof.session_id,
            metadata={
                "proof_type": "signed_synthetic_fixture",
                "fixture_source_hash": proof.source_hash,
            },
            now_ms=current_ms,
        )
        if result.get("outcome") == "conflict":
            raise HushhTechClientError(
                "LINK_CONFLICT",
                "This product account is already linked to another Firebase account.",
                status_code=409,
            )
        if result.get("outcome") == "proof_replayed":
            raise HushhTechClientError(
                "LINK_REQUIRED",
                "A new verified legacy session is required.",
                status_code=409,
            )
        link = result.get("link") or {}
        return {
            "state": "READY",
            "linked": True,
            "reused": result.get("outcome") == "already_linked",
            "recovered": result.get("outcome") == "recovered",
            "link_id": str(link.get("link_id") or ""),
            "legacy_project": str(link.get("legacy_project") or proof.legacy_project),
        }

    async def revoke_link(
        self,
        *,
        firebase_uid: str,
        app_id: str,
        now_ms: int | None = None,
    ) -> dict[str, Any]:
        require_hushh_tech_client_admission(firebase_uid)
        row = await self.store.revoke_link(
            firebase_uid=firebase_uid,
            app_id=app_id,
            now_ms=_now_ms() if now_ms is None else int(now_ms),
        )
        return {"state": "LINK_REQUIRED", "linked": False, "revoked": bool(row)}

    async def get_shadow(
        self,
        *,
        firebase_uid: str,
        app_id: str,
        record_type: str,
        now_ms: int | None = None,
    ) -> dict[str, Any]:
        require_hushh_tech_client_admission(firebase_uid)
        clean_type = str(record_type or "").strip().lower()
        if clean_type not in _SHADOW_RECORD_TYPES:
            raise HushhTechClientError(
                "FEATURE_DISABLED",
                "This Hushh Tech feature is not available for the UAT cohort.",
                status_code=404,
            )
        link = await self.store.get_active_link(firebase_uid=firebase_uid, app_id=app_id)
        if not link:
            raise HushhTechClientError(
                "LINK_REQUIRED",
                "Link the product account before using this feature.",
                status_code=409,
            )
        record = await self.store.get_shadow_record(
            legacy_project=str(link["legacy_project"]),
            legacy_user_uuid=str(link["legacy_user_uuid"]),
            record_type=clean_type,
        )
        if not record:
            raise HushhTechClientError(
                "STALE_SHADOW",
                "The product information is not ready.",
                status_code=503,
            )
        payload = _json_object(record.get("payload"))
        current_ms = _now_ms() if now_ms is None else int(now_ms)
        fresh_until_ms = int(payload.get("fresh_until_ms") or 0)
        configured_max_age = str(
            os.getenv("HUSSH_TECH_SHADOW_MAX_AGE_MS", str(7 * 24 * 60 * 60 * 1000))
        ).strip()
        try:
            max_age_ms = max(1, int(configured_max_age))
        except ValueError:
            max_age_ms = 7 * 24 * 60 * 60 * 1000
        updated_at_ms = int(record.get("updated_at_ms") or 0)
        if (
            (fresh_until_ms and fresh_until_ms <= current_ms)
            or updated_at_ms <= 0
            or current_ms - updated_at_ms > max_age_ms
        ):
            raise HushhTechClientError(
                "STALE_SHADOW",
                "The product information is stale.",
                status_code=503,
            )
        return {
            "state": "READY",
            "record_type": clean_type,
            "payload": payload,
            "source_hash": str(record.get("source_hash") or ""),
            "updated_at_ms": updated_at_ms,
        }


__all__ = [
    "HushhTechClientError",
    "HushhTechClientService",
    "HushhTechClientStore",
    "LaunchAuthorization",
    "PostgresHushhTechClientStore",
    "hushh_tech_client_enabled",
    "require_hushh_tech_client_admission",
]
