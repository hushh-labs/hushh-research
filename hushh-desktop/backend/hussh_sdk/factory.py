from __future__ import annotations

import httpx

from hussh_sdk.agent import HusshAgent
from hussh_sdk.credentials import CredentialResolver
from hussh_sdk.models import ModelConfig, RuntimeConfig, RuntimeKind, runtime_config
from hussh_sdk.runtime import RuntimeAdapter, runtime_adapter_for


def create_agent(
    *,
    name: str,
    runtime: RuntimeKind | RuntimeConfig = "local_platform",
    model: str | ModelConfig | None = None,
    provider: str | None = None,
    credential_ref: str | None = None,
    api_key: str = "sandbox",
    endpoint: str = "https://api.hussh.ai/v1",
    mock_persona: str = "Manish",
    sandbox_persona: str | None = None,
    subject_ua: str = "ua_sandbox",
    transport: httpx.AsyncBaseTransport | None = None,
    runtime_adapter: RuntimeAdapter | None = None,
    credential_resolver: CredentialResolver | None = None,
) -> HusshAgent:
    config = runtime_config(
        runtime,
        model=model,
        provider=provider,
        credential_ref=credential_ref,
    )
    agent = HusshAgent(
        api_key=api_key,
        endpoint=endpoint,
        mock_mode=config.kind == "mock",
        mock_persona=mock_persona,
        sandbox_persona=sandbox_persona,
        subject_ua=subject_ua,
        relying_service=name,
        transport=transport,
        runtime_config=config,
        runtime_adapter=runtime_adapter,
        credential_resolver=credential_resolver,
    )
    if agent.runtime_adapter is None:
        agent.runtime_adapter = runtime_adapter_for(config)
    return agent
