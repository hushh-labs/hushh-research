"""The sealed connector login, from the owner's device to their own agent.

The person signs in to Google on their phone with Hussh's native app client (PKCE,
no client secret). The device seals the one-time authorization code and its PKCE
verifier to THIS pod's X25519 key, and the agent redeems it with Google itself, so
the hub that carries the request never sees the code, the token or anything the
connector later reads. The envelope mechanics are ``pod_sealed_envelope``; this
module is the purpose.

Purpose ``connector_credential``, HKDF info ``hussh/connector-credential/v1``, AAD::

    {"purpose": "connector_credential", "hushhId", "podKeyId", "issuedAtMs",
     "credentialId": uuid4, "connectorId", "provider"}

Plaintext, one of three kinds, each tied to its connector:

* ``authorization_code`` (provider ``google``, connector gmail|calendar|drive|contacts):
  ``{kind, clientProfile: hussh_ios|hussh_android|owner_client, clientId, code,
  codeVerifier, redirectUri, scopes}``;
* ``owner_client`` (provider ``google``, connector ``google_owner_client``): the owner's
  own Google client, ``{kind, clientId, clientSecret}``, for a person who brings one;
* ``mcp_oauth`` (provider ``mcp``, connector ``mcp_<id>``): a finished MCP sign-in,
  ``{kind, endpoint, issuer, tokens, clientInfo}``.

``tests/fixtures/connector_credential_seal_vector_v1.json`` is the deterministic vector
both ends assert. Every refusal is one typed code, never the plaintext or a reason.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Optional

from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey

from hushh_mcp.services import pod_sealed_envelope as core
from hushh_mcp.services.pod_sealed_envelope import BAD_ENVELOPE, SealPurpose, SealRefused

PURPOSE = "connector_credential"
HKDF_INFO = b"hussh/connector-credential/v1"

STALE_CREDENTIAL = "STALE_CREDENTIAL"
CONNECTOR_UNSUPPORTED = "CONNECTOR_UNSUPPORTED"
CREDENTIAL_KIND_UNSUPPORTED = "CREDENTIAL_KIND_UNSUPPORTED"
CLIENT_PROFILE_UNSUPPORTED = "CLIENT_PROFILE_UNSUPPORTED"
SCOPE_NOT_ALLOWED = "SCOPE_NOT_ALLOWED"
REFRESH_TOKEN_MISSING = "REFRESH_TOKEN_MISSING"  # noqa: S105 - a refusal code, not a secret
REFUSAL_CODES: tuple[str, ...] = (
    BAD_ENVELOPE,
    STALE_CREDENTIAL,
    CONNECTOR_UNSUPPORTED,
    CREDENTIAL_KIND_UNSUPPORTED,
    CLIENT_PROFILE_UNSUPPORTED,
    SCOPE_NOT_ALLOWED,
    REFRESH_TOKEN_MISSING,
)

PROVIDER_GOOGLE = "google"
PROVIDER_MCP = "mcp"
GOOGLE_CONNECTORS: tuple[str, ...] = ("gmail", "calendar", "drive", "contacts")
GOOGLE_OWNER_CLIENT = "google_owner_client"
CLIENT_PROFILES: tuple[str, ...] = ("hussh_ios", "hussh_android", "owner_client")
KIND_AUTHORIZATION_CODE = "authorization_code"
KIND_OWNER_CLIENT = "owner_client"
KIND_MCP_OAUTH = "mcp_oauth"

_G = "https://www.googleapis.com/auth/"
#: Per connector and access level, the scope sets that satisfy it, preferred first.
CONNECTOR_SCOPES: dict[str, dict[str, tuple[tuple[str, ...], ...]]] = {
    "gmail": {
        "read": ((_G + "gmail.readonly",), (_G + "gmail.modify",)),
        "manage": ((_G + "gmail.modify",),),
    },
    "calendar": {
        "read": (
            (_G + "calendar.events.readonly", _G + "calendar.freebusy"),
            (_G + "calendar.events", _G + "calendar.freebusy"),
        ),
        "manage": ((_G + "calendar.events", _G + "calendar.freebusy"),),
    },
    "drive": {
        "read": ((_G + "drive.readonly",), (_G + "drive",)),
        "manage": ((_G + "drive",),),
    },
    "contacts": {"read": ((_G + "contacts.readonly",),)},
}
IDENTITY_SCOPES = frozenset({"openid", "email", _G + "userinfo.email"})

_AAD_KEYS = frozenset(
    {"purpose", "hushhId", "podKeyId", "issuedAtMs", "credentialId", "connectorId", "provider"}
)
_KIND_KEYS: dict[str, frozenset[str]] = {
    KIND_AUTHORIZATION_CODE: frozenset(
        {"kind", "clientProfile", "clientId", "code", "codeVerifier", "redirectUri", "scopes"}
    ),
    KIND_OWNER_CLIENT: frozenset({"kind", "clientId", "clientSecret"}),
    KIND_MCP_OAUTH: frozenset({"kind", "endpoint", "issuer", "tokens", "clientInfo"}),
}
_MCP_CONNECTOR_RE = re.compile(r"^mcp_[a-z0-9_-]{1,60}$")
_GOOGLE_CLIENT_RE = re.compile(r"^([0-9]{4,32}-[a-z0-9]{8,64})\.apps\.googleusercontent\.com$")
_VERIFIER_RE = re.compile(r"^[A-Za-z0-9._~-]{43,128}$")
_NO_SPACE_RE = re.compile(r"^\S+$")
_REDIRECT_RE = re.compile(r"^[a-z][a-z0-9+.-]{0,127}:/[^\s#]{0,383}$")
_HTTPS_RE = re.compile(r"^https://[^\s#]{1,500}$")
_MAX_SCOPES = 16


class ConnectorCredentialRefused(SealRefused):
    """An envelope this pod will not accept. ``code`` is the whole explanation."""


SEAL_PURPOSE = SealPurpose(
    name=PURPOSE,
    hkdf_info=HKDF_INFO,
    aad_keys=_AAD_KEYS,
    refusal=ConnectorCredentialRefused,
    max_ciphertext_bytes=16 * 1024,
)


@dataclass(frozen=True)
class OpenedConnectorCredential:
    """One opened login. Every secret field is kept out of the repr."""

    kind: str
    connector_id: str
    provider: str
    credential_id: str
    issued_at_ms: int
    client_profile: Optional[str] = None
    client_id: Optional[str] = None
    redirect_uri: Optional[str] = None
    scopes: tuple[str, ...] = ()
    code: Optional[str] = field(default=None, repr=False)
    code_verifier: Optional[str] = field(default=None, repr=False)
    client_secret: Optional[str] = field(default=None, repr=False)
    mcp: Optional[dict[str, Any]] = field(default=None, repr=False)


def _refuse(code: str) -> ConnectorCredentialRefused:
    return ConnectorCredentialRefused(code)


def allowed_scopes(connector_id: str) -> frozenset[str]:
    """Every scope a login for ``connector_id`` may ask for."""
    levels = CONNECTOR_SCOPES.get(connector_id) or {}
    return IDENTITY_SCOPES | {s for sets in levels.values() for group in sets for s in group}


def expected_kind(connector_id: Any, provider: Any) -> str:
    """The plaintext kind this connector carries, or a typed refusal."""
    if provider == PROVIDER_GOOGLE and connector_id in GOOGLE_CONNECTORS:
        return KIND_AUTHORIZATION_CODE
    if provider == PROVIDER_GOOGLE and connector_id == GOOGLE_OWNER_CLIENT:
        return KIND_OWNER_CLIENT
    if (
        provider == PROVIDER_MCP
        and isinstance(connector_id, str)
        and _MCP_CONNECTOR_RE.fullmatch(connector_id)
    ):
        return KIND_MCP_OAUTH
    raise _refuse(CONNECTOR_UNSUPPORTED)


def seal_connector_credential(
    plaintext: Mapping[str, Any],
    *,
    pod_public_key_raw: bytes,
    aad: Mapping[str, Any],
    ephemeral_private_key_raw: Optional[bytes] = None,
    iv: Optional[bytes] = None,
) -> dict[str, Any]:
    """The device's half, kept here for the golden vector and the tests."""
    return dict(
        core.seal(
            plaintext,
            purpose=SEAL_PURPOSE,
            pod_public_key_raw=pod_public_key_raw,
            aad=aad,
            ephemeral_private_key_raw=ephemeral_private_key_raw,
            iv=iv,
        )
    )


def _text(value: Any, *, limit: int, pattern: Optional[re.Pattern[str]] = None) -> str:
    if not isinstance(value, str) or not value or len(value) > limit:
        raise _refuse(BAD_ENVELOPE)
    if pattern is not None and not pattern.fullmatch(value):
        raise _refuse(BAD_ENVELOPE)
    return value


def _scopes(value: Any, *, connector_id: str) -> tuple[str, ...]:
    if not isinstance(value, list) or not 1 <= len(value) <= _MAX_SCOPES:
        raise _refuse(BAD_ENVELOPE)
    if not all(isinstance(item, str) and item for item in value) or len(set(value)) != len(value):
        raise _refuse(BAD_ENVELOPE)
    if not set(value) <= allowed_scopes(connector_id):
        raise _refuse(SCOPE_NOT_ALLOWED)
    return tuple(value)


def _authorization_code(body: Mapping[str, Any], connector_id: str) -> dict[str, Any]:
    profile = body.get("clientProfile")
    if profile not in CLIENT_PROFILES:
        raise _refuse(CLIENT_PROFILE_UNSUPPORTED)
    client_id = _text(body.get("clientId"), limit=160, pattern=_GOOGLE_CLIENT_RE)
    redirect_uri = _text(body.get("redirectUri"), limit=512, pattern=_REDIRECT_RE)
    if profile == "hussh_ios":
        # Google's iOS client redirects only to its own reversed client id scheme.
        match = _GOOGLE_CLIENT_RE.fullmatch(client_id)
        prefix = match.group(1) if match else ""
        if not redirect_uri.startswith(f"com.googleusercontent.apps.{prefix}:/"):
            raise _refuse(BAD_ENVELOPE)
    if profile != "owner_client":
        from hushh_mcp.services.pod_google_oauth import (  # noqa: PLC0415
            GoogleOAuthError,
            validate_native_client,
        )

        try:
            validate_native_client(str(profile), client_id, redirect_uri)
        except GoogleOAuthError:
            raise _refuse(CLIENT_PROFILE_UNSUPPORTED) from None
    return {
        "client_profile": profile,
        "client_id": client_id,
        "code": _text(body.get("code"), limit=2048, pattern=_NO_SPACE_RE),
        "code_verifier": _text(body.get("codeVerifier"), limit=128, pattern=_VERIFIER_RE),
        "redirect_uri": redirect_uri,
        "scopes": _scopes(body.get("scopes"), connector_id=connector_id),
    }


def _owner_client(body: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "client_profile": "owner_client",
        "client_id": _text(body.get("clientId"), limit=160, pattern=_GOOGLE_CLIENT_RE),
        "client_secret": _text(body.get("clientSecret"), limit=256, pattern=_NO_SPACE_RE),
    }


def _mcp_oauth(body: Mapping[str, Any]) -> dict[str, Any]:
    tokens = body.get("tokens")
    client_info = body.get("clientInfo")
    if not isinstance(tokens, Mapping) or not isinstance(client_info, Mapping):
        raise _refuse(BAD_ENVELOPE)
    refresh = tokens.get("refresh_token")
    if refresh is None:
        raise _refuse(REFRESH_TOKEN_MISSING)
    scope = tokens.get("scope")
    client_id = _text(client_info.get("client_id"), limit=512, pattern=_NO_SPACE_RE)
    secret = client_info.get("client_secret")
    return {
        "scopes": tuple(_text(scope, limit=2048).split()) if scope is not None else (),
        "client_id": client_id,
        "mcp": {
            "endpoint": _text(body.get("endpoint"), limit=512, pattern=_HTTPS_RE),
            "issuer": _text(body.get("issuer"), limit=512, pattern=_HTTPS_RE),
            "refreshToken": _text(refresh, limit=4096, pattern=_NO_SPACE_RE),
            "clientId": client_id,
            "clientSecret": None
            if secret is None
            else _text(secret, limit=512, pattern=_NO_SPACE_RE),
        },
    }


def _parse_plaintext(raw: bytes, *, kind: str, connector_id: str) -> dict[str, Any]:
    body = core.parse_json_object(raw, purpose=SEAL_PURPOSE)
    if body.get("kind") not in _KIND_KEYS or body.get("kind") != kind:
        raise _refuse(CREDENTIAL_KIND_UNSUPPORTED)
    if set(body) != _KIND_KEYS[kind]:
        raise _refuse(BAD_ENVELOPE)
    if kind == KIND_AUTHORIZATION_CODE:
        return _authorization_code(body, connector_id)
    if kind == KIND_OWNER_CLIENT:
        return _owner_client(body)
    return _mcp_oauth(body)


def open_connector_credential(
    envelope: Any,
    *,
    pod_private_key: X25519PrivateKey,
    hushh_id: str,
    pod_key_id: str,
    connector_id: str,
    now_ms: int,
    floor_issued_at_ms: int = 0,
) -> OpenedConnectorCredential:
    """Open and check one envelope for ``connector_id`` on THIS pod, now.

    ``connector_id`` is the one the route was addressed to; an envelope sealed for
    another connector is a bad envelope, so a Calendar login can never be filed as
    Gmail. The AAD is read only after AES-GCM has authenticated it.
    """
    plaintext, aad = core.open_envelope(
        envelope, purpose=SEAL_PURPOSE, pod_private_key=pod_private_key
    )
    core.check_binding(aad, purpose=SEAL_PURPOSE, hushh_id=hushh_id, pod_key_id=pod_key_id)
    if aad.get("connectorId") != connector_id:
        raise _refuse(BAD_ENVELOPE)
    kind = expected_kind(connector_id, aad.get("provider"))
    credential_id = core.check_uuid4(aad.get("credentialId"), purpose=SEAL_PURPOSE)
    issued = core.check_issued(
        aad,
        purpose=SEAL_PURPOSE,
        now_ms=now_ms,
        floor_ms=floor_issued_at_ms,
        stale_code=STALE_CREDENTIAL,
    )
    fields = _parse_plaintext(plaintext, kind=kind, connector_id=connector_id)
    return OpenedConnectorCredential(
        kind=kind,
        connector_id=connector_id,
        provider=str(aad["provider"]),
        credential_id=credential_id,
        issued_at_ms=issued,
        **fields,
    )


__all__ = [
    "CLIENT_PROFILES",
    "CLIENT_PROFILE_UNSUPPORTED",
    "CONNECTOR_SCOPES",
    "CONNECTOR_UNSUPPORTED",
    "CREDENTIAL_KIND_UNSUPPORTED",
    "GOOGLE_CONNECTORS",
    "GOOGLE_OWNER_CLIENT",
    "HKDF_INFO",
    "IDENTITY_SCOPES",
    "KIND_AUTHORIZATION_CODE",
    "KIND_MCP_OAUTH",
    "KIND_OWNER_CLIENT",
    "PROVIDER_GOOGLE",
    "PROVIDER_MCP",
    "REFRESH_TOKEN_MISSING",
    "REFUSAL_CODES",
    "SCOPE_NOT_ALLOWED",
    "SEAL_PURPOSE",
    "STALE_CREDENTIAL",
    "ConnectorCredentialRefused",
    "OpenedConnectorCredential",
    "allowed_scopes",
    "expected_kind",
    "open_connector_credential",
    "seal_connector_credential",
]
