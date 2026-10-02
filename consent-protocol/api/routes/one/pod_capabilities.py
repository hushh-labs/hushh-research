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
* **Gmail push** alerts are delivered through Google Pub/Sub only.
"""

from __future__ import annotations

import os
from typing import Any

from hushh_mcp.services.pod_platform import workload_platform

_TRUE = {"1", "true"}


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

    if not one_voice_enabled():
        return _capability("voice_disabled")
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


def pod_capabilities() -> dict[str, Any]:
    from hushh_mcp.services.pod_memory_bank import memory_bank_config  # noqa: PLC0415

    platform = workload_platform()
    return {
        "platform": platform,
        "memoryRecall": {"source": "memory_bank" if memory_bank_config() else "sealed_log"},
        "voice": voice_capability(),
        "filesBackgroundOrganization": _files_organization(),
        "gmailPush": _capability("requires_google_pubsub" if platform == "azure" else ""),
    }


__all__ = ["pod_capabilities", "vertex_model_configured", "voice_available", "voice_capability"]
