"""Authorization-code exchange and atomic refresh-family lifecycle."""

from __future__ import annotations

import base64
import hashlib
import hmac
from typing import TYPE_CHECKING, Any

from sqlalchemy import text

from hushh_mcp.services import developer_oauth_service as oauth

if TYPE_CHECKING:
    from hushh_mcp.services.developer_oauth_service import DeveloperOAuthService, OAuthClient


def exchange_authorization_code(
    service: DeveloperOAuthService,
    *,
    client: OAuthClient,
    code: str,
    redirect_uri: str,
    code_verifier: str,
    resource: str | None = None,
) -> dict[str, Any]:
    if "authorization_code" not in client.allowed_grant_types:
        raise oauth.OAuthValidationError(
            "unauthorized_client", "This OAuth client cannot use authorization code."
        )
    verifier = str(code_verifier or "").strip()
    if not oauth._PKCE_VALUE_RE.fullmatch(verifier):
        raise oauth.OAuthValidationError("invalid_grant", "Authorization code validation failed.")
    result = service._db.execute_raw(
        """SELECT id, app_id, client_id, redirect_uri, code_challenge, subject_firebase_uid, requested_scope, resource
               FROM developer_oauth_authorizations
               WHERE code_hash = :code_hash AND client_id = :client_id AND status = 'issued' AND expires_at > :now LIMIT 1""",
        {
            "code_hash": oauth._hash_secret(code),
            "client_id": client.client_id,
            "now": oauth._now_ms(),
        },
    )
    if not result.data:
        raise oauth.OAuthValidationError("invalid_grant", "Authorization code validation failed.")
    row = result.data[0]
    callback = (
        oauth.normalize_redirect_uri(redirect_uri)
        if client.registration_method == "portal"
        else redirect_uri
    )
    if callback != str(row["redirect_uri"]) or resource != row.get("resource"):
        raise oauth.OAuthValidationError("invalid_grant", "Authorization code validation failed.")
    challenge = (
        base64.urlsafe_b64encode(hashlib.sha256(verifier.encode("utf-8")).digest())
        .decode("ascii")
        .rstrip("=")
    )
    if not hmac.compare_digest(challenge, str(row["code_challenge"])):
        raise oauth.OAuthValidationError("invalid_grant", "Authorization code validation failed.")
    consumed = service._db.execute_raw(
        """UPDATE developer_oauth_authorizations SET status = 'consumed', consumed_at = :now
               WHERE id = :id AND status = 'issued' RETURNING id""",
        {"id": row["id"], "now": oauth._now_ms()},
    )
    if not consumed.data:
        raise oauth.OAuthValidationError("invalid_grant", "Authorization code validation failed.")
    tokens = service._issue_tokens(
        app_id=str(row["app_id"]),
        subject=str(row["subject_firebase_uid"]),
        authorization_id=int(row["id"]),
        scopes=(str(row["requested_scope"]),),
        resource=row.get("resource"),
        include_refresh_token="refresh_token" in client.allowed_grant_types,
        # PKCE is always the executable, user-authorized path.
        mcp_execution_mode="execute",
    )
    service._audit(
        app_id=str(row["app_id"]),
        client_id=client.client_id,
        subject=str(row["subject_firebase_uid"]),
        event="authorization_code_exchanged",
    )
    return tokens


def refresh(
    service: DeveloperOAuthService,
    *,
    client: OAuthClient,
    refresh_token: str,
    resource: str | None = None,
) -> dict[str, Any]:
    if "refresh_token" not in client.allowed_grant_types:
        raise oauth.OAuthValidationError(
            "unauthorized_client", "This OAuth client cannot refresh tokens."
        )
    query = text("""SELECT id, app_id, subject_firebase_uid, authorization_id, scopes,
                        resource, revoked_at, expires_at
            FROM developer_oauth_tokens WHERE token_hash = :token_hash
            AND token_kind = 'refresh' AND app_id = :app_id LIMIT 1""")
    params = {"token_hash": oauth._hash_secret(refresh_token), "app_id": client.app_id}
    replay = False
    with service._db.engine.begin() as connection:
        sqlite = service._db.engine.dialect.name == "sqlite"
        if sqlite:
            connection.exec_driver_sql("BEGIN IMMEDIATE")
        row = connection.execute(query, params).mappings().first()
        if not row or row["authorization_id"] is None:
            raise oauth.OAuthValidationError("invalid_grant", "Refresh token validation failed.")
        # Every rotation and replay for a family serializes on its authorization.
        lock_query = (
            "SELECT id FROM developer_oauth_authorizations WHERE id = :id"
            if sqlite
            else "SELECT id FROM developer_oauth_authorizations WHERE id = :id FOR UPDATE"
        )
        family = connection.execute(
            text(lock_query),
            {"id": row["authorization_id"]},
        ).first()
        if not family:
            raise oauth.OAuthValidationError("invalid_grant", "Refresh token validation failed.")
        row = connection.execute(query, params).mappings().one()
        if resource is not None and resource != row["resource"]:
            raise oauth.OAuthValidationError("invalid_target", "The MCP resource does not match.")
        if row["revoked_at"] is not None:
            connection.execute(
                text("""UPDATE developer_oauth_tokens SET revoked_at = :now
                    WHERE app_id = :app_id AND authorization_id = :authorization_id AND revoked_at IS NULL"""),
                {
                    "app_id": client.app_id,
                    "authorization_id": row["authorization_id"],
                    "now": oauth._now_ms(),
                },
            )
            replay = True
        else:
            if int(row["expires_at"]) <= oauth._now_ms():
                raise oauth.OAuthValidationError(
                    "invalid_grant", "Refresh token validation failed."
                )
            connection.execute(
                text("UPDATE developer_oauth_tokens SET revoked_at = :now WHERE id = :id"),
                {"now": oauth._now_ms(), "id": row["id"]},
            )
            tokens = service._issue_tokens(
                app_id=client.app_id,
                subject=str(row["subject_firebase_uid"]),
                authorization_id=row["authorization_id"],
                scopes=oauth._json_list(row["scopes"]) or (oauth._MCP_SCOPE,),
                resource=row["resource"],
                mcp_execution_mode="execute",
                connection=connection,
            )
    # Commit family revocation before returning the invalid_grant response.
    service._audit(
        app_id=client.app_id,
        client_id=client.client_id,
        subject=None if replay else str(row["subject_firebase_uid"]),
        event="refresh_token_replay_revoked" if replay else "refresh_token_rotated",
    )
    if replay:
        raise oauth.OAuthValidationError("invalid_grant", "Refresh token validation failed.")
    return tokens
