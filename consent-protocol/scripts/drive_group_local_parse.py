"""Developer-only Windows parser child. No credential or application bootstrap.

The child installs OS job limits before importing the document parser or reading
stdin. The job handle is non-inheritable and retained until process exit, so
termination also kills descendants. Production POSIX children remain unchanged.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path


def install_limits(*, cpu_seconds: int = 20, memory_bytes: int = 512 * 1024 * 1024):
    import win32api
    import win32job

    job = win32job.CreateJobObject(None, "")
    limits = win32job.QueryInformationJobObject(job, win32job.JobObjectExtendedLimitInformation)
    limits["BasicLimitInformation"].update(
        LimitFlags=(
            win32job.JOB_OBJECT_LIMIT_JOB_TIME
            | win32job.JOB_OBJECT_LIMIT_JOB_MEMORY
            | win32job.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            | win32job.JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION
        ),
        PerJobUserTimeLimit=cpu_seconds * 10_000_000,
    )
    limits["JobMemoryLimit"] = memory_bytes
    win32job.SetInformationJobObject(job, win32job.JobObjectExtendedLimitInformation, limits)
    win32job.AssignProcessToJobObject(job, win32api.GetCurrentProcess())
    return job


def main() -> None:
    # No untrusted input, document imports or parser work precedes this gate.
    try:
        job = install_limits()
    except Exception:
        sys.stdout.write(json.dumps({"error": "processor_unavailable"}))
        return
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from hushh_mcp.services.drive_document_parser import (
        MAX_INPUT_BYTES,
        MAX_XLSX_INPUT_BYTES,
        XLSX,
        ParseError,
        parse_document,
        parse_live_document,
    )

    try:
        mime = sys.argv[1]
        live = mime.startswith("live:")
        mime = mime.removeprefix("live:")
        maximum = MAX_XLSX_INPUT_BYTES if live and mime == XLSX else MAX_INPUT_BYTES
        parsed = (parse_live_document if live else parse_document)(
            sys.stdin.buffer.read(maximum + 1), mime
        )
        result = {"pages": parsed.pages, "truncated": parsed.truncated}
    except ParseError as error:
        result = {"error": str(error)}
    except Exception:
        result = {"error": "processor_unavailable"}
    sys.stdout.write(json.dumps(result))
    # Keep the sole job handle alive through the last write.
    assert job is not None
    sys.stdout.flush()
    # ExitProcess closes the last handle after this process's exit status is
    # fixed, and terminates any remaining descendants with the job.
    os._exit(0)


if __name__ == "__main__":
    main()
