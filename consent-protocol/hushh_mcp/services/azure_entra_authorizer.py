"""Connect Azure sign-in: authorization code + PKCE, online-only, tenant-aware.

WHAT THE PERSON GRANTS, AND FOR HOW LONG
The only scope requested is ``https://management.azure.com/user_impersonation``.
No ``offline_access``, so Microsoft issues no refresh token and there is nothing to
store: the delegated access token lives in memory for one setup or upgrade job and
is then gone. Hussh's standing access afterwards is the separate, narrower observer
role on the agent (``azure_setup_plan``), authenticated by federation.

STATE AND PKCE ARE STATELESS AND CALLER-BOUND
The state is ``azure.<exp>.<payload>.<mac>``: a domain-separated HMAC over
``uid|kind|subscription|tenant|nonce`` that expires in 600 s and completes only for
the signed-in account that began it (the ``byoc_oauth_authorizer`` pattern). The PKCE
verifier is derived from the same server key and the state body, so no verifier is
stored and an intercepted code cannot be redeemed without the hub.

TENANT DISCOVERY
ARM rejects a token issued through ``/common`` to a personal Microsoft account
(measured 2026-10-02), and Microsoft fails that sign-in itself (AADSTS900144,
2026-10-03). So with no subscription named, the first leg is a ``discover`` sign-in
through ``/common`` that asks only who the person is (``openid email profile``); its
id token names the directory (``azure_home_directory``) and the second leg is the
ARM sign-in at that tenant, hinted with the same account so Microsoft does not ask
again. When the person names a subscription, its directory is read from ARM's own
unauthenticated 401 challenge (``WWW-Authenticate: authorization_uri=.../{tenant}``).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import os
import re
import secrets
import time
import urllib.parse
from dataclasses import dataclass
from typing import Any, Callable, Literal, Optional

from hushh_mcp.services import azure_federation as federation
from hushh_mcp.services.azure_keyed import keyed_digest

logger = logging.getLogger(__name__)

ARM_DELEGATED_SCOPE = "https://management.azure.com/user_impersonation"
#: The discover leg's scope: who the person is, nothing they own. No offline_access.
DISCOVERY_SCOPE = "openid email profile"
#: The tenant Entra issues personal Microsoft account tokens from. ARM refuses it.
CONSUMER_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad"
STATE_TTL_SECONDS = 600
_STATE_PREFIX = "azure."
_FIRST_LEG_AUTHORITY = "common"
_GUID = re.compile(r"^[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$")
_CHALLENGE_TENANT = re.compile(
    r"authorization_uri=\"https://login\.(?:windows\.net|microsoftonline\.com)/([0-9a-fA-F-]{36})\""
)

#: ``rebuild``: re-create the hosting space Azure removed, adopting what survived.
AuthorizationKind = Literal["setup", "upgrade", "discover", "rebuild"]
_KINDS: tuple[str, ...] = ("setup", "upgrade", "discover", "rebuild")


class AzureAuthorizeError(Exception):
    """A refusal with an HTTP shape, so the route can pass it through honestly."""

    def __init__(self, message: str, *, status_code: int = 400, code: str = "AUTHORIZE_FAILED"):
        super().__init__(message)
        self.status_code = status_code
        self.code = code


@dataclass(frozen=True)
class AuthorizationState:
    user_id: str
    kind: AuthorizationKind
    subscription_id: str
    #: The authority the sign-in used: a tenant id, or ``common`` for a first leg.
    authority: str
    nonce: str


@dataclass(frozen=True)
class DelegatedToken:
    """The person's ARM token for one job. Never logged, never persisted."""

    access_token: str = ""
    tenant_id: str = ""
    expires_in: int = 0

    def __repr__(self) -> str:  # a repr must never print the bearer
        return f"DelegatedToken(tenant_id={self.tenant_id!r}, expires_in={self.expires_in})"


def is_guid(value: object) -> bool:
    return bool(_GUID.match(str(value or "").strip()))


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _unb64(raw: str) -> bytes:
    return base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4))


def redirect_uri() -> str:
    """The registered frontend return (``/one/setup/cloud/azure/return``)."""
    value = (os.getenv("HUSSH_AZURE_OAUTH_REDIRECT_URI") or "").strip()
    parsed = urllib.parse.urlsplit(value)
    local = parsed.scheme == "http" and parsed.hostname in ("localhost", "127.0.0.1")
    if not value or not (parsed.scheme == "https" or local):
        raise AzureAuthorizeError(
            "Microsoft sign-in is not configured on this deployment",
            status_code=503,
            code="NOT_CONFIGURED",
        )
    return value


def make_state(
    user_id: str, *, kind: AuthorizationKind, subscription_id: str, authority: str
) -> str:
    if kind not in _KINDS or "|" in user_id:
        raise AzureAuthorizeError("Unsupported authorization", code="BAD_STATE")
    exp = str(int(time.time()) + STATE_TTL_SECONDS)
    nonce = secrets.token_hex(16)
    payload = _b64(f"{user_id}|{kind}|{subscription_id}|{authority}|{nonce}".encode())
    return f"{_STATE_PREFIX}{exp}.{payload}.{keyed_digest('oauth-state', exp, payload)}"


def verify_state(state: str, user_id: str) -> AuthorizationState:
    """The frozen selection, or a refusal. Completes only for the caller who began it."""
    if not str(state or "").startswith(_STATE_PREFIX):
        raise AzureAuthorizeError("Unrecognized authorization state", code="BAD_STATE")
    try:
        exp, payload, mac = state[len(_STATE_PREFIX) :].split(".", 2)
        if not hmac.compare_digest(mac, keyed_digest("oauth-state", exp, payload)):
            raise AzureAuthorizeError("Authorization state failed verification", code="BAD_STATE")
        if int(exp) < time.time():
            raise AzureAuthorizeError("This sign-in expired; start it again", code="STATE_EXPIRED")
        uid, kind, subscription, authority, nonce = _unb64(payload).decode().split("|")
    except AzureAuthorizeError:
        raise
    except Exception as exc:  # noqa: BLE001 - malformed input is a refusal, not a crash
        raise AzureAuthorizeError("Malformed authorization state", code="BAD_STATE") from exc
    if uid != user_id:
        raise AzureAuthorizeError("This sign-in belongs to a different account", code="BAD_STATE")
    if kind not in _KINDS or (subscription and not is_guid(subscription)):
        raise AzureAuthorizeError("Malformed authorization state", code="BAD_STATE")
    return AuthorizationState(uid, kind, subscription, authority, nonce)  # type: ignore[arg-type]


def code_verifier(state: str) -> str:
    """The PKCE verifier for one state: 64 hex chars, never stored, never sent early."""
    return keyed_digest("pkce", state)


def code_challenge(verifier: str) -> str:
    return _b64(hashlib.sha256(verifier.encode("ascii")).digest())


def discover_tenant_for_subscription(subscription_id: str, *, session: Any = None) -> str:
    """The directory that owns a subscription, from ARM's own 401 challenge."""
    if not is_guid(subscription_id):
        raise AzureAuthorizeError("That is not an Azure subscription id", code="BAD_SUBSCRIPTION")
    if session is None:
        import requests  # type: ignore[import-untyped]  # noqa: PLC0415

        session = requests
    response = session.get(
        f"https://management.azure.com/subscriptions/{subscription_id}",
        params={"api-version": "2022-12-01"},
        timeout=15,
    )
    challenge = str((getattr(response, "headers", None) or {}).get("WWW-Authenticate") or "")
    match = _CHALLENGE_TENANT.search(challenge)
    if getattr(response, "status_code", 0) != 401 or not match:
        raise AzureAuthorizeError(
            "Azure did not recognize that subscription", status_code=404, code="BAD_SUBSCRIPTION"
        )
    return match.group(1).lower()


def begin(
    user_id: str,
    *,
    kind: AuthorizationKind = "setup",
    subscription_id: str = "",
    tenant_id: str = "",
    login_hint: str = "",
    session: Any = None,
) -> str:
    """The Microsoft consent URL for one online-only grant.

    A setup with neither a subscription nor a directory becomes the ``discover``
    leg; a setup with a directory is the ARM leg, hinted with the account the
    discover leg already signed in, so Microsoft does not ask again.
    """
    subscription = str(subscription_id or "").strip().lower()
    authority = str(tenant_id or "").strip().lower()
    if subscription and not authority:
        authority = discover_tenant_for_subscription(subscription, session=session)
    if kind == "setup" and not subscription and not authority:
        kind = "discover"
    authority = federation.require_authority(authority or _FIRST_LEG_AUTHORITY)
    state = make_state(user_id, kind=kind, subscription_id=subscription, authority=authority)
    params = {
        "client_id": federation.app_client_id(),
        "response_type": "code",
        "redirect_uri": redirect_uri(),
        "response_mode": "query",
        # One scope per leg. No offline_access: no refresh token can be issued.
        "scope": DISCOVERY_SCOPE if kind == "discover" else ARM_DELEGATED_SCOPE,
        "state": state,
        "code_challenge": code_challenge(code_verifier(state)),
        "code_challenge_method": "S256",
    }
    hint = str(login_hint or "").strip()
    if hint and kind != "discover":
        params["login_hint"] = hint
    else:
        params["prompt"] = "select_account"
    query = urllib.parse.urlencode(params)
    return f"{federation.ENTRA_AUTHORITY}/{authority}/oauth2/v2.0/authorize?{query}"


def _token_body(
    state: str,
    selection: AuthorizationState,
    code: str,
    scope: str,
    *,
    session: Any,
    sleep: Callable[[float], None],
    assertion: Optional[Callable[[], str]],
) -> dict:
    try:
        return federation.redeem_authorization_code(
            selection.authority,
            code=code,
            redirect_uri=redirect_uri(),
            code_verifier=code_verifier(state),
            scope=scope,
            session=session,
            sleep=sleep,
            assertion=assertion,
        )
    except federation.AzureFederationError as exc:
        raise AzureAuthorizeError(
            "Microsoft did not accept the sign-in; try again", status_code=502, code=exc.code
        ) from exc


def redeem(
    state: str,
    selection: AuthorizationState,
    code: str,
    *,
    session: Any = None,
    sleep: Callable[[float], None] = time.sleep,
    assertion: Optional[Callable[[], str]] = None,
) -> DelegatedToken:
    """Burn the single-use code for the person's in-memory ARM token."""
    if selection.kind == "discover":
        raise AzureAuthorizeError("This sign-in only identifies the account", code="BAD_STATE")
    body = _token_body(
        state,
        selection,
        code,
        ARM_DELEGATED_SCOPE,
        session=session,
        sleep=sleep,
        assertion=assertion,
    )
    token = str(body.get("access_token") or "")
    if not token:
        raise AzureAuthorizeError("Microsoft returned no usable token", status_code=502)
    tenant = str(federation.token_claims(token).get("tid") or "").lower()
    if is_guid(selection.authority) and tenant != selection.authority:
        raise AzureAuthorizeError("The sign-in came from a different directory", code="BAD_TENANT")
    # Any refresh token in `body` is dropped here, unread: none was requested.
    return DelegatedToken(
        access_token=token, tenant_id=tenant, expires_in=int(body.get("expires_in") or 0)
    )


def redeem_discovery(
    state: str,
    selection: AuthorizationState,
    code: str,
    *,
    session: Any = None,
    sleep: Callable[[float], None] = time.sleep,
    assertion: Optional[Callable[[], str]] = None,
) -> "DiscoveredAccount":
    """Burn the discover leg's code for who signed in. No access token is kept."""
    if selection.kind != "discover":
        raise AzureAuthorizeError("Unexpected sign-in leg", code="BAD_STATE")
    body = _token_body(
        state, selection, code, DISCOVERY_SCOPE, session=session, sleep=sleep, assertion=assertion
    )
    return _discovered(body)


@dataclass(frozen=True)
class DiscoveredAccount:
    """Who signed in on the discover leg. Identity claims only; no bearer is kept."""

    tenant_id: str
    claims: dict

    @property
    def login_hint(self) -> str:
        return str(self.claims.get("preferred_username") or self.claims.get("email") or "")

    def __repr__(self) -> str:  # claims carry an email address; keep it out of logs
        return f"DiscoveredAccount(tenant_id={self.tenant_id!r})"


def _discovered(body: dict) -> DiscoveredAccount:
    """The id token's claims, read from Entra's own token response over TLS."""
    id_token = str(body.get("id_token") or "")
    if not id_token:
        raise AzureAuthorizeError("Microsoft returned no account details", status_code=502)
    claims = federation.token_claims(id_token)
    return DiscoveredAccount(tenant_id=str(claims.get("tid") or "").lower(), claims=claims)


def is_personal_account(token: DelegatedToken) -> bool:
    """A personal-account token cannot reach ARM; ask for the subscription id instead."""
    return token.tenant_id == CONSUMER_TENANT


__all__ = [
    "ARM_DELEGATED_SCOPE",
    "CONSUMER_TENANT",
    "DISCOVERY_SCOPE",
    "AuthorizationState",
    "AzureAuthorizeError",
    "DelegatedToken",
    "DiscoveredAccount",
    "begin",
    "code_challenge",
    "code_verifier",
    "discover_tenant_for_subscription",
    "is_guid",
    "is_personal_account",
    "make_state",
    "redeem",
    "redeem_discovery",
    "redirect_uri",
    "verify_state",
]
