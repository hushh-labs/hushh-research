"""The object store's version token: opaque text, never a number to do arithmetic on.

Every conditional write the pod depends on (the commit-log head, the identity key,
the incarnation fence, the memory record, Files entries) reads a version and hands
it back to a compare-and-swap. GCS states that version as a decimal generation;
Azure Blob states an ETag. Callers never interpret it, so the contract is a string,
and :data:`ABSENT` (``""``, falsy like the integer ``0`` it replaces) means "must
not exist yet" on every store.

GCS semantics do not change: a generation is carried as its decimal text, and a
record that persists a version keeps the integer it always carried
(:func:`persisted_version`), so a Google Cloud pod's records stay byte-identical.
"""

from __future__ import annotations

import asyncio
import contextvars
import re
from collections.abc import Callable
from typing import Any, TypeVar

ObjectVersion = str

#: The version of an object that does not exist; create-only writes pass it.
ABSENT: ObjectVersion = ""

_MAX_VERSION_CHARS = 256
# A positive decimal generation without leading zeros, as GCS and the local store state it.
_DECIMAL = re.compile(r"[1-9][0-9]{0,19}")

_T = TypeVar("_T")


def is_object_version(value: Any) -> bool:
    """A present object's version: non-empty printable ASCII without whitespace."""
    return (
        isinstance(value, str)
        and 0 < len(value) <= _MAX_VERSION_CHARS
        and all(33 <= ord(character) <= 126 for character in value)
    )


def decimal_version(generation: int) -> ObjectVersion:
    """A decimal generation as a version token; ``0`` (absent) is :data:`ABSENT`."""
    if type(generation) is not int or generation < 0:
        raise ValueError("an object generation is a non-negative integer")
    return str(generation) if generation else ABSENT


def decimal_generation(version: ObjectVersion) -> int:
    """The decimal generation a token names, for stores that count generations.

    Refuses anything that store could not have issued: an integer (the retired
    contract), or text that is not a canonical positive decimal.
    """
    if not isinstance(version, str):
        raise TypeError("an object version is a string token")
    if version == ABSENT:
        return 0
    if not _DECIMAL.fullmatch(version):
        raise ValueError("object version was not issued by this store")
    return int(version)


def persisted_version(version: ObjectVersion) -> int | str:
    """How a record stores a version: decimal as the integer it always was, else text."""
    if version == ABSENT:
        return 0
    if _DECIMAL.fullmatch(version):
        return int(version)
    if not is_object_version(version):
        raise ValueError("object version is malformed")
    return version


def version_from_persisted(value: Any) -> ObjectVersion | None:
    """Read back :func:`persisted_version`; None for anything it could not have written."""
    if type(value) is int:
        return decimal_version(value) if value >= 0 else None
    if is_object_version(value) and not _DECIMAL.fullmatch(value):
        return str(value)
    return None


async def run_write_to_completion(write: Callable[..., _T], *args: Any) -> _T:
    """Run a blocking write on a worker and never report completion before it ends.

    Offloading must not make cancellation report completion while a write is
    still running, so the worker is retained and joined first. A cancelled caller
    still sees ``CancelledError``, but only after the write has finished. This is
    process-local completion, not a durable upload-drain receipt.
    """
    worker = asyncio.get_running_loop().run_in_executor(
        None, contextvars.copy_context().run, write, *args
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


__all__ = [
    "ABSENT",
    "ObjectVersion",
    "decimal_generation",
    "decimal_version",
    "is_object_version",
    "persisted_version",
    "run_write_to_completion",
    "version_from_persisted",
]
