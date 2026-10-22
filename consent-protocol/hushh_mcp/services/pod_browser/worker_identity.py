"""Irreversible browser-worker privilege drop, only inside the native sandbox."""

from __future__ import annotations

import ctypes
import os
import sys
from pathlib import Path

from .contracts import BrowserRefused
from .scratch import MemoryScratch

WORKER_ID = 10002


def prepare_worker_identity() -> MemoryScratch:
    if sys.platform != "linux":
        raise BrowserRefused("BROWSER_WORKER_IDENTITY_REFUSED")
    # Invoke before threads, IPC or browser startup. The native GCP probe started
    # as root despite image USER; never pass a privileged identity to Chrome.
    try:
        if os.geteuid() == 0:
            if any(group != WORKER_ID for group in os.getgroups()):
                os.setgroups([])
            os.setresgid(WORKER_ID, WORKER_ID, WORKER_ID)
            os.setresuid(WORKER_ID, WORKER_ID, WORKER_ID)
        if os.getresuid() != (WORKER_ID,) * 3 or os.getresgid() != (WORKER_ID,) * 3:
            raise ValueError()
        if any(group != WORKER_ID for group in os.getgroups()):
            raise ValueError()
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.prctl(38, 1, 0, 0, 0) != 0:  # PR_SET_NO_NEW_PRIVS
            raise ValueError()
        status = dict(
            line.split(":", 1) for line in Path("/proc/self/status").read_text().splitlines()
        )
        if status.get("NoNewPrivs", "").strip() != "1" or any(
            int(status[name].strip(), 16) for name in ("CapPrm", "CapEff", "CapAmb")
        ):
            raise ValueError()
        # Native scratch is ephemeral; no fixed shared HOME or retained session.
        scratch = MemoryScratch()
        os.environ["HOME"] = str(scratch.path)
        os.environ["TMPDIR"] = str(scratch.path)
        os.environ["PLAYWRIGHT_BROWSERS_PATH"] = "/opt/browser/browsers"
        return scratch
    except (AttributeError, OSError, ValueError, KeyError):
        raise BrowserRefused("BROWSER_WORKER_IDENTITY_REFUSED") from None
