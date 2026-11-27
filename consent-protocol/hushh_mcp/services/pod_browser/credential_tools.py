"""Native ADK credential hands: semantic target selection stays with the agent."""

from __future__ import annotations

from uuid import uuid4

from google.adk.tools import FunctionTool

from .contracts import BrowserRefused
from .credential_contracts import CredentialTarget, CredentialTargets, CredentialUseRequest


def credential_tools(control, processing) -> list:
    port = control.credentials
    if port is None:
        return []
    try:
        port.require_available()
    except BrowserRefused:
        return []

    async def saved_website_logins(origin: str) -> dict:
        """List opaque saved-login handles for one task-approved exact origin.

        Never infer an account choice when multiple handles are returned. For
        multiple handles or an empty catalog, call use_saved_website_login with
        handle="owner_selection" and explicit screen targets to let the owner
        choose an unlocked vault-only login. Unsaved/passkey/CAPTCHA uses manual
        takeover, never a password/code in ordinary tool arguments.
        """
        await control.require_model_observation()
        await processing.require()
        try:
            rows = await port.catalog(origin)
        except BrowserRefused as exc:
            if exc.code.startswith("BROWSER_CREDENTIAL_"):
                return {"logins": [], "code": exc.code, "manual_sign_in_required": True}
            raise
        return {"logins": [{"handle": row.handle, "origin": row.origin} for row in rows]}

    async def use_saved_website_login(
        handle: str,
        origin: str,
        username_x: int,
        username_y: int,
        password_x: int,
        password_y: int,
        submit_x: int,
        submit_y: int,
        otp_x: int | None = None,
        otp_y: int | None = None,
    ) -> dict:
        """Use an opaque login on explicitly selected current-screen targets.

        Select the username input, masked password input and sign-in submit
        control yourself. This hand never guesses DOM controls, selects an
        account, bypasses MFA/CAPTCHA/passkeys or authorizes unrelated effects.
        This hand declares website authentication only. Never use it to confirm
        a payment, recipient, purchase, account deletion or another website write.
        Passwords/codes never enter these arguments. Website transmission keeps
        its independent existing exact approval. A submitted result is not proof
        that sign-in succeeded: inspect the fresh safe screen.
        """
        await control.require_model_observation()
        await processing.require()
        try:
            request = CredentialUseRequest(
                operation_id="credential_" + uuid4().hex,
                handle=handle,
                origin=origin,
                control_epoch=control.control_epoch,
                targets=CredentialTargets(
                    username=CredentialTarget(x=username_x, y=username_y),
                    password=CredentialTarget(x=password_x, y=password_y),
                    submit=CredentialTarget(x=submit_x, y=submit_y),
                    otp=CredentialTarget(x=otp_x, y=otp_y)
                    if otp_x is not None and otp_y is not None
                    else None,
                ),
            )
        except ValueError:
            return {"state": "refused", "code": "BROWSER_CREDENTIAL_TARGET_REFUSED"}
        try:
            return await port.use(request)
        except BrowserRefused as exc:
            if (
                exc.code
                in {
                    "BROWSER_CREDENTIAL_OWNER_REQUIRED",
                    "BROWSER_CREDENTIAL_VAULT_REQUIRED",
                }
                or port.owner_pending
            ):
                return {"state": "needs_owner", "origin": origin}
            if exc.code.startswith("BROWSER_CREDENTIAL_") and not control.outcome_uncertain:
                return {"state": "refused", "code": exc.code, "origin": origin}
            raise

    return [FunctionTool(saved_website_logins), FunctionTool(use_saved_website_login)]
