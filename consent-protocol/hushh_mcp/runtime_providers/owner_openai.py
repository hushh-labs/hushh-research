"""The person's own OpenAI key as their agent's model, and the one door to owner models.

A person who brings an OpenAI key gets OpenAI, through the Responses API: GPT-6 and
GPT-5.6 models refuse tools with reasoning on Chat Completions
(``openai_responses_transport``), and One's head always carries tools. The general
factory's ``openai`` entry stays the hub's Chat Completions path; this module is the
pod's, selected only by the owner's sealed selection (``pod_ai_selection``), exactly as
``azure_openai`` is selected only by its mode.

``openai`` here is served only in mode ``byok`` and only with a key. The host is pinned
to ``api.openai.com`` so an ambient ``OPENAI_BASE_URL`` can never redirect the owner's
key, the same reason Gemini BYOK pins ``vertexai=False``.

``build_owner_adk_model`` and ``owner_model_client`` are the single entry points for
both owner-cloud models (the person's Azure deployment and their OpenAI key), so One's
head, the specialists and the close-time review cannot reach either by another road.
"""

from __future__ import annotations

import re
from typing import Any

from . import azure_openai

OWNER_OPENAI_PROVIDER = "openai"
OWNER_OPENAI_MODE = "byok"
#: The model a person gets when they choose OpenAI without naming one. The same id was
#: measured inside Azure on the owner's own deployment: 54 of 60, reasoning ``low``.
OWNER_OPENAI_DEFAULT_MODEL = "gpt-5.6-luna"
OPENAI_API_BASE_URL = "https://api.openai.com/v1"
#: Providers whose head is built by this module, never by the Gemini builders.
OWNER_HEADS = frozenset({azure_openai.AZURE_OPENAI_PROVIDER, OWNER_OPENAI_PROVIDER})

_MODEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$")


class OwnerOpenAIModeMismatch(ValueError):
    """``openai`` was asked for outside ``byok``, without a key, or with a bad model."""


def require_owner_openai_pair(
    *, runtime_provider: str, runtime_mode: str, credential: str | None
) -> str:
    """Admit exactly ``openai`` in ``byok`` with a key; return the key, refuse all else."""
    provider = str(runtime_provider or "").strip().lower()
    mode = str(runtime_mode or "").strip()
    if provider != OWNER_OPENAI_PROVIDER or mode != OWNER_OPENAI_MODE:
        raise OwnerOpenAIModeMismatch(
            f"{OWNER_OPENAI_PROVIDER} is served only in mode {OWNER_OPENAI_MODE} on a pod"
        )
    key = str(credential or "").strip()
    if not key:
        raise OwnerOpenAIModeMismatch("the owner's OpenAI key is required")
    return key


def owner_openai_model(model: str | None) -> str:
    """The OpenAI model id to call; the owner's default when they named none."""
    clean = str(model or "").strip() or OWNER_OPENAI_DEFAULT_MODEL
    if not _MODEL_RE.fullmatch(clean):
        raise OwnerOpenAIModeMismatch("the OpenAI model id is invalid")
    return clean


def build_owner_openai_transport(
    *,
    runtime_provider: str,
    runtime_mode: str,
    credential: str | None,
    http_client: Any = None,
) -> Any:
    """The Responses API transport on the owner's key, against OpenAI itself."""
    key = require_owner_openai_pair(
        runtime_provider=runtime_provider, runtime_mode=runtime_mode, credential=credential
    )
    from .openai_responses_transport import OpenAIResponsesTransport  # noqa: PLC0415

    return OpenAIResponsesTransport(
        api_key=key,
        base_url=OPENAI_API_BASE_URL,
        provider=OWNER_OPENAI_PROVIDER,
        http_client=http_client,
    )


def build_owner_openai_adk_model(
    model: str | None, *, mode: str, provider: str, api_key: str | None
) -> Any:
    """One's head on the owner's OpenAI key."""
    key = require_owner_openai_pair(
        runtime_provider=provider, runtime_mode=mode, credential=api_key
    )
    from .adk_model import ProviderAdkModel  # noqa: PLC0415

    return ProviderAdkModel(
        model=owner_openai_model(model),
        provider=OWNER_OPENAI_PROVIDER,
        credential=key,
        runtime_mode=OWNER_OPENAI_MODE,
    )


def _is_azure(provider: str, mode: str) -> bool:
    return (
        mode == azure_openai.USER_AZURE_MI_MODE
        or str(provider or "").strip().lower() == azure_openai.AZURE_OPENAI_PROVIDER
    )


def build_owner_adk_model(model: str, *, mode: str, provider: str, api_key: str | None) -> Any:
    """One's head on an owner-cloud model: their Azure deployment or their OpenAI key.

    Callers dispatch here BEFORE any Gemini alias rewrite, because ``default`` is a
    legal Azure deployment name and an OpenAI default is not a Gemini one.
    """
    if _is_azure(provider, mode):
        return azure_openai.build_owner_azure_adk_model(
            model, mode=mode, provider=provider, api_key=api_key
        )
    return build_owner_openai_adk_model(model, mode=mode, provider=provider, api_key=api_key)


def owner_model_client(runtime_provider: str, runtime_mode: str, credential: str | None) -> Any:
    """The only client door for an owner-cloud model, for a turn or a specialist."""
    if _is_azure(runtime_provider, runtime_mode):
        return azure_openai.owner_azure_client(runtime_provider, runtime_mode, credential)
    return build_owner_openai_transport(
        runtime_provider=runtime_provider, runtime_mode=runtime_mode, credential=credential
    )


def is_owner_model(provider: str | None, mode: str | None) -> bool:
    """Whether ``owner_model_client`` is the door for this pair."""
    return _is_azure(str(provider or ""), str(mode or "")) or (
        str(provider or "").strip().lower() == OWNER_OPENAI_PROVIDER
    )


__all__ = [
    "OPENAI_API_BASE_URL",
    "OWNER_HEADS",
    "OWNER_OPENAI_DEFAULT_MODEL",
    "OWNER_OPENAI_MODE",
    "OWNER_OPENAI_PROVIDER",
    "OwnerOpenAIModeMismatch",
    "build_owner_adk_model",
    "build_owner_openai_adk_model",
    "build_owner_openai_transport",
    "is_owner_model",
    "owner_model_client",
    "owner_openai_model",
    "require_owner_openai_pair",
]
