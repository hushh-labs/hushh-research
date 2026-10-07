"""The agent's own conversation with Google's OAuth endpoints: redeem, refresh, revoke.

Hussh's native phone clients (iOS and Android) are public clients: Google issues them
no secret, and PKCE proves the redeemer is the device that started the sign-in. So the
agent redeems and refreshes a native-client login with only the client id, and the hub
is never a party to it. A person who brings their own Google client also seals its
secret to the agent (``owner_client``), and only then is a secret sent.

Nothing here logs a code, a token, a verifier, a secret or a Google error body: a
failure is one typed code. The id token comes straight back from Google's token
endpoint over TLS, which OpenID Connect Core 3.1.3.7 accepts in place of a signature
check, so only its claims are read (issuer, audience, expiry, subject).
"""

from __future__ import annotations

import base64
import json
import logging
import os
import re
import time
from collections.abc import Awaitable, Mapping
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

logger = logging.getLogger(__name__)

TOKEN_URL = "https://oauth2.googleapis.com/token"  # noqa: S105 - an endpoint, not a credential
REVOKE_URL = "https://oauth2.googleapis.com/revoke"
_ISSUERS = frozenset({"https://accounts.google.com", "accounts.google.com"})
_TIMEOUT_S = 15.0

INVALID_GRANT = "INVALID_GRANT"
PROVIDER_UNREACHABLE = "PROVIDER_UNREACHABLE"
PROVIDER_REFUSED = "PROVIDER_REFUSED"
ACCOUNT_UNVERIFIED = "ACCOUNT_UNVERIFIED"
CLIENT_PROFILE_UNSUPPORTED = "CLIENT_PROFILE_UNSUPPORTED"
_CLIENT_ID = re.compile(r"^([0-9]{4,32})-[a-z0-9]{8,64}\.apps\.googleusercontent\.com$")
_NATIVE_CLIENT_ENV = {
    "hussh_ios": "GOOGLE_IOS_CONNECTOR_CLIENT_ID",
    "hussh_android": "GOOGLE_ANDROID_CONNECTOR_CLIENT_ID",
}


def native_client_id(profile: str) -> str:
    """An operator-configured public client, never an id supplied by a request."""
    value = os.getenv(_NATIVE_CLIENT_ENV.get(profile, ""), "").strip()
    return value if _CLIENT_ID.fullmatch(value) else ""


def oauth_project_id(client_id: str) -> Optional[str]:
    """Project number of a configured native client; unknown clients stay unknown.

    Google revocation affects every client in an OAuth project. Only exact public
    profile matches may supply this identity; a caller's numeric prefix is no proof.
    """
    if not client_id or client_id not in {native_client_id(p) for p in _NATIVE_CLIENT_ENV}:
        return None
    match = _CLIENT_ID.fullmatch(client_id)
    return match.group(1) if match else None


def validate_native_client(
    profile: str, client_id: str, redirect_uri: Optional[str] = None
) -> None:
    """Pin public native profiles and their exact callbacks; Android is a dev pilot."""
    configured = native_client_id(profile)
    if not configured or configured != client_id:
        raise GoogleOAuthError(CLIENT_PROFILE_UNSUPPORTED)
    reversed_id = (
        f"com.googleusercontent.apps.{configured.removesuffix('.apps.googleusercontent.com')}"
    )
    if profile == "hussh_ios":
        expected = f"{reversed_id}:/oauth2redirect"
    else:
        environment = (os.getenv("HUSHH_DEPLOY_ENV") or os.getenv("ENVIRONMENT") or "").lower()
        enabled = os.getenv("GOOGLE_ANDROID_CONNECTOR_DEV_ENABLED", "").lower() in {"1", "true"}
        expected = os.getenv("GOOGLE_ANDROID_CONNECTOR_REDIRECT_URI", "").strip()
        if (
            environment != "dev"
            or not enabled
            or expected not in {"com.hussh.app:/oauth2redirect", f"{reversed_id}:/oauth2redirect"}
        ):
            raise GoogleOAuthError(CLIENT_PROFILE_UNSUPPORTED)
    if redirect_uri is not None and redirect_uri != expected:
        raise GoogleOAuthError(CLIENT_PROFILE_UNSUPPORTED)


#: ``post(url, form) -> (status, json body or None)``; injectable for tests.
Post = Callable[[str, Mapping[str, str]], Awaitable[tuple[int, Optional[dict[str, Any]]]]]


class GoogleOAuthError(RuntimeError):
    """Google did not give the agent a usable answer. ``code`` is the whole story."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class TokenGrant:
    """One token response. Tokens never appear in a repr."""

    scopes: tuple[str, ...]
    expires_in_s: int
    access_token: str = field(repr=False)
    refresh_token: Optional[str] = field(default=None, repr=False)
    id_token: Optional[str] = field(default=None, repr=False)


async def http_post(url: str, form: Mapping[str, str]) -> tuple[int, Optional[dict[str, Any]]]:
    import httpx  # noqa: PLC0415

    async with httpx.AsyncClient(timeout=_TIMEOUT_S, follow_redirects=False) as client:
        response = await client.post(url, data=dict(form))
    try:
        body = response.json()
    except ValueError:
        body = None
    return response.status_code, body if isinstance(body, dict) else None


async def _call(post: Optional[Post], url: str, form: Mapping[str, str]) -> tuple[int, dict]:
    try:
        status, body = await (post or http_post)(url, form)
    except Exception as exc:  # noqa: BLE001 - transport errors may quote the request
        logger.warning("pod_google_oauth.unreachable reason=%s", type(exc).__name__)
        raise GoogleOAuthError(PROVIDER_UNREACHABLE) from None
    return status, body or {}


def _grant(status: int, body: Mapping[str, Any]) -> TokenGrant:
    if status in (400, 401) and body.get("error") in {"invalid_grant", "unauthorized_client"}:
        raise GoogleOAuthError(INVALID_GRANT)
    if status >= 500:
        raise GoogleOAuthError(PROVIDER_UNREACHABLE)
    access = body.get("access_token")
    if status != 200 or not isinstance(access, str) or not access:
        logger.warning("pod_google_oauth.refused status=%d", status)
        raise GoogleOAuthError(PROVIDER_REFUSED)
    expires = body.get("expires_in")
    refresh = body.get("refresh_token")
    id_token = body.get("id_token")
    return TokenGrant(
        scopes=tuple(str(body.get("scope") or "").split()),
        expires_in_s=int(expires) if isinstance(expires, (int, float)) and expires > 0 else 0,
        access_token=access,
        refresh_token=refresh if isinstance(refresh, str) and refresh else None,
        id_token=id_token if isinstance(id_token, str) and id_token else None,
    )


async def redeem_code(
    *,
    client_id: str,
    code: str,
    code_verifier: str,
    redirect_uri: str,
    client_secret: Optional[str] = None,
    post: Optional[Post] = None,
) -> TokenGrant:
    """Exchange a PKCE authorization code at Google's token endpoint."""
    form = {
        "grant_type": "authorization_code",
        "client_id": client_id,
        "code": code,
        "code_verifier": code_verifier,
        "redirect_uri": redirect_uri,
    }
    if client_secret:
        form["client_secret"] = client_secret
    return _grant(*await _call(post, TOKEN_URL, form))


async def refresh(
    *,
    client_id: str,
    refresh_token: str,
    scopes: tuple[str, ...],
    client_secret: Optional[str] = None,
    post: Optional[Post] = None,
) -> TokenGrant:
    """A fresh access token narrowed to ``scopes`` (RFC 6749 section 6)."""
    form = {
        "grant_type": "refresh_token",
        "client_id": client_id,
        "refresh_token": refresh_token,
        "scope": " ".join(scopes),
    }
    if client_secret:
        form["client_secret"] = client_secret
    return _grant(*await _call(post, TOKEN_URL, form))


async def revoke(token: str, *, post: Optional[Post] = None) -> bool:
    """Revoke a login at Google. True when Google confirmed or already forgot it."""
    try:
        status, body = await _call(post, REVOKE_URL, {"token": token})
    except GoogleOAuthError:
        return False
    return status == 200 or (status == 400 and body.get("error") == "invalid_token")


def id_token_subject(
    id_token: Optional[str], *, client_id: str, now_s: Optional[int] = None
) -> str:
    """The Google account subject from an id token Google just returned, or a refusal."""
    try:
        payload_part = str(id_token or "").split(".")[1]
        claims = json.loads(base64.urlsafe_b64decode(payload_part + "=" * (-len(payload_part) % 4)))
    except (IndexError, ValueError):
        raise GoogleOAuthError(ACCOUNT_UNVERIFIED) from None
    now = now_s if now_s is not None else int(time.time())
    subject = claims.get("sub") if isinstance(claims, dict) else None
    if (
        not isinstance(subject, str)
        or not subject.isdigit()
        or not 1 <= len(subject) <= 64
        or claims.get("iss") not in _ISSUERS
        or claims.get("aud") != client_id
        or not isinstance(claims.get("exp"), int)
        or claims["exp"] <= now
    ):
        raise GoogleOAuthError(ACCOUNT_UNVERIFIED)
    return subject


__all__ = [
    "ACCOUNT_UNVERIFIED",
    "INVALID_GRANT",
    "PROVIDER_REFUSED",
    "PROVIDER_UNREACHABLE",
    "REVOKE_URL",
    "TOKEN_URL",
    "GoogleOAuthError",
    "TokenGrant",
    "id_token_subject",
    "redeem_code",
    "refresh",
    "revoke",
]
