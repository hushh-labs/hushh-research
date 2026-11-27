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
from typing import Any, Callable, Literal, Optional

logger = logging.getLogger(__name__)

TOKEN_URL = "https://oauth2.googleapis.com/token"  # noqa: S105 - an endpoint, not a credential
REVOKE_URL = "https://oauth2.googleapis.com/revoke"
_ISSUERS = frozenset({"https://accounts.google.com", "accounts.google.com"})
_TIMEOUT_S = 15.0

#: What the Sentinel gate answers when it holds no Google web client (see sentinel_proxy_server).
GOOGLE_OAUTH_GATE_UNCONFIGURED = "oauth_gate_unconfigured"
INVALID_GRANT = "INVALID_GRANT"
PROVIDER_UNREACHABLE = "PROVIDER_UNREACHABLE"
PROVIDER_REFUSED = "PROVIDER_REFUSED"
ACCOUNT_UNVERIFIED = "ACCOUNT_UNVERIFIED"
CLIENT_PROFILE_UNSUPPORTED = "CLIENT_PROFILE_UNSUPPORTED"
_CLIENT_ID = re.compile(r"^([0-9]{4,32})-[a-z0-9]{8,64}\.apps\.googleusercontent\.com$")
UAT_MAIL_ORIGIN = "https://uat.one.hussh.ai"
HOSTED_WEB_ORIGINS_BY_ENV: dict[str, frozenset[str]] = {
    "dev": frozenset(
        {
            "https://dev.one.hussh.si",
            "https://dev.one.hushh.si",
            "https://dev.one.hussh.ai",
            "https://dev.one.hushh.ai",
        }
    ),
    "uat": frozenset(
        {
            "https://uat.one.hussh.si",
            "https://uat.one.hushh.si",
            "https://uat.one.hussh.ai",
            "https://uat.one.hushh.ai",
        }
    ),
    "production": frozenset(
        {
            "https://one.hussh.si",
            "https://one.hushh.si",
            "https://one.hussh.ai",
            "https://one.hushh.ai",
        }
    ),
}
_NATIVE_CLIENT_ENV = {
    "hussh_web": "GOOGLE_WEB_OAUTH_CLIENT_ID",
    "hussh_uat_mail_web": "GOOGLE_UAT_MAIL_WEB_CLIENT_ID",
    "hussh_ios": "GOOGLE_IOS_CONNECTOR_CLIENT_ID",
    "hussh_android": "GOOGLE_ANDROID_CONNECTOR_CLIENT_ID",
}


def _resolved_deploy_env() -> str:
    raw = (os.getenv("HUSHH_DEPLOY_ENV") or os.getenv("ENVIRONMENT") or "").strip().lower()
    return "production" if raw == "prod" else raw


def native_client_id(profile: str) -> str:
    """An operator-configured public client, never an id supplied by a request."""
    if profile == "hussh_web":
        for env_key in (
            "GOOGLE_WEB_OAUTH_CLIENT_ID",
            "GOOGLE_UAT_MAIL_WEB_CLIENT_ID",
            "GOOGLE_OAUTH_CLIENT_ID",
        ):
            val = os.getenv(env_key, "").strip()
            if _CLIENT_ID.fullmatch(val):
                return val
        return ""
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
    """Pin public native and Sentinel-mediated web profiles and their exact callbacks."""
    configured = native_client_id(profile)
    if not configured or configured != client_id:
        raise GoogleOAuthError(CLIENT_PROFILE_UNSUPPORTED)
    reversed_id = (
        f"com.googleusercontent.apps.{configured.removesuffix('.apps.googleusercontent.com')}"
    )
    if profile == "hussh_web":
        allowed = HOSTED_WEB_ORIGINS_BY_ENV.get(_resolved_deploy_env())
        if not allowed:
            raise GoogleOAuthError(CLIENT_PROFILE_UNSUPPORTED)
        if redirect_uri is not None and redirect_uri not in allowed:
            raise GoogleOAuthError(CLIENT_PROFILE_UNSUPPORTED)
        return
    if profile == "hussh_uat_mail_web":
        if os.getenv("HUSHH_DEPLOY_ENV") != "uat":
            raise GoogleOAuthError(CLIENT_PROFILE_UNSUPPORTED)
        expected = UAT_MAIL_ORIGIN
    elif profile == "hussh_ios":
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


def _sentinel_gateway_auth() -> tuple[str, str]:
    gateway_url = (
        (os.getenv("HUSSH_MODEL_GATEWAY_URL") or os.getenv("SENTINEL_MODEL_GATEWAY_URL") or "")
        .strip()
        .rstrip("/")
    )
    token = (os.getenv("HUSSH_MODEL_GATEWAY_TOKEN") or "").strip()
    return gateway_url, token


async def ready_browser_web_client(profile: str = "hussh_web") -> Optional[str]:
    """Check out-of-sandbox Sentinel first (1-container pod), with legacy UAT loopback fallback."""
    import httpx  # noqa: PLC0415

    expected = native_client_id(profile)
    gateway_url, surrogate = _sentinel_gateway_auth()
    if gateway_url and surrogate:
        try:
            async with httpx.AsyncClient(
                timeout=2.0, trust_env=False, follow_redirects=False
            ) as http:
                resp = await http.get(
                    f"{gateway_url}/v1/oauth/google/ready",
                    headers={"Authorization": f"Bearer {surrogate}"},
                )
            if resp.status_code == 200:
                data = resp.json()
                client_id = data.get("clientId") if isinstance(data, dict) else None
                if isinstance(client_id, str) and _CLIENT_ID.fullmatch(client_id):
                    if not expected or client_id == expected:
                        return client_id
        except (httpx.HTTPError, ValueError):
            pass

    uat_expected = expected or native_client_id("hussh_uat_mail_web")
    if not uat_expected:
        return None
    try:
        async with httpx.AsyncClient(timeout=1.0, trust_env=False, follow_redirects=False) as http:
            response = await http.get("http://127.0.0.1:8764/ready")
        if response.status_code == 200 and response.json() == {"clientId": uat_expected}:
            return uat_expected
    except (httpx.HTTPError, ValueError):
        pass
    return None


async def ready_mail_web_client() -> Optional[str]:
    return await ready_browser_web_client("hussh_uat_mail_web")


async def hosted_web_oauth_exchange(
    url: str, form: Mapping[str, str]
) -> tuple[int, Optional[dict[str, Any]]]:
    """Redeem or refresh browser Google OAuth via out-of-sandbox Sentinel (or legacy loopback)."""
    import httpx  # noqa: PLC0415

    from hushh_mcp.services.pod_owner_cloud import hosted_ace_runtime  # noqa: PLC0415

    if not hosted_ace_runtime() or url != TOKEN_URL:
        raise GoogleOAuthError(CLIENT_PROFILE_UNSUPPORTED)
    payload = {k: v for k, v in form.items() if not (k == "code_verifier" and v == "")}
    gateway_url, surrogate = _sentinel_gateway_auth()
    if gateway_url and surrogate:
        async with httpx.AsyncClient(
            timeout=_TIMEOUT_S, trust_env=False, follow_redirects=False
        ) as http:
            response = await http.post(
                f"{gateway_url}/v1/oauth/google/exchange",
                json=payload,
                headers={
                    "Authorization": f"Bearer {surrogate}",
                    "Content-Type": "application/json",
                },
            )
        try:
            body = response.json()
        except ValueError:
            body = None
        gate_body = body if isinstance(body, dict) else None
        # Readiness already falls back to the UAT sidecar when the gate holds no client;
        # the exchange follows the same rule. Any other answer, including a real refusal
        # from Google, is final and is never retried through the sidecar.
        unconfigured = (
            response.status_code == 503
            and gate_body is not None
            and gate_body.get("error") == GOOGLE_OAUTH_GATE_UNCONFIGURED
        )
        if not unconfigured or os.getenv("HUSHH_DEPLOY_ENV") != "uat":
            return response.status_code, gate_body

    if os.getenv("HUSHH_DEPLOY_ENV") != "uat":
        raise GoogleOAuthError(CLIENT_PROFILE_UNSUPPORTED)
    async with httpx.AsyncClient(
        timeout=_TIMEOUT_S, trust_env=False, follow_redirects=False
    ) as http:
        response = await http.post("http://127.0.0.1:8764/exchange", json=payload)
    try:
        body = response.json()
    except ValueError:
        body = None
    return response.status_code, body if isinstance(body, dict) else None


hosted_mail_exchange = hosted_web_oauth_exchange


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
    """Refresh within the grant; empty scopes preserve it (RFC 6749 section 6)."""
    form = {
        "grant_type": "refresh_token",
        "client_id": client_id,
        "refresh_token": refresh_token,
    }
    if scopes:
        form["scope"] = " ".join(scopes)
    if client_secret:
        form["client_secret"] = client_secret
    return _grant(*await _call(post, TOKEN_URL, form))


RevocationOutcome = Literal["grant_revoked", "token_absent", "unconfirmed"]


async def revoke_outcome(token: str, *, post: Optional[Post] = None) -> RevocationOutcome:
    """Separate a grant revocation from absence of only the submitted token."""
    try:
        status, body = await _call(post, REVOKE_URL, {"token": token})
    except GoogleOAuthError:
        return "unconfirmed"
    if status == 200:
        return "grant_revoked"
    if status == 400 and body.get("error") == "invalid_token":
        return "token_absent"
    return "unconfirmed"


async def revoke(token: str, *, post: Optional[Post] = None) -> bool:
    """Revoke one login. Preserve the single-token disconnect contract."""
    return await revoke_outcome(token, post=post) != "unconfirmed"


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


def id_token_email(id_token: Optional[str], *, client_id: str) -> str:
    """Display only a verified email from the same provider token as the subject."""
    id_token_subject(id_token, client_id=client_id)
    part = str(id_token).split(".")[1]
    claims = json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))
    email = claims.get("email")
    return (
        email
        if claims.get("email_verified") is True
        and isinstance(email, str)
        and len(email) <= 254
        and "@" in email
        and not any(c.isspace() for c in email)
        else ""
    )


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
