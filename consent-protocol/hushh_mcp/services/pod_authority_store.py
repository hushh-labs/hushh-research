"""Owner-local authority records and the incarnation fence, over the pod's own log.

Until this module existed, every admission decision a pod made was a question to
the hub: is this token live, is this device still trusted, is this the owner. That
kept the hub in the conversation path and made revocation a hub fact the pod could
only relay. The private agent that answers its owner directly needs its own record
of whom it trusts and its own record of who has been shown the door, and both must
survive a restart and a replay.

Two record kinds ride the existing sealed, chained commit log, exactly the way the
memory service and the configuration record do (dispatch on kind, filter on owner,
ignore other subsystems' records):

    authority_trust_v1       a hub-signed binding the pod admitted, by subject and version
    authority_tombstone_v1   a revocation of a subject at or below a binding version

Replay rules are the whole contract, so they are stated once here:

* a trust record is admitted only when its version is strictly higher than the one
  already recorded for that subject; the version is monotonic per subject;
* a tombstone wins whenever ``at_version >= trust.version`` for the same subject;
* a newer hub-signed binding (version above the tombstone) re-admits the subject,
  which is how an owner recovers a device they revoked by mistake.

THE INCARNATION FENCE

``maxScale`` is 1, but a revision switch overlaps two instances for a moment, and a
process that has been replaced must not keep publishing: not to the device sockets it
brokered, not to memory, not to the directive stream. The fence is one object,
``authority/incarnation.bin``, sealed under a key derived from the pod's DEK with its
own HKDF label (a sibling of ``pod_identity_store.seal_private_key``), and claimed
with the object store's compare-and-swap. The object generation the winner wrote is
its fence token. A lease re-reads that generation at most every twenty seconds and
answers one of three ways:

    held        our generation is still the current one
    fenced      someone claimed after us; close device links, refuse admissions
    uncertain   the store could not be asked; refuse new work, never assume held

The third answer is deliberately not ``True``. A fence that reads as held whenever
the store is down is not a fence.
"""

from __future__ import annotations

import json
import logging
import secrets
import time
from dataclasses import dataclass
from typing import Any, Literal, Optional

from hushh_mcp.services.pod_commit_log import PodLogFenced

logger = logging.getLogger(__name__)

AUTHORITY_TRUST_KIND = "authority_trust_v1"
AUTHORITY_TOMBSTONE_KIND = "authority_tombstone_v1"
INCARNATION_OBJECT = "authority/incarnation.bin"

#: Its own HKDF label. The DEK seals the log; a sibling label seals the identity key;
#: this one seals the incarnation fence. None of the three opens another.
_INCARNATION_SEAL_INFO = b"hussh/pod-incarnation/aes256gcm/v1"
_KEY_LEN = 32
_NONCE_LEN = 12

LEASE_SECONDS = 20.0

SubjectState = Literal["trusted", "tombstoned", "unknown"]
FenceState = Literal["held", "fenced", "uncertain"]


class PodAuthorityError(RuntimeError):
    """A trust or tombstone write was refused."""

    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(detail or code)
        self.code = code
        self.detail = detail


@dataclass(frozen=True)
class TrustRecord:
    subject_id: str
    role: str
    version: int
    binding: dict[str, Any]
    recorded_at_ms: int


@dataclass(frozen=True)
class TombstoneRecord:
    subject_id: str
    at_version: int
    reason: str
    recorded_at_ms: int


@dataclass(frozen=True)
class SubjectStatus:
    state: SubjectState
    trust: Optional[TrustRecord] = None
    tombstone: Optional[TombstoneRecord] = None


def _clean(value: Any) -> str:
    return str(value or "").strip()


def _version(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise PodAuthorityError("malformed", "a binding version is a positive integer")
    return value


class PodAuthorityStore:
    """Replay-once index of trust and tombstone records for one owner."""

    def __init__(self, log: Any, *, hushh_id: str) -> None:
        owner = _clean(hushh_id)
        if not owner:
            raise PodAuthorityError("no_owner", "an authority store is never built for nobody")
        if log is None:
            raise PodAuthorityError("no_log", "an authority store needs the pod's durable log")
        self._log = log
        self._hushh_id = owner
        self._trust: dict[str, TrustRecord] = {}
        self._tombstones: dict[str, TombstoneRecord] = {}
        self._loaded = False

    @property
    def hushh_id(self) -> str:
        return self._hushh_id

    @property
    def loaded(self) -> bool:
        return self._loaded

    # -- replay -------------------------------------------------------------------

    async def load(self) -> None:
        """Replay the log once. A fenced log refuses; nothing is cached from it."""
        records = await self._log.replay()
        self._trust = {}
        self._tombstones = {}
        self.apply_records(records)
        self._loaded = True

    def apply_records(self, records: Any) -> None:
        """Fold records in log order. Pure over the index; foreign owners are skipped."""
        skipped_foreign = 0
        for record in records or []:
            kind = _clean((record or {}).get("kind"))
            if kind not in {AUTHORITY_TRUST_KIND, AUTHORITY_TOMBSTONE_KIND}:
                continue
            payload = (record or {}).get("payload") or {}
            if not isinstance(payload, dict) or _clean(payload.get("hushh_id")) != self._hushh_id:
                skipped_foreign += 1
                continue
            try:
                if kind == AUTHORITY_TRUST_KIND:
                    self._fold_trust(payload)
                else:
                    self._fold_tombstone(payload)
            except PodAuthorityError as exc:
                logger.warning("pod_authority.record_ignored kind=%s reason=%s", kind, exc.code)
        if skipped_foreign:
            logger.warning("pod_authority.skipped_foreign_records count=%d", skipped_foreign)

    def _fold_trust(self, payload: dict[str, Any]) -> TrustRecord:
        subject_id = _clean(payload.get("subject_id"))
        if not subject_id:
            raise PodAuthorityError("malformed", "a trust record names a subject")
        version = _version(payload.get("version"))
        existing = self._trust.get(subject_id)
        if existing is not None and version <= existing.version:
            raise PodAuthorityError("stale_version", "a trust version never moves backwards")
        binding = payload.get("binding")
        record = TrustRecord(
            subject_id=subject_id,
            role=_clean(payload.get("role")),
            version=version,
            binding=dict(binding) if isinstance(binding, dict) else {},
            recorded_at_ms=int(payload.get("recorded_at_ms") or 0),
        )
        self._trust[subject_id] = record
        return record

    def _fold_tombstone(self, payload: dict[str, Any]) -> TombstoneRecord:
        subject_id = _clean(payload.get("subject_id"))
        if not subject_id:
            raise PodAuthorityError("malformed", "a tombstone names a subject")
        at_version = _version(payload.get("at_version"))
        existing = self._tombstones.get(subject_id)
        if existing is not None and at_version <= existing.at_version:
            # An older tombstone adds nothing; the highest one is the one that binds.
            return existing
        record = TombstoneRecord(
            subject_id=subject_id,
            at_version=at_version,
            reason=_clean(payload.get("reason"))[:64],
            recorded_at_ms=int(payload.get("recorded_at_ms") or 0),
        )
        self._tombstones[subject_id] = record
        return record

    # -- reads --------------------------------------------------------------------

    def subject(self, subject_id: str) -> SubjectStatus:
        """What the log says about one subject, with the tombstone rule applied."""
        key = _clean(subject_id)
        trust = self._trust.get(key)
        tombstone = self._tombstones.get(key)
        if trust is None:
            if tombstone is not None:
                return SubjectStatus("tombstoned", None, tombstone)
            return SubjectStatus("unknown")
        if tombstone is not None and tombstone.at_version >= trust.version:
            return SubjectStatus("tombstoned", trust, tombstone)
        return SubjectStatus("trusted", trust, tombstone)

    def is_trusted(self, subject_id: str, *, role: Optional[str] = None) -> bool:
        status = self.subject(subject_id)
        if status.state != "trusted" or status.trust is None:
            return False
        return role is None or status.trust.role == role

    def trusted_subjects(self) -> list[TrustRecord]:
        return [
            record
            for record in self._trust.values()
            if self.subject(record.subject_id).state == "trusted"
        ]

    def tombstones(self) -> list[TombstoneRecord]:
        return list(self._tombstones.values())

    def highest_version(self, subject_id: str) -> int:
        """The version bar a new binding for this subject must clear."""
        key = _clean(subject_id)
        trust = self._trust.get(key)
        tombstone = self._tombstones.get(key)
        return max(trust.version if trust else 0, tombstone.at_version if tombstone else 0)

    # -- writes -------------------------------------------------------------------

    async def record_trust(self, binding: dict[str, Any]) -> TrustRecord:
        """Append an admitted binding. Refuses a version at or below what is recorded.

        The caller has already verified the hub's signature and every field; this
        method enforces only the two facts the log owns: the owner and the version
        order. It appends nothing on refusal.
        """
        if not isinstance(binding, dict):
            raise PodAuthorityError("malformed", "a binding is an object")
        if _clean(binding.get("hushh_id")) != self._hushh_id:
            raise PodAuthorityError("foreign_owner", "this binding names another owner")
        subject_id = _clean(binding.get("subject_id"))
        version = _version(binding.get("version"))
        if version <= self.highest_version(subject_id):
            raise PodAuthorityError("stale_version", "a newer binding is already recorded")
        payload = {
            "hushh_id": self._hushh_id,
            "subject_id": subject_id,
            "role": _clean(binding.get("role")),
            "version": version,
            "binding": dict(binding),
            "recorded_at_ms": int(time.time() * 1000),
        }
        await self._log.append(AUTHORITY_TRUST_KIND, payload)
        return self._fold_trust(payload)

    async def record_tombstone(
        self, subject_id: str, *, at_version: int, reason: str = ""
    ) -> TombstoneRecord:
        """Append a revocation. Idempotent for an equal or lower version."""
        key = _clean(subject_id)
        if not key:
            raise PodAuthorityError("malformed", "a tombstone names a subject")
        version = _version(at_version)
        existing = self._tombstones.get(key)
        if existing is not None and version <= existing.at_version:
            return existing
        payload = {
            "hushh_id": self._hushh_id,
            "subject_id": key,
            "at_version": version,
            "reason": _clean(reason)[:64],
            "recorded_at_ms": int(time.time() * 1000),
        }
        await self._log.append(AUTHORITY_TOMBSTONE_KIND, payload)
        return self._fold_tombstone(payload)


# -- the incarnation fence ---------------------------------------------------------------


class PodIncarnationError(RuntimeError):
    """The incarnation object could not be claimed or read."""


@dataclass(frozen=True)
class Incarnation:
    epoch: int
    generation: int
    instance_id: str
    claimed_at_ms: int


def _seal_key(dek: bytes) -> bytes:
    from cryptography.hazmat.primitives import hashes  # noqa: PLC0415
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF  # noqa: PLC0415

    if len(dek) != _KEY_LEN:
        raise PodIncarnationError(f"the pod DEK must be exactly {_KEY_LEN} bytes")
    return HKDF(
        algorithm=hashes.SHA256(), length=_KEY_LEN, salt=None, info=_INCARNATION_SEAL_INFO
    ).derive(dek)


def _canonical(payload: dict[str, Any]) -> bytes:
    return json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")


def seal_incarnation(dek: bytes, payload: dict[str, Any]) -> bytes:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM  # noqa: PLC0415

    nonce = secrets.token_bytes(_NONCE_LEN)
    return nonce + AESGCM(_seal_key(dek)).encrypt(
        nonce, _canonical(payload), _INCARNATION_SEAL_INFO
    )


def open_incarnation(dek: bytes, blob: bytes) -> dict[str, Any]:
    """Recover the incarnation payload, or refuse. Authenticated, never partial."""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM  # noqa: PLC0415

    if len(blob) <= _NONCE_LEN:
        raise PodIncarnationError("the incarnation object is too short to be valid")
    try:
        raw = AESGCM(_seal_key(dek)).decrypt(
            blob[:_NONCE_LEN], blob[_NONCE_LEN:], _INCARNATION_SEAL_INFO
        )
        payload = json.loads(raw)
    except Exception as exc:  # noqa: BLE001
        raise PodIncarnationError("the incarnation object failed authenticated decryption") from exc
    if not isinstance(payload, dict) or type(payload.get("epoch")) is not int:
        raise PodIncarnationError("the incarnation object has an unexpected shape")
    return payload


async def claim_incarnation(
    store: Any, dek: bytes, *, instance_id: str, max_retries: int = 8
) -> Incarnation:
    """Become the current incarnation: epoch + 1, written by compare-and-swap.

    The loser of a race re-reads and tries again with the new epoch, so two
    overlapping instances end up with two distinct epochs and exactly one of them
    holds the current generation. There is no adoption here, unlike the identity
    key: two processes must never agree that they are both current.
    """
    name = _clean(instance_id) or secrets.token_hex(8)
    for _ in range(max_retries):
        blob, generation = await store.get_with_generation(INCARNATION_OBJECT)
        epoch = 1
        if blob:
            epoch = int(open_incarnation(dek, blob)["epoch"]) + 1
        claimed_at = int(time.time() * 1000)
        payload = {"epoch": epoch, "instance_id": name, "claimed_at_ms": claimed_at}
        written = await store.put_if_generation(
            INCARNATION_OBJECT, seal_incarnation(dek, payload), generation
        )
        if written is not None:
            logger.info("pod_incarnation.claimed epoch=%s", epoch)
            return Incarnation(
                epoch=epoch, generation=int(written), instance_id=name, claimed_at_ms=claimed_at
            )
    raise PodIncarnationError("the incarnation object kept moving; giving up after retries")


class IncarnationLease:
    """Answers "am I still the current incarnation" with a bounded re-read cadence."""

    def __init__(
        self,
        store: Any,
        incarnation: Incarnation,
        *,
        lease_seconds: float = LEASE_SECONDS,
        clock: Any = time.monotonic,
    ) -> None:
        self._store = store
        self._incarnation = incarnation
        self._lease_seconds = float(lease_seconds)
        self._clock = clock
        self._checked_at: Optional[float] = None
        self._state: FenceState = "held"

    @property
    def incarnation(self) -> Incarnation:
        return self._incarnation

    @property
    def epoch(self) -> int:
        return self._incarnation.epoch

    @property
    def last_state(self) -> FenceState:
        return self._state

    async def is_current(self, *, force: bool = False) -> Optional[bool]:
        """True when held, False when fenced, None when the store could not be asked.

        ``None`` is the honest answer to a store error and it is never coerced to
        ``True``: a caller that needs a yes treats it as a no.
        """
        now = self._clock()
        if (
            not force
            and self._checked_at is not None
            and now - self._checked_at < self._lease_seconds
            and self._state != "uncertain"
        ):
            return self._state == "held"
        try:
            _, generation = await self._store.get_with_generation(INCARNATION_OBJECT)
        except Exception as exc:  # noqa: BLE001 - the store could not be asked
            logger.warning("pod_incarnation.lease_uncertain reason=%s", type(exc).__name__)
            self._state = "uncertain"
            self._checked_at = now
            return None
        self._checked_at = now
        if generation == self._incarnation.generation:
            self._state = "held"
            return True
        if self._state != "fenced":
            logger.warning("pod_incarnation.fenced epoch=%s", self._incarnation.epoch)
        self._state = "fenced"
        return False

    async def state(self, *, force: bool = False) -> FenceState:
        current = await self.is_current(force=force)
        if current is None:
            return "uncertain"
        return "held" if current else "fenced"


# -- process-wide active copy --------------------------------------------------------------

_ACTIVE: Optional["PodAuthorityStore"] = None


def active_authority_store() -> Optional[PodAuthorityStore]:
    return _ACTIVE


def set_active_authority_store(store: Optional[PodAuthorityStore]) -> None:
    global _ACTIVE
    _ACTIVE = store


__all__ = [
    "AUTHORITY_TOMBSTONE_KIND",
    "AUTHORITY_TRUST_KIND",
    "INCARNATION_OBJECT",
    "LEASE_SECONDS",
    "FenceState",
    "Incarnation",
    "IncarnationLease",
    "PodAuthorityError",
    "PodAuthorityStore",
    "PodIncarnationError",
    "PodLogFenced",
    "SubjectStatus",
    "TombstoneRecord",
    "TrustRecord",
    "active_authority_store",
    "claim_incarnation",
    "open_incarnation",
    "seal_incarnation",
    "set_active_authority_store",
]
