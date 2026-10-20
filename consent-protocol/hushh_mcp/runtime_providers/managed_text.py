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
from typing import Any
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


def managed_text_policy() -> dict | None:
    environment = (
        os.getenv("HUSHH_DEPLOY_ENV", "").strip() or os.getenv("ENVIRONMENT", "").strip()
    ).lower()
    if environment != "uat":
        return None
    policy = load_private_drive_text_policy()
    if not policy["enabled"]:
        raise ValueError("UAT managed text processing policy is disabled")
    return {**policy, "generation": str(uuid5(UUID(policy["policy_id"]), policy["version"]))}


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
    status = getattr(error, "status_code", None)
    if status == 429:
        return "quota"
    if status in {500, 502, 503, 504}:
        return "transient_service"
    return None


class ManagedPrimaryTextModel(AzureOpenAIAdkModel):
    """Responses-compatible identity preserves ADK tool-call pairing on replay."""

    fallback_model: Any = Field(exclude=True, repr=False)
    policy_generation: str
    processing_scope: str
    primary_seconds: float = Field(default=30, gt=0, le=40)
    fallback_seconds: float = Field(default=20, gt=0, le=30)

    async def generate_content_async(self, llm_request, stream=False):
        async def current():
            policy = managed_text_policy()
            if policy is None or policy["generation"] != self.policy_generation:
                raise ManagedTextAuthorityError("UAT managed text processing policy changed")
            if self.require_current is not None:
                try:
                    await self.require_current()
                except Exception:
                    raise ManagedTextAuthorityError(
                        "Current text invocation authority ended"
                    ) from None

        if self.require_current is None:
            raise ManagedTextAuthorityError("Managed text model requires invocation authority")
        await current()  # Outside provider-error handling: denial cannot select fallback.
        observed = False
        completed = False
        reason = None
        logger.info(
            "managed_text.selection scope=%s policy=%s primary=azure_openai",
            self.processing_scope,
            self.policy_generation,
        )
        try:
            async with asyncio.timeout(self.primary_seconds) as primary_deadline:
                primary = self.model_copy(update={"require_current": current})
                async with aclosing(
                    AzureOpenAIAdkModel.generate_content_async(primary, llm_request, stream=stream)
                ) as responses:
                    async for response in responses:
                        if stream and not observed:
                            primary_deadline.reschedule(asyncio.get_running_loop().time() + 60)
                        observed = True
                        completed = completed or (
                            response.partial is not True
                            and not response.error_code
                            and response.interrupted is not True
                        )
                        yield response
            if not completed:
                raise ValueError("Azure model call did not complete")
            logger.info(
                "managed_text.outcome scope=%s provider=azure_openai status=completed",
                self.processing_scope,
            )
            return
        except Exception as error:
            reason = fallback_reason(error)
            logger.info(
                "managed_text.attempt scope=%s provider=azure_openai status=failed reason=%s error_type=%s observed=%s",
                self.processing_scope,
                reason or "non_retryable",
                type(error).__name__,
                observed,
            )
            if observed or reason is None:
                raise
        await current()
        logger.info(
            "managed_text.fallback scope=%s provider=gemini reason=%s",
            self.processing_scope,
            reason,
        )
        request = llm_request.model_copy(deep=True)
        request.model = self.fallback_model.model
        # Azure encrypted reasoning is provider-private protocol state, not text.
        for content in request.contents:
            content.parts = [
                part
                for part in content.parts or []
                if not (part.thought_signature or b"").startswith(b"azure-responses-v1:")
            ]
        completed = False
        try:
            fallback_observed = False
            async with asyncio.timeout(self.fallback_seconds) as fallback_deadline:
                async with aclosing(
                    self.fallback_model.generate_content_async(request, stream=stream)
                ) as responses:
                    async for response in responses:
                        if stream and not fallback_observed:
                            fallback_deadline.reschedule(asyncio.get_running_loop().time() + 60)
                        fallback_observed = True
                        completed = completed or (
                            response.partial is not True
                            and not response.error_code
                            and response.interrupted is not True
                        )
                        yield response
            if not completed:
                raise ValueError("Gemini fallback did not complete")
        except Exception as error:
            logger.info(
                "managed_text.outcome scope=%s provider=gemini status=failed error_type=%s",
                self.processing_scope,
                type(error).__name__,
            )
            raise
        logger.info(
            "managed_text.outcome scope=%s provider=gemini status=completed reason=%s",
            self.processing_scope,
            reason,
        )


def build_managed_text_model(
    *, scope: str, require_current: Callable[[], Awaitable[None]] | None = None
):
    """Reuse central Azure configuration. No settings/receipt lookup selects a provider."""
    if scope not in TEXT_SCOPES:
        raise ValueError("Unsupported managed text processing scope")
    policy = managed_text_policy()
    if policy is None:
        raise ValueError("Managed Azure text policy is UAT only")
    from hushh_mcp.one_adk.azure_workload_identity import azure_openai_token_provider
    from hushh_mcp.runtime_providers import build_managed_gemini_adk_model
    from hushh_mcp.runtime_providers.gemini_config import resolve_fleet_model_name

    config = load_pwm_policy(environment="uat")["azure"]
    # One fallback call to the configured Gemini location, no nested regional retries.
    fallback = build_managed_gemini_adk_model(resolve_fleet_model_name("gemini-default"))
    return ManagedPrimaryTextModel(
        model=config["primary_deployment"],
        endpoint=config["primary_endpoint"],
        token_supplier=azure_openai_token_provider(
            tenant_id=config["tenant_id"], client_id=config["client_id"]
        ),
        require_current=require_current,
        fallback_model=fallback,
        policy_generation=policy["generation"],
        processing_scope=scope,
        timeout_seconds=10 if scope == "one_text_chat" else 30,
        primary_seconds=10 if scope == "one_text_chat" else 30,
        fallback_seconds=8 if scope == "one_text_chat" else 20,
    )


def managed_text_binding() -> dict:
    policy = managed_text_policy()
    if policy is None:
        raise ValueError("Managed text binding is UAT only")
    config = load_pwm_policy(environment="uat")["azure"]
    return {
        "provider": "azure_openai",
        "deployment": config["primary_deployment"],
        "config_fingerprint": profile_hash(config),
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
                or await validate_first_party_owner_token(owner, token) is None
            ):
                raise ManagedTextAuthorityError("Current owner invocation authority ended")

        return model.model_copy(update={"require_current": current})


def managed_text_agent(**kwargs) -> LlmAgent:
    agent_type = (
        ManagedTextAgent if isinstance(kwargs.get("model"), ManagedPrimaryTextModel) else LlmAgent
    )
    return agent_type(**kwargs)
