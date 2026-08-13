"""Verify that a maintenance call came from Cloud Scheduler, not from a copied string.

WHAT WAS WRONG WITH THE SHARED HEADER

`deploy/one-location/setup_retention_scheduler.sh` and
`deploy/one-email/setup_kyc_retention_scheduler.sh` each read a long-lived secret
out of Secret Manager and baked it into the Cloud Scheduler job as a literal
`X-Hushh-Maintenance-Token` header. Three consequences, none of them theoretical:

1. **The secret is readable from the job.** `gcloud scheduler jobs describe` and the
   Cloud Console both print `httpTarget.headers`. Anyone with scheduler *view*
   access on the project can read a credential that authorises deleting records.
2. **It never rotates.** Rotating the Secret Manager version does nothing until a
   human remembers to re-run the script, so the value in the job is whatever it was
   on the day it was created.
3. **One value opens every door.** Both scripts use the *same* header name, so a
   token lifted from one job authorises any endpoint that checks that header. The
   test named `shared-one-email-token` in `test_one_location_routes.py` exists
   because someone already noticed this.

WHAT REPLACES IT

Cloud Scheduler can mint a Google-signed OIDC ID token per invocation, scoped to a
single audience. Nothing is stored in the job but the service-account email and the
audience -- both non-secret. The token lives minutes, is signed by Google, and the
`aud` claim binds it to one endpoint, so a token captured from the location purge
cannot be replayed against the KYC purge. That is the property the shared header
could not have at any length of secret.

The verification is fail-closed: a token that does not verify, or verifies as an
identity outside the configured allowlist, is refused. An empty allowlist refuses
everything rather than accepting anyone -- a misconfiguration must not read as
"open to all callers".
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger(__name__)

BEARER_PREFIX = "Bearer "


@dataclass(frozen=True)
class SchedulerIdentity:
    """The verified caller. `email` is a service account, never a person."""

    email: str
    audience: str
    subject: str = ""


class SchedulerIdentityError(RuntimeError):
    """The caller could not be verified as the configured scheduler identity."""

    def __init__(self, reason: str, *, detail: str = "") -> None:
        super().__init__(reason)
        self.reason = reason
        self.detail = detail


def _clean(value: Any) -> str:
    return str(value or "").strip()


def allowed_service_accounts(env_var: str) -> tuple[str, ...]:
    """Read the allowlist for one endpoint.

    Comma-separated so a rotation can list the old and new identity at once and
    neither call is ever refused mid-migration.
    """
    raw = _clean(os.getenv(env_var))
    return tuple(sorted({part.strip().lower() for part in raw.split(",") if part.strip()}))


def expected_audience(env_var: str) -> str:
    """The audience the token must carry. Configured, never inferred.

    Deriving it from the request URL is the obvious shortcut and it is wrong here:
    the scheduler job's URI carries a query string (`?older_than_hours=12`), a proxy
    may rewrite the host, and Google's default-audience behaviour differs from what
    the server sees. Each of those produces a mismatch that presents as an opaque
    401 on a job that is configured correctly. Configuring both sides from one value
    costs one environment variable and removes the entire class.
    """
    return _clean(os.getenv(env_var))


def bearer_token(authorization_header: str | None) -> str:
    header = _clean(authorization_header)
    if not header.startswith(BEARER_PREFIX):
        return ""
    return header[len(BEARER_PREFIX) :].strip()


def _verify_google_id_token(token: str, audience: str) -> dict[str, Any]:
    """Thin seam over Google's verifier so tests can drive claims directly.

    Imported inside the function, matching `gmail_receipts_service`: the auth
    libraries are heavy and a maintenance endpoint must not add them to app import
    time for every process that never calls it.
    """
    from google.auth.transport.requests import Request as GoogleAuthRequest  # noqa: PLC0415
    from google.oauth2 import id_token as google_id_token  # noqa: PLC0415

    claims = google_id_token.verify_oauth2_token(token, GoogleAuthRequest(), audience=audience)
    if not isinstance(claims, dict):
        raise ValueError("token payload is not a claim set")
    return claims


def verify_scheduler_request(
    *,
    authorization_header: str | None,
    audience: str,
    allowed_emails: tuple[str, ...] | list[str],
    verifier=None,
) -> SchedulerIdentity:
    """Verify one maintenance call. Raises `SchedulerIdentityError` on any doubt.

    `verifier` resolves at call time rather than as a default argument. A default of
    `_verify_google_id_token` binds the function object once at import, so patching
    the module attribute later has no effect and a test that believes it substituted
    the verifier is in fact still calling Google -- which fails for reasons that look
    like the assertion under test.
    """
    resolve = verifier if verifier is not None else _verify_google_id_token
    allowlist = tuple(sorted({_clean(email).lower() for email in allowed_emails if _clean(email)}))
    if not allowlist:
        # An unconfigured allowlist is a misconfiguration, not permission. Treating
        # it as "allow" is how a fail-closed control becomes fail-open during the
        # one deploy where somebody forgot the variable.
        raise SchedulerIdentityError(
            "scheduler_identity_not_configured",
            detail="no scheduler service account is allowlisted for this endpoint",
        )

    if not _clean(audience):
        raise SchedulerIdentityError(
            "scheduler_audience_not_configured",
            detail="no audience is configured, so the token could not be bound to this endpoint",
        )

    token = bearer_token(authorization_header)
    if not token:
        raise SchedulerIdentityError(
            "scheduler_token_missing",
            detail="the request carried no OIDC bearer token",
        )

    try:
        claims = resolve(token, audience)
    except Exception as exc:  # noqa: BLE001 - every verification failure is one answer: refused.
        logger.warning("scheduler_identity.verification_failed: %s", type(exc).__name__)
        raise SchedulerIdentityError(
            "scheduler_token_invalid",
            detail="the OIDC token did not verify against Google's signing keys",
        ) from exc

    email = _clean(claims.get("email")).lower()
    if not email:
        raise SchedulerIdentityError(
            "scheduler_token_without_identity",
            detail="the token verified but carries no email claim",
        )

    # Google sets `email_verified` false for identities it cannot vouch for. A
    # service-account token always sets it true, so a false here means the token is
    # not the kind of token this endpoint accepts.
    if claims.get("email_verified") is False:
        raise SchedulerIdentityError(
            "scheduler_token_email_unverified",
            detail=f"{email} presented an unverified email claim",
        )

    if email not in allowlist:
        logger.warning("scheduler_identity.caller_not_allowlisted: %s", email)
        raise SchedulerIdentityError(
            "scheduler_identity_not_allowed",
            detail=f"{email} is not allowlisted for this endpoint",
        )

    return SchedulerIdentity(
        email=email,
        audience=_clean(claims.get("aud")) or _clean(audience),
        subject=_clean(claims.get("sub")),
    )


def verified_scheduler_identity(request: Any, config_prefix: str) -> SchedulerIdentity | None:
    """Adapter for a route guard. Returns None ONLY when no bearer token was offered.

    The None/raise split is the whole point. A request with no `Authorization`
    header is a pre-migration Cloud Scheduler job and may fall through to the shared
    header. A request that *does* present a bearer token and fails verification is
    refused here and never gets a second attempt at the weaker path -- otherwise the
    stronger control would be a suggestion.

    Deliberately typed against `Any` rather than `fastapi.Request`: this module is
    verification logic and must stay importable, and testable, without a web
    framework.
    """
    header = getattr(request, "headers", {}) or {}
    authorization = header.get("authorization") if hasattr(header, "get") else None
    if not bearer_token(authorization):
        return None

    return verify_scheduler_request(
        authorization_header=authorization,
        audience=expected_audience(f"{config_prefix}_AUDIENCE"),
        allowed_emails=allowed_service_accounts(f"{config_prefix}_SCHEDULER_SERVICE_ACCOUNTS"),
    )


def legacy_shared_token_allowed() -> bool:
    """Whether the pre-OIDC `X-Hushh-Maintenance-Token` path is still accepted.

    Defaults to True so flipping the server does not break Cloud Scheduler jobs that
    are still configured with the header. The migration is: deploy this, re-run both
    setup scripts (they now configure OIDC and no longer read the secret), then set
    this to 0 and delete the secrets. Until that last step the old path is still
    open, which is why this returns a value rather than being assumed.
    """
    raw = _clean(os.getenv("HUSHH_MAINTENANCE_LEGACY_TOKEN_ENABLED"))
    if not raw:
        return True
    return raw.lower() in {"1", "true", "yes", "on"}
