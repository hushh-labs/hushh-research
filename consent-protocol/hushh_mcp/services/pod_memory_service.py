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
5. Memory survives the pod. Records are appended to the pod's sealed commit log as they
   are made and replayed on first use after a boot, so an economy-tier pod that goes
   cold between turns resumes rather than restarts. Without durable state configured
   the store is in-process and lossy -- working, but forgetful.

Ship-dark: default OFF. Nothing here runs until the flag is set in a pod.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import re
import time
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any, Optional

logger = logging.getLogger(__name__)

# Storage role: this is the pod's own working copy, not the cloud backup-of-record.
from hushh_mcp.services.pod_storage import ROLE_POD_CACHE  # noqa: E402

_WORD_RE = re.compile(r"[a-z0-9']+")
_MAX_ENTRIES_PER_OWNER = 5000  # bound the working set; oldest evicted first.

# The commit-log ``kind`` under which one sealed memory record is stored. The log is
# shared with the PKM path, so replay filters on this rather than assuming every
# record is memory.
_MEMORY_RECORD_KIND = "agent_memory"


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

    def as_payload(self, pod_key: bytes) -> dict[str, Any]:
        """The form written to the commit log. Nothing readable survives this call.

        ``author`` and ``custom_metadata`` are sealed rather than stored beside the
        ciphertext. They look like harmless labels, but ``custom_metadata`` is
        caller-supplied and invariant 2 is stated without exception -- the backend
        receives an opaque blob, never plaintext. Persisting them in the clear
        would make the invariant true of the message and false of the envelope,
        which is the kind of gap that is only ever found afterwards.

        ``token_digests`` stay outside the seal because search has to match them
        without opening every record; they are keyed HMACs and reveal nothing
        without the pod key. ``created_at_ms`` stays outside for ordering, and is
        no more than the log's own sequence already exposes.
        """
        return {
            "memory_id": self.memory_id,
            "hushh_id": self.hushh_id,
            "created_at_ms": self.created_at_ms,
            "ciphertext": self.ciphertext,
            "token_digests": list(self.token_digests),
            "envelope": _seal(
                pod_key,
                json.dumps(
                    {"author": self.author, "custom_metadata": self.custom_metadata},
                    sort_keys=True,
                ),
                owner=self.hushh_id,
            ),
        }

    @classmethod
    def from_payload(cls, pod_key: bytes, payload: dict[str, Any]) -> "SealedMemory":
        """Rebuild a record read back from the log. Raises if it is not this owner's.

        The envelope is opened with the owner bound as AAD, so a record lifted from
        another pod's log fails here rather than being served as this owner's memory.
        """
        owner = str(payload.get("hushh_id") or "")
        envelope = payload.get("envelope")
        meta: dict[str, Any] = {}
        if envelope:
            meta = json.loads(_unseal(pod_key, str(envelope), owner=owner))
        return cls(
            memory_id=str(payload.get("memory_id") or ""),
            hushh_id=owner,
            created_at_ms=int(payload.get("created_at_ms") or 0),
            ciphertext=str(payload.get("ciphertext") or ""),
            token_digests=tuple(payload.get("token_digests") or ()),
            author=meta.get("author"),
            custom_metadata=dict(meta.get("custom_metadata") or {}),
        )


def _tokens(text: str) -> set[str]:
    return {t for t in _WORD_RE.findall((text or "").lower()) if len(t) > 2}


def _digest(pod_key: bytes, token: str) -> str:
    """Keyed digest so the search index leaks nothing without the pod key."""
    return hmac.new(pod_key, token.encode("utf-8"), hashlib.sha256).hexdigest()[:32]


# Sealing format version. Present in every blob so a reader can tell what it is
# holding instead of guessing -- and so the previous format is REFUSED rather than
# misread. See `_seal` for why the old one had to go.
_SEAL_V2 = "v2"
_AES_GCM_NONCE_BYTES = 12  # 96 bits, the size AES-GCM is specified for
_SEAL_KEY_INFO = b"hushh/pod-memory/aes256gcm/v2"


def _seal_key(pod_key: bytes) -> bytes:
    """Derive a dedicated 32-byte AES-256 key from the pod key material.

    Derived rather than used directly for two reasons. AES-256 needs exactly 32
    bytes and ``HUSSH_POD_MEMORY_KEY`` is operator-supplied, so its length is not
    guaranteed. And the pod key is used elsewhere -- ``_digest`` builds the search
    index from it -- so giving the cipher its own key via a distinct ``info`` label
    means the two uses can never interact.
    """
    from cryptography.hazmat.primitives import hashes  # noqa: PLC0415
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF  # noqa: PLC0415

    return HKDF(
        algorithm=hashes.SHA256(), length=32, salt=None, info=_SEAL_KEY_INFO
    ).derive(pod_key)


def _seal(pod_key: bytes, plaintext: str, *, owner: str = "") -> str:
    """Seal a record under the pod key with authenticated AES-256-GCM.

    What this replaced, and why it had to be replaced
    ------------------------------------------------
    The previous implementation XORed the plaintext against an HMAC keystream. It
    was honestly labelled a placeholder, and it had two defects that a placeholder
    cannot be excused for once real holdings pass through it:

    1. **Unauthenticated.** A keystream cipher with no MAC is malleable: flipping a
       bit of ciphertext flips exactly that bit of plaintext, undetectably. Anyone
       who could write to storage could edit a person's memories -- not read them,
       but *change* them -- and the pod would serve the result as though the owner
       had said it. For an agent whose whole job is to remember you accurately,
       silent tampering is a worse failure than disclosure.
    2. **The nonce was derived from the plaintext** (``sha256(raw + time_ns())``).
       Two identical records written in the same nanosecond produced the same
       nonce, and a repeated nonce on a keystream cipher leaks the XOR of the two
       plaintexts. The nonce also became a fingerprint: equal nonces proved equal
       content without any need to decrypt.

    AES-256-GCM fixes both. The nonce is 96 random bits from the OS, never derived
    from the message, and the tag makes any modification a decryption failure
    rather than a silently altered memory.

    ``owner`` is bound as additional authenticated data, so a sealed record cannot
    be lifted out of one person's pod and replayed into another's -- it would fail
    to open there even under an identical key. The record is bound to whose it is,
    not merely to the key that happened to seal it.

    **No migration was required**, and that was a fact rather than a hope: when v2
    replaced the XOR format, ``PodMemoryStore._records`` was an in-process list that
    nothing persisted and ``pod_storage``'s default backend was Null, so no sealed
    record had ever survived a restart anywhere and there was nothing written in the
    old format to read. Records DO persist now (``as_payload`` / ``from_payload``
    over the commit log), so that window is closed and a future format change will
    need a real migration -- v2 is the oldest thing on disk. ``_unseal`` refuses
    unversioned blobs outright rather than attempting a fallback, because a silent
    fallback would quietly reinstate the malleability.
    """
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM  # noqa: PLC0415

    nonce = os.urandom(_AES_GCM_NONCE_BYTES)
    ciphertext = AESGCM(_seal_key(pod_key)).encrypt(
        nonce, plaintext.encode("utf-8"), _aad(owner)
    )
    return f"{_SEAL_V2}.{base64.b64encode(nonce + ciphertext).decode('ascii')}"


def _unseal(pod_key: bytes, blob: str, *, owner: str = "") -> str:
    """Open a sealed record, or raise. Tampering and mis-binding both raise.

    A failure here is never recoverable by trying something else: a blob that does
    not authenticate is either corrupt, modified, or not this owner's. Any of those
    must surface, because the alternative is an agent confidently reciting a memory
    that is not what its owner actually said.
    """
    from cryptography.exceptions import InvalidTag  # noqa: PLC0415
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM  # noqa: PLC0415

    text = str(blob or "")
    if not text.startswith(f"{_SEAL_V2}."):
        # Deliberately no fallback to the old XOR reader. Accepting the legacy
        # format would reinstate exactly the malleability this change removed, and
        # nothing durable was ever written in it.
        raise PodMemoryError("sealed record is not in a format this pod will open")

    data = base64.b64decode(text[len(_SEAL_V2) + 1 :].encode("ascii"))
    nonce, ciphertext = data[:_AES_GCM_NONCE_BYTES], data[_AES_GCM_NONCE_BYTES:]
    try:
        opened = AESGCM(_seal_key(pod_key)).decrypt(nonce, ciphertext, _aad(owner))
    except InvalidTag as exc:
        raise PodMemoryError("sealed record failed authentication") from exc
    return opened.decode("utf-8")


def _aad(owner: str) -> bytes:
    """Additional authenticated data binding a record to its owner."""
    return f"hushh/pod-memory/owner/{owner}".encode("utf-8")


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
            # Owner-bound: a record sealed in this pod cannot be opened in another.
            ciphertext=_seal(self._pod_key, text, owner=self._hushh_id),
            token_digests=tuple(sorted(_digest(self._pod_key, t) for t in _tokens(text))),
            author=author,
            custom_metadata=dict(custom_metadata or {}),
        )
        self._records.append(rec)
        if len(self._records) > _MAX_ENTRIES_PER_OWNER:
            self._records = self._records[-_MAX_ENTRIES_PER_OWNER:]
        return rec

    def hydrate(self, records: "Iterable[SealedMemory]") -> int:
        """Load records replayed from durable storage. Pure -- the caller does the I/O.

        This is what makes a pod resume rather than restart. Records are appended
        oldest-first and then bounded exactly as ``add`` bounds them, so a pod that
        wakes with more history than it can hold keeps the newest, not a random
        window.

        A record belonging to someone else is REFUSED, not skipped. Invariant 1 says
        memory never crosses a pod boundary; a foreign record arriving here means the
        log or the prefix is wrong, and quietly dropping it would let a
        misconfiguration look like an empty history -- indistinguishable from a
        first boot, and therefore silent for as long as nobody counts.
        """
        loaded = 0
        for rec in records:
            if rec.hushh_id != self._hushh_id:
                raise PodMemoryError(
                    f"pod memory is owner-scoped: this pod serves {self._hushh_id!r}, "
                    f"replayed a record for {rec.hushh_id!r}"
                )
            self._records.append(rec)
            loaded += 1
        if len(self._records) > _MAX_ENTRIES_PER_OWNER:
            self._records = self._records[-_MAX_ENTRIES_PER_OWNER:]
        return loaded

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
        return [
            (rec, _unseal(self._pod_key, rec.ciphertext, owner=self._hushh_id))
            for _, rec in scored[:limit]
        ]

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
        return build_pod_memory_service(hushh_id=hushh_id, pod_key=pod_key, log=_resolve_log())
    except Exception:  # noqa: BLE001 -- fail-safe: never block pod startup on memory
        logger.exception("pod_memory.build_failed hushh_id=%s", hushh_id)
        return None


def _resolve_log() -> Optional[Any]:
    """The pod's commit log, or ``None`` when durable state is not configured.

    Returning ``None`` gives an in-process store that forgets on restart -- lossy but
    working, which is the right shape for a tier where durability is genuinely absent.
    It is emphatically NOT the right shape for a misconfiguration, and the difference
    is upstream: ``resolve_pod_storage`` raises on a partial config rather than
    returning a Null backend, so a half-set environment reaches this function as an
    exception and disables memory loudly instead of degrading to amnesia that looks
    deliberate.
    """
    from hushh_mcp.services.pod_storage import resolve_pod_storage

    storage = resolve_pod_storage()
    # Duck-typed rather than isinstance: NullPodStorage holds no log, the commit-log
    # backend does, and nothing else should be guessed at.
    return getattr(storage, "_log", None)


def build_pod_memory_service(*, hushh_id: str, pod_key: bytes, log: Any = None) -> Any:
    """Construct the ADK-facing memory service for THIS pod.

    Imports ADK lazily so the module stays importable (and unit-testable) in environments
    without ADK, matching how the KMS resolver defers ``google-cloud-kms``.

    Returns an object satisfying ``BaseMemoryService``: ``add_session_to_memory`` and
    ``search_memory``.

    ``log`` is the pod's :class:`PodCommitLog`. With it, memory survives the pod:
    every record is appended to the sealed log as it is made, and replayed the first
    time the agent uses memory after a boot. Without it the store is an in-process
    list -- the previous behaviour exactly, and still the behaviour whenever durable
    state is unconfigured.

    **Hydration is lazy, and that is deliberate.** Replay walks the chain backward one
    serial read per record (each key comes from the previous decrypted record, so it
    cannot be parallelised). Doing that at construction would put it on the boot path
    of every cold wake, where it is paid whether or not the turn touches memory. On
    first async use it is paid only when it is about to be worth something.
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
            self.log = log
            self._hydrated = log is None

        async def _ensure_hydrated(self) -> None:
            """Replay this owner's memory once, on first use after a boot.

            Failure is NOT fail-safe here, unlike building the service at all. A pod
            that cannot read its own history must not answer as though it had none:
            silently continuing would let the agent contradict what its owner told it
            yesterday and call that a fresh start. ``PodMemoryError`` from a foreign or
            tampered record is exactly the signal that something is wrong with custody.
            """
            if self._hydrated:
                return
            # Set before awaiting: a second concurrent turn must not replay in parallel.
            self._hydrated = True
            try:
                replayed = [
                    SealedMemory.from_payload(pod_key, record["payload"])
                    for record in await self.log.replay()
                    if record.get("kind") == _MEMORY_RECORD_KIND
                    and (record.get("payload") or {}).get("hushh_id") == hushh_id
                ]
            except Exception:
                self._hydrated = False  # a transient read failure must stay retryable
                raise
            loaded = store.hydrate(replayed)
            logger.info("pod_memory.hydrated hushh_id=%s records=%d", hushh_id, loaded)

        async def add_session_to_memory(self, session: Any) -> None:
            await self._ensure_hydrated()
            for event in getattr(session, "events", None) or []:
                text = _content_text(getattr(event, "content", None))
                if not text:
                    continue
                rec = store.add(text=text, author=getattr(event, "author", None))
                if rec is not None and self.log is not None:
                    await self.log.append(_MEMORY_RECORD_KIND, rec.as_payload(pod_key))

        async def search_memory(self, *, app_name: str, user_id: str, query: str) -> Any:
            await self._ensure_hydrated()
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
