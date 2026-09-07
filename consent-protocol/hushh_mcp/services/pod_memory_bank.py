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

External erasure is not complete. The bootstrap token cannot delete the engine;
account deletion therefore refuses an unverified external-resource cascade. A
pod-side erase step and durable lifecycle fence must precede deprovisioning.
Creation intents below prevent blind retries after an uncertain provider response;
they are not an erasure fence or a provider-health receipt.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from dataclasses import dataclass
from typing import Any, Callable, Optional

logger = logging.getLogger(__name__)

#: Where the pod keeps the engine id: one small object in its own prefix.
MEMORY_BANK_RECORD_KEY = "memory_bank.json"
_DISPLAY_PREFIX = "one-pod-memory-"
_DEFAULT_LOCATION = "us-central1"
_CREATE_WAIT_SECONDS = 180
_POLL_SECONDS = 3.0


class MemoryBankUnavailable(RuntimeError):
    """Memory Bank could not be reached or created; the caller falls back."""


class MemoryBankCreationPending(MemoryBankUnavailable):
    """A durable creation intent exists; reconciliation must never create again."""


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
    """Provider bodies can contain owner information; expose only HTTP status."""
    return f"provider request refused (HTTP {int(response.status_code)})"


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
    allow_create: bool = True,
) -> str:
    """The engine for this pod, by display name; created when absent. Blocking.

    Find-first makes the call idempotent across restarts that lost the local record.
    Raises :class:`MemoryBankUnavailable` on any refusal, naming the step, so the
    fallback is loud about WHICH permission or quota is missing.
    """
    import requests  # type: ignore[import-untyped]  # noqa: PLC0415

    http = session or requests.Session()
    headers = {"Authorization": f"Bearer {token or _adc_token()}"}
    page_token = ""
    found_ids: set[str] = set()
    for _ in range(32):
        listing = http.get(
            f"{_base_url(cfg)}/reasoningEngines",
            headers=headers,
            params={
                "filter": f'display_name="{cfg.display_name}"',
                **({"pageToken": page_token} if page_token else {}),
            },
            timeout=30,
        )
        if listing.status_code != 200:
            raise MemoryBankUnavailable(f"list {listing.status_code}: {_api_error(listing)}")
        body = listing.json() or {}
        for engine in body.get("reasoningEngines") or []:
            if engine.get("displayName") == cfg.display_name:
                found = _engine_id_from_name(engine.get("name", ""))
                if not found:
                    raise MemoryBankUnavailable("engine inventory has invalid identity")
                found_ids.add(found)
        page_token = str(body.get("nextPageToken") or "")
        if not page_token:
            break
    else:
        raise MemoryBankUnavailable("engine inventory exceeds 32 pages")
    if len(found_ids) > 1:
        raise MemoryBankUnavailable("multiple engines require reconciliation")
    if found_ids:
        return next(iter(found_ids))
    if not allow_create:
        raise MemoryBankCreationPending("creation inventory unresolved")
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
            raise MemoryBankUnavailable("create operation failed")
        if engine_id:
            return engine_id
        # Done, no error, and no name to read. Polling a completed operation cannot
        # change any of that, so say so here rather than sleeping first and reaching
        # the same verdict one round later.
        raise MemoryBankUnavailable("create finished without an engine name")
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
            raise MemoryBankUnavailable("create operation failed")
        return (
            _engine_id_from_name((body.get("response") or {}).get("name", "")) or engine_id or ""
        ) or _raise(MemoryBankUnavailable("create finished without an engine name"))
    # Reaching here means the loop ran to the deadline WITHOUT the operation ever
    # reporting done. A slow create and a failing one are indistinguishable at that
    # point, and this used to pick "slow" and return the id parsed from the create
    # OPERATION's name -- which is not evidence an engine exists, only evidence one was
    # asked for.
    #
    # When the operation later completed with an error -- quota, or a model not
    # available in the person's region, the exact class 5e97f3ba1 was written for --
    # _STATE["engine_id"] was already set, /pod/info and the heartbeat reported
    # memoryBankEngine, and resolve_memory_bank_service built a REST client against a
    # reasoningEngines/<id> that does not exist. Every memories:generate and
    # memories:retrieve then 404s: the pod says it has a Memory Bank and recall
    # silently returns nothing, forever.
    #
    # Unavailable is the honest answer, and it costs nothing to be right about. This
    # function is find-FIRST and documents itself as "idempotent across restarts that
    # lost the local record", so if the engine did finish creating, the next boot lists
    # it by display name and adopts it. Until then the sealed commit log keeps
    # answering underneath, which is what it is for.
    raise MemoryBankUnavailable("create timed out")


def _raise(exc: Exception) -> Any:
    raise exc


# ---- process state ---------------------------------------------------------------

_STATE: dict[str, Any] = {"engine_id": None, "error": None, "attempted": False, "binding": None}
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
    _STATE.update({"engine_id": None, "error": None, "attempted": False, "binding": None})
    _SERVICE.clear()


async def _read_record(store: Any, cfg: MemoryBankConfig) -> Optional[str]:
    if store is None:
        raise MemoryBankUnavailable("durable memory record store unavailable")
    # Only an absent object is absence. Denied reads and corrupt recovery records
    # must not trigger another provider-side creation.
    raw = await store.get(MEMORY_BANK_RECORD_KEY)
    return _decode_record(raw, cfg)


def _decode_record(raw: Any, cfg: MemoryBankConfig) -> Optional[str]:
    if raw is None:
        return None
    record = json.loads(raw)
    expected = {"project": cfg.project, "location": cfg.location, "displayName": cfg.display_name}
    if not isinstance(record, dict) or any(record.get(k) != v for k, v in expected.items()):
        raise MemoryBankUnavailable("memory record owner or project mismatch")
    if "status" in record:
        if record["status"] == "creating":
            raise MemoryBankCreationPending("creation requires reconciliation")
        # Absence is the existing ready-record format. Unknown/future lifecycle
        # states must never be interpreted as permission to reopen an engine.
        raise MemoryBankUnavailable("unsupported memory record state")
    engine_id = record.get("engineId")
    if (
        not isinstance(engine_id, str)
        or not engine_id
        or not all(c.isascii() and (c.isalnum() or c in "-_") for c in engine_id)
    ):
        raise MemoryBankUnavailable("invalid memory engine record")
    return engine_id


async def _reserve_creation(store: Any, cfg: MemoryBankConfig) -> int:
    payload = json.dumps(
        {
            "status": "creating",
            "project": cfg.project,
            "location": cfg.location,
            "displayName": cfg.display_name,
            "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
    ).encode()
    generation = await store.put_if_generation(MEMORY_BANK_RECORD_KEY, payload, 0)
    if generation is None or await store.get(MEMORY_BANK_RECORD_KEY) != payload:
        raise MemoryBankUnavailable("creation reservation not confirmed")
    return generation


async def _write_record(
    store: Any, cfg: MemoryBankConfig, engine_id: str, *, expected_generation: int = 0
) -> None:
    if store is None:
        raise MemoryBankUnavailable("durable memory record store unavailable")
    payload = json.dumps(
        {
            "engineId": engine_id,
            "project": cfg.project,
            "location": cfg.location,
            "displayName": cfg.display_name,
            "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
    ).encode()
    await store.put_if_generation(MEMORY_BANK_RECORD_KEY, payload, expected_generation)
    # CAS loss is not proof that another boot stored the same engine. Verify the
    # winning durable record before reporting readiness or enabling retrieval.
    if await _read_record(store, cfg) != engine_id:
        raise MemoryBankUnavailable("memory record persistence conflict")


async def ensure_memory_bank(*, store: Any = None) -> Optional[str]:
    """Resolve (or create) this pod's engine once per process. Never raises.

    Order: env id, then the pod's own record, then find-or-create in the person's
    project. The outcome lands in :func:`memory_bank_status` either way.
    """
    cfg = memory_bank_config()
    if cfg is None:
        _STATE["binding"] = None
        _STATE["engine_id"] = None
        _SERVICE.clear()
        return None
    _STATE["attempted"] = True
    try:
        try:
            recorded = await _read_record(store, cfg)
        except MemoryBankCreationPending:
            # A previous process may have lost the create response. Discover only:
            # absence is not proof the timed-out operation will never complete.
            raw, generation = await store.get_with_generation(MEMORY_BANK_RECORD_KEY)
            try:
                engine_id = _decode_record(raw, cfg)
            except MemoryBankCreationPending:
                engine_id = await asyncio.to_thread(find_or_create_engine, cfg, allow_create=False)
                await _write_record(store, cfg, engine_id, expected_generation=generation)
            if not engine_id:
                raise MemoryBankUnavailable("creation reservation disappeared")
        else:
            if cfg.engine_id and recorded and cfg.engine_id != recorded:
                raise MemoryBankUnavailable("configured engine conflicts with durable record")
            engine_id = recorded or cfg.engine_id
            if not engine_id:
                # Prove durable write authority and reserve creation BEFORE any
                # provider request. Concurrent boots lose CAS and do not create.
                generation = await _reserve_creation(store, cfg)
                engine_id = await asyncio.to_thread(find_or_create_engine, cfg)
                await _write_record(store, cfg, engine_id, expected_generation=generation)
            elif not recorded:
                await _write_record(store, cfg, engine_id)
        if cfg.engine_id and cfg.engine_id != engine_id:
            raise MemoryBankUnavailable("configured engine conflicts with durable record")
        binding = _STATE.get("binding")
        if (
            binding is None
            or binding[0] != cfg
            or binding[1] is not store
            or binding[2] != engine_id
        ):
            _SERVICE.clear()
            _STATE["binding"] = (cfg, store, engine_id)
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
        _STATE["engine_id"] = None
        _STATE["binding"] = None
        _SERVICE.clear()
        _STATE["error"] = type(exc).__name__
        logger.warning("pod_memory_bank.unavailable reason=%s", _STATE["error"])
        return None


class _AdcToken:
    """A cached ADC bearer for the pod's own identity, refreshed when it expires."""

    def __init__(self) -> None:
        self._credentials: Any = None

    def get(self) -> str:
        import google.auth  # noqa: PLC0415
        from google.auth.transport.requests import Request  # noqa: PLC0415

        if self._credentials is None:
            self._credentials, _ = google.auth.default(
                scopes=["https://www.googleapis.com/auth/cloud-platform"]
            )
        if not self._credentials.valid:
            self._credentials.refresh(Request())
        return str(self._credentials.token)


def _event_text(content: Any) -> str:
    parts = getattr(content, "parts", None) or []
    texts = [str(getattr(part, "text", "") or "") for part in parts]
    return "\n".join(t for t in texts if t.strip()).strip()


def build_rest_memory_bank_service(
    cfg: MemoryBankConfig,
    engine_id: str,
    *,
    store: Any,
    is_current: Callable[[], bool],
    session: Any = None,
    token: Any = None,
    top_k: int = 8,
) -> Any:
    """Memory Bank over its REST surface, as an ADK ``BaseMemoryService``.

    ADK ships ``VertexAiMemoryBankService`` but it imports ``google-cloud-aiplatform``,
    which pins ``google-genai<2`` and cannot live in the same graph as ADK 2.x
    (``pyproject.toml`` keeps the ``gcp`` extra out on purpose; seen live 2026-09-03
    as ``ImportError`` on the founder's pod after the engine had been created).
    The two calls the service makes are plain REST -- ``memories:generate`` after a
    turn and ``memories:retrieve`` on recall -- so this is the same behaviour on the
    pod's own identity with no new dependency. Generation is a long-running
    operation the pod does not wait on; recall is synchronous and bounded.
    """
    import requests  # type: ignore[import-untyped]  # noqa: PLC0415
    from google.adk.memory.base_memory_service import (  # noqa: PLC0415
        BaseMemoryService,
        SearchMemoryResponse,
    )
    from google.adk.memory.memory_entry import MemoryEntry  # noqa: PLC0415
    from google.genai import types as genai_types  # noqa: PLC0415

    owner_id = cfg.display_name.removeprefix(_DISPLAY_PREFIX)
    if not cfg.display_name.startswith(_DISPLAY_PREFIX) or not owner_id:
        raise MemoryBankUnavailable("memory owner binding unavailable")

    def require_owner(user_id: Any) -> None:
        if user_id != owner_id:
            raise MemoryBankUnavailable("memory owner mismatch")

    async def require_record() -> None:
        # A composite can retain this client after the resolver cache is cleared.
        # Validate the captured binding on each operation, before inspecting event
        # information or obtaining provider credentials. This is an admission
        # check, not a distributed drain: an already admitted request can race a
        # later record mutation, so account erasure remains contained upstream.
        if not is_current():
            raise MemoryBankUnavailable("memory initialization is no longer current")
        try:
            if await _read_record(store, cfg) != engine_id or not is_current():
                raise MemoryBankUnavailable("memory record is no longer current")
        except Exception as exc:  # noqa: BLE001 - sanitize storage failure details
            if is_current():
                _STATE["error"] = type(exc).__name__
            raise MemoryBankUnavailable("memory record admission unavailable") from None

    http = session or requests.Session()
    bearer = token or _AdcToken()
    engine = f"{_base_url(cfg)}/reasoningEngines/{engine_id}"

    def _headers() -> dict[str, str]:
        value = bearer.get() if hasattr(bearer, "get") else str(bearer)
        return {"Authorization": f"Bearer {value}"}

    class _RestMemoryBankService(BaseMemoryService):
        engine_id_ = engine_id

        async def add_session_to_memory(self, session: Any) -> None:
            require_owner(getattr(session, "user_id", None))
            await require_record()
            events = []
            for event in getattr(session, "events", None) or []:
                if str(getattr(event, "invocation_id", "") or "").startswith("history_"):
                    continue  # browser-carried history is read, never re-stored
                text = _event_text(getattr(event, "content", None))
                if not text:
                    continue
                role = "model" if str(getattr(event, "author", "") or "") != "user" else "user"
                events.append({"content": {"role": role, "parts": [{"text": text}]}})
            if not events:
                return
            body = {
                "directContentsSource": {"events": events},
                "scope": {"user_id": str(getattr(session, "user_id", "") or cfg.display_name)},
            }
            await asyncio.to_thread(self._post, "memories:generate", body)

        async def search_memory(self, *, app_name: str, user_id: str, query: str) -> Any:
            require_owner(user_id)
            await require_record()
            body = {
                "scope": {"user_id": str(user_id or cfg.display_name)},
                "similaritySearchParams": {"searchQuery": query, "topK": top_k},
            }
            payload = await asyncio.to_thread(self._post, "memories:retrieve", body)
            memories = []
            for item in (payload or {}).get("retrievedMemories") or []:
                fact = str(((item or {}).get("memory") or {}).get("fact") or "").strip()
                if not fact:
                    continue
                memories.append(
                    MemoryEntry(
                        content=genai_types.Content(
                            role="model", parts=[genai_types.Part(text=fact)]
                        ),
                        author="memory_bank",
                        timestamp=str(((item or {}).get("memory") or {}).get("updateTime") or ""),
                    )
                )
            return SearchMemoryResponse(memories=memories)

        def _post(self, verb: str, body: dict[str, Any]) -> dict[str, Any]:
            response = http.post(f"{engine}/{verb}", headers=_headers(), json=body, timeout=30)
            if response.status_code not in (200, 201):
                message = _api_error(response)
                error = f"{verb} {response.status_code}: {message}"
                if is_current():
                    _STATE["error"] = error
                raise MemoryBankUnavailable(error)
            if is_current():
                _STATE["error"] = None
            try:
                return response.json() or {}
            except Exception:  # noqa: BLE001
                return {}

    return _RestMemoryBankService()


def resolve_memory_bank_service() -> Optional[Any]:
    """The pod's Memory Bank as a ``BaseMemoryService``, or None. Never raises.

    Only once the engine is known: before ``ensure_memory_bank`` has run (or when it
    failed) the pod's memory is the commit log alone, which is the honest state.
    """
    cfg = memory_bank_config()
    engine_id = _STATE.get("engine_id")
    binding = _STATE.get("binding")
    if cfg is None or not engine_id or binding is None or binding[0] != cfg:
        _STATE["binding"] = None
        _STATE["engine_id"] = None
        _SERVICE.clear()
        return None
    if "service" in _SERVICE:
        return _SERVICE["service"]
    try:
        service = build_rest_memory_bank_service(
            cfg,
            str(engine_id),
            store=binding[1],
            is_current=lambda: _STATE.get("binding") is binding and memory_bank_config() == cfg,
        )
    except Exception as exc:  # noqa: BLE001
        _STATE["error"] = type(exc).__name__
        logger.warning("pod_memory_bank.service_failed reason=%s", _STATE["error"])
        return None
    _SERVICE["service"] = service
    return service
