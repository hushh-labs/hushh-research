"""What this pod can honestly do, derived from what it was deployed with.

Reported on ``/pod/info`` so the hub and the app can say, before anyone tries,
which features this agent has. Nothing here is a new flag: every answer is read
from deployment topology the hub already renders, or from what the platform sets
(``docs/reference/architecture/byoc-azure.md``, Azure version 1 capabilities):

* **memory recall** comes from Memory Bank only where one is configured (a Google
  Cloud project); everywhere else it is recall from the sealed commit log;
* **voice** needs a Vertex model, so a pod with no Vertex project says so here and
  refuses before accepting a connection, rather than failing after it;
* **Files background organization** needs Google Cloud Storage and its worker;
* **Gmail push** alerts are delivered through Google Pub/Sub only;
* **web search** is Google Search grounding, which only a Gemini model has, so a pod
  whose own model is the person's Azure OpenAI deployment, or whose owner sealed an
  OpenAI key to it, reports it unavailable;
* **private commands** (voice transcription and location commands) need Gemini
  structured output and audio input, so the same Azure or OpenAI pod reports them
  unavailable here instead of answering a typed 503 only after someone tries;
* **aiSelection** is which "Bring your own AI" providers this image can run a
  person's turns on (``pod_ai_selection``). An older image says nothing, and that
  silence is how the app knows to offer the owner an update before asking for a key.
  The heartbeat carries the same object to the hub, which keeps it only after
  ``ai_selection_advert`` has checked its shape.
"""

from __future__ import annotations

import os
import re
from typing import Any

from hushh_mcp.services.pod_platform import workload_platform

_TRUE = {"1", "true"}
AI_SELECTION_VERSION = 1
_PROVIDER_ID_RE = re.compile(r"^[a-z][a-z0-9_]{0,31}$")
_MAX_ADVERTISED_PROVIDERS = 8


def _env(name: str) -> str:
    return (os.getenv(name) or "").strip()


def _capability(reason: str) -> dict[str, Any]:
    """Available when ``reason`` is empty; otherwise unavailable, with why."""
    return {"available": not reason, "reason": reason or None}


def vertex_model_configured() -> bool:
    """A Vertex project rendered for this pod (every Google Cloud pod has one)."""
    return bool(_env("GENAI_GOOGLE_CLOUD_PROJECT") or _env("GOOGLE_CLOUD_PROJECT"))


def voice_capability() -> dict[str, Any]:
    from api.routes.one.relay_auth import one_voice_enabled  # noqa: PLC0415
    from hushh_mcp.services.pod_ai_selection import owner_ai_in_force  # noqa: PLC0415

    if not one_voice_enabled():
        return _capability("voice_disabled")
    if owner_ai_in_force():  # Live runs on managed Gemini: it never stands in for the owner's AI
        return _capability("owner_ai_selected")
    return _capability("" if vertex_model_configured() else "no_vertex_model")


def voice_available() -> bool:
    return bool(voice_capability()["available"])


def _files_organization() -> dict[str, Any]:
    if _env("POD_FILES_ENABLED").lower() not in _TRUE:
        return _capability("files_disabled")
    if not _env("POD_STORAGE_GCS_BUCKET"):
        return _capability("requires_google_cloud_storage")
    if not _env("POD_FILES_TASK_QUEUE") or not _env("POD_FILES_WORKER_SERVICE_ACCOUNT"):
        return _capability("background_worker_not_configured")
    return _capability("")


def own_model_provider() -> str:
    """The provider of this pod's OWN model, the one a request with no key of its own runs on.

    A sealed owner selection IS the own model, so its provider answers first. Otherwise
    any rendered Azure model topology, complete or not, means the own model is the
    person's Azure OpenAI deployment; every other pod's own model is Gemini (its Vertex,
    or a Gemini key). Never raises: a report must not fail where a turn would refuse.
    """
    from hushh_mcp.runtime_providers.azure_openai import (  # noqa: PLC0415
        AZURE_OPENAI_PROVIDER,
        azure_openai_configured,
    )
    from hushh_mcp.services.pod_ai_selection import current_ai_selection  # noqa: PLC0415

    selection = current_ai_selection()
    if selection is not None:
        # str(): mypy skips hushh_mcp.services (follow_imports=skip), so this is Any.
        return str(selection.provider)
    return AZURE_OPENAI_PROVIDER if azure_openai_configured() else "gemini"


def web_search_capability() -> dict[str, Any]:
    """Web search for this pod's OWN model, from the predicate One's head is built with.

    A turn that brings its own key or a Puppy device is decided by its head
    (``hushh_mcp/one_adk/web_search.py``), never by this report.
    """
    from hushh_mcp.one_adk.web_search import provider_supports_web_search  # noqa: PLC0415

    supported = provider_supports_web_search(own_model_provider())
    return _capability("" if supported else "requires_gemini_model")


def private_commands_capability() -> dict[str, Any]:
    """Voice transcription and location commands for this pod's OWN model.

    ``pod_commands._command_target`` builds a command brain only on Gemini, because a
    command needs Gemini structured output and audio input, which neither the owner's
    Azure transport nor an OpenAI key carries. Every other own model is refused there
    with ``COMMAND_MODEL_UNAVAILABLE``, so it is reported unavailable here, in the same
    words web search uses. A request that brings its own Gemini key or a Puppy device is
    decided by that request, never by this report.
    """
    return _capability("" if own_model_provider() == "gemini" else "requires_gemini_model")


def ai_selection_capability() -> dict[str, Any]:
    """The "Bring your own AI" providers this image runs turns on (contract C3)."""
    from hushh_mcp.services.pod_ai_selection_seal import SUPPORTED_PROVIDERS  # noqa: PLC0415

    return {"version": AI_SELECTION_VERSION, "providers": list(SUPPORTED_PROVIDERS)}


def ai_selection_advert(value: Any) -> dict[str, Any] | None:
    """A pod's self-reported ``aiSelection``, re-shaped, or None when it is not one.

    The hub stores what a pod says about itself only in this exact shape: a positive
    integer version and a short list of provider ids. Every other key is dropped, and
    a malformed advert reads as no advert (an older image), never as a partial one.
    """
    if not isinstance(value, dict):
        return None
    version = value.get("version")
    providers = value.get("providers")
    if type(version) is not int or not 1 <= version <= 1000 or not isinstance(providers, list):
        return None
    if len(providers) > _MAX_ADVERTISED_PROVIDERS or not all(
        isinstance(item, str) and _PROVIDER_ID_RE.fullmatch(item) for item in providers
    ):
        return None
    return {"version": version, "providers": list(dict.fromkeys(providers))}


def observed_ai_selection(backend_metadata: Any) -> dict[str, Any] | None:
    """The advert the running pod last reported (``observed``), or None for an older one."""
    observed = backend_metadata.get("observed") if isinstance(backend_metadata, dict) else None
    return ai_selection_advert(observed.get("aiSelection")) if isinstance(observed, dict) else None


def pod_capabilities() -> dict[str, Any]:
    from hushh_mcp.services.pod_memory_bank import memory_bank_config  # noqa: PLC0415

    platform = workload_platform()
    return {
        "platform": platform,
        "memoryRecall": {"source": "memory_bank" if memory_bank_config() else "sealed_log"},
        "voice": voice_capability(),
        "filesBackgroundOrganization": _files_organization(),
        "gmailPush": _capability("requires_google_pubsub" if platform == "azure" else ""),
        "webSearch": web_search_capability(),
        "privateCommands": private_commands_capability(),
        "aiSelection": ai_selection_capability(),
    }


__all__ = [
    "ai_selection_advert",
    "ai_selection_capability",
    "observed_ai_selection",
    "own_model_provider",
    "pod_capabilities",
    "private_commands_capability",
    "vertex_model_configured",
    "voice_available",
    "voice_capability",
    "web_search_capability",
]
