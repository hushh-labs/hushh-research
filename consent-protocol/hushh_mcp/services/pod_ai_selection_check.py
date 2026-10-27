"""Does the owner's chosen AI accept their key? One tiny live call, and a typed answer.

Before a selection is stored the pod spends a few output tokens of the person's own
quota on the exact provider and model they chose, as the exact client their turns
will use. A key the provider refuses is never stored, so a person learns about a
mistyped key while they are still looking at the setting, not on their next question.

The provider's own error text never leaves this module and is never logged: an OpenAI
401 quotes part of the key back ("Incorrect API key provided: sk-ab...yz"). What leaves
is one code from a closed vocabulary and the exception's class name in a log line.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Iterator
from typing import Any, Optional

logger = logging.getLogger(__name__)

LIVE_CHECK_TIMEOUT_SECONDS = 8.0
#: OpenAI's Responses API refuses a cap below 16; a few tokens either way is the point.
LIVE_CHECK_MAX_OUTPUT_TOKENS = 16

KEY_REFUSED = "KEY_REFUSED"
QUOTA_EXCEEDED = "QUOTA_EXCEEDED"
MODEL_UNAVAILABLE = "MODEL_UNAVAILABLE"
PROVIDER_UNREACHABLE = "PROVIDER_UNREACHABLE"
BAD_ENVELOPE = "BAD_ENVELOPE"


def selection_model(provider: str, model: Optional[str], *, gemini_default: str) -> str:
    """The model a selection runs on; each provider's default when none was named."""
    if model:
        return model
    if provider == "openai":
        from hushh_mcp.runtime_providers.owner_openai import (  # noqa: PLC0415
            OWNER_OPENAI_DEFAULT_MODEL,
        )

        return OWNER_OPENAI_DEFAULT_MODEL
    return gemini_default


def selection_client(selection: Any) -> Any:
    """The client a turn on ``selection`` will use, built the same way."""
    if selection.provider == "azure_openai":
        from hushh_mcp.runtime_providers.owner_azure_key import (  # noqa: PLC0415
            build_transport,
            credential_bundle,
        )

        return build_transport(
            credential_bundle(
                endpoint=selection.azure_endpoint or "",
                deployment=selection.model or "",
                api_key=selection.api_key,
            )
        )
    if selection.provider == "openai":
        from hushh_mcp.runtime_providers.owner_openai import (  # noqa: PLC0415
            OWNER_OPENAI_MODE,
            build_owner_openai_transport,
        )

        return build_owner_openai_transport(
            runtime_provider="openai", runtime_mode=OWNER_OPENAI_MODE, credential=selection.api_key
        )
    from hushh_mcp.runtime_providers.factory import build_runtime_client  # noqa: PLC0415

    return build_runtime_client(
        "gemini",
        selection.api_key,
        gemini_byok_transport=selection.transport or "developer_api",
        vertex_project=selection.vertex_project,
        vertex_location=selection.vertex_location,
    )


def _chain(exc: BaseException) -> Iterator[BaseException]:
    seen: set[int] = set()
    current: Optional[BaseException] = exc
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        yield current
        current = current.__cause__ or current.__context__


def _http_status(exc: BaseException) -> Optional[int]:
    for attr in ("status_code", "code"):
        value = getattr(exc, attr, None)
        if isinstance(value, int) and not isinstance(value, bool) and 400 <= value <= 599:
            return value
    value = getattr(getattr(exc, "response", None), "status_code", None)
    if isinstance(value, int) and not isinstance(value, bool) and 400 <= value <= 599:
        return value
    return None


def _names_an_invalid_key(exc: BaseException) -> bool:
    """Gemini answers a bad key with 400 INVALID_ARGUMENT / API_KEY_INVALID, not 401."""
    text = f"{getattr(exc, 'message', '')} {getattr(exc, 'details', '')}".lower()
    return "api_key_invalid" in text or "api key not valid" in text


def provider_refusal(exc: BaseException) -> Optional[str]:
    """``KEY_REFUSED`` or ``QUOTA_EXCEEDED`` when the provider refused the owner's key."""
    for candidate in _chain(exc):
        status = _http_status(candidate)
        if status in {401, 403} or (status == 400 and _names_an_invalid_key(candidate)):
            return KEY_REFUSED
        if status == 429:
            return QUOTA_EXCEEDED
    return None


def classify_check_failure(exc: BaseException) -> str:
    """One code for a failed live check. Anything unrecognised is ``PROVIDER_UNREACHABLE``."""
    refusal = provider_refusal(exc)
    if refusal:
        return refusal
    for candidate in _chain(exc):
        if _http_status(candidate) in {400, 404, 422}:
            return MODEL_UNAVAILABLE
    return PROVIDER_UNREACHABLE


async def live_check(
    selection: Any,
    *,
    gemini_default: str,
    client: Any = None,
    timeout_seconds: float = LIVE_CHECK_TIMEOUT_SECONDS,
) -> Optional[str]:
    """None when the provider answered on this key and model; otherwise the code."""
    from google.genai import types  # noqa: PLC0415

    model = selection_model(selection.provider, selection.model, gemini_default=gemini_default)
    try:
        runtime = client if client is not None else selection_client(selection)
    except ValueError:
        # The selection itself cannot name a reachable endpoint (a malformed Vertex
        # project or location): nothing was sent, and nothing is stored.
        return BAD_ENVELOPE
    contents = [types.Content(role="user", parts=[types.Part.from_text(text="Reply with OK.")])]
    config = types.GenerateContentConfig(max_output_tokens=LIVE_CHECK_MAX_OUTPUT_TOKENS)
    try:
        await asyncio.wait_for(
            runtime.aio.models.generate_content(model=model, contents=contents, config=config),
            timeout=timeout_seconds,
        )
    except Exception as exc:  # noqa: BLE001 - every failure becomes one typed code
        code = classify_check_failure(exc)
        logger.info(
            "pod_ai_selection.check_failed provider=%s code=%s error=%s",
            selection.provider,
            code,
            type(exc).__name__,
        )
        return code
    return None


__all__ = [
    "KEY_REFUSED",
    "LIVE_CHECK_MAX_OUTPUT_TOKENS",
    "LIVE_CHECK_TIMEOUT_SECONDS",
    "MODEL_UNAVAILABLE",
    "PROVIDER_UNREACHABLE",
    "QUOTA_EXCEEDED",
    "classify_check_failure",
    "live_check",
    "provider_refusal",
    "selection_client",
    "selection_model",
]


async def verify_cloud_default(*, gemini_default: str) -> dict[str, str | int]:
    """Probe only a default admitted by the same model authority as pod chat."""
    import time  # noqa: PLC0415

    from google.genai import types  # noqa: PLC0415

    from hushh_mcp.runtime_providers import azure_openai  # noqa: PLC0415
    from hushh_mcp.runtime_providers.factory import build_managed_runtime_client  # noqa: PLC0415
    from hushh_mcp.runtime_providers.owner_gemini import (
        build_owner_gemini_client,
        require_admitted_model,
    )
    from hushh_mcp.services.pod_ai_effective_connection import cloud_default_fingerprint
    from hushh_mcp.services.pod_ai_selection import AiSelectionRefused  # noqa: PLC0415

    azure = azure_openai.owner_azure_model()
    if azure:
        provider, model = azure
        client = azure_openai.owner_azure_client(provider, "user_azure_mi")
    else:
        from hushh_mcp.services.pod_platform import workload_platform  # noqa: PLC0415

        if workload_platform() == "azure":
            raise AiSelectionRefused("AI_DEFAULT_UNAVAILABLE")
        from hushh_mcp.runtime_settings import (  # noqa: PLC0415
            pod_hosted_adc_enabled,
            pod_managed_model_enabled,
            pod_user_adc_enabled,
        )

        # Verification has the same default authority as ordinary turns;
        # fleet configuration alone must not discard an owner's key.
        if not (pod_hosted_adc_enabled() or pod_user_adc_enabled() or pod_managed_model_enabled()):
            raise AiSelectionRefused("AI_DEFAULT_UNAVAILABLE")
        provider, model = "gemini", require_admitted_model(gemini_default)
        client = (
            build_owner_gemini_client()
            if pod_hosted_adc_enabled() or pod_user_adc_enabled()
            else build_managed_runtime_client(provider)
        )
    fingerprint = cloud_default_fingerprint(provider, model)
    response = await asyncio.wait_for(
        client.aio.models.generate_content(
            model=model,
            contents="Reply with OK.",
            config=types.GenerateContentConfig(max_output_tokens=16),
        ),
        timeout=8,
    )
    if not isinstance(getattr(response, "text", None), str) or not response.text.strip():
        raise ValueError("PROVIDER_EMPTY_RESPONSE")
    if cloud_default_fingerprint(provider, model) != fingerprint:
        raise AiSelectionRefused("AI_DEFAULT_CONFIGURATION_CHANGED")
    return {
        "defaultProvider": provider,
        "defaultModel": model,
        "checkedAtMs": int(time.time() * 1000),
        "connectionFingerprint": fingerprint,
    }
