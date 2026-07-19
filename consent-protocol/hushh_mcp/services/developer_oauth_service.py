"""OAuth 2.1 / PKCE support for registered developer applications.

OAuth authenticates a developer application to the MCP transport.  It never
grants access to a person's information: the existing consent lifecycle and
the encrypted export boundary continue to govern that separately.
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
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from db.db_client import get_db
from hushh_mcp.runtime_settings import get_core_security_settings
from hushh_mcp.services.developer_registry_service import (
    SCHEMA_PROFILE_AGENTFORCE,
    SCHEMA_PROFILE_FLAT,
    DeveloperPrincipal,
    DeveloperRegistryService,
)

_ACCESS_TOKEN_TTL_SECONDS = 60 * 60
_REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30
_AUTHORIZATION_TTL_SECONDS = 10 * 60
_MAX_REDIRECT_URIS = 10
_MCP_SCOPE = "mcp:tools"
_PKCE_VALUE_RE = re.compile(r"^[A-Za-z0-9_-]{43,128}$")


class OAuthValidationError(ValueError):
    """A stable OAuth validation failure safe to return to a client."""

    def __init__(self, code: str, message: str):
        self.code = code
        self.message = message
        super().__init__(message)


@dataclass(frozen=True)
class OAuthClient:
    app_id: str
    client_id: str
    client_secret_prefix: str
    redirect_uris: tuple[str, ...]
    created_at: int
    secret_rotated_at: int


def _now_ms() -> int:
    return int(time.time() * 1000)


def _oauth_pepper() -> str:
    configured = str(os.getenv("DEVELOPER_OAUTH_PEPPER", "")).strip()
    if configured:
        return configured
    configured = str(os.getenv("DEVELOPER_TOKEN_PEPPER", "")).strip()
    if configured:
        return configured
    try:
        return get_core_security_settings().app_signing_key
    except ValueError:
        # Local/offline tests still need deterministic hashing.  Production
        # startup must supply an application signing key before this can occur.
        return "hushh-oauth-local-development-pepper"


def _hash_secret(value: str) -> str:
    return hmac.new(
        _oauth_pepper().encode("utf-8"), value.encode("utf-8"), hashlib.sha256
    ).hexdigest()


def _json_list(value: Any) -> tuple[str, ...]:
    if isinstance(value, list):
        return tuple(str(item).strip() for item in value if str(item).strip())
    if isinstance(value, str):
        try:
            loaded = json.loads(value)
        except json.JSONDecodeError:
            return ()
        return _json_list(loaded)
    return ()


def normalize_redirect_uri(value: str) -> str:
    """Validate a redirect URI once, then require byte-for-byte equality."""
    raw = str(value or "").strip()
    if not raw or len(raw) > 2048:
        raise OAuthValidationError("invalid_request", "A valid redirect_uri is required.")
    try:
        parts = urlsplit(raw)
    except ValueError as exc:
        raise OAuthValidationError("invalid_request", "A valid redirect_uri is required.") from exc
    hostname = (parts.hostname or "").lower()
    if parts.fragment or not parts.scheme or not parts.netloc or parts.username or parts.password:
        raise OAuthValidationError("invalid_request", "A valid redirect_uri is required.")
    local_loopback = hostname in {"localhost", "127.0.0.1", "::1"}
    if parts.scheme != "https" and not (parts.scheme == "http" and local_loopback):
        raise OAuthValidationError(
            "invalid_request", "redirect_uri must use HTTPS (loopback HTTP is allowed)."
        )
    # urlsplit lower-cases neither scheme nor netloc; canonicalise only values
    # that are semantically case-insensitive so portal validation is reliable.
    netloc = parts.netloc.lower()
    return urlunsplit((parts.scheme.lower(), netloc, parts.path or "/", parts.query, ""))


def append_oauth_parameters(uri: str, params: dict[str, str]) -> str:
    """Append OAuth response parameters without changing a registered URI."""
    from urllib.parse import parse_qsl, urlencode

    parts = urlsplit(uri)
    query = parse_qsl(parts.query, keep_blank_values=True)
    query.extend((key, value) for key, value in params.items() if value)
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), ""))


class DeveloperOAuthService:
    _tables_ensured = False

    def __init__(self) -> None:
        self._db = get_db()
        self._registry = DeveloperRegistryService()

    def ensure_tables(self) -> None:
        if self.__class__._tables_ensured:
            return
        # Migration 099 is authoritative.  These statements are a narrowly
        # scoped boot safety-net, matching the developer registry convention.
        if str(os.getenv("DB_OFFLINE", "0")).strip().lower() in {"1", "true", "yes", "on"}:
            statements = [
                """CREATE TABLE IF NOT EXISTS developer_oauth_clients (
                    app_id TEXT PRIMARY KEY, client_id TEXT NOT NULL UNIQUE,
                    client_secret_hash TEXT NOT NULL, client_secret_prefix TEXT NOT NULL,
                    redirect_uris TEXT NOT NULL, created_at INTEGER NOT NULL,
                    secret_rotated_at INTEGER NOT NULL, revoked_at INTEGER)""",
                """CREATE TABLE IF NOT EXISTS developer_oauth_authorizations (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, transaction_ref TEXT NOT NULL UNIQUE,
                    code_hash TEXT UNIQUE, app_id TEXT NOT NULL, client_id TEXT NOT NULL,
                    redirect_uri TEXT NOT NULL, code_challenge TEXT NOT NULL,
                    subject_firebase_uid TEXT, requested_scope TEXT NOT NULL,
                    state TEXT, status TEXT NOT NULL, expires_at INTEGER NOT NULL,
                    created_at INTEGER NOT NULL, consumed_at INTEGER)""",
                """CREATE TABLE IF NOT EXISTS developer_oauth_tokens (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, token_hash TEXT NOT NULL UNIQUE,
                    token_prefix TEXT NOT NULL, token_kind TEXT NOT NULL, app_id TEXT NOT NULL,
                    subject_firebase_uid TEXT, authorization_id INTEGER,
                    scopes TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
                    revoked_at INTEGER, last_used_at INTEGER,
                    grant_type TEXT NOT NULL DEFAULT 'authorization_code')""",
                """CREATE TABLE IF NOT EXISTS developer_oauth_audit_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, app_id TEXT NOT NULL,
                    client_id TEXT, subject_firebase_uid TEXT, event_type TEXT NOT NULL,
                    created_at INTEGER NOT NULL)""",
            ]
        else:
            statements = [
                """CREATE TABLE IF NOT EXISTS developer_oauth_clients (
                    app_id TEXT PRIMARY KEY REFERENCES developer_apps(app_id) ON DELETE CASCADE,
                    client_id TEXT NOT NULL UNIQUE, client_secret_hash TEXT NOT NULL,
                    client_secret_prefix TEXT NOT NULL, redirect_uris JSONB NOT NULL DEFAULT '[]'::jsonb,
                    created_at BIGINT NOT NULL, secret_rotated_at BIGINT NOT NULL, revoked_at BIGINT)""",
                """CREATE TABLE IF NOT EXISTS developer_oauth_authorizations (
                    id BIGSERIAL PRIMARY KEY, transaction_ref TEXT NOT NULL UNIQUE,
                    code_hash TEXT UNIQUE, app_id TEXT NOT NULL REFERENCES developer_apps(app_id) ON DELETE CASCADE,
                    client_id TEXT NOT NULL REFERENCES developer_oauth_clients(client_id) ON DELETE CASCADE,
                    redirect_uri TEXT NOT NULL, code_challenge TEXT NOT NULL,
                    subject_firebase_uid TEXT, requested_scope TEXT NOT NULL,
                    state TEXT, status TEXT NOT NULL, expires_at BIGINT NOT NULL,
                    created_at BIGINT NOT NULL, consumed_at BIGINT)""",
                """CREATE TABLE IF NOT EXISTS developer_oauth_tokens (
                    id BIGSERIAL PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE,
                    token_prefix TEXT NOT NULL, token_kind TEXT NOT NULL,
                    app_id TEXT NOT NULL REFERENCES developer_apps(app_id) ON DELETE CASCADE,
                    subject_firebase_uid TEXT,
                    authorization_id BIGINT REFERENCES developer_oauth_authorizations(id) ON DELETE SET NULL,
                    scopes JSONB NOT NULL DEFAULT '["mcp:tools"]'::jsonb,
                    created_at BIGINT NOT NULL, expires_at BIGINT NOT NULL,
                    revoked_at BIGINT, last_used_at BIGINT,
                    grant_type TEXT NOT NULL DEFAULT 'authorization_code',
                    CONSTRAINT developer_oauth_token_kind_check CHECK (token_kind IN ('access', 'refresh')))""",
                """CREATE TABLE IF NOT EXISTS developer_oauth_audit_events (
                    id BIGSERIAL PRIMARY KEY, app_id TEXT NOT NULL,
                    client_id TEXT, subject_firebase_uid TEXT,
                    event_type TEXT NOT NULL, created_at BIGINT NOT NULL)""",
            ]
        for statement in statements:
            self._db.execute_raw(statement, {})
        if str(os.getenv("DB_OFFLINE", "0")).strip().lower() not in {"1", "true", "yes", "on"}:
            # Migration 105 is authoritative. These additive statements keep a
            # newly booted service safe against a narrowly lagging database.
            self._db.execute_raw(
                "ALTER TABLE developer_oauth_tokens ALTER COLUMN subject_firebase_uid DROP NOT NULL",
                {},
            )
            self._db.execute_raw(
                "ALTER TABLE developer_oauth_tokens ADD COLUMN IF NOT EXISTS grant_type TEXT NOT NULL DEFAULT 'authorization_code'",
                {},
            )
        self.__class__._tables_ensured = True

    def _audit(
        self, *, app_id: str, client_id: str | None, subject: str | None, event: str
    ) -> None:
        self._db.execute_raw(
            """INSERT INTO developer_oauth_audit_events
               (app_id, client_id, subject_firebase_uid, event_type, created_at)
               VALUES (:app_id, :client_id, :subject, :event, :created_at)""",
            {
                "app_id": app_id,
                "client_id": client_id,
                "subject": subject,
                "event": event,
                "created_at": _now_ms(),
            },
        )

    @staticmethod
    def _client_from_row(row: dict[str, Any]) -> OAuthClient:
        return OAuthClient(
            app_id=str(row["app_id"]),
            client_id=str(row["client_id"]),
            client_secret_prefix=str(row["client_secret_prefix"]),
            redirect_uris=_json_list(row.get("redirect_uris")),
            created_at=int(row["created_at"]),
            secret_rotated_at=int(row["secret_rotated_at"]),
        )

    def get_client_for_app(self, app_id: str) -> OAuthClient | None:
        self.ensure_tables()
        result = self._db.execute_raw(
            """SELECT app_id, client_id, client_secret_prefix, redirect_uris, created_at, secret_rotated_at
               FROM developer_oauth_clients WHERE app_id = :app_id AND revoked_at IS NULL LIMIT 1""",
            {"app_id": app_id},
        )
        return self._client_from_row(result.data[0]) if result.data else None

    def get_client(self, client_id: str) -> OAuthClient | None:
        self.ensure_tables()
        result = self._db.execute_raw(
            """SELECT app_id, client_id, client_secret_prefix, redirect_uris, created_at, secret_rotated_at
               FROM developer_oauth_clients WHERE client_id = :client_id AND revoked_at IS NULL LIMIT 1""",
            {"client_id": client_id},
        )
        return self._client_from_row(result.data[0]) if result.data else None

    def create_or_rotate_client(self, *, app_id: str) -> tuple[OAuthClient, str]:
        self.ensure_tables()
        current = self.get_client_for_app(app_id)
        now = _now_ms()
        raw_secret = f"hcs_{secrets.token_urlsafe(32)}"
        secret_prefix = raw_secret[:12]
        if current is None:
            client_id = f"hco_{secrets.token_urlsafe(18)}"
            redirect_uris: tuple[str, ...] = ()
            if str(os.getenv("DB_OFFLINE", "0")).strip().lower() in {"1", "true", "yes", "on"}:
                statement = """INSERT INTO developer_oauth_clients (app_id, client_id, client_secret_hash, client_secret_prefix, redirect_uris, created_at, secret_rotated_at)
                VALUES (:app_id, :client_id, :secret_hash, :secret_prefix, :redirect_uris, :created_at, :rotated_at)"""
            else:
                statement = """INSERT INTO developer_oauth_clients (app_id, client_id, client_secret_hash, client_secret_prefix, redirect_uris, created_at, secret_rotated_at)
                VALUES (:app_id, :client_id, :secret_hash, :secret_prefix, CAST(:redirect_uris AS JSONB), :created_at, :rotated_at)"""
            self._db.execute_raw(
                statement,
                {
                    "app_id": app_id,
                    "client_id": client_id,
                    "secret_hash": _hash_secret(raw_secret),
                    "secret_prefix": secret_prefix,
                    "redirect_uris": json.dumps(redirect_uris),
                    "created_at": now,
                    "rotated_at": now,
                },
            )
        else:
            client_id = current.client_id
            redirect_uris = current.redirect_uris
            self._db.execute_raw(
                """UPDATE developer_oauth_clients SET client_secret_hash = :secret_hash,
                   client_secret_prefix = :secret_prefix, secret_rotated_at = :rotated_at
                   WHERE app_id = :app_id AND revoked_at IS NULL""",
                {
                    "app_id": app_id,
                    "secret_hash": _hash_secret(raw_secret),
                    "secret_prefix": secret_prefix,
                    "rotated_at": now,
                },
            )
            self._db.execute_raw(
                "UPDATE developer_oauth_tokens SET revoked_at = :revoked_at WHERE app_id = :app_id AND revoked_at IS NULL",
                {"app_id": app_id, "revoked_at": now},
            )
        client = self.get_client(client_id)
        if client is None:
            raise RuntimeError("OAuth client creation did not persist.")
        self._audit(
            app_id=app_id, client_id=client.client_id, subject=None, event="client_secret_rotated"
        )
        return client, raw_secret

    def update_redirect_uris(self, *, app_id: str, redirect_uris: list[str]) -> OAuthClient:
        normalized = tuple(dict.fromkeys(normalize_redirect_uri(value) for value in redirect_uris))
        if len(normalized) > _MAX_REDIRECT_URIS:
            raise OAuthValidationError(
                "invalid_request", "At most 10 redirect URIs may be registered."
            )
        self.ensure_tables()
        client = self.get_client_for_app(app_id)
        if client is None:
            raise OAuthValidationError(
                "invalid_client", "Create an OAuth client before registering redirects."
            )
        if str(os.getenv("DB_OFFLINE", "0")).strip().lower() in {"1", "true", "yes", "on"}:
            statement = "UPDATE developer_oauth_clients SET redirect_uris = :redirect_uris WHERE app_id = :app_id"
        else:
            statement = "UPDATE developer_oauth_clients SET redirect_uris = CAST(:redirect_uris AS JSONB) WHERE app_id = :app_id"
        self._db.execute_raw(statement, {"app_id": app_id, "redirect_uris": json.dumps(normalized)})
        self._audit(
            app_id=app_id, client_id=client.client_id, subject=None, event="redirect_uris_updated"
        )
        updated = self.get_client(client.client_id)
        if updated is None:
            raise RuntimeError("OAuth client update did not persist.")
        return updated

    def verify_client_secret(self, *, client_id: str, client_secret: str | None) -> OAuthClient:
        self.ensure_tables()
        result = self._db.execute_raw(
            """SELECT app_id, client_id, client_secret_hash, client_secret_prefix, redirect_uris, created_at, secret_rotated_at
               FROM developer_oauth_clients WHERE client_id = :client_id AND revoked_at IS NULL LIMIT 1""",
            {"client_id": client_id},
        )
        if not result.data or not client_secret:
            raise OAuthValidationError("invalid_client", "Client authentication failed.")
        row = result.data[0]
        if not hmac.compare_digest(
            str(row.get("client_secret_hash") or ""), _hash_secret(client_secret)
        ):
            raise OAuthValidationError("invalid_client", "Client authentication failed.")
        return self._client_from_row(row)

    def begin_authorization(
        self,
        *,
        client_id: str,
        redirect_uri: str,
        code_challenge: str,
        state: str | None,
        scope: str | None,
    ) -> str:
        client = self.get_client(client_id)
        if client is None:
            raise OAuthValidationError("invalid_client", "Unknown OAuth client.")
        normalized_uri = normalize_redirect_uri(redirect_uri)
        if normalized_uri not in client.redirect_uris:
            raise OAuthValidationError(
                "invalid_request", "redirect_uri is not registered for this client."
            )
        challenge = str(code_challenge or "").strip()
        if not _PKCE_VALUE_RE.fullmatch(challenge):
            raise OAuthValidationError(
                "invalid_request", "A valid S256 code_challenge is required."
            )
        requested_scope = str(scope or _MCP_SCOPE).strip()
        if requested_scope != _MCP_SCOPE:
            raise OAuthValidationError("invalid_scope", "Only the mcp:tools scope is supported.")
        reference = f"oar_{secrets.token_hex(16)}"
        now = _now_ms()
        self.ensure_tables()
        self._db.execute_raw(
            """INSERT INTO developer_oauth_authorizations
               (transaction_ref, app_id, client_id, redirect_uri, code_challenge, requested_scope, state, status, expires_at, created_at)
               VALUES (:transaction_ref, :app_id, :client_id, :redirect_uri, :code_challenge, :requested_scope, :state, 'pending', :expires_at, :created_at)""",
            {
                "transaction_ref": reference,
                "app_id": client.app_id,
                "client_id": client.client_id,
                "redirect_uri": normalized_uri,
                "code_challenge": challenge,
                "requested_scope": requested_scope,
                "state": str(state or "")[:512] or None,
                "expires_at": now + _AUTHORIZATION_TTL_SECONDS * 1000,
                "created_at": now,
            },
        )
        self._audit(
            app_id=client.app_id,
            client_id=client.client_id,
            subject=None,
            event="authorization_started",
        )
        return reference

    def approve_authorization(self, *, transaction_ref: str, subject_firebase_uid: str) -> str:
        self.ensure_tables()
        raw_code = f"hca_{secrets.token_urlsafe(32)}"
        now = _now_ms()
        result = self._db.execute_raw(
            """UPDATE developer_oauth_authorizations
               SET code_hash = :code_hash, subject_firebase_uid = :subject, status = 'issued'
               WHERE transaction_ref = :transaction_ref AND status = 'pending' AND expires_at > :now
               RETURNING app_id, client_id""",
            {
                "code_hash": _hash_secret(raw_code),
                "subject": subject_firebase_uid,
                "transaction_ref": transaction_ref,
                "now": now,
            },
        )
        if not result.data:
            raise OAuthValidationError(
                "invalid_request", "This authorization request is no longer available."
            )
        row = result.data[0]
        self._audit(
            app_id=str(row["app_id"]),
            client_id=str(row["client_id"]),
            subject=subject_firebase_uid,
            event="authorization_approved",
        )
        return raw_code

    def authorization_redirect(self, *, transaction_ref: str) -> dict[str, str] | None:
        self.ensure_tables()
        result = self._db.execute_raw(
            """SELECT redirect_uri, state FROM developer_oauth_authorizations
               WHERE transaction_ref = :transaction_ref LIMIT 1""",
            {"transaction_ref": transaction_ref},
        )
        if not result.data:
            return None
        row = result.data[0]
        return {
            "redirect_uri": str(row.get("redirect_uri") or ""),
            "state": str(row.get("state") or ""),
        }

    def deny_authorization(
        self, *, transaction_ref: str, subject_firebase_uid: str
    ) -> dict[str, str]:
        self.ensure_tables()
        result = self._db.execute_raw(
            """UPDATE developer_oauth_authorizations SET subject_firebase_uid = :subject, status = 'denied'
               WHERE transaction_ref = :transaction_ref AND status = 'pending' AND expires_at > :now
               RETURNING app_id, client_id, redirect_uri, state""",
            {"transaction_ref": transaction_ref, "subject": subject_firebase_uid, "now": _now_ms()},
        )
        if not result.data:
            raise OAuthValidationError(
                "invalid_request", "This authorization request is no longer available."
            )
        row = result.data[0]
        self._audit(
            app_id=str(row["app_id"]),
            client_id=str(row["client_id"]),
            subject=subject_firebase_uid,
            event="authorization_denied",
        )
        return {key: str(row.get(key) or "") for key in ("redirect_uri", "state")}

    def _issue_tokens(
        self,
        *,
        app_id: str,
        subject: str | None,
        authorization_id: int | None,
        scopes: tuple[str, ...],
        include_refresh_token: bool = True,
        grant_type: str = "authorization_code",
    ) -> dict[str, Any]:
        now = _now_ms()
        access_token = f"hdo_at_{secrets.token_urlsafe(32)}"
        refresh_token = f"hdo_rt_{secrets.token_urlsafe(40)}" if include_refresh_token else None
        values = []
        token_specs: list[tuple[str, str, int]] = [
            (access_token, "access", _ACCESS_TOKEN_TTL_SECONDS)
        ]
        if refresh_token:
            token_specs.append((refresh_token, "refresh", _REFRESH_TOKEN_TTL_SECONDS))
        for raw, kind, ttl in token_specs:
            values.append(
                {
                    "token_hash": _hash_secret(raw),
                    "token_prefix": raw[:14],
                    "token_kind": kind,
                    "app_id": app_id,
                    "subject": subject,
                    "authorization_id": authorization_id,
                    "scopes": json.dumps(scopes),
                    "created_at": now,
                    "expires_at": now + ttl * 1000,
                    "grant_type": grant_type,
                }
            )
        if str(os.getenv("DB_OFFLINE", "0")).strip().lower() in {"1", "true", "yes", "on"}:
            statement = """INSERT INTO developer_oauth_tokens (token_hash, token_prefix, token_kind, app_id, subject_firebase_uid, authorization_id, scopes, created_at, expires_at, grant_type) VALUES (:token_hash, :token_prefix, :token_kind, :app_id, :subject, :authorization_id, :scopes, :created_at, :expires_at, :grant_type)"""
        else:
            statement = """INSERT INTO developer_oauth_tokens (token_hash, token_prefix, token_kind, app_id, subject_firebase_uid, authorization_id, scopes, created_at, expires_at, grant_type) VALUES (:token_hash, :token_prefix, :token_kind, :app_id, :subject, :authorization_id, CAST(:scopes AS JSONB), :created_at, :expires_at, :grant_type)"""
        for value in values:
            self._db.execute_raw(statement, value)
        payload = {
            "access_token": access_token,
            "token_type": "Bearer",
            "expires_in": _ACCESS_TOKEN_TTL_SECONDS,
            "scope": " ".join(scopes),
        }
        if refresh_token:
            payload["refresh_token"] = refresh_token
        return payload

    @staticmethod
    def _database_bool(value: Any) -> bool:
        return value is True or str(value).strip().lower() in {"1", "true", "yes", "on"}

    def issue_client_credentials(
        self, *, client: OAuthClient, scope: str | None = None
    ) -> dict[str, Any]:
        """Issue an app-bound access token for an explicitly provisioned connector."""

        requested_scope = str(scope or _MCP_SCOPE).strip() or _MCP_SCOPE
        if requested_scope != _MCP_SCOPE:
            raise OAuthValidationError("invalid_scope", "Only the mcp:tools scope is available.")
        app = self._registry.get_app(client.app_id)
        if (
            not app
            or str(app.get("status") or "") != "active"
            or str(app.get("kind") or "") != "partner_crm"
            or str(app.get("schema_profile") or "")
            not in {SCHEMA_PROFILE_FLAT, SCHEMA_PROFILE_AGENTFORCE}
            or not self._database_bool(app.get("oauth_client_credentials_enabled"))
        ):
            raise OAuthValidationError(
                "unauthorized_client",
                "Client credentials are not enabled for this developer app.",
            )
        tokens = self._issue_tokens(
            app_id=client.app_id,
            subject=None,
            authorization_id=None,
            scopes=(_MCP_SCOPE,),
            include_refresh_token=False,
            grant_type="client_credentials",
        )
        self._audit(
            app_id=client.app_id,
            client_id=client.client_id,
            subject=None,
            event="client_credentials_exchanged",
        )
        return tokens

    def exchange_authorization_code(
        self, *, client: OAuthClient, code: str, redirect_uri: str, code_verifier: str
    ) -> dict[str, Any]:
        verifier = str(code_verifier or "").strip()
        if not _PKCE_VALUE_RE.fullmatch(verifier):
            raise OAuthValidationError("invalid_grant", "Authorization code validation failed.")
        result = self._db.execute_raw(
            """SELECT id, app_id, client_id, redirect_uri, code_challenge, subject_firebase_uid, requested_scope
               FROM developer_oauth_authorizations
               WHERE code_hash = :code_hash AND client_id = :client_id AND status = 'issued' AND expires_at > :now LIMIT 1""",
            {"code_hash": _hash_secret(code), "client_id": client.client_id, "now": _now_ms()},
        )
        if not result.data:
            raise OAuthValidationError("invalid_grant", "Authorization code validation failed.")
        row = result.data[0]
        if normalize_redirect_uri(redirect_uri) != str(row["redirect_uri"]):
            raise OAuthValidationError("invalid_grant", "Authorization code validation failed.")
        challenge = (
            base64.urlsafe_b64encode(hashlib.sha256(verifier.encode("utf-8")).digest())
            .decode("ascii")
            .rstrip("=")
        )
        if not hmac.compare_digest(challenge, str(row["code_challenge"])):
            raise OAuthValidationError("invalid_grant", "Authorization code validation failed.")
        consumed = self._db.execute_raw(
            """UPDATE developer_oauth_authorizations SET status = 'consumed', consumed_at = :now
               WHERE id = :id AND status = 'issued' RETURNING id""",
            {"id": row["id"], "now": _now_ms()},
        )
        if not consumed.data:
            raise OAuthValidationError("invalid_grant", "Authorization code validation failed.")
        tokens = self._issue_tokens(
            app_id=str(row["app_id"]),
            subject=str(row["subject_firebase_uid"]),
            authorization_id=int(row["id"]),
            scopes=(str(row["requested_scope"]),),
        )
        self._audit(
            app_id=str(row["app_id"]),
            client_id=client.client_id,
            subject=str(row["subject_firebase_uid"]),
            event="authorization_code_exchanged",
        )
        return tokens

    def refresh(self, *, client: OAuthClient, refresh_token: str) -> dict[str, Any]:
        result = self._db.execute_raw(
            """SELECT id, app_id, subject_firebase_uid, authorization_id, scopes
               FROM developer_oauth_tokens WHERE token_hash = :token_hash AND token_kind = 'refresh'
               AND app_id = :app_id AND revoked_at IS NULL AND expires_at > :now LIMIT 1""",
            {"token_hash": _hash_secret(refresh_token), "app_id": client.app_id, "now": _now_ms()},
        )
        if not result.data:
            raise OAuthValidationError("invalid_grant", "Refresh token validation failed.")
        row = result.data[0]
        revoked = self._db.execute_raw(
            "UPDATE developer_oauth_tokens SET revoked_at = :now WHERE id = :id AND revoked_at IS NULL RETURNING id",
            {"id": row["id"], "now": _now_ms()},
        )
        if not revoked.data:
            raise OAuthValidationError("invalid_grant", "Refresh token validation failed.")
        tokens = self._issue_tokens(
            app_id=client.app_id,
            subject=str(row["subject_firebase_uid"]),
            authorization_id=row.get("authorization_id"),
            scopes=_json_list(row.get("scopes")) or (_MCP_SCOPE,),
        )
        self._audit(
            app_id=client.app_id,
            client_id=client.client_id,
            subject=str(row["subject_firebase_uid"]),
            event="refresh_token_rotated",
        )
        return tokens

    def revoke(self, *, client: OAuthClient, token: str) -> None:
        self.ensure_tables()
        result = self._db.execute_raw(
            """UPDATE developer_oauth_tokens SET revoked_at = :now
               WHERE token_hash = :token_hash AND app_id = :app_id AND revoked_at IS NULL RETURNING subject_firebase_uid""",
            {"token_hash": _hash_secret(token), "app_id": client.app_id, "now": _now_ms()},
        )
        subject = str(result.data[0].get("subject_firebase_uid") or "") if result.data else None
        self._audit(
            app_id=client.app_id, client_id=client.client_id, subject=subject, event="token_revoked"
        )

    def authenticate_access_token(
        self, raw_token: str, *, ip_address: str | None = None, user_agent: str | None = None
    ) -> DeveloperPrincipal | None:
        if not str(raw_token or "").startswith("hdo_at_"):
            return None
        self.ensure_tables()
        result = self._db.execute_raw(
            """SELECT apps.app_id, apps.agent_id, apps.display_name, apps.allowed_tool_groups,
                      apps.allowed_capabilities, apps.support_url, apps.policy_url, apps.website_url,
                      apps.brand_image_url, apps.contact_email, apps.kind, apps.crm_id,
                      apps.schema_profile, apps.oauth_client_credentials_enabled,
                      tokens.id AS token_id
               FROM developer_oauth_tokens AS tokens
               INNER JOIN developer_apps AS apps ON apps.app_id = tokens.app_id
               WHERE tokens.token_hash = :token_hash AND tokens.token_kind = 'access'
                 AND tokens.revoked_at IS NULL AND tokens.expires_at > :now AND apps.status = 'active' LIMIT 1""",
            {"token_hash": _hash_secret(raw_token), "now": _now_ms()},
        )
        if not result.data:
            return None
        row = dict(result.data[0])
        row["auth_source"] = "oauth"
        principal = self._registry._principal_from_row(row)
        self._db.execute_raw(
            "UPDATE developer_oauth_tokens SET last_used_at = :now WHERE id = :id",
            {"id": row["token_id"], "now": _now_ms()},
        )
        return principal
