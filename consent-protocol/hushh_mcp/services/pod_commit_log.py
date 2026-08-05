"""The pod's system of record: an encrypted, hash-chained commit log in object storage.

WHY A LOG, NOT A DATABASE. The pod must run identically on the user's own GCP,
on Anypoint CloudHub 2.0, and eventually on the user's own hardware. CloudHub
2.0 has no managed database and no attachable volume -- replicas get ephemeral
disk and can be rescheduled -- so any design that needs a durable disk fails the
mass tier outright. The one primitive every target shares is an HTTPS-reachable
bucket. So the bucket holds the truth, and everything else (the SQLite working
store included) is a rebuildable index over it.

Wire shape:

    {prefix}head.json                     the POINTER: {"seq": N, "key": ..., "sha": ...}
    {prefix}records/000000000042-ab12.bin one sealed RECORD, immutable once written

* **Atomicity** is the object store's conditional write. Advancing the log is a
  compare-and-swap on the pointer's generation (`ifGenerationMatch` on GCS, a
  locked generation file locally). Two concurrent writers both write record
  objects; exactly one wins the pointer swap; the loser's record is an orphan
  the chain never references, and the loser retries. This IS the
  ``expected_content_revision`` idea, enforced by the platform, identically on
  every target.
* **Confidentiality**: every record is sealed with AES-256-GCM under the pod's
  log key before it leaves the process. The store holds ciphertext only.
* **Integrity**: records carry a SHA-256 chain (each record binds its
  predecessor's hash). Replay verifies the chain and REFUSES a tampered or
  truncated log rather than loading it -- a storage provider that alters
  history produces a loud failure, not silent corruption.

The log key arrives from the pod's mounted secret material
(``HUSSH_POD_LOG_KEY``), which on BYOC lives in the USER'S project. There is no
fallback key: an unset key is a refusal, because "encrypted with something" is
not a property anyone can reason about.
"""

from __future__ import annotations

import base64
import contextlib
import fcntl
import hashlib
import json
import os
import secrets
import urllib.parse
from pathlib import Path
from typing import Any, Optional, Protocol

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

POD_LOG_KEY_ENV = "HUSSH_POD_LOG_KEY"

_NONCE_LEN = 12
_KEY_LEN = 32


class PodLogTampered(RuntimeError):
    """The chain does not verify: altered, truncated, or reordered history."""


class PodLogConflict(RuntimeError):
    """The pointer moved underneath a writer more times than it was willing to retry."""


def log_key_from_env() -> bytes:
    material = (os.getenv(POD_LOG_KEY_ENV) or "").strip()
    if not material:
        raise RuntimeError(
            f"{POD_LOG_KEY_ENV} is not set -- the commit log never runs with a guessed key"
        )
    for decoder in (base64.b64decode, base64.urlsafe_b64decode):
        try:
            raw = decoder(material + "=" * (-len(material) % 4))
        except Exception:  # noqa: BLE001 - try the next encoding
            continue
        if len(raw) == _KEY_LEN:
            return raw
    raise RuntimeError(f"{POD_LOG_KEY_ENV} must be a base64 raw 32-byte key")


# --- the store contract ---------------------------------------------------------------


class ObjectStore(Protocol):
    """The minimum object-store surface the log needs, on every platform."""

    async def get(self, key: str) -> Optional[bytes]: ...

    async def get_with_generation(self, key: str) -> tuple[Optional[bytes], int]: ...

    async def put(self, key: str, data: bytes) -> None:
        """Write-once: refuses to overwrite an existing object."""
        ...

    async def put_if_generation(self, key: str, data: bytes, expected: int) -> Optional[int]:
        """Compare-and-swap: write only if the object's generation is ``expected``
        (0 = must not exist). Returns the new generation, or None on a lost race."""
        ...


class LocalObjectStore:
    """Filesystem store for tests, dev, and single-node hardware (Puppy One).

    CAS is a generation sidecar guarded by an exclusive ``flock`` -- correct for
    one machine, which is exactly the scope this store claims.
    """

    def __init__(self, root: str) -> None:
        self._root = Path(root)
        self._root.mkdir(parents=True, exist_ok=True)

    def _path(self, key: str) -> Path:
        path = (self._root / key).resolve()
        if self._root.resolve() not in path.parents and path != self._root.resolve():
            raise ValueError("object key escapes the store root")
        path.parent.mkdir(parents=True, exist_ok=True)
        return path

    @contextlib.contextmanager
    def _lock(self):
        lock_path = self._root / ".lock"
        with open(lock_path, "w", encoding="utf-8") as handle:  # noqa: PTH123
            fcntl.flock(handle, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(handle, fcntl.LOCK_UN)

    async def get(self, key: str) -> Optional[bytes]:
        data, _ = await self.get_with_generation(key)
        return data

    async def get_with_generation(self, key: str) -> tuple[Optional[bytes], int]:
        path = self._path(key)
        generation_path = path.with_suffix(path.suffix + ".gen")
        if not path.exists():
            return None, 0
        generation = int(generation_path.read_text()) if generation_path.exists() else 1
        return path.read_bytes(), generation

    async def put(self, key: str, data: bytes) -> None:
        path = self._path(key)
        with self._lock():
            if path.exists():
                raise FileExistsError(f"record object already exists: {key}")
            path.write_bytes(data)

    async def put_if_generation(self, key: str, data: bytes, expected: int) -> Optional[int]:
        path = self._path(key)
        generation_path = path.with_suffix(path.suffix + ".gen")
        with self._lock():
            current = 0
            if path.exists():
                current = int(generation_path.read_text()) if generation_path.exists() else 1
            if current != expected:
                return None
            path.write_bytes(data)
            new_generation = current + 1
            generation_path.write_text(str(new_generation))
            return new_generation


class GcsObjectStore:
    """GCS over its JSON API, keyless: the pod's own identity token, no SDK.

    ``ifGenerationMatch`` is the whole point -- the compare-and-swap the log's
    atomicity rides on is enforced by GCS itself, not by this client.
    """

    # The GCE metadata endpoint that mints the pod's OWN access credential -- an
    # address, not a secret. (Named to make that plain to scanners and readers.)
    _METADATA_ACCESS_ENDPOINT = (
        "http://metadata.google.internal/computeMetadata/v1/instance"
        "/service-accounts/default/token"
    )

    def __init__(self, bucket: str, prefix: str = "", *, session: Any = None) -> None:
        if not bucket:
            raise ValueError("a bucket is required")
        self._bucket = bucket
        self._prefix = prefix.strip("/")
        if session is None:
            import requests as session  # noqa: PLC0415 - deferred so tests can inject
        self._session = session

    def _key(self, key: str) -> str:
        return f"{self._prefix}/{key}" if self._prefix else key

    def _token(self) -> str:
        response = self._session.get(
            self._METADATA_ACCESS_ENDPOINT, headers={"Metadata-Flavor": "Google"}, timeout=10
        )
        return response.json()["access_token"]

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._token()}"}

    async def get(self, key: str) -> Optional[bytes]:
        data, _ = await self.get_with_generation(key)
        return data

    async def get_with_generation(self, key: str) -> tuple[Optional[bytes], int]:
        quoted = urllib.parse.quote(self._key(key), safe="")
        meta = self._session.get(
            f"https://storage.googleapis.com/storage/v1/b/{self._bucket}/o/{quoted}",
            params={"fields": "generation"},
            headers=self._headers(),
            timeout=30,
        )
        if getattr(meta, "status_code", 0) == 404:
            return None, 0
        meta.raise_for_status()
        generation = int(meta.json()["generation"])
        media = self._session.get(
            f"https://storage.googleapis.com/storage/v1/b/{self._bucket}/o/{quoted}",
            params={"alt": "media", "generation": str(generation)},
            headers=self._headers(),
            timeout=60,
        )
        media.raise_for_status()
        return media.content, generation

    async def put(self, key: str, data: bytes) -> None:
        # Records are immutable: ifGenerationMatch=0 means "must not exist yet".
        created = await self.put_if_generation(key, data, 0)
        if created is None:
            raise FileExistsError(f"record object already exists: {key}")

    async def put_if_generation(self, key: str, data: bytes, expected: int) -> Optional[int]:
        response = self._session.post(
            f"https://storage.googleapis.com/upload/storage/v1/b/{self._bucket}/o",
            params={
                "uploadType": "media",
                "name": self._key(key),
                "ifGenerationMatch": str(expected),
            },
            headers={**self._headers(), "Content-Type": "application/octet-stream"},
            data=data,
            timeout=60,
        )
        if getattr(response, "status_code", 0) == 412:
            return None  # lost the race; the caller retries from a fresh pointer
        response.raise_for_status()
        return int(response.json()["generation"])


# --- the log --------------------------------------------------------------------------


def _canonical(record: dict[str, Any]) -> bytes:
    return json.dumps(record, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _record_sha(seq: int, kind: str, payload: Any, prev_sha: Optional[str]) -> str:
    body = _canonical({"seq": seq, "kind": kind, "payload": payload, "prev_sha": prev_sha})
    return hashlib.sha256(body).hexdigest()


class PodCommitLog:
    """Append-only, sealed, chained. The pod's one durable truth."""

    HEAD = "head.json"

    def __init__(self, store: ObjectStore, seal_key: bytes, *, max_retries: int = 8) -> None:
        if len(seal_key) != _KEY_LEN:
            raise ValueError("the log key must be exactly 32 bytes")
        self._store = store
        self._aead = AESGCM(seal_key)
        self._max_retries = max_retries

    # -- sealing ----------------------------------------------------------------------

    def _seal(self, record: dict[str, Any]) -> bytes:
        nonce = secrets.token_bytes(_NONCE_LEN)
        return nonce + self._aead.encrypt(nonce, _canonical(record), None)

    def _unseal(self, blob: bytes) -> dict[str, Any]:
        try:
            plaintext = self._aead.decrypt(blob[:_NONCE_LEN], blob[_NONCE_LEN:], None)
            return json.loads(plaintext)
        except Exception as exc:
            raise PodLogTampered("a log record failed authenticated decryption") from exc

    # -- operations -------------------------------------------------------------------

    async def append(self, kind: str, payload: Any) -> dict[str, Any]:
        """Append one record. Linearized by the pointer CAS; retries lost races."""
        for _ in range(self._max_retries):
            head_bytes, generation = await self._store.get_with_generation(self.HEAD)
            head = json.loads(head_bytes) if head_bytes else None
            seq = (int(head["seq"]) + 1) if head else 1
            prev_key = head["key"] if head else None
            prev_sha = head["sha"] if head else None

            record = {
                "seq": seq,
                "kind": kind,
                "payload": payload,
                "prev_key": prev_key,
                "prev_sha": prev_sha,
                "sha": _record_sha(seq, kind, payload, prev_sha),
            }
            key = f"records/{seq:012d}-{secrets.token_hex(4)}.bin"
            await self._store.put(key, self._seal(record))

            new_head = _canonical({"seq": seq, "key": key, "sha": record["sha"]})
            if await self._store.put_if_generation(self.HEAD, new_head, generation) is not None:
                return record
            # Lost the race: our record object is an orphan the chain never
            # references. Re-read the pointer and try again.
        raise PodLogConflict("the log head kept moving; giving up after retries")

    async def replay(self) -> list[dict[str, Any]]:
        """Every record, oldest first, chain-verified. Raises on tampering."""
        head_bytes, _ = await self._store.get_with_generation(self.HEAD)
        if not head_bytes:
            return []
        head = json.loads(head_bytes)

        records: list[dict[str, Any]] = []
        key: Optional[str] = head["key"]
        expected_sha: Optional[str] = head["sha"]
        while key is not None:
            blob = await self._store.get(key)
            if blob is None:
                raise PodLogTampered(f"the chain references a missing record: {key}")
            record = self._unseal(blob)
            recomputed = _record_sha(
                record["seq"], record["kind"], record["payload"], record.get("prev_sha")
            )
            if recomputed != record.get("sha") or recomputed != expected_sha:
                raise PodLogTampered(f"hash chain broke at seq {record.get('seq')}")
            records.append(record)
            key = record.get("prev_key")
            expected_sha = record.get("prev_sha")
        records.reverse()
        if [r["seq"] for r in records] != list(range(1, len(records) + 1)):
            raise PodLogTampered("the chain's sequence numbers are not contiguous")
        return records
