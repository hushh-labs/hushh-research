"""Task-owned tmpfs scratch. Refuse disk-backed or unverified private scratch."""

from __future__ import annotations

import ctypes
import os
import shutil
import sys
import tempfile
from pathlib import Path

from .contracts import BrowserRefused


def require_tmpfs(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        require_tmpfs_fd(descriptor)
    finally:
        os.close(descriptor)


def require_tmpfs_fd(descriptor: int) -> None:
    if sys.platform != "linux":
        raise BrowserRefused("BROWSER_MEMORY_SCRATCH_REQUIRED")
    # Check the actual opened filesystem, not ambiguous stacked mount labels.
    buffer = ctypes.create_string_buffer(256)
    native = ctypes.CDLL(None, use_errno=True)
    if (
        native.fstatfs(descriptor, buffer) != 0
        or ctypes.c_long.from_buffer(buffer).value != 0x01021994
    ):
        raise BrowserRefused("BROWSER_MEMORY_SCRATCH_REQUIRED")


class MemoryScratch:
    # Fixed mount, not a fixed temporary filename: actual tmpfs is verified and
    # mkdtemp atomically creates an unpredictable, owner-only (0700) directory.
    def __init__(self, root: Path = Path("/dev/shm")) -> None:  # noqa: S108 # nosec B108
        require_tmpfs(root)
        self.path = Path(tempfile.mkdtemp(prefix="browser-task-", dir=root))
        try:
            require_tmpfs(self.path)
        except BaseException:
            shutil.rmtree(self.path)
            raise
        self._closed = False

    def close(self) -> None:
        if not self._closed:
            shutil.rmtree(self.path)
            self._closed = True
