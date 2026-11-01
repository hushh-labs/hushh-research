"""Prepare one managed transport attempt without changing saved conversation events."""

from hushh_mcp.runtime_providers.azure_adk import AzureOpenAIAdkModel


async def prepare_text_attempt(owner, request, provider, index, current, stream):
    streaming = stream or owner.response_observer is not None
    if provider == "azure_openai":
        primary = owner.model_copy(update={"require_current": current})
        source = AzureOpenAIAdkModel.generate_content_async(primary, request, stream=streaming)
        return source, owner.model, "", owner._primary_timeout(request), None
    vertex = owner.fallback_model
    owned = vertex is None
    if vertex is None:
        if owner.fallback_factory is None:
            raise ValueError("Managed Vertex alternate is not configured")
        vertex = owner.fallback_factory()
    try:
        request = request.model_copy(deep=True)
        request.model = vertex.model
        if request.config is not None and request.config.thinking_config is None:
            from google.genai import types

            from hushh_mcp.runtime_providers.gemini_config import thinking_config_for

            request.config.thinking_config = thinking_config_for(
                vertex.model,
                "minimal"
                if owner.default_reasoning_effort == "none"
                else owner.default_reasoning_effort,
                types,
            )
        # Azure-private encrypted reasoning is not a native Gemini signature.
        for content in request.contents:
            content.parts = [
                part
                for part in content.parts or []
                if not (part.thought_signature or b"").startswith(b"azure-responses-v1:")
            ]
        request.contents = [content for content in request.contents if content.parts]
        from hushh_mcp.runtime_providers import ManagedGeminiRuntimeBinding

        location = ManagedGeminiRuntimeBinding.from_environment().primary_location
        seconds = owner._primary_timeout(request) if not index else owner.fallback_seconds
        source = vertex.generate_content_async(request, stream=streaming)
        return source, vertex.model, location, seconds, vertex if owned else None
    except BaseException:
        if owned:
            from hushh_mcp.runtime_providers.lifecycle import close_owned_adk_model

            await close_owned_adk_model(vertex)
        raise


def fallback_reason(error: Exception) -> str | None:
    """Closed retry taxonomy at the model transport boundary, never cause guessing."""
    from openai import APIConnectionError, APITimeoutError

    from hushh_mcp.runtime_providers.azure_adk import AzureAuthenticationError
    from hushh_mcp.runtime_providers.azure_call_lifecycle import (
        AzureRateLimitedError,
        AzureTokenServiceUnavailableError,
    )

    if isinstance(error, AzureTokenServiceUnavailableError):
        return "token_service"
    if isinstance(error, AzureRateLimitedError):
        return "quota"
    if isinstance(error, (PermissionError, ValueError, AzureAuthenticationError)):
        return None
    if isinstance(error, (TimeoutError, APITimeoutError)):
        return "timeout"
    if isinstance(error, APIConnectionError):
        return "connection"
    from hushh_mcp.runtime_providers.vertex_failover import _status_code

    status = _status_code(error)
    if status == 408:
        return "timeout"
    if status == 429:
        return "quota"
    if status in {500, 502, 503, 504}:
        return "transient_service"
    return None


def record_text_fallback(scope, primary, alternate, reason):
    import logging

    from hushh_mcp.one_adk.queued_input import current_run

    active = current_run()
    logging.getLogger("hushh_mcp.runtime_providers.managed_text").warning(
        "managed_text.fallback scope=%s primary=%s alternate=%s reason=%s "
        "attempt=2 run=%s drift=provider_fallback",
        scope,
        primary,
        alternate,
        reason,
        active.run_id[:8] if active is not None else "unbound",
    )
