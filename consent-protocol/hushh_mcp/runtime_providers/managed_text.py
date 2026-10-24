"""One owning Azure-first UAT text contract; no information or action authority.

A retry repeats only an unobserved model call, never a Runner or its tools.
Legacy personal pilot receipts are historical records, not this admin policy.
"""

from __future__ import annotations

import asyncio
import logging
import os
from collections.abc import Awaitable, Callable
from contextlib import aclosing
from typing import Any, Literal, TypedDict, cast
from uuid import UUID, uuid5

from google.adk.agents import LlmAgent
from pydantic import Field

from hushh_mcp.managed_ai_config import (
    load_private_drive_text_policy,
    load_pwm_policy,
    profile_hash,
)
from hushh_mcp.runtime_providers.azure_adk import AzureOpenAIAdkModel

logger = logging.getLogger(__name__)
TEXT_SCOPES = frozenset({"one_text_chat", "drive_document_requests"})
ONE_TOOL_FIRST_OUTPUT_SECONDS = 30.0
ManagedProvider = Literal["azure_openai", "vertex"]


class ManagedTextReceipt(TypedDict):
    ready: Literal[True]
    provider: ManagedProvider
    model: str
    location: str


def managed_text_policy() -> dict | None:
    environment = (
        os.getenv("HUSHH_DEPLOY_ENV", "").strip() or os.getenv("ENVIRONMENT", "").strip()
    ).lower()
    if environment != "uat":
        return None
    policy = load_private_drive_text_policy()
    if not policy["enabled"]:
        raise ValueError("UAT managed text processing policy is disabled")
    from hushh_mcp.managed_ai_config import selected_managed_provider

    selected = selected_managed_provider()
    if selected not in {policy["provider"], policy["alternate_provider"]}:
        raise ValueError("Invalid UAT managed text provider")
    version = policy["version"] + (":vertex" if selected == "vertex" else "")
    return {
        **policy,
        "selected_provider": selected,
        "generation": str(uuid5(UUID(policy["policy_id"]), version)),
    }


class ManagedTextAuthorityError(PermissionError):
    """Current invocation/information authority failed; never provider failover."""


def fallback_reason(error: Exception) -> str | None:
    """Closed retry taxonomy at the model transport boundary, never cause guessing."""
    from openai import APIConnectionError, APITimeoutError

    from hushh_mcp.runtime_providers.azure_adk import AzureAuthenticationError

    if isinstance(error, (PermissionError, ValueError, AzureAuthenticationError)):
        return None
    if isinstance(error, (TimeoutError, APITimeoutError)):
        return "timeout"
    if isinstance(error, APIConnectionError):
        return "connection"
    from hushh_mcp.runtime_providers.vertex_failover import _status_code

    status = _status_code(error)
    if status == 429:
        return "quota"
    if status in {500, 502, 503, 504}:
        return "transient_service"
    return None


class ManagedPrimaryTextModel(AzureOpenAIAdkModel):
    """One provider attempt at a time; never replay observed output or tools."""

    fallback_model: Any = Field(default=None, exclude=True, repr=False)
    fallback_factory: Callable[[], Any] | None = Field(default=None, exclude=True, repr=False)
    primary_provider: Literal["azure_openai", "vertex"] = "azure_openai"
    allow_fallback: bool = True
    completion_observer: Callable[[dict[str, str]], None] | None = Field(
        default=None, exclude=True, repr=False
    )
    response_observer: Callable[[Any], Awaitable[None]] | None = Field(
        default=None, exclude=True, repr=False
    )
    policy_generation: str
    processing_scope: str
    runtime_binding: Any = Field(default=None, exclude=True, repr=False)
    primary_seconds: float = Field(default=30, gt=0, le=40)
    fallback_seconds: float = Field(default=20, gt=0, le=30)

    def _primary_timeout(self, request) -> float:
        if self.processing_scope != "one_text_chat":
            return self.primary_seconds
        latest = request.contents[-1] if request.contents else None
        continuation = (
            latest is not None
            and latest.role == "user"
            and any(part.function_response is not None for part in latest.parts or [])
        )
        native_search = (
            self.allow_web_search
            and request.config is not None
            and any(
                getattr(tool, "google_search", None) is not None
                for tool in request.config.tools or []
            )
        )
        # Native search can be silent while searching. A tool response starts a
        # new model call, but is already inside the user's bounded active turn.
        return (
            ONE_TOOL_FIRST_OUTPUT_SECONDS if continuation or native_search else self.primary_seconds
        )

    async def _require_current(self):
        if self.runtime_binding is not None:
            try:
                self.runtime_binding.require_current()
            except RuntimeError as error:
                if str(error) == "Managed Azure processor selection changed":
                    raise ManagedTextAuthorityError(
                        "Managed Azure processing policy changed"
                    ) from None
                raise
        policy = managed_text_policy()
        if policy is None or policy["generation"] != self.policy_generation:
            raise ManagedTextAuthorityError("UAT managed text processing policy changed")
        if self.require_current is not None:
            try:
                await self.require_current()
            except ManagedTextAuthorityError:
                raise
            except PermissionError:
                raise ManagedTextAuthorityError(
                    "Text invocation authority validation failed"
                ) from None

    async def _observe_response(self, response, *, stream, deadline, observed):
        terminal = (
            response.partial is not True
            and not response.error_code
            and response.interrupted is not True
        )
        if not observed or terminal:
            await self._require_current()
        if (stream or self.response_observer is not None) and not observed:
            deadline.reschedule(asyncio.get_running_loop().time() + 60)
        if self.response_observer is not None:
            await self.response_observer(response)
        # AgentTool keeps its unary final result; genuine partials use its observer.
        publish = not (self.response_observer is not None and response.partial and not stream)
        return terminal, publish

    async def generate_content_async(self, llm_request, stream=False):
        current = self._require_current
        if self.require_current is None:
            raise ManagedTextAuthorityError("Managed text model requires invocation authority")
        await current()
        providers = (
            ("azure_openai", "vertex")
            if self.primary_provider == "azure_openai"
            else ("vertex", "azure_openai")
        )
        # One chat never changes processors, including manually composed models.
        if self.processing_scope == "one_text_chat":
            if self.primary_provider != "azure_openai":
                raise ValueError("One chat requires the managed Azure processor")
            providers = ("azure_openai",)
        elif not self.allow_fallback:
            providers = providers[:1]
        for index, provider in enumerate(providers):
            observed = completed = False
            request = llm_request
            model_name, location = self.model, ""
            if provider == "azure_openai":
                primary = self.model_copy(update={"require_current": current})
                source = AzureOpenAIAdkModel.generate_content_async(
                    primary, request, stream=stream or self.response_observer is not None
                )
                seconds = self._primary_timeout(request)
            else:
                vertex = self.fallback_model
                if vertex is None:
                    if self.fallback_factory is None:
                        raise ValueError("Managed Vertex alternate is not configured")
                    vertex = self.fallback_factory()
                request = llm_request.model_copy(deep=True)
                request.model = vertex.model
                # Provider-private encrypted reasoning cannot cross providers.
                for content in request.contents:
                    content.parts = [
                        part
                        for part in content.parts or []
                        if not (part.thought_signature or b"").startswith(b"azure-responses-v1:")
                    ]
                source = vertex.generate_content_async(request, stream=stream)
                model_name = vertex.model
                from hushh_mcp.runtime_providers import ManagedGeminiRuntimeBinding

                location = ManagedGeminiRuntimeBinding.from_environment().primary_location
                seconds = self.fallback_seconds
            logger.info(
                "managed_text.selection scope=%s policy=%s provider=%s attempt=%s first_output_budget_ms=%s",
                self.processing_scope,
                self.policy_generation,
                provider,
                index + 1,
                int(seconds * 1000),
            )
            try:
                if index:
                    await current()
                async with asyncio.timeout(seconds) as deadline:
                    async with aclosing(source) as responses:
                        async for response in responses:
                            terminal, publish = await self._observe_response(
                                response, stream=stream, deadline=deadline, observed=observed
                            )
                            observed = True
                            completed = completed or terminal
                            if publish:
                                yield response
                if not completed:
                    raise ValueError("Managed model call did not complete")
                if self.completion_observer is not None:
                    self.completion_observer(
                        {"provider": provider, "model": model_name, "location": location}
                    )
                logger.info(
                    "managed_text.outcome scope=%s provider=%s status=completed",
                    self.processing_scope,
                    provider,
                )
                return
            except Exception as error:
                reason = fallback_reason(error)
                logger.info(
                    "managed_text.attempt scope=%s provider=%s status=failed reason=%s error_type=%s observed=%s",
                    self.processing_scope,
                    provider,
                    reason or "non_retryable",
                    type(error).__name__,
                    observed,
                )
                if (
                    observed
                    or reason is None
                    or index
                    or not self.allow_fallback
                    or self.processing_scope == "one_text_chat"
                ):
                    raise


def build_managed_text_model(
    *,
    scope: str,
    require_current: Callable[[], Awaitable[None]] | None = None,
    provider: Literal["azure_openai", "vertex"] | None = None,
    completion_observer: Callable[[dict[str, str]], None] | None = None,
):
    """Reuse central Azure configuration. No settings/receipt lookup selects a provider."""
    if scope not in TEXT_SCOPES:
        raise ValueError("Unsupported managed text processing scope")
    policy = managed_text_policy()
    if policy is None:
        raise ValueError("Managed Azure text policy is UAT only")
    from hushh_mcp.runtime_providers.factory import ManagedGeminiRuntimeBinding
    from hushh_mcp.runtime_providers.gemini_config import resolve_fleet_model_name
    from hushh_mcp.runtime_providers.managed_azure import ManagedAzureBinding, _credential_supplier

    config = load_pwm_policy(environment="uat", provider="azure_openai")["azure"]

    # One fallback call to the configured Gemini location, no nested regional retries.
    def fallback():
        # Explicit Vertex transport: the default managed factory may now select
        # Azure, which must never masquerade as the alternate provider.
        return ManagedGeminiRuntimeBinding.from_environment().build_adk_model(
            resolve_fleet_model_name("gemini-default")
        )

    selected = provider or policy["selected_provider"]
    if selected not in {"azure_openai", "vertex"}:
        raise ValueError("Invalid UAT managed text provider")
    chat = scope == "one_text_chat"
    if chat and selected != "azure_openai":
        raise ValueError("One chat requires the managed Azure processor")
    binding = ManagedAzureBinding.from_environment() if chat else None
    if chat and binding is None:
        raise ValueError("One chat requires the managed Azure processor")
    return ManagedPrimaryTextModel(
        model=config["primary_deployment"],
        endpoint=config["primary_endpoint"],
        token_supplier=_credential_supplier(config["tenant_id"], config["client_id"]),
        require_current=require_current,
        fallback_factory=None if chat else fallback,
        allow_fallback=not chat,
        primary_provider=cast(ManagedProvider, selected),
        completion_observer=completion_observer,
        policy_generation=policy["generation"],
        processing_scope=scope,
        runtime_binding=binding,
        # The outer first-output budget is independent of the SDK's read-idle
        # budget after output starts. Never kill a healthy stream at 10 seconds.
        timeout_seconds=60 if chat else 30,
        primary_seconds=10 if chat else 30,
        fallback_seconds=8 if chat else 20,
        default_reasoning_effort="minimal" if chat else None,
    )


def one_chat_root_model(model: Any) -> Any:
    """Select only One's root; specialist and ordinary Search models stay intact."""
    if not isinstance(model, ManagedPrimaryTextModel) or model.processing_scope != "one_text_chat":
        return model
    binding = model.runtime_binding
    if binding is None:
        return model
    binding.require_current()
    descriptor = binding.capabilities.get("one_text_root")
    if descriptor is None:
        return model
    return model.model_copy(
        update={
            "model": descriptor["deployment"],
            "default_reasoning_effort": descriptor["reasoning_effort"],
            "text_verbosity": descriptor["text_verbosity"],
        }
    )


async def probe_managed_text_model(
    *,
    scope: str,
    provider: Literal["azure_openai", "vertex"] | None = None,
    allow_fallback: bool = True,
) -> ManagedTextReceipt:
    """Synthetic text only. This proves a transport, never owner access or tools."""
    import json

    from google.adk.models.llm_request import LlmRequest
    from google.genai import types

    async def synthetic_authority():
        return None  # No owner information, history, tools, or persistence is admitted.

    completed: list[dict[str, str]] = []
    model = build_managed_text_model(
        scope=scope,
        require_current=synthetic_authority,
        provider=provider,
        completion_observer=completed.append,
    ).model_copy(update={"allow_fallback": allow_fallback})
    if scope == "one_text_chat":
        model = one_chat_root_model(model)
    request = LlmRequest(
        model=model.model,
        contents=[
            types.Content(role="user", parts=[types.Part(text='Return exactly {"ready":true}.')])
        ],
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            response_json_schema={
                "type": "object",
                "properties": {"ready": {"type": "boolean"}},
                "required": ["ready"],
                "additionalProperties": False,
            },
            max_output_tokens=256,
            thinking_config=types.ThinkingConfig(thinking_level=types.ThinkingLevel.LOW),
        ),
    )
    results = [item async for item in model.generate_content_async(request)]
    answer = "".join(
        part.text or ""
        for item in results
        for part in (item.content.parts if item.content else [])
        if not part.thought
    )
    value = json.loads(answer)
    if (
        not isinstance(value, dict)
        or set(value) != {"ready"}
        or value["ready"] is not True
        or len(completed) != 1
        or (provider is not None and not allow_fallback and completed[0]["provider"] != provider)
    ):
        raise RuntimeError("Managed text provider did not complete its structured contract")
    return {
        "ready": True,
        "provider": cast(ManagedProvider, completed[0]["provider"]),
        "model": completed[0]["model"],
        "location": completed[0]["location"],
    }


def managed_text_binding(*, scope: str = "drive_document_requests") -> dict:
    policy = managed_text_policy()
    if policy is None:
        raise ValueError("Managed text binding is UAT only")
    config = load_pwm_policy(environment="uat", provider="azure_openai")["azure"]
    provider = policy["selected_provider"]
    deployment = config["primary_deployment"]
    fingerprint = profile_hash(config)
    if provider == "azure_openai" and scope == "one_text_chat":
        from hushh_mcp.managed_ai_config import load_managed_runtime_policy

        runtime = load_managed_runtime_policy()
        root = runtime["azure"].get("one_text_root") if runtime else None
        if root is not None:
            deployment = root["deployment"]
            fingerprint = profile_hash({"azure": config, "one_text_root": root})
    if provider == "vertex":
        from hushh_mcp.runtime_providers import ManagedGeminiRuntimeBinding
        from hushh_mcp.runtime_providers.gemini_config import resolve_fleet_model_name

        binding = ManagedGeminiRuntimeBinding.from_environment()
        deployment = resolve_fleet_model_name("gemini-default")
        fingerprint = profile_hash(
            {
                "azure": config,
                "vertex_project": binding.project,
                "vertex_location": binding.primary_location,
                "vertex_model": deployment,
            }
        )
    return {
        "provider": "gemini" if provider == "vertex" else provider,
        "deployment": deployment,
        "config_fingerprint": fingerprint,
        "approval_generation": policy["generation"],
        "authorization_basis": "uat_policy",
    }


class ManagedTextAgent(LlmAgent):
    """Bind current owner authority without mutating a process-wide ADK app."""

    async def canonical_model_async(self, ctx):
        model = self.canonical_model
        if not isinstance(model, ManagedPrimaryTextModel):
            return model
        from hushh_mcp.adk_bridge.delegation import validate_first_party_owner_token
        from hushh_mcp.one_adk.request_secrets import resolve_request_secret

        owner = ctx.state.get("hussh:user_id")
        token = resolve_request_secret(ctx.state.get("hussh:consent_token"))

        async def current():
            if self.name == "one_intro":
                # This separate pre-vault agent receives no protected history/tools.
                return
            if (
                not owner
                or not token
                or await validate_first_party_owner_token(owner, token, report_unavailable=True)
                is None
            ):
                raise ManagedTextAuthorityError("Current owner invocation authority ended")

        return model.model_copy(
            update={
                "require_current": current,
                "call_role": "root"
                if self.name in {"one", "one_intro"}
                else "search"
                if self.name == "google_search"
                else "specialist",
            }
        )


def managed_text_agent(**kwargs) -> LlmAgent:
    agent_type = (
        ManagedTextAgent if isinstance(kwargs.get("model"), ManagedPrimaryTextModel) else LlmAgent
    )
    return agent_type(**kwargs)
