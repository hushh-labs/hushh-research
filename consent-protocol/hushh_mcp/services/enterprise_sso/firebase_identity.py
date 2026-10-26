"""The Firebase boundary for enterprise SSO.

Firebase stays the only token verifier, and it is also this feature's only
identity store. WorkOS profile attribution is retained by the local lifecycle;
provider claims retain the existing sign-in compatibility. This adapter creates
the identity a custom
token signs in as, mints that token, and ends an identity's access. It never
deletes an account.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

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


def require_generation_compatibility() -> None:
    """Keep public rollout off until legacy membership coverage is qualified."""
    if os.getenv("ACCOUNT_GENERATION_ADMISSION_ENABLED", "").strip().lower() == "true":
        raise EnterpriseSsoError("sso_generation_unavailable", 503)


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

    async def offboard(
        self, uid: str, origin: str, organization: str, profile_hash: str
    ) -> bool: ...


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
        require_generation_compatibility()
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

        try:
            firebase_auth, app = self._auth()
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

    async def _mutate(
        self,
        uid: str,
        purpose: Literal["display_name", "sso_claims", "sso_create", "sso_offboarding"],
        operation: Callable[[Any, Any, str], None],
    ) -> None:
        from hushh_mcp.services import account_firebase_mutations as mutations
        from hushh_mcp.services.account_generation_service import AccountGenerationRefused

        firebase_auth, app = self._write_auth()
        try:
            result = await mutations.run(
                uid,
                purpose=purpose,
                authority_project=str(app.project_id),
                operation=lambda captured: operation(firebase_auth, app, captured),
            )
            if not result.settled:
                raise EnterpriseSsoError("sso_identity_write_unconfirmed", 503)
        except AccountGenerationRefused:
            raise EnterpriseSsoError("sso_generation_unavailable", 503) from None
        except mutations.FirebaseMutationRejected:
            raise EnterpriseSsoError("sso_account_conflict", 409) from None
        except mutations.FirebaseMutationTransportError:
            raise EnterpriseSsoError("sso_identity_write_unconfirmed", 503) from None

    async def create_user(self, uid: str, email: str, display_name: str | None = None) -> None:
        """Stable UID creation, fenced against retirement for the complete SDK call."""

        def create(firebase_auth, app, captured):
            try:
                firebase_auth.create_user(
                    uid=captured,
                    email=email,
                    email_verified=True,
                    app=app,
                    **({"display_name": display_name} if display_name else {}),
                )
            except firebase_auth.UidAlreadyExistsError:
                return

        await self._mutate(uid, "sso_create", create)

    async def set_display_name(self, uid: str, display_name: str) -> None:
        from hushh_mcp.services.account_firebase_mutations import set_display_name

        await self._mutate(
            uid,
            "display_name",
            lambda _auth, app, captured: set_display_name(app, captured, display_name),
        )

    async def merge_claims(self, uid: str, updates: Mapping[str, Any]) -> None:
        from hushh_mcp.services.account_firebase_mutations import (
            FirebaseMutationRejected,
            set_welcome_claims,
        )

        if set(updates) - {CLAIM_ORG, CLAIM_USER, CLAIM_ORIGIN}:
            raise EnterpriseSsoError("sso_account_conflict", 409)

        def merge(firebase_auth, app, captured):
            user = firebase_auth.get_user(captured, app=app)
            current = dict(user.custom_claims or {})
            if current.get(CLAIM_DEPROVISIONED_AT) or any(
                current.get(field, updates.get(field)) != updates.get(field)
                for field in (CLAIM_ORG, CLAIM_USER)
            ):
                raise FirebaseMutationRejected("WorkOS identity binding changed")
            merged = {**current, **updates}
            if current.get(CLAIM_ORIGIN) in {ORIGIN_CREATED, ORIGIN_LINKED}:
                merged[CLAIM_ORIGIN] = current[CLAIM_ORIGIN]
            set_welcome_claims(app, captured, merged)

        await self._mutate(uid, "sso_claims", merge)

    async def mint_token(self, uid: str, claims: dict[str, str]) -> str:
        from api.utils.firebase_auth import current_auth_lane
        from hushh_mcp.services.account_generation_service import AccountGenerationService

        identity, binding = await asyncio.to_thread(
            AccountGenerationService.custom_session_binding, uid, lane=current_auth_lane()
        )
        firebase_auth, app = self._write_auth()
        token: Any = await asyncio.to_thread(
            firebase_auth.create_custom_token, identity, {**claims, **binding}, app=app
        )
        return token.decode("utf-8") if isinstance(token, bytes) else str(token)

    async def offboard(self, uid: str, origin: str, organization: str, profile_hash: str) -> bool:
        """One no-retry provider update, joined with dispatch/settlement receipts."""
        from hushh_mcp.services.account_firebase_mutations import (
            FirebaseMutationRejected,
            _update_identity,
        )

        from .membership import membership_hash

        if origin not in {ORIGIN_CREATED, ORIGIN_LINKED}:
            raise EnterpriseSsoError("sso_account_conflict", 409)

        def update(firebase_auth, app, captured):
            try:
                user = firebase_auth.get_user(captured, app=app)
            except firebase_auth.UserNotFoundError:
                return
            claims = dict(user.custom_claims or {})
            if (
                claims.get(CLAIM_ORIGIN) != origin
                or claims.get(CLAIM_ORG) != organization
                or membership_hash(organization, str(claims.get(CLAIM_USER) or "")) != profile_hash
            ):
                raise FirebaseMutationRejected("WorkOS identity binding changed")
            claims.setdefault(CLAIM_DEPROVISIONED_AT, int(time.time()))
            serialized = json.dumps(claims, separators=(",", ":"), allow_nan=False)
            if len(serialized.encode()) > 1000:
                raise EnterpriseSsoError("sso_account_conflict", 409)
            fields = {"customAttributes": serialized, "validSince": str(int(time.time()))}
            if origin == ORIGIN_CREATED:
                fields["disableUser"] = True
            _update_identity(app, captured, fields)

        await self._mutate(uid, "sso_offboarding", update)
        return True
