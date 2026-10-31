"""Server-side WebAuthn / FIDO2 ceremony engine (passkeys + hardware security keys).

This is the missing piece that turns hussh's biometric/passkey support from a
*vault-unlock* PRF device into a real, server-verified **authenticator** — the
foundation for passkey login, step-up, and hardware keys (Google Titan, YubiKey).
See docs/future/identity-assurance/README.md.

It wraps ``py_webauthn`` with two injected stores (a credential repo + a one-time
challenge store, both Protocols), so the whole engine is hermetically testable
with fakes. The server mints the challenge, stores it bound to a short TTL, and
**verifies** the attestation (registration) and assertion (authentication) --
unlike the existing client-side PRF flow, which never verified anything.

Standards: W3C WebAuthn L2 / FIDO2. Registration stores the credential's public
key + AAGUID + sign_count so later assertions are verified and cloned-authenticator
use (sign_count regression) is caught. Reached only when ``WEBAUTHN_ENABLED`` is on
(enforced at the route). Nothing here touches the vault DEK or PKM.
"""

from __future__ import annotations

import base64
import json
import os
import time
from dataclasses import dataclass
from typing import Any, Optional, Protocol

from webauthn import (
    generate_authentication_options,
    generate_registration_options,
    options_to_json,
    verify_authentication_response,
    verify_registration_response,
)
from webauthn.helpers import bytes_to_base64url
from webauthn.helpers.structs import (
    AuthenticatorSelectionCriteria,
    PublicKeyCredentialDescriptor,
    ResidentKeyRequirement,
    UserVerificationRequirement,
)

from hushh_mcp.services.webauthn_aal import classify
from hushh_mcp.services.webauthn_mds import mds_verified_aaguid

CEREMONY_REGISTRATION = "registration"
CEREMONY_AUTHENTICATION = "authentication"


@dataclass(frozen=True)
class WebAuthnSettings:
    rp_id: str
    rp_name: str
    origins: tuple[str, ...]
    challenge_ttl_s: int = 300


class _CredentialRepo(Protocol):
    async def add(self, cred: dict[str, Any]) -> None: ...

    async def get_by_credential_id(self, credential_id: str) -> Optional[dict]: ...

    async def list_by_user(self, user_id: str) -> list[dict]: ...

    async def update_sign_count(
        self, credential_id: str, *, sign_count: int, last_used_at: str
    ) -> None: ...


class _ChallengeStore(Protocol):
    async def save(
        self, *, user_id: Optional[str], challenge: str, ceremony: str, rp_id: str, ttl_s: int
    ) -> None: ...

    async def consume(self, challenge: str) -> Optional[dict]: ...


def _extract_challenge(credential: Any) -> str:
    """Pull the base64url challenge the client echoed back in clientDataJSON.

    The stored challenge is looked up by this value, so both the usernameless
    authentication ceremony and registration resolve their expected challenge
    without server-side sessions.
    """
    cred = json.loads(credential) if isinstance(credential, str) else dict(credential)
    client_data_b64 = cred["response"]["clientDataJSON"]
    padded = client_data_b64 + "=" * (-len(client_data_b64) % 4)
    client_data = json.loads(base64.urlsafe_b64decode(padded))
    return str(client_data["challenge"])


class WebAuthnService:
    """Begin/finish the WebAuthn registration + authentication ceremonies."""

    def __init__(
        self,
        *,
        credentials: _CredentialRepo,
        challenges: _ChallengeStore,
        settings: WebAuthnSettings,
    ) -> None:
        self._creds = credentials
        self._challenges = challenges
        self._settings = settings

    async def begin_registration(
        self, *, user_id: str, user_name: str, display_name: Optional[str] = None
    ) -> str:
        """Options JSON for `navigator.credentials.create()`. Excludes already-
        registered credentials so a device can't double-register."""
        existing = await self._creds.list_by_user(user_id)
        exclude = [
            PublicKeyCredentialDescriptor(id=_b64url_to_bytes(c["credential_id"])) for c in existing
        ]
        options = generate_registration_options(
            rp_id=self._settings.rp_id,
            rp_name=self._settings.rp_name,
            user_id=user_id.encode("utf-8"),
            user_name=user_name,
            user_display_name=display_name or user_name,
            exclude_credentials=exclude,
            authenticator_selection=AuthenticatorSelectionCriteria(
                resident_key=ResidentKeyRequirement.PREFERRED,
                user_verification=UserVerificationRequirement.PREFERRED,
            ),
        )
        await self._challenges.save(
            user_id=user_id,
            challenge=bytes_to_base64url(options.challenge),
            ceremony=CEREMONY_REGISTRATION,
            rp_id=self._settings.rp_id,
            ttl_s=self._settings.challenge_ttl_s,
        )
        return options_to_json(options)

    async def finish_registration(
        self, *, user_id: str, credential: Any, device_label: Optional[str] = None
    ) -> dict[str, Any]:
        """Verify the attestation and persist the new credential's public key."""
        stored = await self._consume_valid(credential, CEREMONY_REGISTRATION, user_id=user_id)
        verified = verify_registration_response(
            credential=credential,
            expected_challenge=_b64url_to_bytes(stored["challenge"]),
            expected_rp_id=self._settings.rp_id,
            expected_origin=list(self._settings.origins),
        )
        credential_id = bytes_to_base64url(verified.credential_id)
        aaguid = str(verified.aaguid) if verified.aaguid else None
        row = {
            "user_id": user_id,
            "credential_id": credential_id,
            "public_key": bytes_to_base64url(verified.credential_public_key),
            "sign_count": int(verified.sign_count),
            "aaguid": aaguid,
            "device_type": str(getattr(verified.credential_device_type, "value", "") or ""),
            "backed_up": bool(verified.credential_backed_up),
            "rp_id": self._settings.rp_id,
            "device_label": device_label,
        }
        await self._creds.add(row)
        assurance = classify(
            user_verified=verified.user_verified,
            aaguid=aaguid,
            backed_up=verified.credential_backed_up,
            mds_verified=mds_verified_aaguid(aaguid),
        )
        return {
            "credentialId": credential_id,
            "aaguid": aaguid,
            "userVerified": verified.user_verified,
            **assurance,
        }

    async def begin_authentication(self, *, user_id: Optional[str] = None) -> str:
        """Options JSON for `navigator.credentials.get()`. Usernameless by default
        (discoverable credentials); pass ``user_id`` to scope to a user's keys."""
        allow: list[PublicKeyCredentialDescriptor] = []
        if user_id:
            allow = [
                PublicKeyCredentialDescriptor(id=_b64url_to_bytes(c["credential_id"]))
                for c in await self._creds.list_by_user(user_id)
            ]
        options = generate_authentication_options(
            rp_id=self._settings.rp_id,
            allow_credentials=allow or None,
            user_verification=UserVerificationRequirement.PREFERRED,
        )
        await self._challenges.save(
            user_id=user_id,
            challenge=bytes_to_base64url(options.challenge),
            ceremony=CEREMONY_AUTHENTICATION,
            rp_id=self._settings.rp_id,
            ttl_s=self._settings.challenge_ttl_s,
        )
        return options_to_json(options)

    async def finish_authentication(self, *, credential: Any) -> dict[str, Any]:
        """Verify the assertion against the stored public key, catch sign_count
        regression (cloned authenticator), and return the authenticated user."""
        stored = await self._consume_valid(credential, CEREMONY_AUTHENTICATION)
        cred = json.loads(credential) if isinstance(credential, str) else dict(credential)
        credential_id = str(cred["id"])
        record = await self._creds.get_by_credential_id(credential_id)
        if not record:
            raise ValueError("unknown_credential")
        verified = verify_authentication_response(
            credential=credential,
            expected_challenge=_b64url_to_bytes(stored["challenge"]),
            expected_rp_id=self._settings.rp_id,
            expected_origin=list(self._settings.origins),
            credential_public_key=_b64url_to_bytes(record["public_key"]),
            credential_current_sign_count=int(record.get("sign_count") or 0),
        )
        await self._creds.update_sign_count(
            credential_id,
            sign_count=int(verified.new_sign_count),
            last_used_at=_now_iso(),
        )
        _aaguid = record.get("aaguid")
        assurance = classify(
            user_verified=verified.user_verified,
            aaguid=_aaguid,
            mds_verified=mds_verified_aaguid(_aaguid),
        )
        return {
            "userId": record["user_id"],
            "credentialId": credential_id,
            "aaguid": record.get("aaguid"),
            "userVerified": verified.user_verified,
            **assurance,
        }

    async def _consume_valid(
        self, credential: Any, ceremony: str, *, user_id: Optional[str] = None
    ) -> dict[str, Any]:
        challenge = _extract_challenge(credential)
        stored = await self._challenges.consume(challenge)
        if not stored:
            raise ValueError("challenge_not_found_or_expired")
        if stored.get("ceremony") != ceremony:
            raise ValueError("challenge_ceremony_mismatch")
        if user_id is not None and stored.get("user_id") not in (None, user_id):
            raise ValueError("challenge_user_mismatch")
        return stored


def get_webauthn_settings() -> WebAuthnSettings:
    """Resolve RP id/name + allowed origins from env.

    Defaults align with the existing native passkey RP (``one.hushh.ai``) and its
    dev/uat associated domains (App.entitlements), so this and the vault-unlock PRF
    flow share one relying party.
    """
    rp_id = (os.getenv("WEBAUTHN_RP_ID") or "").strip() or "one.hushh.ai"
    rp_name = (os.getenv("WEBAUTHN_RP_NAME") or "").strip() or "hussh"
    origins_env = (os.getenv("WEBAUTHN_ORIGINS") or "").strip()
    if origins_env:
        origins = tuple(o.strip() for o in origins_env.split(",") if o.strip())
    else:
        origins = tuple(f"https://{host}" for host in (rp_id, f"uat.{rp_id}", f"dev.{rp_id}"))
    return WebAuthnSettings(rp_id=rp_id, rp_name=rp_name, origins=origins)


def _b64url_to_bytes(value: str) -> bytes:
    padded = value + "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(padded)


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
