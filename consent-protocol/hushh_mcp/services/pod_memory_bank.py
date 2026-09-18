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
composite service in :mod:`pod_memory_service` commits each event to the sealed log
before attempting the bank. Busy or unavailable generation falls back to that log;
there is no automatic backfill of turns skipped by the bank.

External erasure is not complete. The bootstrap token cannot delete the engine;
account deletion therefore refuses an unverified external-resource cascade. The
internal erasure reconciler below retains provider retry state behind the log fence;
trusted lifecycle admission and complete receipts must precede deprovisioning.
Creation intents below prevent blind retries after an uncertain provider response;
they are not an erasure fence or a provider-health receipt.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import uuid
from collections.abc import Coroutine
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Callable, Optional

logger = logging.getLogger(__name__)

#: Where the pod keeps the engine id: one small object in its own prefix.
MEMORY_BANK_RECORD_KEY = "memory_bank.json"
_DISPLAY_PREFIX = "one-pod-memory-"
_DEFAULT_LOCATION = "us-central1"
_CREATE_WAIT_SECONDS = 180
#: Operations read while recovering an unacknowledged submission. The owner
#: pod's engine holds two in its entire history; this is a runaway bound.
_OPERATION_PAGE_MAX = 200
#: The LRO metadata type a `memories:generate` submission creates. Recovery
#: adopts only this kind; an engine CREATE operation is not a generation.
_GENERATE_METADATA_TYPE = "GenerateMemoriesOperationMetadata"
_POLL_SECONDS = 3.0
# Strong references retain already-admitted workers after caller cancellation.
# This is process-local execution bookkeeping; the durable record owns admission.
_PROVIDER_TASKS: set[asyncio.Task] = set()


def _provider_finished(task: asyncio.Task) -> None:
    _PROVIDER_TASKS.discard(task)
    if not task.cancelled():
        task.exception()  # Consume a detached failure without logging information.


async def _await_admitted_work(work: Coroutine[Any, Any, Any]) -> Any:
    worker = asyncio.create_task(work)
    _PROVIDER_TASKS.add(worker)
    worker.add_done_callback(_provider_finished)
    return await asyncio.shield(worker)


class MemoryBankUnavailable(RuntimeError):
    """Memory Bank could not be reached or created; the caller falls back."""


class MemoryBankCreationPending(MemoryBankUnavailable):
    """A durable creation intent exists; reconciliation must never create again."""


class MemoryBankGenerationPending(MemoryBankUnavailable):
    """An earlier provider mutation has not established terminal completion."""


class MemoryBankErasurePending(MemoryBankUnavailable):
    """Erasure remains fenced until provider completion can be established."""


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


def _resource_segment(value: str) -> bool:
    return bool(value) and all(c.isascii() and (c.isalnum() or c in "-_") for c in value)


def _engine_id_from_name(name: str) -> Optional[str]:
    """``.../reasoningEngines/123`` or ``.../reasoningEngines/123/operations/9`` -> ``123``."""
    parts = str(name or "").split("/")
    try:
        return parts[parts.index("reasoningEngines") + 1] or None
    except (ValueError, IndexError):
        return None


def _completed_engine_id(operation: dict[str, Any], cfg: MemoryBankConfig) -> str:
    response = operation.get("response")
    name = response.get("name") if isinstance(response, dict) else None
    parts = name.split("/") if isinstance(name, str) else []
    # Only a returned engine resource establishes completion. An operation path
    # contains an allocated ID but does not prove an engine exists. Requests and
    # the durable record retain cfg.project; a provider name cannot reroute them.
    if (
        len(parts) != 6
        or parts[0] != "projects"
        or not parts[1]
        or parts[2] != "locations"
        or parts[3] != cfg.location
        or parts[4] != "reasoningEngines"
        or not parts[5]
    ):
        raise MemoryBankUnavailable("create finished without a valid engine resource")
    return parts[5]


def _json_object(response: Any) -> dict[str, Any]:
    try:
        payload = response.json()
    except Exception:  # noqa: BLE001 - provider bodies are never diagnostic text
        raise MemoryBankUnavailable("memory provider returned invalid JSON") from None
    if not isinstance(payload, dict):
        raise MemoryBankUnavailable("memory provider returned invalid response shape")
    return payload


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
    on_created: Optional[Callable[[dict[str, str]], None]] = None,
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
        body = _json_object(listing)
        if body.get("error") is not None:
            raise MemoryBankUnavailable("engine inventory operation failed")
        engines = body.get("reasoningEngines", [])
        if not isinstance(engines, list) or any(not isinstance(item, dict) for item in engines):
            raise MemoryBankUnavailable("engine inventory response invalid")
        for engine in engines:
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
    operation = _json_object(created)
    if operation.get("error") is not None:
        raise MemoryBankUnavailable("create operation failed")
    if operation.get("done") is True:
        engine_id = _completed_engine_id(operation, cfg)
        if on_created is not None:
            on_created(_engine_incarnation(operation.get("response"), cfg, engine_id))
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
        body = _json_object(polled)
        if body.get("error") is not None:
            raise MemoryBankUnavailable("create operation failed")
        if body.get("done") is not True:
            continue
        engine_id = _completed_engine_id(body, cfg)
        if on_created is not None:
            on_created(_engine_incarnation(body.get("response"), cfg, engine_id))
        return engine_id
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


def _engine_incarnation(body: Any, cfg: MemoryBankConfig, engine_id: str) -> dict[str, str]:
    """Narrow provider evidence; the local record timestamp is not an incarnation."""
    if not isinstance(body, dict):
        raise MemoryBankUnavailable("memory engine incarnation unavailable")
    name, created = body.get("name"), body.get("createTime")
    parts = name.split("/") if isinstance(name, str) else []
    if (
        len(parts) != 6
        or parts[0] != "projects"
        or not _resource_segment(parts[1])
        or parts[2:] != ["locations", cfg.location, "reasoningEngines", engine_id]
        or not isinstance(created, str)
        or not 0 < len(created) <= 64
        or body.get("error") is not None
    ):
        raise MemoryBankUnavailable("memory engine incarnation unavailable")
    try:
        timestamp = datetime.fromisoformat(created.replace("Z", "+00:00"))
        if timestamp.tzinfo is None:
            raise ValueError("timestamp has no timezone")
    except ValueError:
        raise MemoryBankUnavailable("memory engine incarnation unavailable") from None
    return {"name": name, "createTime": created}


def _observe_engine_incarnation(cfg: MemoryBankConfig, engine_id: str) -> dict[str, str]:
    """Read the configured resource, never a response-supplied URL. Blocking."""
    import requests  # type: ignore[import-untyped]  # noqa: PLC0415

    try:
        response = requests.get(
            f"{_base_url(cfg)}/reasoningEngines/{engine_id}",
            headers={"Authorization": f"Bearer {_adc_token()}"},
            timeout=30,
            allow_redirects=False,
        )
        if response.status_code != 200:
            raise MemoryBankUnavailable("memory engine observation refused")
        return _engine_incarnation(_json_object(response), cfg, engine_id)
    except Exception:
        raise MemoryBankUnavailable("memory engine observation unavailable") from None


def _decode_record(raw: Any, cfg: MemoryBankConfig) -> Optional[str]:
    if raw is None:
        return None
    record = json.loads(raw)
    expected = {"project": cfg.project, "location": cfg.location, "displayName": cfg.display_name}
    if not isinstance(record, dict) or any(record.get(k) != v for k, v in expected.items()):
        raise MemoryBankUnavailable("memory record owner or project mismatch")
    if "erasure" in record:
        raise MemoryBankUnavailable("memory record is fenced for erasure")
    if "status" not in record and (
        "generationProtocol" in record
        or "generationOperation" in record
        or "recallOperation" in record
    ):
        raise MemoryBankUnavailable("unsupported memory record version")
    if "status" in record:
        if record["status"] == "creating":
            if (
                "generationProtocol" in record
                or "generationOperation" in record
                or "recallOperation" in record
            ):
                raise MemoryBankUnavailable("inconsistent memory creation record")
            raise MemoryBankCreationPending("creation requires reconciliation")
        # Absence is the existing ready-record format. Unknown/future lifecycle
        # states must never be interpreted as permission to reopen an engine.
        if (
            record["status"] != "ready"
            or type(record.get("generationProtocol")) is not int
            or record["generationProtocol"] not in {1, 2}
        ):
            raise MemoryBankUnavailable("unsupported memory record state")
    _generation_slot(record)
    _recall_slot(record)
    engine_id = record.get("engineId")
    if (
        not isinstance(engine_id, str)
        or not engine_id
        or not all(c.isascii() and (c.isalnum() or c in "-_") for c in engine_id)
    ):
        raise MemoryBankUnavailable("invalid memory engine record")
    if "engineIncarnation" in record:
        receipt = record["engineIncarnation"]
        if _engine_incarnation(receipt, cfg, engine_id) != receipt:
            raise MemoryBankUnavailable("invalid memory engine incarnation record")
    if "creationProvenance" in record:
        _creation_provenance(record)
    return engine_id


def _creation_provenance(record: dict[str, Any]) -> dict[str, Any]:
    """Only an acknowledged fresh creation may carry this immutable evidence."""
    proof = record.get("creationProvenance")
    if (
        not isinstance(proof, dict)
        or set(proof) != {"version", "reservationGeneration", "engineIncarnation"}
        or type(proof.get("version")) is not int
        or proof["version"] != 1
        or type(proof.get("reservationGeneration")) is not int
        or proof["reservationGeneration"] <= 0
        or not isinstance(record.get("engineIncarnation"), dict)
        or proof.get("engineIncarnation") != record["engineIncarnation"]
        or record.get("generationProtocol") != 2
    ):
        raise MemoryBankUnavailable("invalid memory creation provenance")
    return proof


def _generation_slot(record: dict[str, Any]) -> Optional[dict[str, Any]]:
    slot = record.get("generationOperation")
    if slot is None:
        return None
    if (
        not isinstance(slot, dict)
        or set(slot) - {"attempt", "phase", "operation"}
        or not isinstance(slot.get("attempt"), str)
        or len(slot["attempt"]) != 32
        or any(c not in "0123456789abcdef" for c in slot["attempt"])
        or slot.get("phase") not in ("submitting", "pending")
    ):
        raise MemoryBankUnavailable("invalid generation reservation")
    if slot["phase"] == "submitting" and "operation" in slot:
        raise MemoryBankUnavailable("invalid generation reservation")
    if slot["phase"] == "pending" and (
        not isinstance(slot.get("operation"), str) or not slot["operation"]
    ):
        raise MemoryBankUnavailable("invalid generation acknowledgement")
    return slot


def _recall_slot(record: dict[str, Any]) -> Optional[dict[str, str]]:
    if "recallOperation" not in record:
        if record.get("generationProtocol") == 2:
            raise MemoryBankUnavailable("memory recall completion field missing")
        return None
    if record.get("generationProtocol") != 2:
        raise MemoryBankUnavailable("unsupported recall record version")
    slot = record["recallOperation"]
    if slot is None:
        return None
    if (
        not isinstance(slot, dict)
        or set(slot) != {"attempt", "clientId", "engineId"}
        or slot.get("engineId") != record.get("engineId")
        or any(
            not isinstance(slot.get(key), str)
            or len(slot[key]) != 32
            or any(c not in "0123456789abcdef" for c in slot[key])
            for key in ("attempt", "clientId")
        )
    ):
        raise MemoryBankUnavailable("invalid recall reservation")
    return slot


def _admission_fence(record: dict[str, Any], owner_id: str) -> dict[str, Any]:
    state = record.get("erasure")
    if (
        not isinstance(state, dict)
        or set(state) != {"version", "ownerId", "attemptId", "phase", "priorGeneration"}
        or type(state.get("version")) is not int
        or state["version"] != 1
        or state.get("ownerId") != owner_id
        or state.get("phase") != "admission_closed"
        or not isinstance(state.get("attemptId"), str)
        or not 0 < len(state["attemptId"]) <= 128
        or type(state.get("priorGeneration")) is not int
        or state["priorGeneration"] < 0
    ):
        raise MemoryBankUnavailable("memory admission fence mismatch")
    return state


async def fence_memory_bank_admission(
    *, store: Any, log: Any, owner_id: str, attempt_id: str
) -> None:
    """Close admission only, including absent/creating records; never call a provider."""
    try:
        await log.require_fenced(owner_id=owner_id, attempt_id=attempt_id)
        raw, generation = await store.get_with_generation(MEMORY_BANK_RECORD_KEY)
        record = json.loads(raw) if raw is not None else {}
        if not isinstance(record, dict):
            raise MemoryBankUnavailable("invalid memory record")
        if "erasure" in record:
            if (
                isinstance(record["erasure"], dict)
                and record["erasure"].get("phase") == "admission_closed"
            ):
                fence = _admission_fence(record, owner_id)
            else:
                if record.get("displayName") != _DISPLAY_PREFIX + owner_id:
                    raise MemoryBankUnavailable("memory admission owner mismatch")
                cfg = MemoryBankConfig(
                    project=record.get("project"),
                    location=record.get("location"),
                    display_name=record["displayName"],
                    engine_id=record.get("engineId"),
                )
                fence = _erasure_state(record, cfg, record.get("engineId"))
            if fence["attemptId"] != attempt_id:
                raise MemoryBankUnavailable("memory admission attempt changed")
            return
        if record and record.get("displayName") != _DISPLAY_PREFIX + owner_id:
            raise MemoryBankUnavailable("memory admission owner mismatch")
        if not record:
            cfg = memory_bank_config()
            if cfg is not None:
                if cfg.display_name != _DISPLAY_PREFIX + owner_id:
                    raise MemoryBankUnavailable("memory admission configuration mismatch")
                record = {
                    "project": cfg.project,
                    "location": cfg.location,
                    "displayName": cfg.display_name,
                }
        record = {
            **record,
            "erasure": {
                "version": 1,
                "ownerId": owner_id,
                "attemptId": attempt_id,
                "phase": "admission_closed",
                "priorGeneration": generation,
            },
        }
        _admission_fence(record, owner_id)
        await _persist_record(store, record, generation)
    except Exception:
        raise MemoryBankUnavailable("memory admission fence incomplete") from None


async def memory_bank_erasure_binding(
    *, store: Any, log: Any, owner_id: str, attempt_id: str
) -> dict[str, Any]:
    """Read bounded engine coordinates after fencing, without provider access.

    The hub must durably retain this binding before requesting reconciliation.
    It is not a deletion receipt or proof of historical provider-work drainage.
    """
    try:
        cfg = memory_bank_config()
        if cfg is None or cfg.display_name != _DISPLAY_PREFIX + owner_id:
            raise MemoryBankUnavailable("memory owner configuration unavailable")
        await log.require_fenced(owner_id=owner_id, attempt_id=attempt_id)
        raw, generation = await store.get_with_generation(MEMORY_BANK_RECORD_KEY)
        if type(generation) is not int or generation <= 0:
            raise MemoryBankUnavailable("memory record unavailable")
        record = json.loads(raw)
        engine_id = record.get("engineId")
        if not isinstance(engine_id, str) or not _resource_segment(engine_id):
            raise MemoryBankUnavailable("memory engine unavailable")
        if cfg.engine_id and cfg.engine_id != engine_id:
            raise MemoryBankUnavailable("memory engine configuration changed")
        state = _erasure_state(record, cfg, engine_id)
        if state["attemptId"] != attempt_id or record.get("generationProtocol") != 2:
            raise MemoryBankUnavailable("memory admission binding unavailable")
        incarnation = _engine_incarnation(record.get("engineIncarnation"), cfg, engine_id)
        # The record may receive late acknowledgements, but the captured binding
        # must come from one confirmed generation, never a torn read.
        if await store.get_with_generation(MEMORY_BANK_RECORD_KEY) != (raw, generation):
            raise MemoryBankUnavailable("memory binding changed during observation")
        await log.require_fenced(owner_id=owner_id, attempt_id=attempt_id)
        return {
            "project": cfg.project,
            "location": cfg.location,
            "engineId": engine_id,
            "engineIncarnation": incarnation,
            "generationProtocol": 2,
            **(
                {"creationProvenance": _creation_provenance(record)}
                if "creationProvenance" in record
                else {}
            ),
        }
    except Exception:
        raise MemoryBankUnavailable("memory erasure binding unavailable") from None


def _erasure_state(record: dict[str, Any], cfg: MemoryBankConfig, engine_id: str) -> dict[str, Any]:
    """Validate lifecycle metadata without admitting ordinary memory operations."""
    state = record.get("erasure")
    if isinstance(state, dict) and state.get("phase") == "admission_closed":
        state = _admission_fence(record, cfg.display_name.removeprefix(_DISPLAY_PREFIX))
        ordinary = {key: value for key, value in record.items() if key != "erasure"}
        if _decode_record(json.dumps(ordinary), cfg) != engine_id:
            raise MemoryBankUnavailable("memory admission binding mismatch")
        return state
    if (
        record.get("status") not in {"erasing", "provider_deleted"}
        or not isinstance(state, dict)
        or set(state)
        - {
            "version",
            "ownerId",
            "attemptId",
            "incarnationId",
            "engineCreateTime",
            "phase",
            "providerProject",
            "operation",
        }
        or type(state.get("version")) is not int
        or state["version"] != 1
        or state.get("ownerId") != cfg.display_name.removeprefix(_DISPLAY_PREFIX)
        or any(
            not isinstance(state.get(key), str)
            or not 0 < len(state[key]) <= 256
            or state[key] != state[key].strip()
            or any(ord(c) < 32 or ord(c) == 127 for c in state[key])
            for key in ("attemptId", "incarnationId", "engineCreateTime")
        )
        or state.get("phase")
        not in {"waiting", "delete_submitting", "delete_pending", "provider_deleted"}
        or (record["status"] == "provider_deleted") != (state["phase"] == "provider_deleted")
        or ("providerProject" in state and not _resource_segment(state["providerProject"]))
        or (state["phase"] != "waiting" and "providerProject" not in state)
        or (state["phase"] in {"delete_pending", "provider_deleted"}) != ("operation" in state)
    ):
        raise MemoryBankUnavailable("invalid memory erasure record")
    ready_fields = {key: value for key, value in record.items() if key != "erasure"}
    if _decode_record(json.dumps({**ready_fields, "status": "ready"}), cfg) != engine_id:
        raise MemoryBankUnavailable("memory erasure binding mismatch")
    if state["phase"] != "waiting" and (
        _generation_slot(record) is not None or _recall_slot(record) is not None
    ):
        raise MemoryBankUnavailable("memory erasure has an unresolved mutation")
    return state


async def _persist_record(store: Any, record: dict[str, Any], generation: int) -> int:
    payload = json.dumps(record, sort_keys=True).encode()
    updated = await store.put_if_generation(MEMORY_BANK_RECORD_KEY, payload, generation)
    observed, observed_generation = await store.get_with_generation(MEMORY_BANK_RECORD_KEY)
    if (
        type(updated) is not int
        or updated <= 0
        or type(observed_generation) is not int
        or observed != payload
        or observed_generation != updated
    ):
        raise MemoryBankUnavailable("memory record persistence unconfirmed")
    return updated


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
    if (
        type(generation) is not int
        or generation <= 0
        or await store.get(MEMORY_BANK_RECORD_KEY) != payload
    ):
        raise MemoryBankUnavailable("creation reservation not confirmed")
    return generation


async def _write_record(
    store: Any,
    cfg: MemoryBankConfig,
    engine_id: str,
    *,
    expected_generation: int = 0,
    creation_incarnation: Optional[dict[str, str]] = None,
) -> None:
    if store is None:
        raise MemoryBankUnavailable("durable memory record store unavailable")
    if not _resource_segment(engine_id):
        raise MemoryBankUnavailable("invalid memory engine identity")
    # Observe before first admission, then retain the exact provider name/time in
    # the existing CAS record. Never retrofit today's resource onto a legacy
    # record and call that historical identity proof.
    incarnation = await asyncio.to_thread(_observe_engine_incarnation, cfg, engine_id)
    provenance = {}
    if creation_incarnation is not None:
        if creation_incarnation != incarnation or expected_generation <= 0:
            raise MemoryBankUnavailable("memory creation observation mismatch")
        provenance = {
            "creationProvenance": {
                "version": 1,
                "reservationGeneration": expected_generation,
                "engineIncarnation": incarnation,
            }
        }
    payload = json.dumps(
        {
            "status": "ready",
            "generationProtocol": 2,
            "generationOperation": None,
            "recallOperation": None,
            "engineId": engine_id,
            "engineIncarnation": incarnation,
            "project": cfg.project,
            "location": cfg.location,
            "displayName": cfg.display_name,
            "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            **provenance,
        }
    ).encode()
    try:
        await store.put_if_generation(MEMORY_BANK_RECORD_KEY, payload, expected_generation)
    except Exception:
        # A CAS conflict is reconciled below; storage details remain private.
        pass
    observed, generation = await store.get_with_generation(MEMORY_BANK_RECORD_KEY)
    current = json.loads(observed) if observed is not None else {}
    if isinstance(current, dict) and "erasure" in current:
        state = _admission_fence(current, cfg.display_name.removeprefix(_DISPLAY_PREFIX))
        if state["priorGeneration"] != expected_generation or any(
            current.get(key) != value
            for key, value in {
                "project": cfg.project,
                "location": cfg.location,
                "displayName": cfg.display_name,
            }.items()
        ):
            raise MemoryBankUnavailable("creation acknowledgement binding changed")
        receipt = {"engineId": engine_id, "engineIncarnation": incarnation, **provenance}
        existing = current.get("creationAcknowledgement")
        if existing is not None and existing != receipt:
            raise MemoryBankUnavailable("creation acknowledgement changed")
        await _persist_record(store, {**current, "creationAcknowledgement": receipt}, generation)
        raise MemoryBankErasurePending("creation acknowledged under closed admission")
    # CAS loss is not proof that another boot stored the same engine. Verify the
    # winning durable record before reporting readiness or enabling retrieval.
    observed = await store.get(MEMORY_BANK_RECORD_KEY)
    if observed != payload or _decode_record(observed, cfg) != engine_id:
        raise MemoryBankUnavailable("memory record persistence conflict")


async def _resume_erasure_if_present(store: Any, cfg: MemoryBankConfig, log: Any) -> bool:
    """At boot, observe only a deletion already acknowledged in durable state.

    Initial deletion and unresolved submissions still require the trusted
    lifecycle coordinator. This path never discovers, creates, or submits DELETE.
    """
    raw = await store.get(MEMORY_BANK_RECORD_KEY)
    if raw is None:
        return False
    record = json.loads(raw)
    if not isinstance(record, dict):
        raise MemoryBankUnavailable("invalid memory recovery record")
    if "erasure" not in record:
        return False
    _STATE.update(engine_id=None, binding=None)
    _SERVICE.clear()
    if isinstance(record["erasure"], dict) and record["erasure"].get("phase") == "admission_closed":
        state = _admission_fence(record, cfg.display_name.removeprefix(_DISPLAY_PREFIX))
        await log.require_fenced(owner_id=state["ownerId"], attempt_id=state["attemptId"])
        raise MemoryBankErasurePending("memory admission closed; lifecycle reconciliation required")
    engine_id = record.get("engineId")
    if not isinstance(engine_id, str) or not _resource_segment(engine_id):
        raise MemoryBankUnavailable("invalid memory erasure engine")
    state = _erasure_state(record, cfg, engine_id)
    await log.require_fenced(owner_id=state["ownerId"], attempt_id=state["attemptId"])
    if state["phase"] not in {"delete_pending", "provider_deleted"}:
        raise MemoryBankErasurePending("memory erasure requires lifecycle reconciliation")
    service = build_rest_memory_bank_service(cfg, engine_id, store=store, is_current=lambda: False)
    result = await service.reconcile_memory_bank_erasure(
        log=log,
        user_id=state["ownerId"],
        attempt_id=state["attemptId"],
        incarnation_id=state["incarnationId"],
        expected_engine_create_time=state["engineCreateTime"],
        observe_only=True,
    )
    if result != {"status": "provider_deleted"}:
        raise MemoryBankErasurePending("memory erasure observation incomplete")
    _STATE["error"] = "MemoryBankProviderDeleted"
    return True


async def ensure_memory_bank(*, store: Any = None, log: Any = None) -> Optional[str]:
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
        if log is not None and await _resume_erasure_if_present(store, cfg, log):
            return None
        if log is not None:
            await log.require_open()
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
                created: list[dict[str, str]] = []
                engine_id = await asyncio.to_thread(
                    find_or_create_engine, cfg, on_created=created.append
                )
                await _write_record(
                    store,
                    cfg,
                    engine_id,
                    expected_generation=generation,
                    creation_incarnation=created[0] if len(created) == 1 else None,
                )
            elif not recorded:
                await _write_record(store, cfg, engine_id)
        if cfg.engine_id and cfg.engine_id != engine_id:
            raise MemoryBankUnavailable("configured engine conflicts with durable record")
        if log is not None:
            await log.require_open()
        if await _read_record(store, cfg) != engine_id:
            raise MemoryBankUnavailable("memory initialization admission changed")
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


async def rebuild_memory_bank(*, store: Any, log: Any = None, service: Any = None) -> str:
    """Replace this pod's engine with a fresh one, deterministically, on ADC alone.

    The provider offers whole-engine deletion only, so honouring a revoked fact at
    the provider means deleting the engine and creating another. This is the
    ``/pod/tick`` job behind ``memory_bank_rebuild_on_tick``; it needs no model
    and no owner credential, only the pod's own identity in the owner's project.

    Sequence, each step refusing rather than guessing:
    1. the durable record must be ready, unfenced, with no generation or recall
       slot open (an open slot raises ``MemoryBankGenerationPending``: try later);
    2. the engine is deleted through the resolved service's own ``_delete_engine``;
    3. the record is rewritten as a creation reservation at the CURRENT generation
       (CAS), so a concurrent boot cannot re-adopt the deleted engine;
    4. ``find_or_create_engine`` creates the replacement; a provider that still
       lists the deleted engine is refused rather than silently re-bound;
    5. the record is written for the new engine with its creation provenance and
       ``ensure_memory_bank`` re-binds the process to it.

    The caller records the ``agent_memory_provider_rebuild`` marker in the pod's
    log afterwards; nothing here writes to the memory log. Per-fact provider
    erasure is never claimed: the new engine simply starts empty.
    """
    cfg = memory_bank_config()
    if cfg is None or store is None:
        raise MemoryBankUnavailable("memory bank is not configured for this pod")
    bank = service if service is not None else resolve_memory_bank_service()
    if bank is None or not hasattr(bank, "_delete_engine"):
        raise MemoryBankUnavailable("memory bank service is not ready")
    if log is not None:
        await log.require_open()
    raw, generation = await store.get_with_generation(MEMORY_BANK_RECORD_KEY)
    if raw is None or type(generation) is not int or generation <= 0:
        raise MemoryBankUnavailable("memory record unavailable for rebuild")
    record = json.loads(raw)
    if not isinstance(record, dict) or "erasure" in record:
        raise MemoryBankUnavailable("memory record is fenced for erasure")
    if _generation_slot(record) is not None:
        raise MemoryBankGenerationPending("memory generation still pending")
    if _recall_slot(record) is not None:
        raise MemoryBankGenerationPending("memory recall completion unresolved")
    old_engine = _decode_record(raw, cfg)
    if not old_engine:
        raise MemoryBankUnavailable("memory record names no engine")

    await asyncio.to_thread(bank._delete_engine)
    reservation = {
        "status": "creating",
        "project": cfg.project,
        "location": cfg.location,
        "displayName": cfg.display_name,
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "rebuiltFrom": old_engine,
    }
    generation = await _persist_record(store, reservation, generation)
    created: list[dict[str, str]] = []
    engine_id = await asyncio.to_thread(find_or_create_engine, cfg, on_created=created.append)
    if not engine_id or engine_id == old_engine:
        raise MemoryBankUnavailable("provider still lists the deleted engine")
    await _write_record(
        store,
        cfg,
        engine_id,
        expected_generation=generation,
        creation_incarnation=created[0] if len(created) == 1 else None,
    )
    _STATE["binding"] = None
    _STATE["engine_id"] = None
    _SERVICE.clear()
    bound = await ensure_memory_bank(store=store, log=log)
    if bound != engine_id:
        raise MemoryBankUnavailable("memory rebuild admission changed")
    logger.info("pod_memory_bank.rebuilt location=%s", cfg.location)
    return engine_id


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
    Generation and recall use plain REST -- ``memories:generate`` after a
    turn and ``memories:retrieve`` on recall -- so this retains the adapter on the
    pod's own identity with no new dependency. Generation is a long-running
    operation tracked in the existing durable record; submission is not completion
    evidence. One outstanding mutation is permitted. Later turns stay in the
    sealed log while the slot is pending; this is not queued eventual indexing.
    Recall is synchronous and remains available while generation is pending.
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
    client_id = uuid.uuid4().hex

    def _headers() -> dict[str, str]:
        value = bearer.get() if hasattr(bearer, "get") else str(bearer)
        return {"Authorization": f"Bearer {value}"}

    class _RestMemoryBankService(BaseMemoryService):
        engine_id_ = engine_id
        _provider_project: Optional[str] = None

        def _get(self, resource: str) -> dict[str, Any]:
            try:
                response = http.get(
                    f"https://{cfg.location}-aiplatform.googleapis.com/v1beta1/{resource}",
                    headers=_headers(),
                    timeout=30,
                    allow_redirects=False,
                )
            except Exception:  # noqa: BLE001 - never retain provider/credential error text
                raise MemoryBankUnavailable("memory operation lookup unavailable") from None
            if response.status_code != 200:
                raise MemoryBankUnavailable(_api_error(response))
            return _json_object(response)

        async def _resolve_provider_project(self) -> str:
            if self._provider_project is None:
                # GET the configured engine, never a provider-supplied address.
                # Its canonical name proves the project-ID/number equivalence
                # needed when the subsequent LRO uses a numeric project name.
                body = await asyncio.to_thread(
                    self._get,
                    f"projects/{cfg.project}/locations/{cfg.location}/reasoningEngines/{engine_id}",
                )
                name = body.get("name")
                parts = name.split("/") if isinstance(name, str) else []
                if (
                    body.get("error") is not None
                    or len(parts) != 6
                    or parts[0] != "projects"
                    or not _resource_segment(parts[1])
                    or parts[2:] != ["locations", cfg.location, "reasoningEngines", engine_id]
                ):
                    raise MemoryBankUnavailable("memory engine identity unavailable")
                self._provider_project = parts[1]
            return self._provider_project

        def _operation_path(self, name: Any) -> str:
            # The generic Operation contract does not require the engine in its
            # name. Association is established only by the acknowledgement from
            # our POST to the configured engine, then stored in the owner-bound
            # record. A poll must return that exact stored operation; a matching
            # project/region alone is never enough to adopt another operation.
            parts = name.split("/") if isinstance(name, str) else []
            if (
                len(parts) not in {6, 8}
                or parts[:1] != ["projects"]
                or parts[1] not in {cfg.project, self._provider_project}
                or parts[2:4] != ["locations", cfg.location]
                or parts[-2] != "operations"
                or not _resource_segment(parts[-1])
                or (len(parts) == 8 and parts[4:6] != ["reasoningEngines", engine_id])
            ):
                raise MemoryBankUnavailable("memory operation identity unavailable")
            # Keep routing on the configured project even when the response used
            # its independently verified numeric alias.
            parts[1] = cfg.project
            return "/".join(parts)

        async def _record_state(self) -> tuple[dict[str, Any], int]:
            await require_record()
            raw, generation = await store.get_with_generation(MEMORY_BANK_RECORD_KEY)
            if _decode_record(raw, cfg) != engine_id or not is_current():
                raise MemoryBankUnavailable("memory generation admission changed")
            return json.loads(raw), generation

        async def _save_state(self, record: dict[str, Any], generation: int) -> int:
            if _decode_record(json.dumps(record), cfg) != engine_id:
                raise MemoryBankUnavailable("memory ordinary write binding changed")
            if not is_current():
                raise MemoryBankUnavailable("memory generation admission changed")
            updated = await _persist_record(store, record, generation)
            if not is_current():
                raise MemoryBankUnavailable("memory generation admission changed")
            return updated

        async def _complete_slot(
            self,
            record: dict[str, Any],
            field: str,
            expected: dict[str, Any],
            replacement: Optional[dict[str, Any]],
        ) -> tuple[dict[str, Any], int]:
            # Acknowledgements may race another slot or the erasure fence. Merge
            # only this exact operation; never republish a stale whole record.
            for _ in range(4):
                raw, generation = await store.get_with_generation(MEMORY_BANK_RECORD_KEY)
                current = json.loads(raw)
                if "erasure" in current:
                    if _erasure_state(current, cfg, engine_id)["phase"] not in {
                        "waiting",
                        "admission_closed",
                    }:
                        raise MemoryBankUnavailable("memory completion crossed erasure")
                elif _decode_record(raw, cfg) != engine_id:
                    raise MemoryBankUnavailable("memory completion binding changed")
                if current.get("engineIncarnation") != record.get("engineIncarnation"):
                    raise MemoryBankUnavailable("memory completion incarnation changed")
                previous = current.get(field)
                if previous == replacement:
                    return current, generation
                if previous != expected:
                    raise MemoryBankUnavailable("memory completion attempt changed")
                current = {**current, field: replacement}
                try:
                    updated = await _persist_record(store, current, generation)
                    return current, updated
                except Exception:
                    # Bounded retry revalidates owner, incarnation, fence and
                    # exact slot. No timeout removes an unresolved operation.
                    continue
            raise MemoryBankUnavailable("memory completion persistence unconfirmed")

        async def _save_generation_acknowledgement(
            self, record: dict[str, Any], generation: int
        ) -> tuple[dict[str, Any], int]:
            incoming = _generation_slot(record)
            if incoming is None or incoming["phase"] != "pending":
                raise MemoryBankUnavailable("memory acknowledgement unavailable")
            return await self._complete_slot(
                record,
                "generationOperation",
                {"attempt": incoming["attempt"], "phase": "submitting"},
                incoming,
            )

        def _erasure_engine_observation(self) -> Optional[dict[str, Any]]:
            try:
                response = http.get(engine, headers=_headers(), timeout=30, allow_redirects=False)
            except Exception:  # noqa: BLE001
                raise MemoryBankUnavailable("memory erasure observation unavailable") from None
            if response.status_code == 404:
                return None
            if response.status_code != 200:
                raise MemoryBankUnavailable(_api_error(response))
            body = _json_object(response)
            name = body.get("name")
            parts = name.split("/") if isinstance(name, str) else []
            if (
                "error" in body
                or len(parts) != 6
                or parts[0] != "projects"
                or not _resource_segment(parts[1])
                or parts[2:] != ["locations", cfg.location, "reasoningEngines", engine_id]
            ):
                raise MemoryBankUnavailable("memory erasure engine identity unavailable")
            return body

        def _delete_engine(self) -> dict[str, Any]:
            try:
                response = http.delete(
                    engine,
                    params={"force": "true"},
                    headers=_headers(),
                    timeout=30,
                    allow_redirects=False,
                )
            except Exception:  # noqa: BLE001
                raise MemoryBankErasurePending(
                    "memory deletion acknowledgement unresolved"
                ) from None
            if response.status_code != 200:
                raise MemoryBankErasurePending("memory deletion acknowledgement unavailable")
            return _json_object(response)

        async def reconcile_memory_bank_erasure(
            self,
            *,
            log: Any,
            user_id: str,
            attempt_id: str,
            incarnation_id: str,
            expected_engine_create_time: str,
            observe_only: bool = False,
        ) -> dict[str, str]:
            """Internal provider reconciliation; not account-erasure completion.

            The trusted lifecycle caller owns consent and registry/replacement
            fencing. Google DELETE has no incarnation precondition: createTime
            equality is an observation only. Compute and substrate teardown remain disabled.
            This method uses the captured store even after ordinary resolution
            is invalidated; every retry verifies its irreversible record binding.
            """
            require_owner(user_id)
            try:
                await log.require_fenced(owner_id=user_id, attempt_id=attempt_id)
                return await self._reconcile_erasure(
                    log=log,
                    user_id=user_id,
                    attempt_id=attempt_id,
                    incarnation_id=incarnation_id,
                    expected_engine_create_time=expected_engine_create_time,
                    observe_only=observe_only,
                )
            except MemoryBankUnavailable:
                raise
            except Exception:  # noqa: BLE001 - storage/provider details stay private
                raise MemoryBankUnavailable("memory erasure reconciliation unavailable") from None

        async def _reconcile_erasure(
            self,
            *,
            log: Any,
            user_id: str,
            attempt_id: str,
            incarnation_id: str,
            expected_engine_create_time: str,
            observe_only: bool,
        ) -> dict[str, str]:
            expected = {
                "version": 1,
                "ownerId": user_id,
                "attemptId": attempt_id,
                "incarnationId": incarnation_id,
                "engineCreateTime": expected_engine_create_time,
            }
            raw, generation = await store.get_with_generation(MEMORY_BANK_RECORD_KEY)
            record = json.loads(raw)
            if observe_only and (
                not isinstance(record, dict)
                or record.get("status") not in {"erasing", "provider_deleted"}
                or not isinstance(record.get("erasure"), dict)
                or record["erasure"].get("phase") not in {"delete_pending", "provider_deleted"}
            ):
                raise MemoryBankErasurePending("memory erasure is not acknowledged")
            if (
                isinstance(record, dict)
                and isinstance(record.get("erasure"), dict)
                and record["erasure"].get("phase") == "admission_closed"
            ):
                closed = _admission_fence(record, user_id)
                if closed["attemptId"] != attempt_id:
                    raise MemoryBankUnavailable("memory erasure attempt changed")
                # Only the trusted lifecycle caller may advance this phase. A
                # fenced absence or late creation receipt does not establish a
                # fully initialized engine or coverage of old provider work.
                ordinary = {key: value for key, value in record.items() if key != "erasure"}
                if (
                    ordinary.get("generationProtocol") != 2
                    or _decode_record(json.dumps(ordinary), cfg) != engine_id
                ):
                    raise MemoryBankErasurePending("memory initialization requires reconciliation")
                if _recall_slot(ordinary) is not None:
                    raise MemoryBankErasurePending("memory recall completion unresolved")
                incarnation = ordinary.get("engineIncarnation")
                if (
                    _engine_incarnation(incarnation, cfg, engine_id) != incarnation
                    or incarnation["createTime"] != expected_engine_create_time
                ):
                    raise MemoryBankUnavailable("memory erasure incarnation changed")
                record = {
                    **record,
                    "status": "erasing",
                    "erasure": {**expected, "phase": "waiting"},
                }
                _erasure_state(record, cfg, engine_id)
                generation = await _persist_record(store, record, generation)
            incarnation = record.get("engineIncarnation") if isinstance(record, dict) else None
            if (
                _engine_incarnation(incarnation, cfg, engine_id) != incarnation
                or incarnation["createTime"] != expected_engine_create_time
            ):
                raise MemoryBankUnavailable("memory erasure lacks matching incarnation evidence")
            if record.get("status") not in {"erasing", "provider_deleted"}:
                if _decode_record(raw, cfg) != engine_id:
                    raise MemoryBankUnavailable("memory erasure binding mismatch")
                record = {
                    **record,
                    "status": "erasing",
                    "generationProtocol": record.get("generationProtocol", 1),
                    "erasure": {**expected, "phase": "waiting"},
                }
                _erasure_state(record, cfg, engine_id)
                generation = await _persist_record(store, record, generation)
            state = _erasure_state(record, cfg, engine_id)
            if any(state.get(key) != value for key, value in expected.items()):
                raise MemoryBankUnavailable("memory erasure attempt or incarnation mismatch")
            if (
                "providerProject" in state
                and state["providerProject"] != incarnation["name"].split("/")[1]
            ):
                raise MemoryBankUnavailable("memory erasure provider binding mismatch")
            if "operation" in state:
                self._provider_project = state["providerProject"]
                self._operation_path(state["operation"])
            if state["phase"] == "provider_deleted":
                return {"status": "provider_deleted"}
            # Recheck before credentials or provider information access. No
            # timeout clears unresolved submission slots or reverses this fence.
            await log.require_fenced(owner_id=user_id, attempt_id=attempt_id)
            if state["phase"] == "delete_submitting":
                raise MemoryBankErasurePending("memory deletion acknowledgement unresolved")
            if state["phase"] == "waiting":
                if _recall_slot(record) is not None:
                    raise MemoryBankErasurePending("memory recall completion unresolved")
                slot = _generation_slot(record)
                if slot is not None and slot["phase"] == "submitting":
                    raise MemoryBankErasurePending("memory generation acknowledgement unresolved")
                body = await asyncio.to_thread(self._erasure_engine_observation)
                if (
                    body is None
                    or body.get("createTime") != expected_engine_create_time
                    or body.get("name") != incarnation["name"]
                ):
                    raise MemoryBankUnavailable("memory erasure incarnation not observed")
                provider_project = body["name"].split("/")[1]
                if "providerProject" in state and state["providerProject"] != provider_project:
                    raise MemoryBankUnavailable("memory provider project binding changed")
                self._provider_project = provider_project
                state = {**state, "providerProject": provider_project}
                record = {**record, "erasure": state}
                generation = await _persist_record(store, record, generation)
                if slot is not None:
                    operation = self._operation_path(slot["operation"])
                    payload = await asyncio.to_thread(self._get, operation)
                    if self._operation_path(payload.get("name")) != operation:
                        raise MemoryBankUnavailable("memory generation response mismatch")
                    if payload.get("done") is not True:
                        raise MemoryBankErasurePending("memory generation still pending")
                    if "error" in payload:
                        error = payload["error"]
                        if (
                            not isinstance(error, dict)
                            or type(error.get("code")) is not int
                            or not 1 <= error["code"] <= 16
                            or "response" in payload
                        ):
                            raise MemoryBankUnavailable("memory generation result invalid")
                    elif not isinstance(payload.get("response"), dict):
                        raise MemoryBankUnavailable("memory generation result unavailable")
                    record = {**record, "generationOperation": None}
                state = {**state, "phase": "delete_submitting"}
                record = {**record, "erasure": state}
                generation = await _persist_record(store, record, generation)
                await log.require_fenced(owner_id=user_id, attempt_id=attempt_id)

                async def delete_and_record_acknowledgement() -> tuple[dict, dict, dict, int]:
                    # Once admitted, a disconnected caller must not discard a
                    # provider acknowledgement. Process loss still leaves the
                    # durable submitting state unresolved; never repeat DELETE.
                    result = await asyncio.to_thread(self._delete_engine)
                    operation = self._operation_path(result.get("name"))
                    pending = {**state, "phase": "delete_pending", "operation": operation}
                    updated = {**record, "erasure": pending}
                    saved = await _persist_record(store, updated, generation)
                    return result, pending, updated, saved

                payload, state, record, generation = await _await_admitted_work(
                    delete_and_record_acknowledgement()
                )
            else:
                # Persisted alias came from the configured engine's authenticated
                # GET. A deleted engine cannot supply it again after restart.
                self._provider_project = state["providerProject"]
                operation = self._operation_path(state["operation"])
                payload = await asyncio.to_thread(self._get, operation)
                if self._operation_path(payload.get("name")) != operation:
                    raise MemoryBankUnavailable("memory deletion response mismatch")
            if payload.get("done") is not True:
                raise MemoryBankErasurePending("memory deletion still pending")
            if "error" in payload or payload.get("response") not in (
                {},
                {"@type": "type.googleapis.com/google.protobuf.Empty"},
            ):
                raise MemoryBankUnavailable("memory deletion completion unverified")
            if await asyncio.to_thread(self._erasure_engine_observation) is not None:
                raise MemoryBankErasurePending("memory engine absence unconfirmed")
            record = {
                **record,
                "status": "provider_deleted",
                "erasure": {**state, "phase": "provider_deleted"},
            }
            await _persist_record(store, record, generation)
            return {"status": "provider_deleted"}

        async def _discover_submitted_generation(self) -> Optional[str]:
            """The operation an unacknowledged POST created, or None if it never landed.

            WHY THIS IS SAFE TO ADOPT, and why the module's usual rule does not
            forbid it. `_operation_path` says a matching project and region is
            never enough to adopt an operation, and that is right: it guards
            against picking up a stranger's work. This lists the operations OF
            THE ENGINE THE OWNER-BOUND RECORD ALREADY NAMES, so the scope is the
            pod's own engine, not the project.

            WHY THE MOST RECENT ONE IS NECESSARILY OURS. Once a slot reaches
            phase `submitting`, `_generate` refuses before the POST on every
            later turn. So no generate operation can be created after the
            reservation, and the newest one is either the reservation's own or
            it predates it.

            That makes the duplicate risk zero, which is the whole reason this
            exists rather than a timer:

            *   the lost POST landed -> its operation is the newest -> adopted,
                and nothing is re-sent;
            *   the lost POST never landed -> the newest is an older, already
                finished operation -> adopting it clears the slot and the
                current turn proceeds normally. Nothing is duplicated, because
                there was never a second submission to duplicate. One already
                lost turn stays lost, which is what it already was.

            A blind expiry cannot make that distinction, which is why it was
            refused: on the owner pod the POST HAD landed and completed in 2.8
            seconds, so forgetting it would have duplicated that memory on the
            retry.
            """
            listing = await asyncio.to_thread(
                self._get,
                f"projects/{cfg.project}/locations/{cfg.location}"
                f"/reasoningEngines/{engine_id}/operations",
            )
            operations = listing.get("operations")
            if not isinstance(operations, list):
                return None
            newest_name: Optional[str] = None
            newest_created = ""
            for entry in operations[:_OPERATION_PAGE_MAX]:
                if not isinstance(entry, dict):
                    continue
                metadata = entry.get("metadata")
                if not isinstance(metadata, dict):
                    continue
                if not str(metadata.get("@type") or "").endswith(_GENERATE_METADATA_TYPE):
                    continue
                generic = metadata.get("genericMetadata")
                created = (generic if isinstance(generic, dict) else metadata).get("createTime")
                if not isinstance(created, str) or not created:
                    continue
                if created > newest_created:
                    # Validated the same way a polled operation is: a name this
                    # pod's own engine and project do not account for is refused.
                    newest_created, newest_name = created, self._operation_path(entry.get("name"))
            return newest_name

        async def _finish_operation(
            self, record: dict[str, Any], generation: int, payload: dict[str, Any]
        ) -> tuple[dict[str, Any], int]:
            if payload.get("done") is not True:
                raise MemoryBankGenerationPending("memory generation still pending")
            failed = "error" in payload
            if failed:
                error = payload["error"]
                if (
                    not isinstance(error, dict)
                    or type(error.get("code")) is not int
                    or not 1 <= error["code"] <= 16
                    or "response" in payload
                ):
                    raise MemoryBankUnavailable("memory operation result invalid")
            elif "response" in payload and not isinstance(payload["response"], dict):
                raise MemoryBankUnavailable("memory operation result unavailable")
            # A DONE OPERATION WITH NO `error` IS A SUCCESS, EVEN WITH NO `response`.
            #
            # Measured against real Vertex on 2026-09-11: a finished
            # `memories:generate` LRO returns exactly {name, metadata, done:true}
            # -- no `response` key at all. The engine CREATE operation does carry
            # one, which is why requiring it looked right.
            #
            # Demanding it made every successful generation unreconcilable: the
            # poll raised before `_complete_slot`, so the slot never cleared and
            # the next turn polled the same finished operation and raised again.
            # A second permanent latch, sitting in the path that was supposed to
            # recover from the first. The owner pod has exactly one generate
            # operation in its whole history, so this path had never once run to
            # completion.
            #
            # A malformed payload is still refused: a `response` that is present
            # and not an object fails above.
            slot = _generation_slot(record)
            if slot is None:
                raise MemoryBankUnavailable("memory generation completion lacks reservation")
            record, generation = await self._complete_slot(
                record, "generationOperation", slot, None
            )
            if failed:
                raise MemoryBankUnavailable("memory generation operation failed")
            return record, generation

        async def _generate(self, body: dict[str, Any]) -> None:
            await require_record()
            await self._resolve_provider_project()
            record, generation = await self._record_state()
            slot = _generation_slot(record)
            if slot:
                if slot["phase"] == "submitting":
                    # ASK THE PROVIDER BEFORE REFUSING.
                    #
                    # This used to raise unconditionally, and the reasoning was
                    # sound as far as it went: no timeout, restart or empty
                    # inventory can prove an unacknowledged POST will not
                    # materialize later. What it missed is that the provider can
                    # simply be ASKED. Measured on the owner pod 2026-09-11: the
                    # lost submission was sitting in the engine's operation list,
                    # created eight milliseconds before the pod logged its
                    # failure, done and error-free in 2.8 seconds. The pod had
                    # refused every memory write for twenty-five hours and five
                    # cold starts over an operation that had already succeeded.
                    #
                    # Discovery first, always. Only a provider that reports no
                    # generate operation at all establishes that nothing landed,
                    # and then there is nothing to duplicate by clearing.
                    discovered = await self._discover_submitted_generation()
                    if discovered is None:
                        # AN EMPTY INVENTORY STILL PROVES NOTHING, and the
                        # original refusal said so. A POST can be in flight and
                        # not yet listed, so clearing here would re-send it and
                        # duplicate the memory. That is exactly the case
                        # `test_lost_provider_acknowledgement_remains_unresolved`
                        # pins, and it is the owner pod's own shape.
                        #
                        # Expiring safely needs a reservation TIMESTAMP, so an
                        # empty inventory can be read as "long enough that an
                        # in-flight POST would have appeared by now". The slot
                        # schema has no timestamp today, and adding one changes
                        # the record in a way older images reject, so it carries
                        # a protocol bump and a rollback guard. That is a
                        # separate change; this one recovers the case that is
                        # provable and leaves the unprovable one exactly as it
                        # was.
                        raise MemoryBankGenerationPending(
                            "memory generation acknowledgement unresolved"
                        )
                    record, generation = await self._complete_slot(
                        record,
                        "generationOperation",
                        slot,
                        {**slot, "phase": "pending", "operation": discovered},
                    )
                    slot = _generation_slot(record)
            if slot:
                operation = self._operation_path(slot["operation"])
                payload = await asyncio.to_thread(self._get, operation)
                if self._operation_path(payload.get("name")) != operation:
                    raise MemoryBankUnavailable("memory operation response mismatch")
                record, generation = await self._finish_operation(record, generation, payload)
                await require_record()
            record = {
                **record,
                "status": "ready",
                "generationProtocol": record.get("generationProtocol", 1),
                "generationOperation": {"attempt": uuid.uuid4().hex, "phase": "submitting"},
            }
            generation = await self._save_state(record, generation)

            async def generate_and_record_acknowledgement() -> None:
                payload = await asyncio.to_thread(self._post, "memories:generate", body)
                operation = self._operation_path(payload.get("name"))
                acknowledged = {
                    **record,
                    "generationOperation": {
                        **record["generationOperation"],
                        "phase": "pending",
                        "operation": operation,
                    },
                }
                acknowledged, updated = await self._save_generation_acknowledgement(
                    acknowledged, generation
                )
                if payload.get("done") is True:
                    await require_record()
                    await self._finish_operation(acknowledged, updated, payload)

            # Keep the already-admitted worker alive to retain its acknowledgement
            # even if the originating turn is cancelled. Unknown outcomes retain
            # the durable submitting slot; this never authorizes a second POST.
            await _await_admitted_work(generate_and_record_acknowledgement())

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
            try:
                await self._generate(body)
            except Exception as exc:  # noqa: BLE001 - durable store failures may disclose paths
                if is_current():
                    _STATE["error"] = type(exc).__name__
                if isinstance(exc, MemoryBankUnavailable):
                    raise
                raise MemoryBankUnavailable("memory generation tracking unavailable") from None

        async def search_memory(self, *, app_name: str, user_id: str, query: str) -> Any:
            require_owner(user_id)
            try:
                return await self._search_memory(user_id=user_id, query=query)
            except MemoryBankUnavailable:
                raise
            except Exception:
                raise MemoryBankUnavailable("memory recall tracking unavailable") from None

        async def _search_memory(self, *, user_id: str, query: str) -> Any:
            await require_record()
            body = {
                "scope": {"user_id": str(user_id or cfg.display_name)},
                "similaritySearchParams": {"searchQuery": query, "topK": top_k},
            }
            record, generation = await self._record_state()
            if _recall_slot(record) is not None:
                raise MemoryBankUnavailable("memory recall completion unresolved")
            slot = {"attempt": uuid.uuid4().hex, "clientId": client_id, "engineId": engine_id}
            record = {
                **record,
                "status": "ready",
                "generationProtocol": 2,
                "recallOperation": slot,
            }
            await self._save_state(record, generation)

            async def retrieve_and_record_completion() -> dict[str, Any]:
                payload = await asyncio.to_thread(self._post, "memories:retrieve", body)
                await self._complete_slot(record, "recallOperation", slot, None)
                return payload

            # Cancelling the caller must not cancel acknowledgement of a worker
            # that is still running. Only a validated response and exact durable
            # completion clear admission. Process loss or uncertainty retain it.
            payload = await _await_admitted_work(retrieve_and_record_completion())
            # A durable fence or binding change can land while retrieval is in
            # flight. Do not release its information after admission is revoked.
            # This release check does not prove provider work has drained.
            await require_record()
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
            try:
                response = http.post(
                    f"{engine}/{verb}",
                    headers=_headers(),
                    json=body,
                    timeout=30,
                    allow_redirects=False,
                )
            except Exception:  # noqa: BLE001 - transport/auth exceptions may contain private context
                error = "memory provider request unavailable"
                if is_current():
                    _STATE["error"] = error
                raise MemoryBankUnavailable(error) from None
            if response.status_code not in (200, 201):
                message = _api_error(response)
                error = f"{verb} {response.status_code}: {message}"
                if is_current():
                    _STATE["error"] = error
                raise MemoryBankUnavailable(error)
            try:
                payload = _json_object(response)
                if payload.get("error") is not None and verb != "memories:generate":
                    raise MemoryBankUnavailable("memory provider operation failed")
                if verb == "memories:generate":
                    if payload.get("error") is not None and not payload.get("name"):
                        raise MemoryBankUnavailable("memory provider operation failed")
                    if not isinstance(payload.get("name"), str) or not payload["name"]:
                        raise MemoryBankUnavailable("memory generation acknowledgement unavailable")
                    if "done" in payload and not isinstance(payload["done"], bool):
                        raise MemoryBankUnavailable("memory generation status invalid")
                else:
                    entries = payload.get("retrievedMemories", [])
                    if not isinstance(entries, list) or any(
                        not isinstance(item, dict)
                        or not isinstance(item.get("memory"), dict)
                        or not isinstance(item["memory"].get("fact"), str)
                        for item in entries
                    ):
                        raise MemoryBankUnavailable("memory retrieval response invalid")
            except MemoryBankUnavailable as exc:
                if is_current():
                    _STATE["error"] = str(exc)
                raise
            if is_current():
                _STATE["error"] = None
            return payload

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
