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

import asyncio
import base64
import contextlib
import contextvars
import fcntl
import hashlib
import json
import os
import secrets
import tempfile
import threading
import time
import urllib.parse
from collections.abc import Callable
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


class PodLogFenced(RuntimeError):
    """Ordinary access to this log has been irreversibly closed for erasure."""


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


# --- the shared key validator ---------------------------------------------------------

# How many times a key is percent-decoded before the validator gives up on it.
# Four is far past any real stack; a key still encoded after four rounds is
# refused rather than passed on as "probably fine".
_PERCENT_DECODE_ROUNDS = 4


def _refuse_unsafe_text(text: str) -> tuple[str, ...]:
    """The literal checks, run on one spelling of a key. Returns its segments."""
    if not text:
        raise ValueError("object key is empty")
    if text.startswith("/"):
        raise ValueError("object key must be relative")
    if "\\" in text:
        raise ValueError("object key contains a backslash")
    if any(ord(character) < 32 or ord(character) == 127 for character in text):
        raise ValueError("object key contains a control character")
    segments = tuple(text.split("/"))
    if any(segment in ("", ".", "..") for segment in segments):
        raise ValueError("object key has an empty or traversing segment")
    return segments


def object_key_segments(key: str) -> tuple[str, ...]:
    """Validate one object key and return its path segments.

    Every store shares this. It rejects the shapes that let a key address
    something other than what the caller named: absolute paths, backslashes,
    control characters, empty segments, and ``.`` or ``..`` traversal.

    It judges EVERY percent-decoding of the key, not only the literal text.
    The threat model is a file manager built on this class, and a file manager
    takes keys over HTTP, where some layer routinely decodes once more than
    this one did. ``a/%2e%2e/b`` is traversal written in a second alphabet, and
    a validator that only reads the first alphabet is a validator an attacker
    chooses the spelling for.

    Nothing owner-supplied reaches a key today. A file manager would be the
    first caller that does, and validation added after the first caller is
    validation added after the first mistake.
    """
    if not isinstance(key, str):
        raise ValueError("object key is empty")
    segments = _refuse_unsafe_text(key)
    decoded = key
    for _ in range(_PERCENT_DECODE_ROUNDS):
        try:
            once = urllib.parse.unquote(decoded, errors="strict")
        except UnicodeDecodeError:
            raise ValueError("object key has an undecodable escape") from None
        if once == decoded:
            return segments
        decoded = once
        _refuse_unsafe_text(decoded)
    raise ValueError("object key is still percent-encoded after decoding")


def object_prefix_segments(prefix: str) -> tuple[str, ...]:
    """Validate a store prefix and return its segments. Empty means no prefix."""
    trimmed = (prefix or "").strip("/")
    return object_key_segments(trimmed) if trimmed else ()


def _landing_segments(path: str) -> Optional[tuple[str, ...]]:
    """Where a slash-separated path LANDS, with ``.`` and ``..`` applied.

    None when it climbs above its own root, which no prefix can contain.
    """
    landed: list[str] = []
    for segment in path.split("/"):
        if segment in ("", "."):
            continue
        if segment == "..":
            if not landed:
                return None
            landed.pop()
            continue
        landed.append(segment)
    return tuple(landed)


def object_key_is_within(prefix: str, key: str) -> bool:
    """Whole-segment confinement: does ``key`` LAND strictly inside ``prefix``?

    The comparison is segment by segment, never a bare string prefix. A string
    prefix check would let a prefix of ``pods/abc`` admit ``pods/abcdef/head.json``
    because the text happens to start the same way. That is the exact shape of
    CVE-2025-53110, where allowing one directory also allowed every sibling whose
    name merely began with it.

    This is a real second layer, not a re-run of :func:`object_key_segments`: it
    applies ``.`` and ``..`` itself and decides on where the key lands, so
    relaxing the validator (a file manager wanting relative navigation is the
    plausible way that happens) cannot silently un-protect confinement. It is
    total by design and never raises: a key that cannot be resolved, or that
    climbs above the root, is simply not within anything.
    """
    landed = _landing_segments(key if isinstance(key, str) else "")
    root = _landing_segments(prefix if isinstance(prefix, str) else "")
    if landed is None or root is None:
        return False
    return len(landed) > len(root) and landed[: len(root)] == root


class LocalObjectStore:
    """Single-machine object store with locked reads and recoverable file-pair CAS.

    The existing bytes and integer .gen layout remains readable. A transient redo
    journal makes interrupted pair updates recoverable; it carries the same bytes
    supplied by the caller, which already owns encryption. All cooperating writers
    and readers must use this implementation. This is not a distributed fence.
    """

    _JOURNAL = ".pending-write.json"

    def __init__(self, root: str) -> None:
        self._root = Path(root)
        self._ensure_directory(self._root)

    @staticmethod
    def _sync_directory(directory: Path) -> None:
        descriptor = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    def _ensure_directory(self, directory: Path) -> None:
        missing = []
        parent = directory
        while not parent.exists():
            missing.append(parent)
            parent = parent.parent
        for child in reversed(missing):
            child.mkdir(exist_ok=True)
            self._sync_directory(child.parent)

    def _path(self, key: str) -> Path:
        path = self._root.joinpath(*object_key_segments(key)).resolve()
        if self._root.resolve() not in path.parents:
            raise ValueError("object key escapes the store root")
        if path in {self._root.resolve() / ".lock", self._root.resolve() / self._JOURNAL}:
            raise ValueError("object key is reserved by the store")
        if path.name.endswith(".gen") or path.name.startswith(".object-write-"):
            raise ValueError("object key is reserved by the store")
        self._ensure_directory(path.parent)
        return path

    def _atomic_write(self, path: Path, data: bytes) -> None:
        descriptor, temporary = tempfile.mkstemp(prefix=".object-write-", dir=path.parent)
        temporary_path = Path(temporary)
        try:
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary_path, path)
            self._sync_directory(path.parent)
        finally:
            temporary_path.unlink(missing_ok=True)

    @staticmethod
    def _read_pair(path: Path) -> tuple[Optional[bytes], int]:
        generation_path = path.with_suffix(path.suffix + ".gen")
        if not path.exists():
            if generation_path.exists():
                raise PodLogTampered("object generation exists without content")
            return None, 0
        try:
            generation = int(generation_path.read_text()) if generation_path.exists() else 1
        except (ValueError, OSError):
            raise PodLogTampered("object generation is unreadable") from None
        if generation < 1:
            raise PodLogTampered("object generation is invalid")
        return path.read_bytes(), generation

    def _recover_pending_write(self) -> None:
        journal = self._root / self._JOURNAL
        if not journal.exists():
            return
        try:
            record = json.loads(journal.read_bytes())
            if not isinstance(record, dict) or record.get("version") != 1:
                raise ValueError("unsupported journal")
            key, expected, generation = record["key"], record["expected"], record["generation"]
            if not isinstance(key, str) or type(expected) is not int or type(generation) is not int:
                raise ValueError("invalid journal identity")
            if expected < 0 or generation != expected + 1:
                raise ValueError("invalid journal generation")
            data = base64.b64decode(record["data"], validate=True)
            if hashlib.sha256(data).hexdigest() != record["new_sha256"]:
                raise ValueError("invalid journal content")
            old_digest = record["old_sha256"]
            if expected == 0:
                if old_digest is not None:
                    raise ValueError("invalid absent-object digest")
            elif not isinstance(old_digest, str) or len(old_digest) != 64:
                raise ValueError("invalid old digest")
            path = self._path(key)
            current, current_generation = self._read_pair(path)
            current_digest = hashlib.sha256(current).hexdigest() if current is not None else None
            # Content is replaced before its generation. Accept only the old pair,
            # that specific interrupted pair, or the completed new pair.
            old_or_interrupted = current_generation == expected and current_digest in {
                old_digest,
                record["new_sha256"],
            }
            # A newly created object without .gen has legacy generation 1.
            new_pair = current_generation == generation and current_digest == record["new_sha256"]
            if not (old_or_interrupted or new_pair):
                raise ValueError("journal does not match current object")
        except Exception:  # noqa: BLE001 - preserve corrupt journal and do not expose object bytes
            raise PodLogTampered("pending object write cannot be safely recovered") from None
        self._atomic_write(path, data)
        self._atomic_write(path.with_suffix(path.suffix + ".gen"), str(generation).encode())
        journal.unlink()
        self._sync_directory(self._root)

    @contextlib.contextmanager
    def _lock(self):
        lock_path = self._root / ".lock"
        with open(lock_path, "a", encoding="utf-8") as handle:  # noqa: PTH123
            fcntl.flock(handle, fcntl.LOCK_EX)
            try:
                self._recover_pending_write()
                yield
            finally:
                fcntl.flock(handle, fcntl.LOCK_UN)

    async def get(self, key: str) -> Optional[bytes]:
        data, _ = await self.get_with_generation(key)
        return data

    async def get_with_generation(self, key: str) -> tuple[Optional[bytes], int]:
        with self._lock():
            return self._read_pair(self._path(key))

    def _commit_pair(self, key: str, data: bytes, current: Optional[bytes], generation: int) -> int:
        record = {
            "version": 1,
            "key": key,
            "expected": generation,
            "generation": generation + 1,
            "old_sha256": hashlib.sha256(current).hexdigest() if current is not None else None,
            "new_sha256": hashlib.sha256(data).hexdigest(),
            "data": base64.b64encode(data).decode("ascii"),
        }
        self._atomic_write(self._root / self._JOURNAL, json.dumps(record).encode())
        self._recover_pending_write()
        return generation + 1

    async def put(self, key: str, data: bytes) -> None:
        with self._lock():
            current, generation = self._read_pair(self._path(key))
            if generation:
                raise FileExistsError(f"record object already exists: {key}")
            self._commit_pair(key, data, current, generation)

    async def put_if_generation(self, key: str, data: bytes, expected: int) -> Optional[int]:
        with self._lock():
            current, generation = self._read_pair(self._path(key))
            if generation != expected:
                return None
            return self._commit_pair(key, data, current, generation)


class GcsObjectStore:
    """GCS over its JSON API, keyless: the pod's own identity token, no SDK.

    ``ifGenerationMatch`` is the whole point -- the compare-and-swap the log's
    atomicity rides on is enforced by GCS itself, not by this client.

    COST, stated exactly, because an earlier telling of it was too generous.
    A WARM read is one object round trip: the media response states the
    generation of the very bytes it returned. A COLD read is two, because the
    first call on a fresh store also mints the access credential.

    The credential cache is per INSTANCE, and ``resolve_pod_storage()``
    constructs a new instance on every call (pod_identity_store,
    pod_memory_service, pod_pkm_resolver, and one per ``/one/pod/migration``
    request each build their own), so a pod process holds several caches and
    mints once per instance, not once per process. That is a deliberate pick
    over a module-global cache: a process-wide credential keyed to nothing is
    shared mutable state that outlives any owner's request, and the honest fix
    for the duplication is for the resolver to memoize the store, which is
    that module's call to make. The saving that matters is already here --
    one instance serves many reads, and a log replay reads every record
    through a single store.
    """

    # The GCE metadata endpoint that mints the pod's OWN access credential -- an
    # address, not a secret. (Named to make that plain to scanners and readers.)
    _METADATA_ACCESS_ENDPOINT = (
        "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token"
    )

    # Stop reusing a minted credential this long before the issuer says it dies,
    # so a request that starts inside the window still completes with a live one.
    _TOKEN_REFRESH_MARGIN_SECONDS = 60

    # Statuses that mean "this credential is not accepted", whatever the cache
    # believes about its remaining life.
    _CREDENTIAL_REFUSED = (401, 403)

    def __init__(self, bucket: str, prefix: str = "", *, session: Any = None) -> None:
        if not bucket:
            raise ValueError("a bucket is required")
        self._bucket = bucket
        self._prefix_segments = object_prefix_segments(prefix)
        self._prefix = "/".join(self._prefix_segments)
        # The credential is minted per store instance, not per HTTP call. Reads
        # run on worker threads, so the cache is guarded -- but only the cache:
        # the mint itself deliberately runs OUTSIDE the lock (see _token).
        self._token_lock = threading.Lock()
        self._token_value: Optional[str] = None
        self._token_expires_at = 0.0
        # Learned once per instance: whether media responses on this egress
        # path actually carry x-goog-generation. A gateway that strips it
        # strips it for every object, so paying the probe (and its discarded
        # body) on every read would be paying for the same answer repeatedly.
        self._media_states_generation = True
        if session is None:
            import requests  # type: ignore[import-untyped]  # noqa: PLC0415

            session = requests
        self._session = session

    @staticmethod
    def _generation_value(value: Any) -> int:
        if (
            not isinstance(value, str)
            or not 1 <= len(value) <= 20
            or not value.isascii()
            or not value.isdigit()
            or int(value) <= 0
        ):
            raise RuntimeError("pod storage generation unverified")
        return int(value)

    @classmethod
    def _generation(cls, body: Any) -> int:
        return cls._generation_value(body.get("generation") if isinstance(body, dict) else None)

    @staticmethod
    def _header(response: Any, name: str) -> Optional[str]:
        """One response header, matched case-insensitively, or None."""
        headers = getattr(response, "headers", None)
        if not hasattr(headers, "items"):
            return None
        wanted = name.lower()
        for header, value in headers.items():
            if isinstance(header, str) and header.lower() == wanted:
                return value if isinstance(value, str) else None
        return None

    @classmethod
    def _stated_generation(cls, response: Any) -> Optional[int]:
        """The generation this response states, or None when it states none usable.

        A MISSING ``x-goog-generation`` and a MALFORMED one are the same fact:
        this response cannot prove which version it carries. Both take the same
        pinned fallback, which re-derives the generation authoritatively from
        the metadata endpoint. Hard-failing the malformed case would fail closed
        for no benefit -- the recovery is exactly as trustworthy either way, and
        refusing it would let one normalizing egress proxy take the pod's
        storage down.
        """
        stated = cls._header(response, "x-goog-generation")
        if stated is None:
            return None
        try:
            return cls._generation_value(stated)
        except RuntimeError:
            return None

    def _key(self, key: str) -> str:
        """Compose the stored object name, confined to this store's prefix."""
        composed = "/".join(self._prefix_segments + object_key_segments(key))
        # Second layer, independent of the validator above: object_key_is_within
        # resolves traversal itself and decides on where the key LANDS, so this
        # still refuses an escape if object_key_segments is ever relaxed.
        if not object_key_is_within(self._prefix, composed):
            raise ValueError("object key escapes the store prefix")
        return composed

    @staticmethod
    def _token_lifetime(body: Any) -> int:
        """Seconds the issuer says this credential is good for; 0 when unstated."""
        value = body.get("expires_in") if isinstance(body, dict) else None
        if type(value) is not int or value <= 0:
            return 0
        return value

    def _cached_token(self) -> Optional[str]:
        """The cached credential while it is still inside its window, else None."""
        with self._token_lock:
            if self._token_value is not None and time.monotonic() < self._token_expires_at:
                return self._token_value
            # Never serve a credential past its window.
            self._token_value, self._token_expires_at = None, 0.0
            return None

    def _forget_token(self) -> None:
        """Drop the cached credential so the next call mints a fresh one."""
        with self._token_lock:
            self._token_value, self._token_expires_at = None, 0.0

    def _mint_token(self) -> tuple[str, int]:
        """One metadata round trip: the credential and the seconds it is usable."""
        response = self._session.get(
            self._METADATA_ACCESS_ENDPOINT,
            headers={"Metadata-Flavor": "Google"},
            timeout=10,
            allow_redirects=False,
        )
        if response.status_code != 200:
            raise RuntimeError("pod storage credential unavailable")
        body = response.json()
        token = body.get("access_token") if isinstance(body, dict) else None
        if not isinstance(token, str) or not token.strip() or len(token) > 16384:
            raise RuntimeError("pod storage credential unavailable")
        return token, self._token_lifetime(body) - self._TOKEN_REFRESH_MARGIN_SECONDS

    def _token(self) -> str:
        """The pod's own access credential, reused until its stated expiry nears.

        Minting was once per HTTP call, and a single object read made two of
        them. On a scale-to-zero pod that round trip is the latency the owner
        waits on, and it bought nothing: the credential does not change between
        the two calls of one read.

        THE LOCK GUARDS THE CACHE, NOT THE MINT. Holding it across the metadata
        call would turn N concurrent storage operations into N SEQUENTIAL
        10-second timeouts whenever the metadata server is unresponsive, where
        the uncached code failed all N in parallel -- a caching optimisation
        that converts a slow dependency into an availability outage. The cost
        of minting outside the lock is a thundering herd of redundant mints on
        a cold start; the cost of minting inside it is the pod hanging. A
        failed mint also leaves the cache exactly as it found it, so a live
        cached credential is never thrown away by an unrelated refresh.
        """
        cached = self._cached_token()
        if cached is not None:
            return cached
        token, usable = self._mint_token()
        if usable > 0:
            with self._token_lock:
                self._token_value, self._token_expires_at = token, time.monotonic() + usable
        return token

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._token()}"}

    def _authorized(self, send: Callable[[dict[str, str]], Any]) -> Any:
        """Send one authorized request, re-minting ONCE if the credential is refused.

        Before the credential was cached, every call minted fresh, so a
        credential that died mid-life self-healed on the very next call.
        Caching would otherwise keep re-presenting the same dead bearer for the
        rest of its window (up to ``expires_in`` minus the margin). One retry,
        never a loop: if the fresh credential is refused too, the refusal is
        real and the caller must see it. Every request this wraps is safe to
        repeat -- reads are reads, and the write carries ``ifGenerationMatch``,
        which a refused attempt cannot have consumed.
        """
        response = send(self._headers())
        if getattr(response, "status_code", 0) in self._CREDENTIAL_REFUSED:
            self._forget_token()
            response = send(self._headers())
        return response

    def _object_get(self, url: str, params: dict[str, str], timeout: int) -> Any:
        return self._authorized(
            lambda headers: self._session.get(
                url,
                params=params,
                headers=headers,
                timeout=timeout,
                allow_redirects=False,
            )
        )

    async def get(self, key: str) -> Optional[bytes]:
        data, _ = await self.get_with_generation(key)
        return data

    async def get_with_generation(self, key: str) -> tuple[Optional[bytes], int]:
        return await asyncio.to_thread(self._get_with_generation, key)

    def _get_with_generation(self, key: str) -> tuple[Optional[bytes], int]:
        quoted = urllib.parse.quote(self._key(key), safe="")
        url = f"https://storage.googleapis.com/storage/v1/b/{self._bucket}/o/{quoted}"
        if not self._media_states_generation:
            # This egress path already proved it strips the header. Probing it
            # again would download the whole body only to discard it.
            return self._get_pinned(url)
        # ONE object round trip. A media response states the generation of the
        # very bytes it returned (``x-goog-generation``), so a preceding
        # metadata GET buys nothing but latency and a second billed Class B
        # operation, and it is strictly weaker: two calls can straddle a write,
        # one cannot.
        media = self._object_get(url, {"alt": "media"}, 60)
        if getattr(media, "status_code", 0) == 404:
            return None, 0
        if media.status_code != 200:
            raise RuntimeError("pod storage content unavailable")
        generation = self._stated_generation(media)
        if generation is not None:
            return media.content, generation
        # A response that states no usable generation cannot prove which
        # version it is, and the compare-and-swap rides on that number. Fall
        # back to the pinned read rather than guess it, and remember, so the
        # body is downloaded twice ONCE per store rather than on every read.
        self._media_states_generation = False
        return self._get_pinned(url)

    def _get_pinned(self, url: str) -> tuple[Optional[bytes], int]:
        """Metadata first, then the media pinned to that exact generation."""
        meta = self._object_get(url, {"fields": "generation"}, 30)
        if getattr(meta, "status_code", 0) == 404:
            return None, 0
        if meta.status_code != 200:
            raise RuntimeError("pod storage metadata unavailable")
        generation = self._generation(meta.json())
        media = self._object_get(url, {"alt": "media", "generation": str(generation)}, 60)
        if media.status_code != 200:
            raise RuntimeError("pod storage content unavailable")
        return media.content, generation

    async def put(self, key: str, data: bytes) -> None:
        # Records are immutable: ifGenerationMatch=0 means "must not exist yet".
        created = await self.put_if_generation(key, data, 0)
        if created is None:
            raise FileExistsError(f"record object already exists: {key}")

    async def put_if_generation(self, key: str, data: bytes, expected: int) -> Optional[int]:
        # Offloading must not make cancellation report completion while a write
        # is still running. Retain and join the bounded HTTP worker first. This
        # is process-local completion, not a durable upload-drain receipt.
        worker = asyncio.get_running_loop().run_in_executor(
            None, contextvars.copy_context().run, self._put_if_generation, key, data, expected
        )
        cancelled = False
        while not worker.done():
            try:
                await asyncio.shield(worker)
            except asyncio.CancelledError:
                cancelled = True
            except Exception:
                break
        if cancelled:
            # Observe any worker exception without releasing it to a cancelled caller.
            if not worker.cancelled():
                worker.exception()
            raise asyncio.CancelledError
        return worker.result()

    def _put_if_generation(self, key: str, data: bytes, expected: int) -> Optional[int]:
        name = self._key(key)
        response = self._authorized(
            lambda headers: self._session.post(
                f"https://storage.googleapis.com/upload/storage/v1/b/{self._bucket}/o",
                params={
                    "uploadType": "media",
                    "name": name,
                    "ifGenerationMatch": str(expected),
                },
                headers={**headers, "Content-Type": "application/octet-stream"},
                data=data,
                timeout=60,
                allow_redirects=False,
            )
        )
        if getattr(response, "status_code", 0) == 412:
            return None  # lost the race; the caller retries from a fresh pointer
        if response.status_code not in (200, 201):
            raise RuntimeError("pod storage write unconfirmed")
        return self._generation(response.json())


# --- the log --------------------------------------------------------------------------


def _canonical(record: dict[str, Any]) -> bytes:
    return json.dumps(record, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _record_sha(seq: int, kind: str, payload: Any, prev_sha: Optional[str]) -> str:
    body = _canonical({"seq": seq, "kind": kind, "payload": payload, "prev_sha": prev_sha})
    return hashlib.sha256(body).hexdigest()


class PodCommitLog:
    """Append-only, sealed, chained. The pod's one durable truth."""

    HEAD = "head.json"

    def __init__(
        self,
        store: ObjectStore,
        seal_key: bytes,
        *,
        max_retries: int = 8,
        owner_id: Optional[str] = None,
    ) -> None:
        if len(seal_key) != _KEY_LEN:
            raise ValueError("the log key must be exactly 32 bytes")
        self._store = store
        self._aead = AESGCM(seal_key)
        self._max_retries = max_retries
        self._owner_id = owner_id

    # -- sealing ----------------------------------------------------------------------

    def _seal(self, record: dict[str, Any]) -> bytes:
        nonce = secrets.token_bytes(_NONCE_LEN)
        return nonce + self._aead.encrypt(nonce, _canonical(record), None)

    def _unseal(self, blob: bytes) -> dict[str, Any]:
        try:
            plaintext = self._aead.decrypt(blob[:_NONCE_LEN], blob[_NONCE_LEN:], None)
            record = json.loads(plaintext)
            if not isinstance(record, dict):
                raise ValueError("record shape")
            return record
        except Exception:
            raise PodLogTampered("a log record failed authenticated decryption") from None

    def _read_head(self, head_bytes: Optional[bytes]) -> Optional[dict[str, Any]]:
        if head_bytes is None:
            return None
        if self._read_fence(head_bytes) is not None:
            raise PodLogFenced("the log is closed for erasure")
        try:
            head = json.loads(head_bytes)
            if not isinstance(head, dict):
                raise ValueError("shape")
            seq, key, digest = head.get("seq"), head.get("key"), head.get("sha")
            if type(seq) is not int or seq < 1:
                raise ValueError("sequence")
            if (
                not isinstance(key, str)
                or not key.startswith("records/")
                or any(part in ("", ".", "..") for part in key.split("/"))
                or "\\" in key
                or any(ord(character) < 32 or ord(character) == 127 for character in key)
            ):
                raise ValueError("record key")
            if (
                not isinstance(digest, str)
                or len(digest) != 64
                or any(character not in "0123456789abcdef" for character in digest)
            ):
                raise ValueError("digest")
            return head
        except (ValueError, TypeError, UnicodeError) as exc:
            raise PodLogTampered("the log head is malformed") from exc

    def _read_fence(self, raw: bytes) -> Optional[dict[str, Any]]:
        """Authenticate the lifecycle marker; never expose its owner or prior head."""
        try:
            envelope = json.loads(raw)
            if not isinstance(envelope, dict) or "sealedFence" not in envelope:
                return None
            if (
                set(envelope) != {"version", "state", "seq", "sealedFence"}
                or type(envelope["version"]) is not int
                or envelope["version"] != 2
                or envelope["state"] != "fenced"
                or envelope["seq"] != "fenced"
            ):
                raise ValueError("shape")
            fence = self._unseal(base64.b64decode(envelope["sealedFence"], validate=True))
            if (
                not isinstance(fence, dict)
                or set(fence) != {"kind", "owner_id", "attempt_id", "prior_head"}
                or fence["kind"] != "pod_log_erasure_fence"
                or not self._valid_identity(fence["owner_id"])
                or not self._valid_identity(fence["attempt_id"])
                or (self._owner_id is not None and fence["owner_id"] != self._owner_id)
            ):
                raise ValueError("binding")
            prior = fence["prior_head"]
            if prior is not None:
                if not isinstance(prior, dict) or set(prior) != {"seq", "key", "sha"}:
                    raise ValueError("predecessor")
                self._read_head(_canonical(prior))
            return fence
        except Exception:  # noqa: BLE001 - encrypted lifecycle metadata stays private
            raise PodLogTampered("the log erasure fence did not verify") from None

    @staticmethod
    def _valid_identity(value: Any) -> bool:
        return (
            isinstance(value, str)
            and 0 < len(value) <= 256
            and value == value.strip()
            and not any(ord(char) < 32 or ord(char) == 127 for char in value)
        )

    async def require_open(self) -> None:
        """Check ordinary read admission; this does not drain in-flight work."""
        raw, _ = await self._store.get_with_generation(self.HEAD)
        self._read_head(raw)

    async def require_fenced(self, *, owner_id: str, attempt_id: str) -> None:
        """Verify an existing authenticated fence without exposing prior history."""
        if (
            not self._valid_identity(owner_id)
            or owner_id != self._owner_id
            or not self._valid_identity(attempt_id)
        ):
            raise PodLogFenced("log erasure authority unavailable")
        raw, _ = await self._store.get_with_generation(self.HEAD)
        fence = self._read_fence(raw) if raw is not None else None
        if fence is None or fence["attempt_id"] != attempt_id:
            raise PodLogFenced("log erasure fence does not match")

    async def fence_for_erasure(self, *, owner_id: str, attempt_id: str) -> None:
        """Close committed appends and ordinary replay on the existing head CAS.

        Only a log configured for this owner can accept the attempt. The trusted
        lifecycle caller still owns consent, incarnation and attempt authority;
        this storage primitive does not authenticate a network request. There is
        no unfreeze. It does not prove provider deletion or that orphan uploads
        have drained, and must never by itself mark account erasure complete.
        """
        if (
            not self._valid_identity(owner_id)
            or owner_id != self._owner_id
            or not self._valid_identity(attempt_id)
        ):
            raise PodLogFenced("log erasure authority unavailable")
        for _ in range(self._max_retries):
            raw, generation = await self._store.get_with_generation(self.HEAD)
            previous_fence = self._read_fence(raw) if raw is not None else None
            if previous_fence is not None:
                if previous_fence["attempt_id"] != attempt_id:
                    raise PodLogFenced("log erasure attempt does not match")
                return
            head = self._read_head(raw)
            await self._replay_head(head)
            payload = {
                "kind": "pod_log_erasure_fence",
                "owner_id": owner_id,
                "attempt_id": attempt_id,
                "prior_head": {key: head[key] for key in ("seq", "key", "sha")}
                if head is not None
                else None,
            }
            # Pre-validation readers evaluate int(head['seq']) and require
            # key/sha. An invalid sequence and absent coordinates make those
            # readers refuse; a flag beside valid coordinates would be ignored.
            marker = _canonical(
                {
                    "version": 2,
                    "state": "fenced",
                    "seq": "fenced",
                    "sealedFence": base64.b64encode(self._seal(payload)).decode("ascii"),
                }
            )
            written = await self._store.put_if_generation(self.HEAD, marker, generation)
            if written is None:
                continue
            observed, observed_generation = await self._store.get_with_generation(self.HEAD)
            if observed != marker or observed_generation != written:
                raise PodLogConflict("log erasure fence persistence unconfirmed")
            self._read_fence(observed)
            return
        raise PodLogConflict("the log head kept moving during erasure fencing")

    # -- operations -------------------------------------------------------------------

    async def append(
        self,
        kind: str,
        payload: Any,
        *,
        precondition: Callable[[list[dict[str, Any]]], None] | None = None,
    ) -> dict[str, Any]:
        """Append one record, linearized by the pointer CAS.

        Internal authority transitions may supply a side-effect-free precondition
        that raises on refusal. It receives the verified history for this exact
        HEAD generation and runs again after every lost CAS. A separate replay
        before append cannot provide that atomic authority check.
        """
        for _ in range(self._max_retries):
            head_bytes, generation = await self._store.get_with_generation(self.HEAD)
            head = self._read_head(head_bytes)
            if head is not None:
                # Refuse a corrupt predecessor before publishing any successor.
                blob = await self._store.get(head["key"])
                if blob is None:
                    raise PodLogTampered("the log head references a missing record")
                predecessor = self._unseal(blob)
                if (
                    not isinstance(predecessor, dict)
                    or type(predecessor.get("seq")) is not int
                    or predecessor["seq"] != head["seq"]
                    or predecessor.get("sha") != head["sha"]
                ):
                    raise PodLogTampered("the log head and predecessor disagree")
            if precondition is not None:
                precondition(await self._replay_head(head))
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
        head = self._read_head(head_bytes)
        records = await self._replay_head(head)
        # A fence may have won while chain I/O was in flight. Do not release a
        # captured history after observing the durable closure.
        await self.require_open()
        return records

    async def _replay_head(self, head: Optional[dict[str, Any]]) -> list[dict[str, Any]]:
        if head is None:
            return []

        records: list[dict[str, Any]] = []
        key: Optional[str] = head["key"]
        expected_sha: Optional[str] = head["sha"]
        expected_seq = head["seq"]
        while key is not None:
            blob = await self._store.get(key)
            if blob is None:
                raise PodLogTampered(f"the chain references a missing record: {key}")
            record = self._unseal(blob)
            if (
                not isinstance(record, dict)
                or type(record.get("seq")) is not int
                or record["seq"] != expected_seq
            ):
                raise PodLogTampered("the log head and record sequence disagree")
            expected_seq -= 1
            recomputed = _record_sha(
                record["seq"], record["kind"], record["payload"], record.get("prev_sha")
            )
            if recomputed != record.get("sha") or recomputed != expected_sha:
                raise PodLogTampered(f"hash chain broke at seq {record.get('seq')}")
            records.append(record)
            key = record.get("prev_key")
            expected_sha = record.get("prev_sha")
        records.reverse()
        if expected_seq != 0 or [r["seq"] for r in records] != list(range(1, len(records) + 1)):
            raise PodLogTampered("the chain's sequence numbers are not contiguous")
        return records
