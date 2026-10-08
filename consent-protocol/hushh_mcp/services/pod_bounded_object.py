"""Bounded ciphertext reads. Limits apply before materializing object bodies."""

from __future__ import annotations

import os
import stat
from pathlib import Path
from typing import Callable, Protocol


class ObjectReadTooLarge(RuntimeError):
    def __init__(self) -> None:
        super().__init__("OBJECT_READ_TOO_LARGE")


class BoundedObjectReader(Protocol):
    async def get_bounded(self, key: str, *, max_bytes: int) -> bytes | None: ...


def read_bounded_response(response, *, max_bytes: int) -> bytes | None:
    """Consume an uncompressed streamed response; never access response.content."""
    if not 1 <= max_bytes <= 8 * 1024 * 1024:
        raise ValueError("invalid bounded read limit")
    try:
        if response.status_code == 404:
            return None
        if response.status_code != 200:
            raise RuntimeError("OBJECT_READ_UNAVAILABLE")
        if response.headers.get("Content-Encoding", "identity").lower() != "identity":
            raise RuntimeError("OBJECT_ENCODING_REFUSED")
        size = response.headers.get("Content-Length")
        if size is not None:
            try:
                declared = int(size)
                if declared < 0:
                    raise ValueError()
            except ValueError:
                raise RuntimeError("OBJECT_LENGTH_REFUSED") from None
            if declared > max_bytes:
                raise ObjectReadTooLarge()
        body = bytearray()
        for chunk in response.iter_content(chunk_size=min(65536, max_bytes + 1)):
            if len(body) + len(chunk) > max_bytes:
                raise ObjectReadTooLarge()
            body.extend(chunk)
        return bytes(body)
    finally:
        response.close()


def read_local_bounded(path: Path, *, max_bytes: int) -> bytes | None:
    if not 1 <= max_bytes <= 8 * 1024 * 1024:
        raise ValueError("invalid bounded read limit")
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(descriptor, "rb") as handle:
            if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
                raise ValueError("bounded object is not a regular file")
            body = handle.read(max_bytes + 1)
    except FileNotFoundError:
        return None
    if len(body) > max_bytes:
        raise ObjectReadTooLarge()
    return body


def read_stated_gcs_media(response, generation: Callable) -> tuple[bytes | None, int | None]:
    """A media receipt must state which exact object generation was read."""
    if getattr(response, "status_code", 0) == 404:
        return None, 0
    if response.status_code != 200:
        raise RuntimeError("pod storage content unavailable")
    stated = generation(response)
    return (response.content, stated) if stated is not None else (None, None)


def read_gcs_bounded(session, authorized: Callable, url: str, max_bytes: int) -> bytes | None:
    response = authorized(
        lambda headers: session.get(
            url,
            params={"alt": "media"},
            headers={**headers, "Accept-Encoding": "identity"},
            timeout=60,
            allow_redirects=False,
            stream=True,
        )
    )
    return read_bounded_response(response, max_bytes=max_bytes)
