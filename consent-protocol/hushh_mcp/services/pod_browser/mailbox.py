"""Bounded, fixed-name RPC envelopes across a task-only sandbox bind mount.

No stdin assumption, host socket exception, shell command, or caller file path.
The cloud must prove this bridge with direct egress denied before admission.
"""

from __future__ import annotations

import asyncio
import json
import os
import stat
from pathlib import Path
from uuid import uuid4

from .contracts import BrowserRefused

MAX_ENVELOPE_BYTES = 6 * 1024 * 1024


class BrowserMailbox:
    def __init__(self, directory: Path, *, lane: str) -> None:
        if lane not in {"command", "network"}:
            raise BrowserRefused("BROWSER_BRIDGE_INVALID")
        self._lane = lane
        self._fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        info = os.fstat(self._fd)
        if not stat.S_ISDIR(info.st_mode) or info.st_mode & 0o077:
            os.close(self._fd)
            raise BrowserRefused("BROWSER_BRIDGE_INVALID")
        self._lock = asyncio.Lock()

    def _read(self, suffix: str) -> dict | None:
        try:
            fd = os.open(
                f"{self._lane}-{suffix}.json",
                os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                dir_fd=self._fd,
            )
        except FileNotFoundError:
            return None
        except OSError:
            raise BrowserRefused("BROWSER_BRIDGE_INVALID") from None
        try:
            info = os.fstat(fd)
            if (
                not stat.S_ISREG(info.st_mode)
                or info.st_nlink != 1
                or info.st_size > MAX_ENVELOPE_BYTES
            ):
                raise BrowserRefused("BROWSER_BRIDGE_INVALID")
            with os.fdopen(fd, "rb", closefd=False) as handle:
                data = handle.read(MAX_ENVELOPE_BYTES + 1)
            if len(data) > MAX_ENVELOPE_BYTES:
                raise BrowserRefused("BROWSER_BRIDGE_INVALID")
            value = json.loads(data)
            if not isinstance(value, dict):
                raise ValueError()
            return value
        except (ValueError, UnicodeDecodeError, RecursionError):
            raise BrowserRefused("BROWSER_BRIDGE_INVALID") from None
        finally:
            os.close(fd)

    def _write(self, suffix: str, value: dict) -> None:
        data = json.dumps(value, separators=(",", ":"), allow_nan=False).encode()
        if len(data) > MAX_ENVELOPE_BYTES:
            raise BrowserRefused("BROWSER_BRIDGE_TOO_LARGE")
        temporary = f"{self._lane}-{uuid4().hex}.tmp"
        fd = os.open(
            temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=self._fd
        )
        try:
            with os.fdopen(fd, "wb", closefd=False) as handle:
                handle.write(data)
                handle.flush()
                os.fsync(fd)
            os.rename(
                temporary, f"{self._lane}-{suffix}.json", src_dir_fd=self._fd, dst_dir_fd=self._fd
            )
        finally:
            os.close(fd)
            try:
                os.unlink(temporary, dir_fd=self._fd)
            except FileNotFoundError:
                pass

    async def exchange(self, payload: dict, *, timeout: float = 25) -> dict:
        async with self._lock:
            message_id = uuid4().hex
            self._write("request", {"id": message_id, "payload": payload})
            try:
                async with asyncio.timeout(timeout):
                    while True:
                        result = self._read("response")
                        if result and result.get("id") == message_id:
                            if set(result) != {"id", "payload"} or not isinstance(
                                result["payload"], dict
                            ):
                                raise BrowserRefused("BROWSER_BRIDGE_INVALID")
                            return result["payload"]
                        await asyncio.sleep(0.01)
            except TimeoutError:
                raise BrowserRefused("BROWSER_BRIDGE_TIMEOUT") from None

    def receive(self, previous_id: str | None) -> tuple[str, dict] | None:
        request = self._read("request")
        if not request or request.get("id") == previous_id:
            return None
        message_id = request.get("id")
        if (
            set(request) != {"id", "payload"}
            or not isinstance(message_id, str)
            or len(message_id) != 32
            or any(c not in "0123456789abcdef" for c in message_id)
            or not isinstance(request.get("payload"), dict)
        ):
            raise BrowserRefused("BROWSER_BRIDGE_INVALID")
        return message_id, request["payload"]

    def reply(self, message_id: str, payload: dict) -> None:
        self._write("response", {"id": message_id, "payload": payload})

    def close(self) -> None:
        if self._fd >= 0:
            try:
                for suffix in ("request", "response"):
                    try:
                        os.unlink(f"{self._lane}-{suffix}.json", dir_fd=self._fd)
                    except FileNotFoundError:
                        pass
            finally:
                os.close(self._fd)
                self._fd = -1

    def require_memory(self) -> None:
        from .scratch import require_tmpfs_fd

        require_tmpfs_fd(self._fd)
