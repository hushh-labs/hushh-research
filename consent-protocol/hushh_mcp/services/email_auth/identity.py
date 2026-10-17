"""Firebase remains the only account/session authority. No WorkOS calls."""

from __future__ import annotations

from api.utils.firebase_admin import get_firebase_auth_app
from hushh_mcp.services.email_auth.contracts import EmailAuthError, normalize_email


def enterprise_account_deprovisioned(claims: dict) -> bool:
    # Origin is provenance, not an SSO-only flag. Preserve offboarding semantics.
    return (
        claims.get("workosOrigin") == "created" and claims.get("workosDeprovisionedAt") is not None
    )


def independent_method_allowed(claims: dict) -> bool:
    provider = (claims.get("firebase") or {}).get("sign_in_provider")
    return not (
        enterprise_account_deprovisioned(claims)
        and (provider == "microsoft.com" or claims.get("emailAuthMethod") == "otp")
    )


class FirebaseEmailIdentity:
    @staticmethod
    def _context():
        from firebase_admin import auth

        app = get_firebase_auth_app()
        if app is None:
            raise EmailAuthError("identity_unavailable", "Sign-in is temporarily unavailable.", 503)
        return auth, app

    @staticmethod
    def _active(user) -> None:
        from hushh_mcp.services.account_deletion_lifecycle_service import (
            AccountDeletionLifecycleService,
        )

        if user.disabled or enterprise_account_deprovisioned(user.custom_claims or {}):
            raise EmailAuthError("account_unavailable", "Use your existing sign-in method.", 403)
        if AccountDeletionLifecycleService.is_tombstoned(user.uid):
            raise EmailAuthError("account_unavailable", "This account is unavailable.", 403)

    def find(self, email: str):
        auth, app = self._context()
        try:
            return auth.get_user_by_email(email, app=app)
        except auth.UserNotFoundError:
            return None

    def provision(self, uid: str, email: str):
        auth, app = self._context()
        from hushh_mcp.services.account_deletion_lifecycle_service import (
            AccountDeletionLifecycleService,
        )

        if AccountDeletionLifecycleService.is_tombstoned(uid):
            raise EmailAuthError("account_unavailable", "This account is unavailable.", 403)
        try:
            user = auth.get_user(uid, app=app)
        except auth.UserNotFoundError:
            try:
                user = auth.create_user(uid=uid, email=email, email_verified=True, app=app)
            except (auth.EmailAlreadyExistsError, auth.UidAlreadyExistsError):
                # Only the reserved UID may be recovered; matching email is insufficient.
                user = auth.get_user(uid, app=app)
        if not user.email or normalize_email(user.email)[0] != email:
            raise EmailAuthError("account_conflict", "Use your existing sign-in method.", 409)
        self._active(user)
        return user

    def issue(self, uid: str, email: str) -> str:
        auth, app = self._context()
        user = auth.get_user(uid, app=app)
        self._active(user)
        if not user.email_verified or normalize_email(user.email or "")[0] != email:
            raise EmailAuthError("account_conflict", "Use your existing sign-in method.", 409)
        token = auth.create_custom_token(uid, {"emailAuthMethod": "otp"}, app=app)
        return token.decode() if isinstance(token, bytes) else str(token)
