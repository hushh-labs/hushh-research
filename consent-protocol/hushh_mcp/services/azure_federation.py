"""Hussh's Azure app identity with no secret anywhere: workload identity federation.

The Hussh app registration carries one federated credential: issuer
``https://accounts.google.com``, subject = a DEDICATED broker service account's
numeric id (never the internet-facing hub runtime account), audience
``api://AzureADTokenExchange``. To act as the app in a person's tenant the hub:

1. obtains a Google ID token for the broker with that audience: from the metadata
   server when the attached runtime identity IS the broker, otherwise through IAM
   Credentials ``generateIdToken`` (which is also what local impersonation uses);
2. presents it at ``login.microsoftonline.com/{tenant}/oauth2/v2.0/token`` as a
   ``jwt-bearer`` client assertion.

The same assertion authenticates the app when it redeems a person's authorization
code (``redeem_authorization_code``), so no client secret is ever created.

AADSTS70021 ("no matching federated identity record") is retried with backoff: a
freshly written federated credential takes a short while to become visible.

Hub deployment configuration, not pod behaviour: ``HUSSH_AZURE_APP_CLIENT_ID`` and
``HUSSH_AZURE_BROKER_SA``. Neither is a secret.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import re
import time
from dataclasses import dataclass
from typing import Any, Callable, Optional

logger = logging.getLogger(__name__)

FEDERATION_AUDIENCE = "api://AzureADTokenExchange"
ENTRA_AUTHORITY = "https://login.microsoftonline.com"
ARM_APP_SCOPE = "https://management.azure.com/.default"
CLIENT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"
#: Backoff for AADSTS70021 while a new federated credential propagates.
FEDERATION_SETTLE_DELAYS: tuple[float, ...] = (2.0, 5.0, 10.0, 20.0)

_METADATA = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default"
_IAM_CREDENTIALS = "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts"
_GUID = re.compile(r"^[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$")
#: Authorities that are not a tenant id but are legal for an interactive first leg.
_MULTI_TENANT_AUTHORITIES = frozenset({"common", "organizations"})


class AzureFederationError(RuntimeError):
    """A typed refusal; ``code`` is stable for routes and setup-job records."""

    def __init__(self, message: str, *, code: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class AppToken:
    access_token: str
    expires_in: int
    #: The Hussh app's service-principal object id IN THIS TENANT (the token's ``oid``).
    object_id: str


def app_client_id() -> str:
    value = (os.getenv("HUSSH_AZURE_APP_CLIENT_ID") or "").strip()
    if not _GUID.match(value):
        raise AzureFederationError(
            "Microsoft sign-in is not configured on this deployment", code="NOT_CONFIGURED"
        )
    return value


def broker_service_account() -> str:
    value = (os.getenv("HUSSH_AZURE_BROKER_SA") or "").strip().removeprefix("serviceAccount:")
    if not value.endswith(".iam.gserviceaccount.com"):
        raise AzureFederationError(
            "the Azure federation broker identity is not configured", code="NOT_CONFIGURED"
        )
    return value


def require_authority(authority: str) -> str:
    """A tenant id (GUID) or a multi-tenant authority; nothing else reaches a URL."""
    value = str(authority or "").strip()
    if _GUID.match(value) or value in _MULTI_TENANT_AUTHORITIES:
        return value.lower()
    raise AzureFederationError("unrecognized Microsoft directory", code="BAD_TENANT")


def token_claims(token: str) -> dict[str, Any]:
    """Claims of a token received DIRECTLY from Entra over TLS. Not a verifier.

    Used only to read our own token's ``tid``/``oid``. Never applied to a token a
    caller presents: Hussh builds no Entra token verifier (byoc-azure.md).
    """
    try:
        segment = token.split(".")[1]
        decoded = json.loads(base64.urlsafe_b64decode(segment + "=" * (-len(segment) % 4)))
    except (IndexError, ValueError) as exc:
        raise AzureFederationError(
            "Microsoft returned an unreadable token", code="EXCHANGE_FAILED"
        ) from exc
    return decoded if isinstance(decoded, dict) else {}


def _session(session: Any) -> Any:
    if session is not None:
        return session
    import requests  # noqa: PLC0415

    return requests


def _metadata_assertion(broker: str, session: Any) -> Optional[str]:
    """The attached identity's ID token, only when that identity IS the broker."""
    headers = {"Metadata-Flavor": "Google"}
    try:
        email = session.get(f"{_METADATA}/email", headers=headers, timeout=5)
        if getattr(email, "status_code", 0) != 200 or email.text.strip() != broker:
            return None
        minted = session.get(
            f"{_METADATA}/identity",
            headers=headers,
            params={"audience": FEDERATION_AUDIENCE, "format": "full"},
            timeout=10,
        )
    except Exception:  # noqa: BLE001 - no metadata server off Google Cloud
        return None
    token = str(getattr(minted, "text", "") or "").strip()
    return token if getattr(minted, "status_code", 0) == 200 and token else None


def _iam_assertion(broker: str, session: Any) -> str:
    """``generateIdToken`` for the broker, as the hub's own runtime identity."""
    from hushh_mcp.services.pod_image_copy import attached_identity  # noqa: PLC0415

    access_token, _email = attached_identity()
    response = session.post(
        f"{_IAM_CREDENTIALS}/{broker}:generateIdToken",
        headers={"Authorization": f"Bearer {access_token}"},
        json={"audience": FEDERATION_AUDIENCE, "includeEmail": True},
        timeout=30,
    )
    token = str(((response.json() or {}) if response.status_code == 200 else {}).get("token") or "")
    if not token:
        logger.warning("azure_federation.assertion_refused http=%s", response.status_code)
        raise AzureFederationError(
            "the federation broker could not mint its assertion", code="ASSERTION_UNAVAILABLE"
        )
    return token


def google_assertion(*, session: Any = None) -> str:
    """A Google ID token for the broker, audience ``api://AzureADTokenExchange``."""
    broker = broker_service_account()
    http = _session(session)
    return _metadata_assertion(broker, http) or _iam_assertion(broker, http)


def _entra_error(response: Any) -> tuple[str, list[int]]:
    try:
        body = response.json() or {}
    except ValueError:
        body = {}
    codes = [int(c) for c in body.get("error_codes") or [] if str(c).isdigit()]
    return str(body.get("error") or ""), codes


def _token_request(
    authority: str,
    form: dict[str, str],
    *,
    assertion: Callable[[], str],
    session: Any,
    sleep: Callable[[float], None],
) -> dict[str, Any]:
    """POST the token endpoint, retrying only the federation-propagation refusal."""
    url = f"{ENTRA_AUTHORITY}/{require_authority(authority)}/oauth2/v2.0/token"
    http = _session(session)
    for attempt, delay in enumerate((*FEDERATION_SETTLE_DELAYS, None)):
        payload = {
            **form,
            "client_id": app_client_id(),
            "client_assertion_type": CLIENT_ASSERTION_TYPE,
            "client_assertion": assertion(),
        }
        response = http.post(url, data=payload, timeout=30)
        if response.status_code == 200:
            return dict(response.json() or {})
        error, codes = _entra_error(response)
        if 70021 in codes and delay is not None:
            logger.info("azure_federation.not_settled attempt=%s sleeping=%ss", attempt + 1, delay)
            sleep(delay)
            continue
        logger.warning(
            "azure_federation.refused http=%s error=%s codes=%s", response.status_code, error, codes
        )
        code = "FEDERATION_NOT_SETTLED" if 70021 in codes else "EXCHANGE_REFUSED"
        raise AzureFederationError("Microsoft refused the Hussh app sign-in", code=code)
    raise AssertionError("unreachable")  # pragma: no cover


def app_token(
    tenant_id: str,
    *,
    scope: str = ARM_APP_SCOPE,
    session: Any = None,
    sleep: Callable[[float], None] = time.sleep,
    assertion: Optional[Callable[[], str]] = None,
) -> AppToken:
    """An app-only token for the Hussh app's service principal in ``tenant_id``."""
    if not _GUID.match(str(tenant_id or "").strip()):
        raise AzureFederationError("an app token needs a tenant id", code="BAD_TENANT")
    body = _token_request(
        tenant_id,
        {"grant_type": "client_credentials", "scope": scope},
        assertion=assertion or (lambda: google_assertion(session=session)),
        session=session,
        sleep=sleep,
    )
    token = str(body.get("access_token") or "")
    if not token:
        raise AzureFederationError("Microsoft returned no app token", code="EXCHANGE_FAILED")
    return AppToken(
        access_token=token,
        expires_in=int(body.get("expires_in") or 0),
        object_id=str(token_claims(token).get("oid") or ""),
    )


def redeem_authorization_code(
    authority: str,
    *,
    code: str,
    redirect_uri: str,
    code_verifier: str,
    scope: str,
    session: Any = None,
    sleep: Callable[[float], None] = time.sleep,
    assertion: Optional[Callable[[], str]] = None,
) -> dict[str, Any]:
    """A person's delegated token for one code, the app proven by federation."""
    return _token_request(
        authority,
        {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect_uri,
            "code_verifier": code_verifier,
            "scope": scope,
        },
        assertion=assertion or (lambda: google_assertion(session=session)),
        session=session,
        sleep=sleep,
    )


__all__ = [
    "ARM_APP_SCOPE",
    "CLIENT_ASSERTION_TYPE",
    "FEDERATION_AUDIENCE",
    "AppToken",
    "AzureFederationError",
    "app_client_id",
    "app_token",
    "broker_service_account",
    "google_assertion",
    "redeem_authorization_code",
    "require_authority",
    "token_claims",
]
