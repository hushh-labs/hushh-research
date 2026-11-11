"""Keyless Azure OpenAI authentication for the Cloud Run service identity.

The Entra application must trust the Google service account's unique ID with
issuer ``https://accounts.google.com`` and audience
``api://AzureADTokenExchange``. This module stores no Google or Azure secrets.
The trusted pre-merge readiness exam alone selects the GitHub Actions assertion
for its separate probe-only application; nothing detects it automatically.
"""

from __future__ import annotations

import os
from collections.abc import Callable
from functools import partial

import httpx
from azure.identity import ClientAssertionCredential, get_bearer_token_provider

_METADATA_IDENTITY_URL = (
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity"
)
_FEDERATED_AUDIENCE = "api://AzureADTokenExchange"
_COGNITIVE_SERVICES_SCOPE = "https://cognitiveservices.azure.com/.default"
_MAX_ASSERTION_LENGTH = 16_384
_ENTRA_CONNECTION_TIMEOUT_SECONDS = 2.0
_ENTRA_READ_TIMEOUT_SECONDS = 5.0


class AzureWorkloadIdentityError(RuntimeError):
    """The Cloud Run identity assertion could not be obtained."""


def _google_identity_assertion(*, timeout_seconds: float) -> str:
    """Fetch a short-lived Google ID token for the federated Entra credential."""
    try:
        # Do not send the metadata request through an ambient HTTP proxy.
        with httpx.Client(
            timeout=timeout_seconds, trust_env=False, follow_redirects=False
        ) as client:
            response = client.get(
                _METADATA_IDENTITY_URL,
                params={"audience": _FEDERATED_AUDIENCE},
                headers={"Metadata-Flavor": "Google"},
            )
            response.raise_for_status()
    except httpx.HTTPError as exc:
        raise AzureWorkloadIdentityError("Google identity metadata is unavailable") from exc

    assertion = response.text.strip()
    if not assertion or len(assertion) > _MAX_ASSERTION_LENGTH:
        raise AzureWorkloadIdentityError("Google identity metadata returned an invalid assertion")
    return assertion


def azure_openai_token_provider(
    *, tenant_id: str, client_id: str, metadata_timeout_seconds: float = 2.0
) -> Callable[[], str]:
    """Return a cached, refreshing Azure Cognitive Services bearer-token provider.

    ``client_id`` belongs to the Entra app whose federated credential trusts
    the Cloud Run runtime service account. The returned callable is accepted
    by ``openai.OpenAI(api_key=...)`` on the Azure ``/openai/v1/`` endpoint.
    """
    _require_ids(tenant_id, client_id)
    if not 0 < metadata_timeout_seconds <= 10:
        raise ValueError("metadata_timeout_seconds must be between 0 and 10")
    return _bearer_provider(
        tenant_id,
        client_id,
        partial(_google_identity_assertion, timeout_seconds=metadata_timeout_seconds),
    )


def _github_actions_assertion(*, timeout_seconds: float) -> str:
    """Fetch the job's GitHub Actions OIDC token for the probe-only Entra credential."""
    url = os.environ.get("ACTIONS_ID_TOKEN_REQUEST_URL", "")
    request_token = os.environ.get("ACTIONS_ID_TOKEN_REQUEST_TOKEN", "")
    if not url.startswith("https://") or not request_token:
        raise AzureWorkloadIdentityError("GitHub Actions OIDC is unavailable")
    try:
        with httpx.Client(
            timeout=timeout_seconds, trust_env=False, follow_redirects=False
        ) as client:
            # The request URL carries its own api-version; add, never replace, the query.
            response = client.get(
                httpx.URL(url).copy_merge_params({"audience": _FEDERATED_AUDIENCE}),
                headers={"Authorization": f"bearer {request_token}"},
            )
            response.raise_for_status()
            assertion = response.json().get("value")
    except (httpx.HTTPError, ValueError, AttributeError) as exc:
        raise AzureWorkloadIdentityError("GitHub Actions OIDC is unavailable") from exc
    if not isinstance(assertion, str) or not assertion.strip():
        raise AzureWorkloadIdentityError("GitHub Actions OIDC returned an invalid assertion")
    if len(assertion.strip()) > _MAX_ASSERTION_LENGTH:
        raise AzureWorkloadIdentityError("GitHub Actions OIDC returned an invalid assertion")
    return assertion.strip()


def github_actions_token_provider(*, tenant_id: str, client_id: str) -> Callable[[], str]:
    """Bearer tokens for the readiness exam's probe-only Entra app on GitHub Actions.

    Only the trusted exam workflow calls this; the runtime keeps the metadata path.
    """
    _require_ids(tenant_id, client_id)
    return _bearer_provider(
        tenant_id, client_id, partial(_github_actions_assertion, timeout_seconds=5.0)
    )


def _require_ids(tenant_id: str, client_id: str) -> None:
    if not tenant_id or not tenant_id.strip() or not client_id or not client_id.strip():
        raise ValueError("Azure tenant_id and client_id are required")


def _bearer_provider(
    tenant_id: str, client_id: str, assertion: Callable[[], str]
) -> Callable[[], str]:
    credential = ClientAssertionCredential(
        tenant_id=tenant_id,
        client_id=client_id,
        func=assertion,
        connection_timeout=_ENTRA_CONNECTION_TIMEOUT_SECONDS,
        read_timeout=_ENTRA_READ_TIMEOUT_SECONDS,
        retry_total=0,
    )
    return get_bearer_token_provider(credential, _COGNITIVE_SERVICES_SCOPE)
