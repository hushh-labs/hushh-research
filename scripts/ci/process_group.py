"""Own a command and its descendants on POSIX and Windows."""

from contextlib import contextmanager
import os
import signal
import subprocess
import sys
import time


class _WindowsJob:
    def __init__(self):
        import ctypes
        from ctypes import wintypes

        class BasicLimits(ctypes.Structure):
            _fields_ = [
                ("process_time", ctypes.c_int64),
                ("job_time", ctypes.c_int64),
                ("flags", wintypes.DWORD),
                ("min_working_set", ctypes.c_size_t),
                ("max_working_set", ctypes.c_size_t),
                ("active_limit", wintypes.DWORD),
                ("affinity", ctypes.c_size_t),
                ("priority", wintypes.DWORD),
                ("scheduling", wintypes.DWORD),
            ]

        class Limits(ctypes.Structure):
            _fields_ = [
                ("basic", BasicLimits),
                ("io", ctypes.c_uint64 * 6),
                ("process_memory", ctypes.c_size_t),
                ("job_memory", ctypes.c_size_t),
                ("peak_process_memory", ctypes.c_size_t),
                ("peak_job_memory", ctypes.c_size_t),
            ]

        self.api = ctypes.WinDLL("kernel32", use_last_error=True)
        signatures = {
            "CreateJobObjectW": ([ctypes.c_void_p, wintypes.LPCWSTR], wintypes.HANDLE),
            "SetInformationJobObject": (
                [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD],
                wintypes.BOOL,
            ),
            "OpenProcess": (
                [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD],
                wintypes.HANDLE,
            ),
            "AssignProcessToJobObject": (
                [wintypes.HANDLE, wintypes.HANDLE],
                wintypes.BOOL,
            ),
            "TerminateJobObject": ([wintypes.HANDLE, wintypes.UINT], wintypes.BOOL),
            "QueryInformationJobObject": (
                [
                    wintypes.HANDLE,
                    ctypes.c_int,
                    ctypes.c_void_p,
                    wintypes.DWORD,
                    ctypes.c_void_p,
                ],
                wintypes.BOOL,
            ),
            "CloseHandle": ([wintypes.HANDLE], wintypes.BOOL),
        }
        for name, (args, result) in signatures.items():
            function = getattr(self.api, name)
            function.argtypes, function.restype = args, result
        self.handle = self.api.CreateJobObjectW(None, None)
        if not self.handle:
            raise ctypes.WinError(ctypes.get_last_error())
        limits = Limits()
        limits.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not self.api.SetInformationJobObject(
            self.handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)
        ):
            error = ctypes.WinError(ctypes.get_last_error())
            self.close()
            raise error

    def assign(self, pid):
        import ctypes

        handle = self.api.OpenProcess(0x0101, False, pid)  # SET_QUOTA | TERMINATE
        if not handle:
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            if not self.api.AssignProcessToJobObject(self.handle, handle):
                raise ctypes.WinError(ctypes.get_last_error())
        finally:
            self.api.CloseHandle(handle)

    def stop(self):
        import ctypes

        if not self.api.TerminateJobObject(self.handle, 1):
            raise ctypes.WinError(ctypes.get_last_error())

    def close(self):
        if self.handle:
            import ctypes
            from ctypes import wintypes

            class Accounting(ctypes.Structure):
                _fields_ = [
                    ("times", ctypes.c_int64 * 4),
                    ("faults", wintypes.DWORD),
                    ("total", wintypes.DWORD),
                    ("active", wintypes.DWORD),
                    ("terminated", wintypes.DWORD),
                ]

            try:
                self.stop()
                deadline = time.monotonic() + 5
                accounting = Accounting()
                while True:
                    if not self.api.QueryInformationJobObject(
                        self.handle,
                        1,
                        ctypes.byref(accounting),
                        ctypes.sizeof(accounting),
                        None,
                    ):
                        raise ctypes.WinError(ctypes.get_last_error())
                    if accounting.active == 0:
                        break
                    if time.monotonic() >= deadline:
                        raise OSError("Owned command descendants did not exit")
                    time.sleep(0.01)
            finally:
                self.api.CloseHandle(self.handle)
                self.handle = None


@contextmanager
def command_group(args, **kwargs):
    """Yield (process, stop(force=...)) for a noninteractive command group.

    Windows targets wait behind a pipe until their bootstrap belongs to a Job
    Object. Assignment failure never launches an unsupervised target.
    """
    if os.name != "nt":
        process = subprocess.Popen(args, start_new_session=True, **kwargs)

        def stop(*, force=False):
            try:
                os.killpg(process.pid, signal.SIGKILL if force else signal.SIGTERM)
            except ProcessLookupError:
                pass

        try:
            yield process, stop
        finally:
            stop(force=True)
        return

    job = _WindowsJob()
    process = None
    bootstrap = (
        "import subprocess,sys; "
        "gate=sys.stdin.buffer.read(1); "
        "sys.exit(subprocess.call(sys.argv[1:]) if gate==b'1' else 125)"
    )
    try:
        process = subprocess.Popen(
            [sys.executable, "-c", bootstrap, *args],
            stdin=subprocess.PIPE,
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP,
            **kwargs,
        )
        job.assign(process.pid)
        process.stdin.write("1" if kwargs.get("text") else b"1")
        process.stdin.close()
        process.stdin = None

        def stop(*, force=False):
            if not force and process.poll() is None:
                try:
                    process.send_signal(signal.CTRL_BREAK_EVENT)
                    return
                except OSError:
                    pass  # Headless hosts cannot deliver console events.
            job.stop()

        yield process, stop
    finally:
        try:
            job.close()
        finally:
            if process is not None:
                # This also covers failure before assignment/gate release.
                if process.poll() is None:
                    process.kill()
                process.communicate(timeout=5)
