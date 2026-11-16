# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Fixed-capacity byte ring buffer for bounded CLI stdout/stderr capture (#9511)."""

from __future__ import annotations

from collections import deque

DEFAULT_STREAM_RING_BYTES = 64 * 1024  # 64 KiB per stream


class BoundedStreamRingBuffer:
    """Retains only the trailing `max_bytes` of a byte stream without heap growth."""

    def __init__(self, max_bytes: int = DEFAULT_STREAM_RING_BYTES) -> None:
        if max_bytes <= 0:
            raise ValueError("max_bytes must be positive")
        self.max_bytes = int(max_bytes)
        self._chunks: deque[bytes] = deque()
        self._retained_bytes = 0
        self.total_bytes = 0
        self.truncated_bytes = 0

    @property
    def retained_bytes(self) -> int:
        return self._retained_bytes

    def append(self, chunk: bytes | bytearray | memoryview) -> None:
        raw = bytes(chunk)
        if not raw:
            return
        self.total_bytes += len(raw)
        if len(raw) >= self.max_bytes:
            dropped = self._retained_bytes + (len(raw) - self.max_bytes)
            self.truncated_bytes += dropped
            self._chunks.clear()
            tail = raw[-self.max_bytes :]
            self._chunks.append(tail)
            self._retained_bytes = len(tail)
            return

        self._chunks.append(raw)
        self._retained_bytes += len(raw)
        while self._retained_bytes > self.max_bytes and self._chunks:
            excess = self._retained_bytes - self.max_bytes
            oldest = self._chunks[0]
            if len(oldest) <= excess:
                self._chunks.popleft()
                self._retained_bytes -= len(oldest)
                self.truncated_bytes += len(oldest)
            else:
                self._chunks[0] = oldest[excess:]
                self._retained_bytes -= excess
                self.truncated_bytes += excess

    def to_bytes(self) -> bytes:
        return b"".join(self._chunks)

    def utf8_tail(self) -> str:
        return self.to_bytes().decode("utf-8", errors="replace")
