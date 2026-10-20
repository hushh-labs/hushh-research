"""Protect the disposable owner PKM index from other pod process identities."""

from __future__ import annotations

import os
import stat
from pathlib import Path


def prepare_index_path(value: str) -> str:
    path = Path(value)
    if not path.is_absolute():
        raise RuntimeError("POD_PKM_PRIVATE_PATH_REQUIRED")
    path.parent.mkdir(mode=0o700, exist_ok=True)
    parent = path.parent.resolve(strict=True)
    descriptor = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        info = os.fstat(descriptor)
        if info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise RuntimeError("POD_PKM_PRIVATE_DIRECTORY_REQUIRED")
        # A private leaf below another user's mutable ancestor is not stable.
        for ancestor in parent.parents:
            info = ancestor.stat()
            if info.st_uid not in {0, os.geteuid()} or (
                info.st_mode & 0o022 and not (info.st_uid == 0 and info.st_mode & stat.S_ISVTX)
            ):
                raise RuntimeError("POD_PKM_PRIVATE_DIRECTORY_REQUIRED")
        for suffix in ("", "-wal", "-shm"):
            flags = os.O_RDWR | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK
            try:
                file = os.open(
                    path.name + suffix,
                    flags | (os.O_CREAT if not suffix else 0),
                    0o600,
                    dir_fd=descriptor,
                )
            except FileNotFoundError:
                continue
            try:
                info = os.fstat(file)
                if (
                    not stat.S_ISREG(info.st_mode)
                    or info.st_nlink != 1
                    or info.st_uid != os.geteuid()
                ):
                    raise RuntimeError("POD_PKM_PRIVATE_FILE_REQUIRED")
                os.fchmod(file, 0o600)
            finally:
                os.close(file)
    finally:
        os.close(descriptor)
    return str(parent / path.name)
