"""The Firebase boundary for enterprise SSO.

Firebase stays the only token verifier, and it is also this feature's only
account store: which WorkOS person an account belongs to, and whether that
person was later deprovisioned, live as custom claims on the Firebase user.
There is no table. This adapter looks users up, creates the identity a custom
token signs in as, mints that token, and ends an identity's access. It never
deletes an account.
"""

from __future__ import annotations

import asyncio
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Protocol

from .errors import EnterpriseSsoError

SSO_AUTH_PROVIDER = "workos"

# User claims this feature owns. camelCase and `workos`-prefixed, like the existing
# `hushhWelcomeMailAt`, so they can never collide with another feature's claims.
CLAIM_ORG = "workosOrgId"
CLAIM_USER = "workosUserId"
CLAIM_ORIGIN = "workosOrigin"  # "created" (SSO made the account) or "linked" (it already existed)
CLAIM_DEPROVISIONED_AT = "workosDeprovisionedAt"
ORIGIN_CREATED = "created"
ORIGIN_LINKED = "linked"


@dataclass(frozen=True)
class FirebaseUserInfo:
    uid: str
    email_verified: bool
    disabled: bool = False
    claims: Mapping[str, Any] = field(default_factory=dict)
    display_name: str | None = None


class FirebaseIdentityPort(Protocol):
    async def get_user(self, uid: str) -> FirebaseUserInfo | None: ...

    async def find_by_email(self, email: str) -> FirebaseUserInfo | None: ...

    async def create_user(self, uid: str, email: str, display_name: str | None = None) -> None: ...

    async def set_display_name(self, uid: str, display_name: str) -> None: ...

    async def merge_claims(self, uid: str, updates: Mapping[str, Any]) -> None: ...

    async def mint_token(self, uid: str, claims: dict[str, str]) -> str: ...

    async def quarantine(self, uid: str) -> bool: ...

    async def revoke_sessions(self, uid: str) -> bool: ...


def _info(user: Any) -> FirebaseUserInfo:
    return FirebaseUserInfo(
        uid=user.uid,
        email_verified=bool(user.email_verified),
        disabled=bool(user.disabled),
        claims=dict(user.custom_claims or {}),
        display_name=(getattr(user, "display_name", None) or "").strip() or None,
    )


class FirebaseAdminIdentity:
    """firebase_admin-backed implementation, resolved lazily per call."""

    @staticmethod
    def _auth():
        from firebase_admin import auth as firebase_auth

        from api.utils.firebase_admin import get_firebase_auth_app

        app = get_firebase_auth_app()
        if app is None:
            raise EnterpriseSsoError("sso_unavailable", 503)
        return firebase_auth, app

    def _write_auth(self):
        from api.utils.firebase_admin import (
            FirebaseAuthorityError,
            assert_firebase_identity_mutation_allowed,
        )

        firebase_auth, app = self._auth()
        try:
            assert_firebase_identity_mutation_allowed(app)
        except FirebaseAuthorityError as exc:
            raise EnterpriseSsoError("sso_unavailable", 503) from exc
        return firebase_auth, app

    async def get_user(self, uid: str) -> FirebaseUserInfo | None:
        firebase_auth, app = self._auth()
        try:
            return _info(await asyncio.to_thread(firebase_auth.get_user, uid, app=app))
        except firebase_auth.UserNotFoundError:
            return None

    async def find_by_email(self, email: str) -> FirebaseUserInfo | None:
        firebase_auth, app = self._auth()
        try:
            return _info(await asyncio.to_thread(firebase_auth.get_user_by_email, email, app=app))
        except firebase_auth.UserNotFoundError:
            return None

    async def create_user(self, uid: str, email: str, display_name: str | None = None) -> None:
        """Create the identity, idempotently. The org's IdP asserted this email on a domain
        WorkOS verified by DNS, so the address is created verified."""
        firebase_auth, app = self._write_auth()
        extra = {"display_name": display_name} if display_name else {}
        try:
            await asyncio.to_thread(
                firebase_auth.create_user,
                uid=uid,
                email=email,
                email_verified=True,
                app=app,
                **extra,
            )
        except firebase_auth.UidAlreadyExistsError:
            return  # a concurrent first sign-in for the same person already made it
        except firebase_auth.EmailAlreadyExistsError:
            # A different account holds this address. Never merge into it here.
            raise EnterpriseSsoError("sso_email_conflict", 409) from None

    async def set_display_name(self, uid: str, display_name: str) -> None:
        """Set the name the profile shows. Firebase Auth is where the app reads it from; the
        identity shadow catches up on the person's next sign-in."""
        firebase_auth, app = self._write_auth()
        await asyncio.to_thread(firebase_auth.update_user, uid, display_name=display_name, app=app)

    async def merge_claims(self, uid: str, updates: Mapping[str, Any]) -> None:
        """Add to a user's claims. `set_custom_user_claims` replaces the whole object, so
        the existing claims (for example `hushhWelcomeMailAt`) are read and kept."""
        firebase_auth, app = self._write_auth()
        user = await asyncio.to_thread(firebase_auth.get_user, uid, app=app)
        merged = {**(user.custom_claims or {}), **updates}
        await asyncio.to_thread(firebase_auth.set_custom_user_claims, uid, merged, app=app)

    async def mint_token(self, uid: str, claims: dict[str, str]) -> str:
        firebase_auth, app = self._write_auth()
        token: Any = await asyncio.to_thread(
            firebase_auth.create_custom_token, uid, claims, app=app
        )
        return token.decode("utf-8") if isinstance(token, bytes) else str(token)

    async def quarantine(self, uid: str) -> bool:
        """Disable and revoke through the account lifecycle's own quarantine."""
        from hushh_mcp.services.account_deletion_lifecycle_service import (
            AccountDeletionLifecycleService,
        )

        attempt = await AccountDeletionLifecycleService().quarantine_firebase_identity(uid)
        return attempt.outcome in {"quarantined", "not_found"}

    async def revoke_sessions(self, uid: str) -> bool:
        """End live sessions without disabling the account."""
        firebase_auth, app = self._auth()
        try:
            from api.utils.firebase_admin import assert_firebase_identity_mutation_allowed

            assert_firebase_identity_mutation_allowed(app)
            await asyncio.to_thread(firebase_auth.revoke_refresh_tokens, uid, app=app)
        except firebase_auth.UserNotFoundError:
            return True
        except Exception:  # noqa: BLE001 - the caller turns False into a retry
            return False
        return True
