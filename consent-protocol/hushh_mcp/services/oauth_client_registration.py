"""External OAuth client metadata, without information or consent authority."""

from __future__ import annotations

import asyncio
import hashlib
import json
import secrets
from typing import Any
from urllib.parse import urlsplit

import httpx
from sqlalchemy import text
from starlette.concurrency import run_in_threadpool

from hushh_mcp.services.developer_oauth_service import (
    DeveloperOAuthService,
    OAuthClient,
    OAuthValidationError,
    _hash_secret,
    _now_ms,
    normalize_redirect_uri,
)
from hushh_mcp.services.mcp_public_http import (
    McpResponseLimitError,
    UnsafeMcpEndpoint,
    create_public_mcp_http_client,
    validate_mcp_endpoint,
)

MAX_METADATA_BYTES = 5 * 1024
_METADATA_FETCH_SLOTS = asyncio.Semaphore(4)


def validate_client_metadata(value: Any, *, cimd: bool = False) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise OAuthValidationError("invalid_client_metadata", "Expected a metadata object.")
    redirects = value.get("redirect_uris")
    if not isinstance(redirects, list) or not 1 <= len(redirects) <= 10:
        raise OAuthValidationError("invalid_redirect_uri", "Register 1 to 10 exact callbacks.")
    for uri in redirects:
        if not isinstance(uri, str) or uri != uri.strip():
            raise OAuthValidationError("invalid_redirect_uri", "Invalid callback URI.")
        try:
            normalize_redirect_uri(uri)
        except OAuthValidationError as exc:
            raise OAuthValidationError("invalid_redirect_uri", "Invalid callback URI.") from exc
        # Keep the original string: OAuth compares callbacks byte for byte.
        if "\\" in uri or any(ord(char) <= 32 or ord(char) == 127 for char in uri):
            raise OAuthValidationError("invalid_redirect_uri", "Invalid callback URI.")
    grants = value.get("grant_types", ["authorization_code"])
    responses = value.get("response_types", ["code"])
    if (
        not isinstance(grants, list)
        or not all(isinstance(grant, str) for grant in grants)
        or "authorization_code" not in grants
        or not isinstance(responses, list)
        or "code" not in responses
        or (
            not cimd
            and (
                any(grant not in {"authorization_code", "refresh_token"} for grant in grants)
                or responses != ["code"]
            )
        )
    ):
        raise OAuthValidationError(
            "invalid_client_metadata", "Only authorization code is supported."
        )
    # CIMD describes capabilities, not privileges requested from this server.
    grants = [grant for grant in grants if grant in {"authorization_code", "refresh_token"}]
    if value.get("scope", "mcp:tools") != "mcp:tools":
        raise OAuthValidationError("invalid_client_metadata", "Only mcp:tools is supported.")
    method = value.get("token_endpoint_auth_method", "none" if cimd else "client_secret_basic")
    methods = value.get("token_endpoint_auth_methods_supported")
    if cimd and isinstance(methods, list) and "none" in methods:
        method = "none"
    allowed = {"none"} if cimd else {"none", "client_secret_basic", "client_secret_post"}
    if not isinstance(method, str) or method not in allowed:
        raise OAuthValidationError("invalid_client_metadata", "Unsupported client authentication.")
    name = value.get("client_name", "External OAuth application")
    if not isinstance(name, str) or not 1 <= len(name) <= 128 or any(ord(c) < 32 for c in name):
        raise OAuthValidationError("invalid_client_metadata", "Invalid client name.")
    return {
        "redirect_uris": list(dict.fromkeys(redirects)),
        "grant_types": list(dict.fromkeys(grants)),
        "response_types": ["code"],
        "token_endpoint_auth_method": method,
        "scope": "mcp:tools",
        "client_name": name,
    }


async def fetch_client_metadata(client_id: str) -> dict[str, Any]:
    """Fetch bounded public HTTPS metadata with DNS pinning and no redirects."""
    try:
        validate_mcp_endpoint(client_id)
        if urlsplit(client_id).path in {"", "/"} or any(
            part in {".", ".."} for part in urlsplit(client_id).path.split("/")
        ):
            raise UnsafeMcpEndpoint()
        async with (
            asyncio.timeout(8),
            _METADATA_FETCH_SLOTS,
            create_public_mcp_http_client(
                timeout=httpx.Timeout(5), max_response_bytes=MAX_METADATA_BYTES
            ) as client,
        ):
            response = await client.get(client_id, headers={"Accept": "application/json"})
            if response.status_code != 200:
                raise ValueError("Metadata unavailable")
            if response.headers.get("content-type", "").split(";")[0].strip() != "application/json":
                raise ValueError("Expected JSON")
            metadata = response.json()
        if not isinstance(metadata, dict) or metadata.get("client_id") != client_id:
            raise ValueError("Client identity mismatch")
        return validate_client_metadata(metadata, cimd=True)
    except (
        httpx.HTTPError,
        UnsafeMcpEndpoint,
        McpResponseLimitError,
        ValueError,
        TimeoutError,
    ) as exc:
        raise OAuthValidationError(
            "invalid_client_metadata", "Client metadata could not be validated."
        ) from exc


class OAuthClientRegistration:
    def __init__(self, oauth: DeveloperOAuthService):
        self.oauth = oauth

    async def resolve(self, client_id: str) -> OAuthClient:
        if not client_id.startswith("https://"):
            client = await run_in_threadpool(self.oauth.get_client, client_id)
            if client is None:
                raise OAuthValidationError("invalid_client", "Unknown OAuth client.")
            return client
        # Revalidate on authorization, never trust stale callbacks indefinitely.
        metadata = await fetch_client_metadata(client_id)
        return await run_in_threadpool(self._persist, client_id, metadata, "cimd", None)

    def register(self, metadata: Any) -> dict[str, Any]:
        validated = validate_client_metadata(metadata)
        client_id = f"hco_{secrets.token_urlsafe(32)}"
        secret = (
            None if validated["token_endpoint_auth_method"] == "none" else secrets.token_urlsafe(32)  # noqa: S105 - OAuth method identifier
        )
        self._persist(client_id, validated, "dcr", secret)
        result = {**validated, "client_id": client_id, "client_id_issued_at": _now_ms() // 1000}
        if secret is not None:
            result.update(client_secret=secret, client_secret_expires_at=0)
        return result

    def _persist(
        self, client_id: str, metadata: dict[str, Any], source: str, secret: str | None
    ) -> OAuthClient:
        self.oauth._registry.ensure_tables()
        self.oauth.ensure_tables()
        app_id = "app_oauth_" + hashlib.sha256(client_id.encode()).hexdigest()
        now = _now_ms()
        params = {
            "app_id": app_id,
            "agent_id": f"developer:{app_id}",
            "now": now,
            # A self-asserted name is never a verified platform identity.
            "name": f"Unverified OAuth app ({urlsplit(client_id).hostname or client_id[:20]})",
            "client_id": client_id,
            "secret_hash": _hash_secret(secret) if secret else "",
            "secret_prefix": secret[:8] if secret else "",
            "source": source,
            "method": metadata["token_endpoint_auth_method"],
            "redirects": json.dumps(metadata["redirect_uris"]),
            "grants": json.dumps(metadata["grant_types"]),
        }
        offline = self.oauth._db.engine.dialect.name == "sqlite"
        statement = """INSERT INTO developer_oauth_clients
            (app_id, client_id, client_secret_hash, client_secret_prefix, redirect_uris,
             created_at, secret_rotated_at, allowed_grant_types, registration_method,
             token_endpoint_auth_method)
            VALUES (:app_id, :client_id, :secret_hash, :secret_prefix, :redirects,
                    :now, :now, :grants, :source, :method)
            ON CONFLICT (client_id) DO UPDATE SET redirect_uris = excluded.redirect_uris,
                allowed_grant_types = excluded.allowed_grant_types
            WHERE developer_oauth_clients.registration_method = 'cimd'
              AND developer_oauth_clients.revoked_at IS NULL"""
        if not offline:
            # Only dialect-specific syntax changes; all values remain bound.
            statement = statement.replace(":redirects", "CAST(:redirects AS JSONB)").replace(
                ":grants", "CAST(:grants AS JSONB)"
            )
        with self.oauth._db.engine.begin() as connection:
            connection.execute(
                text("""INSERT INTO developer_apps
                (app_id, agent_id, display_name, contact_email, status, kind,
                 allowed_tool_groups, allowed_capabilities, owner_provider_ids, created_at, updated_at)
                VALUES (:app_id, :agent_id, :name, '', 'active', 'oauth_dynamic',
                        '["core_consent"]', '[]', '[]', :now, :now)
                ON CONFLICT (app_id) DO NOTHING"""),
                params,
            )
            connection.execute(text(statement), params)
        client = self.oauth.get_client(client_id)
        app = self.oauth._registry.get_app(app_id)
        if client is None or not app or app["status"] != "active":
            raise OAuthValidationError("invalid_client", "OAuth client is unavailable.")
        return client
