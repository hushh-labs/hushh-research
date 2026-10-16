"""Keyless Azure OpenAI authentication for the Cloud Run service identity.

The Entra application must trust the Google service account's unique ID with
issuer ``https://accounts.google.com`` and audience
``api://AzureADTokenExchange``. This module stores no Google or Azure secrets.
"""

from __future__ import annotations

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
    if not tenant_id or not tenant_id.strip() or not client_id or not client_id.strip():
        raise ValueError("Azure tenant_id and client_id are required")
    if not 0 < metadata_timeout_seconds <= 10:
        raise ValueError("metadata_timeout_seconds must be between 0 and 10")

    credential = ClientAssertionCredential(
        tenant_id=tenant_id,
        client_id=client_id,
        func=partial(_google_identity_assertion, timeout_seconds=metadata_timeout_seconds),
        connection_timeout=_ENTRA_CONNECTION_TIMEOUT_SECONDS,
        read_timeout=_ENTRA_READ_TIMEOUT_SECONDS,
        retry_total=0,
    )
    return get_bearer_token_provider(credential, _COGNITIVE_SERVICES_SCOPE)
