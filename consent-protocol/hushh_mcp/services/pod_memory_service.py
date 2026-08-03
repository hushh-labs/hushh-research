"""Per-pod agent memory — the ADK ``BaseMemoryService`` bound to one owner.

WHY THIS EXISTS
---------------
`AGENTS.md` § Agent Architecture Doctrine decides statefulness by **runtime topology**:
the shared multi-tenant hub stays dumb by default because memory there would be
cross-tenant leakage, while a **per-user pod** is an intelligent private agent that holds
its own memory. In a pod, isolation comes from topology and cryptography — one pod, one
owner, its own X25519 key, its own encrypted store — not from amnesia.

WHY NOT AN OFF-THE-SHELF ADK MEMORY SERVICE
-------------------------------------------
ADK 2.4.0 ships three: ``InMemoryMemoryService`` (keyword match, explicitly
prototyping-only), ``VertexAiMemoryBankService`` and ``VertexAiRagMemoryService``. Both
persistent options are Vertex-backed, which would place an owner's memory somewhere hussh
can read — breaking the exact guarantee a private agent depends on. There is no
Postgres-native or file-backed persistent memory service in 2.4.0. So the pod brings its
own, over the encrypted-blob seam that already exists in ``pod_storage``.

WHAT THIS IS AND IS NOT
-----------------------
PKM is the **information authority** — the zero-knowledge vault, system of record for what
the owner knows and holds. This is the **agent-experience** layer: conversation, learned
preference, working context, the accumulated sense of how to serve *this* owner. It is not
a second copy of PKM and must never become one, so the Bacterial Gate's prohibition on a
second source of truth holds.

INVARIANTS (each asserted by a test in ``tests/test_pod_memory_service.py``)
---------------------------------------------------------------------------
1. Memory never crosses a pod boundary. Every record is namespaced by ``hushh_id``; a
   lookup for a different owner returns nothing, and a mismatched owner raises.
2. Only ciphertext leaves this process. Text is handed to the storage backend already
   sealed; the backend receives an opaque blob, never plaintext.
3. Flag-off is inert. With ``POD_AGENT_MEMORY_ENABLED`` unset the service is never
   constructed and the runner keeps ``memory_service=None`` — today's exact behaviour.
4. Recall is explicit. Search is invoked by a tool call, so it can be receipted through
   ``pod_access_audit`` like any other access to the owner's information.

Ship-dark: default OFF. Nothing here runs until the flag is set in a pod.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import re
import time
from dataclasses import dataclass, field
from typing import Any, Optional

logger = logging.getLogger(__name__)

# Storage role: this is the pod's own working copy, not the cloud backup-of-record.
from hushh_mcp.services.pod_storage import ROLE_POD_CACHE  # noqa: E402

_WORD_RE = re.compile(r"[a-z0-9']+")
_MAX_ENTRIES_PER_OWNER = 5000  # bound the working set; oldest evicted first.


class PodMemoryError(RuntimeError):
    """Raised when a memory operation would cross an owner boundary."""


@dataclass(frozen=True)
class SealedMemory:
    """One memory record as it exists at rest: ciphertext plus searchable digests.

    ``ciphertext`` is opaque to everything outside the pod. ``token_digests`` are keyed
    one-way digests of the record's words, which let the pod match a query without holding
    plaintext in the index. A digest reveals nothing without the pod key, so the index is
    as private as the record.
    """

    memory_id: str
    hushh_id: str
    created_at_ms: int
    ciphertext: str
    token_digests: tuple[str, ...]
    author: Optional[str] = None
    custom_metadata: dict[str, Any] = field(default_factory=dict)


def _tokens(text: str) -> set[str]:
    return {t for t in _WORD_RE.findall((text or "").lower()) if len(t) > 2}


def _digest(pod_key: bytes, token: str) -> str:
    """Keyed digest so the search index leaks nothing without the pod key."""
    return hmac.new(pod_key, token.encode("utf-8"), hashlib.sha256).hexdigest()[:32]


def _seal(pod_key: bytes, plaintext: str) -> str:
    """Seal a record under the pod key.

    NOTE — deliberately simple: this XORs against an HMAC keystream derived from the pod
    key plus a per-record nonce, which binds the record to the key and keeps plaintext out
    of storage and logs. It is NOT a substitute for the real envelope. When
    ``pod_storage`` grows a live backend (M-series), sealing moves there and uses
    X25519-AES256-GCM, matching ``pod_connector_keypair_service.WRAPPING_ALG``. Keeping the
    seam here means that swap changes one function, not the service.
    """
    raw = plaintext.encode("utf-8")
    nonce = hashlib.sha256(raw + str(time.time_ns()).encode()).digest()[:16]
    stream = b""
    counter = 0
    while len(stream) < len(raw):
        stream += hmac.new(pod_key, nonce + counter.to_bytes(4, "big"), hashlib.sha256).digest()
        counter += 1
    # strict=False: the keystream is whole HMAC blocks and may exceed the payload;
    # truncating to the payload length is the intent.
    sealed = bytes(a ^ b for a, b in zip(raw, stream, strict=False))
    return base64.b64encode(nonce + sealed).decode("ascii")


def _unseal(pod_key: bytes, blob: str) -> str:
    data = base64.b64decode(blob.encode("ascii"))
    nonce, sealed = data[:16], data[16:]
    stream = b""
    counter = 0
    while len(stream) < len(sealed):
        stream += hmac.new(pod_key, nonce + counter.to_bytes(4, "big"), hashlib.sha256).digest()
        counter += 1
    return bytes(a ^ b for a, b in zip(sealed, stream, strict=False)).decode("utf-8")


def _content_text(content: Any) -> str:
    """Flatten ADK ``types.Content`` (or anything part-shaped) to searchable text."""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    parts = getattr(content, "parts", None) or []
    out = []
    for p in parts:
        t = getattr(p, "text", None)
        if t:
            out.append(str(t))
    return " ".join(out)


class PodMemoryStore:
    """Owner-scoped sealed store. Pure and injectable — no ADK import, no I/O.

    Kept separate from the ADK-facing service so the isolation and sealing invariants can
    be tested without constructing a Runner, and so the storage backend can be swapped
    without touching the ADK contract.
    """

    def __init__(self, *, hushh_id: str, pod_key: bytes, role: str = ROLE_POD_CACHE) -> None:
        if not hushh_id:
            raise PodMemoryError("pod memory requires a hushh_id — memory is always owner-scoped")
        if not pod_key:
            raise PodMemoryError("pod memory requires the pod key — records are sealed at rest")
        self._hushh_id = hushh_id
        self._pod_key = pod_key
        self._role = role
        self._records: list[SealedMemory] = []

    @property
    def role(self) -> str:
        return self._role

    def add(self, *, text: str, author: Optional[str] = None,
            custom_metadata: Optional[dict[str, Any]] = None) -> Optional[SealedMemory]:
        text = (text or "").strip()
        if not text:
            return None
        rec = SealedMemory(
            memory_id=hashlib.sha256(
                f"{self._hushh_id}|{text}|{time.time_ns()}".encode("utf-8")
            ).hexdigest()[:24],
            hushh_id=self._hushh_id,
            created_at_ms=int(time.time() * 1000),
            ciphertext=_seal(self._pod_key, text),
            token_digests=tuple(sorted(_digest(self._pod_key, t) for t in _tokens(text))),
            author=author,
            custom_metadata=dict(custom_metadata or {}),
        )
        self._records.append(rec)
        if len(self._records) > _MAX_ENTRIES_PER_OWNER:
            self._records = self._records[-_MAX_ENTRIES_PER_OWNER:]
        return rec

    def search(self, *, hushh_id: str, query: str, limit: int = 10) -> list[tuple[SealedMemory, str]]:
        """Return (record, plaintext) for matches. Raises if the owner does not match.

        The owner check is not defensive politeness — it is invariant 1. A pod that can be
        asked for another owner's memory is not a private agent.
        """
        if hushh_id != self._hushh_id:
            raise PodMemoryError(
                f"pod memory is owner-scoped: this pod serves {self._hushh_id!r}, asked for {hushh_id!r}"
            )
        wanted = {_digest(self._pod_key, t) for t in _tokens(query)}
        if not wanted:
            return []
        scored = []
        for rec in self._records:
            overlap = len(wanted.intersection(rec.token_digests))
            if overlap:
                scored.append((overlap, rec))
        scored.sort(key=lambda pair: (pair[0], pair[1].created_at_ms), reverse=True)
        return [(rec, _unseal(self._pod_key, rec.ciphertext)) for _, rec in scored[:limit]]

    def export(self) -> str:
        """Owner-facing export. Ciphertext only — proves the store holds no plaintext."""
        return json.dumps(
            [
                {
                    "memory_id": r.memory_id,
                    "created_at_ms": r.created_at_ms,
                    "ciphertext": r.ciphertext,
                    "author": r.author,
                }
                for r in self._records
            ],
            indent=2,
        )

    def purge(self) -> int:
        n = len(self._records)
        self._records.clear()
        return n

    def __len__(self) -> int:
        return len(self._records)


def resolve_pod_memory_service() -> Optional[Any]:
    """The single decision point for whether a runtime gets memory at all.

    Returns ``None`` — meaning ``Runner(memory_service=None)``, today's exact behaviour —
    unless BOTH hold:

    1. ``pod_mode()``  — this process serves exactly one owner. The shared hub must never
       hold memory; that is the doctrine's first half, and checking it here makes it a
       property of the code rather than a rule someone has to remember.
    2. ``pod_agent_memory_enabled()`` — the kill-switch is explicitly on.

    Fail-safe: any error resolving the pod identity or key returns ``None`` and logs, so a
    half-configured pod degrades to a memoryless agent rather than failing to start.
    """
    from hushh_mcp.runtime_settings import pod_agent_memory_enabled, pod_mode

    if not pod_mode():
        return None  # shared hub — dumb by default, structurally.
    if not pod_agent_memory_enabled():
        return None

    import os

    hushh_id = (os.environ.get("HUSSH_ID") or "").strip()
    pod_key_b64 = (os.environ.get("HUSSH_POD_MEMORY_KEY") or "").strip()
    if not hushh_id or not pod_key_b64:
        logger.warning(
            "pod_memory.disabled reason=missing_identity_or_key hushh_id_present=%s key_present=%s",
            bool(hushh_id),
            bool(pod_key_b64),
        )
        return None
    try:
        pod_key = base64.b64decode(pod_key_b64)
        return build_pod_memory_service(hushh_id=hushh_id, pod_key=pod_key)
    except Exception:  # noqa: BLE001 -- fail-safe: never block pod startup on memory
        logger.exception("pod_memory.build_failed hushh_id=%s", hushh_id)
        return None


def build_pod_memory_service(*, hushh_id: str, pod_key: bytes) -> Any:
    """Construct the ADK-facing memory service for THIS pod.

    Imports ADK lazily so the module stays importable (and unit-testable) in environments
    without ADK, matching how the KMS resolver defers ``google-cloud-kms``.

    Returns an object satisfying ``BaseMemoryService``: ``add_session_to_memory`` and
    ``search_memory``.
    """
    from google.adk.memory.base_memory_service import BaseMemoryService, SearchMemoryResponse
    from google.adk.memory.memory_entry import MemoryEntry
    from google.genai import types as genai_types

    store = PodMemoryStore(hushh_id=hushh_id, pod_key=pod_key)

    class _PodMemoryService(BaseMemoryService):
        """One owner's agent memory. Never shared, never plaintext at rest."""

        def __init__(self) -> None:
            self.store = store
            self.hushh_id = hushh_id

        async def add_session_to_memory(self, session: Any) -> None:
            for event in getattr(session, "events", None) or []:
                text = _content_text(getattr(event, "content", None))
                if text:
                    store.add(text=text, author=getattr(event, "author", None))

        async def search_memory(self, *, app_name: str, user_id: str, query: str) -> Any:
            # user_id carries the pod owner; a mismatch is an isolation breach, not a miss.
            hits = store.search(hushh_id=self.hushh_id if user_id in ("", self.hushh_id) else user_id,
                                query=query)
            return SearchMemoryResponse(
                memories=[
                    MemoryEntry(
                        content=genai_types.Content(parts=[genai_types.Part(text=plain)]),
                        id=rec.memory_id,
                        author=rec.author,
                        custom_metadata=dict(rec.custom_metadata),
                    )
                    for rec, plain in hits
                ]
            )

    return _PodMemoryService()
