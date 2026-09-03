"""Vertex AI Memory Bank as the pod's memory, on the person's own Vertex.

Founder decision (2026-09-03): the pod's ADK memory is Memory Bank in the person's
project. Until now a pod's memory was keyed word-overlap over its sealed commit log:
real, durable, and lexical. Memory Bank is the first non-lexical retrieval in the
system -- managed extraction and embedding-backed recall -- and it runs under the
pod's OWN service account in the person's OWN project, so hushh never holds it.

Who creates the engine, and why it is the pod
---------------------------------------------
The Agent Engine that hosts a Memory Bank is created by the POD, lazily, after boot,
under its own identity. Verified 2026-09-03 in a live BYOC project: the bootstrap
account holds no Vertex role by design (``aiplatform.reasoningEngines.list`` denied),
and the hub cannot mint as the pod (``iam_bootstrap_can_run_as_pod`` is actAs, not
tokenCreator). The pod's service account is the one principal that already holds
``roles/aiplatform.user`` there, so self-provisioning needs no new grant and no
re-authorisation from people whose projects already exist.

The engine id is written once into the pod's own object store (beside the commit
log's wrapped key) and reported on the heartbeat, so the hub learns it without ever
being able to reach it.

Fail-safe, and loud about it
----------------------------
Every failure here degrades to the sealed commit log -- the durable record of record
-- and is visible on ``/pod/info`` (``memoryBankError``) rather than swallowed. The
composite service in :mod:`pod_memory_service` writes every turn to BOTH, so a Memory
Bank outage loses recall quality, never memory.

Not yet: erasure. The bootstrap token cannot delete the engine either, so account
deletion leaves it behind (Pillar 1 item; the fix is a pod-side erase step before
deprovision). Recorded here so nobody rediscovers it.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from dataclasses import dataclass
from typing import Any, Optional

logger = logging.getLogger(__name__)

#: Where the pod keeps the engine id: one small object in its own prefix.
MEMORY_BANK_RECORD_KEY = "memory_bank.json"
_DISPLAY_PREFIX = "one-pod-memory-"
_DEFAULT_LOCATION = "us-central1"
_CREATE_WAIT_SECONDS = 180
_POLL_SECONDS = 3.0


class MemoryBankUnavailable(RuntimeError):
    """Memory Bank could not be reached or created; the caller falls back."""


@dataclass(frozen=True)
class MemoryBankConfig:
    project: str
    location: str
    display_name: str
    engine_id: Optional[str]


def pod_memory_backend() -> str:
    """``commit_log`` (default) or ``memory_bank``. Read per call; env is the contract."""
    return (os.getenv("POD_MEMORY_BACKEND") or "commit_log").strip().lower() or "commit_log"


def memory_bank_config() -> Optional[MemoryBankConfig]:
    """The pod's Memory Bank address, or None when this pod does not use one.

    Regional on purpose: Agent Engine is not offered at ``global``, so the location is
    ``POD_MEMORY_BANK_LOCATION`` (rendered from the pod's own region), never the model
    location in ``GOOGLE_CLOUD_LOCATION``.
    """
    if pod_memory_backend() != "memory_bank":
        return None
    project = (os.getenv("GOOGLE_CLOUD_PROJECT") or "").strip()
    hushh_id = (os.getenv("HUSSH_ID") or "").strip()
    if not project or not hushh_id:
        return None
    location = (os.getenv("POD_MEMORY_BANK_LOCATION") or "").strip() or _DEFAULT_LOCATION
    engine_id = (os.getenv("POD_MEMORY_BANK_ENGINE_ID") or "").strip() or None
    return MemoryBankConfig(
        project=project,
        location=location,
        display_name=f"{_DISPLAY_PREFIX}{hushh_id}",
        engine_id=engine_id,
    )


def _base_url(cfg: MemoryBankConfig) -> str:
    return (
        f"https://{cfg.location}-aiplatform.googleapis.com/v1beta1/"
        f"projects/{cfg.project}/locations/{cfg.location}"
    )


def _engine_id_from_name(name: str) -> Optional[str]:
    """``.../reasoningEngines/123`` or ``.../reasoningEngines/123/operations/9`` -> ``123``."""
    parts = str(name or "").split("/")
    try:
        return parts[parts.index("reasoningEngines") + 1] or None
    except (ValueError, IndexError):
        return None


def _adc_token() -> str:
    import google.auth  # noqa: PLC0415
    from google.auth.transport.requests import Request  # noqa: PLC0415

    credentials, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
    credentials.refresh(Request())
    return str(credentials.token)


def _api_error(response: Any) -> str:
    """The API's own error message, bounded; the raw body when there is none."""
    try:
        body = response.json() or {}
    except Exception:  # noqa: BLE001
        body = {}
    message = str((body.get("error") or {}).get("message") or "")
    return " ".join((message or str(getattr(response, "text", "") or "")).split())[:300]


def _engine_body(cfg: MemoryBankConfig, *, explicit_models: bool = True) -> dict[str, Any]:
    """A Memory-Bank-only Agent Engine: no code deployed, just the memory store.

    ``explicit_models=False`` leaves the extraction and embedding models to the
    service's defaults; the explicit form names them on the person's own publisher.
    """
    memory_bank: dict[str, Any] = {}
    if explicit_models:
        publisher = f"projects/{cfg.project}/locations/{cfg.location}/publishers/google/models"
        generation = (os.getenv("POD_MEMORY_BANK_GENERATION_MODEL") or "gemini-2.5-flash").strip()
        embedding = (os.getenv("POD_MEMORY_BANK_EMBEDDING_MODEL") or "text-embedding-005").strip()
        memory_bank = {
            "generationConfig": {"model": f"{publisher}/{generation}"},
            "similaritySearchConfig": {"embeddingModel": f"{publisher}/{embedding}"},
        }
    return {
        "displayName": cfg.display_name,
        "description": "Hussh One private agent memory. Owned by this project's pod.",
        "contextSpec": {"memoryBankConfig": memory_bank},
    }


def find_or_create_engine(
    cfg: MemoryBankConfig,
    *,
    session: Any = None,
    token: Optional[str] = None,
    wait_seconds: float = _CREATE_WAIT_SECONDS,
    sleep: Any = time.sleep,
) -> str:
    """The engine for this pod, by display name; created when absent. Blocking.

    Find-first makes the call idempotent across restarts that lost the local record.
    Raises :class:`MemoryBankUnavailable` on any refusal, naming the step, so the
    fallback is loud about WHICH permission or quota is missing.
    """
    import requests  # type: ignore[import-untyped]  # noqa: PLC0415

    http = session or requests.Session()
    headers = {"Authorization": f"Bearer {token or _adc_token()}"}
    listing = http.get(
        f"{_base_url(cfg)}/reasoningEngines",
        headers=headers,
        params={"filter": f'display_name="{cfg.display_name}"'},
        timeout=30,
    )
    if listing.status_code != 200:
        raise MemoryBankUnavailable(f"list {listing.status_code}: {_api_error(listing)}")
    for engine in (listing.json() or {}).get("reasoningEngines") or []:
        if engine.get("displayName") == cfg.display_name:
            found = _engine_id_from_name(engine.get("name", ""))
            if found:
                return found
    created = http.post(
        f"{_base_url(cfg)}/reasoningEngines", headers=headers, json=_engine_body(cfg), timeout=60
    )
    if created.status_code == 400:
        # The explicit model choices were refused (seen live 2026-09-03 in a BYOC
        # project). Try once more letting the service pick its own defaults; a
        # Memory Bank with default models beats no Memory Bank, and the refusal is
        # kept in the error if the retry fails too.
        first = _api_error(created)
        created = http.post(
            f"{_base_url(cfg)}/reasoningEngines",
            headers=headers,
            json=_engine_body(cfg, explicit_models=False),
            timeout=60,
        )
        if created.status_code not in (200, 201):
            raise MemoryBankUnavailable(
                f"create {created.status_code}: {_api_error(created)} (with models: {first})"
            )
    elif created.status_code not in (200, 201):
        raise MemoryBankUnavailable(f"create {created.status_code}: {_api_error(created)}")
    operation = created.json() or {}
    engine_id = _engine_id_from_name(
        ((operation.get("response") or {}).get("name")) or operation.get("name", "")
    )
    if operation.get("done"):
        if operation.get("error"):
            raise MemoryBankUnavailable(f"create failed: {str(operation['error'])[:200]}")
        if engine_id:
            return engine_id
    op_name = str(operation.get("name") or "")
    deadline = time.monotonic() + wait_seconds
    while op_name and time.monotonic() < deadline:
        sleep(_POLL_SECONDS)
        polled = http.get(
            f"https://{cfg.location}-aiplatform.googleapis.com/v1beta1/{op_name}",
            headers=headers,
            timeout=30,
        )
        if polled.status_code != 200:
            continue
        body = polled.json() or {}
        if not body.get("done"):
            continue
        if body.get("error"):
            raise MemoryBankUnavailable(f"create failed: {str(body['error'])[:200]}")
        return (
            _engine_id_from_name((body.get("response") or {}).get("name", "")) or engine_id or ""
        ) or _raise(MemoryBankUnavailable("create finished without an engine name"))
    if engine_id:
        # The operation name already carries the id; a slow LRO is not a failure.
        return engine_id
    raise MemoryBankUnavailable("create timed out")


def _raise(exc: Exception) -> Any:
    raise exc


# ---- process state ---------------------------------------------------------------

_STATE: dict[str, Any] = {"engine_id": None, "error": None, "attempted": False}
_SERVICE: dict[str, Any] = {}


def memory_bank_status() -> dict[str, Any]:
    """What ``/pod/info`` and the heartbeat report. Absent fields mean absent."""
    out: dict[str, Any] = {}
    if _STATE.get("engine_id"):
        out["memoryBankEngine"] = str(_STATE["engine_id"])
    if _STATE.get("error"):
        out["memoryBankError"] = str(_STATE["error"])[:400]
    return out


def reset_memory_bank_state() -> None:
    """Tests only."""
    _STATE.update({"engine_id": None, "error": None, "attempted": False})
    _SERVICE.clear()


async def _read_record(store: Any) -> Optional[str]:
    if store is None:
        return None
    try:
        raw = await store.get(MEMORY_BANK_RECORD_KEY)
    except Exception:  # noqa: BLE001 - a missing record is the common case
        return None
    if not raw:
        return None
    try:
        return str(json.loads(raw).get("engineId") or "") or None
    except Exception:  # noqa: BLE001
        return None


async def _write_record(store: Any, cfg: MemoryBankConfig, engine_id: str) -> None:
    if store is None:
        return
    payload = json.dumps(
        {
            "engineId": engine_id,
            "project": cfg.project,
            "location": cfg.location,
            "displayName": cfg.display_name,
            "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
    ).encode()
    try:
        await store.put_if_generation(MEMORY_BANK_RECORD_KEY, payload, 0)
    except Exception:  # noqa: BLE001 - losing the race means another boot wrote it
        logger.info("pod_memory_bank.record_exists")


async def ensure_memory_bank(*, store: Any = None) -> Optional[str]:
    """Resolve (or create) this pod's engine once per process. Never raises.

    Order: env id, then the pod's own record, then find-or-create in the person's
    project. The outcome lands in :func:`memory_bank_status` either way.
    """
    if _STATE.get("engine_id"):
        return str(_STATE["engine_id"])
    cfg = memory_bank_config()
    if cfg is None:
        return None
    _STATE["attempted"] = True
    try:
        engine_id = cfg.engine_id or await _read_record(store)
        if not engine_id:
            engine_id = await asyncio.to_thread(find_or_create_engine, cfg)
            await _write_record(store, cfg, engine_id)
        _STATE["engine_id"] = engine_id
        _STATE["error"] = None
        logger.info(
            "pod_memory_bank.ready project=%s location=%s engine=%s",
            cfg.project,
            cfg.location,
            engine_id,
        )
        return engine_id
    except Exception as exc:  # noqa: BLE001 - memory must never take the pod down
        _STATE["error"] = f"{type(exc).__name__}: {str(exc)[:360]}"
        logger.warning("pod_memory_bank.unavailable reason=%s", _STATE["error"])
        return None


def resolve_memory_bank_service() -> Optional[Any]:
    """The ADK ``VertexAiMemoryBankService`` for this pod, or None. Never raises.

    Only once the engine is known: before ``ensure_memory_bank`` has run (or when it
    failed) the pod's memory is the commit log alone, which is the honest state.
    """
    cfg = memory_bank_config()
    engine_id = _STATE.get("engine_id")
    if cfg is None or not engine_id:
        return None
    if "service" in _SERVICE:
        return _SERVICE["service"]
    try:
        from google.adk.memory import VertexAiMemoryBankService  # noqa: PLC0415

        service = VertexAiMemoryBankService(
            project=cfg.project, location=cfg.location, agent_engine_id=str(engine_id)
        )
    except Exception as exc:  # noqa: BLE001
        _STATE["error"] = f"{type(exc).__name__}: {str(exc)[:160]}"
        logger.warning("pod_memory_bank.service_failed reason=%s", _STATE["error"])
        return None
    _SERVICE["service"] = service
    return service
