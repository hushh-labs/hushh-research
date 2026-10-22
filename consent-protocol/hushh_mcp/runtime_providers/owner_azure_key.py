"""Owner-sealed Azure key configuration; independent of workload identity.

The private credential bundle travels only through the existing request credential
port. It freezes endpoint and deployment alongside the key for each turn; a later
selection cannot redirect an already admitted turn.
"""

from __future__ import annotations

import json
from typing import Any

from .azure_openai import (
    AzureOpenAIModeMismatch,
    AzureOpenAITopology,
    AzureOpenAITopologyInvalid,
    _endpoint,
    valid_deployment_name,
)

PROVIDER = "azure_openai"
MODE = "byok"


def configuration(endpoint: str, deployment: str) -> AzureOpenAITopology:
    if not valid_deployment_name(deployment):
        raise ValueError("AZURE_DEPLOYMENT_INVALID")
    try:
        return AzureOpenAITopology(_endpoint(endpoint), deployment)
    except AzureOpenAITopologyInvalid:
        raise ValueError("AZURE_ENDPOINT_INVALID") from None


def credential_bundle(*, endpoint: str, deployment: str, api_key: str) -> str:
    topology = configuration(endpoint, deployment)
    if not api_key.strip() or len(api_key) > 512:
        raise ValueError("AZURE_KEY_INVALID")
    return json.dumps(
        {"endpoint": topology.endpoint, "deployment": deployment, "apiKey": api_key.strip()},
        separators=(",", ":"),
    )


def _open(credential: str | None) -> tuple[AzureOpenAITopology, str]:
    try:
        value = json.loads(credential or "")
        if not isinstance(value, dict) or set(value) != {"endpoint", "deployment", "apiKey"}:
            raise ValueError
        if not all(isinstance(v, str) for v in value.values()):
            raise ValueError
        canonical = credential_bundle(
            endpoint=value["endpoint"], deployment=value["deployment"], api_key=value["apiKey"]
        )
        value = json.loads(canonical)
        return configuration(value["endpoint"], value["deployment"]), value["apiKey"]
    except (ValueError, TypeError, KeyError):
        raise AzureOpenAIModeMismatch("AZURE_OWNER_CREDENTIAL_INVALID") from None


def build_transport(credential: str | None, *, http_client: Any = None) -> Any:
    from openai import AsyncOpenAI  # noqa: PLC0415

    from hushh_mcp.services.mcp_public_http import create_public_mcp_http_client  # noqa: PLC0415

    from .openai_responses_transport import OpenAIResponsesTransport  # noqa: PLC0415

    topology, key = _open(credential)
    # Do not follow a provider redirect with an owner credential. Azure's v1
    # Responses API uses the deployment as model and supports key authentication.
    transport_client = http_client if http_client is not None else create_public_mcp_http_client()
    transport_client.follow_redirects = False
    client = AsyncOpenAI(
        api_key=key,
        base_url=topology.base_url,
        max_retries=0,
        http_client=transport_client,
    )
    return OpenAIResponsesTransport(api_key=key, provider=PROVIDER, client=client)


def build_adk_model(model: str, *, credential: str | None) -> Any:
    from .adk_model import ProviderAdkModel  # noqa: PLC0415

    topology, _key = _open(credential)
    if model != topology.deployment:
        raise AzureOpenAIModeMismatch("AZURE_DEPLOYMENT_MISMATCH")
    return ProviderAdkModel(
        model=model, provider=PROVIDER, credential=credential or "", runtime_mode=MODE
    )
