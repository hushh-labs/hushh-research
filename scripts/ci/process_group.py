"""Own a command and its descendants on POSIX and Windows."""

import math
import os
import queue
import signal
import subprocess
import sys
import threading
import time
from contextlib import contextmanager


def _group_is_absent(group):
    """Independent absence proof; an unavailable/empty inventory is not proof."""
    try:
        observed = subprocess.run(
            ["/bin/ps", "-axo", "pgid="],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=1,
            check=False,
        )
        values = observed.stdout.split()
        if not values or any(not value.isascii() or not value.isdecimal() for value in values):
            return False
        return observed.returncode == 0 and group not in {int(value) for value in values}
    except (OSError, subprocess.SubprocessError, ValueError):
        return False


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
def command_group(args, *, wait_only=False, **kwargs):
    """Yield (process, stop(force=...)) for a noninteractive command group.

    Windows targets wait behind a pipe until their bootstrap belongs to a Job
    Object. Assignment failure never launches an unsupervised target.
    """
    if os.name != "nt":
        process = subprocess.Popen(args, start_new_session=True, **kwargs)  # noqa: S603 -- trusted caller command, owned group.

        def stop(*, force=False):
            try:
                os.killpg(process.pid, signal.SIGKILL if force else signal.SIGTERM)
            except ProcessLookupError:
                pass
            except PermissionError:
                # Darwin can report EPERM for a group that vanished after TERM.
                # Reaping the parent alone cannot prove its descendants exited.
                if (
                    force
                    and sys.platform == "darwin"
                    and process.poll() is not None
                    and _group_is_absent(process.pid)
                ):
                    return
                raise

        try:
            yield process, stop
        finally:
            try:
                stop(force=True)
            finally:
                if wait_only:
                    if process.poll() is None:
                        process.kill()
                    process.wait(timeout=5)
        return

    job = _WindowsJob()
    process = None
    bootstrap = (
        "import subprocess,sys; "
        "gate=sys.stdin.buffer.read(1); "
        "sys.exit(subprocess.call(sys.argv[1:]) if gate==b'1' else 125)"
    )
    try:
        process = subprocess.Popen(  # noqa: S603 -- gated trusted command, assigned to this Job before release.
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
                if wait_only:
                    process.wait(timeout=5)
                else:
                    process.communicate(timeout=5)


class BoundedReadError(RuntimeError):
    """A redacted transport classification, without command or response content."""

    def __init__(self, reason):
        self.reason = reason
        super().__init__("Bounded command read: " + reason)


def _pump_stdout(stream, chunks, stopped, chunk_size):
    def post(kind, value=None):
        while not stopped.is_set():
            try:
                chunks.put((kind, value), timeout=0.05)
                return True
            except queue.Full:
                pass
        return False

    try:
        while not stopped.is_set():
            chunk = os.read(stream.fileno(), chunk_size)
            if not post("data", chunk) or not chunk:
                return
    except Exception:  # noqa: BLE001 -- no response or pipe diagnostic enters output.
        post("read")


def _collect_stdout(process, chunks, end, max_bytes):
    output = bytearray()
    while True:
        remaining = end - time.monotonic()
        if remaining <= 0:
            raise BoundedReadError("timeout")
        try:
            kind, chunk = chunks.get(timeout=remaining)
        except queue.Empty:
            raise BoundedReadError("timeout") from None
        if kind != "data":
            raise BoundedReadError("read")
        if not chunk:
            break
        if len(output) + len(chunk) > max_bytes:
            raise BoundedReadError("size")
        output.extend(chunk)
    remaining = end - time.monotonic()
    if remaining <= 0:
        raise BoundedReadError("timeout")
    try:
        code = process.wait(timeout=remaining)
    except subprocess.TimeoutExpired:
        raise BoundedReadError("timeout") from None
    if code != 0:
        raise BoundedReadError("exit")
    return bytes(output)


def bounded_stdout(args, *, max_bytes, timeout):
    """Read bounded bytes using one bounded queue; settle the process tree first.

    Windows select() cannot wait on anonymous subprocess pipes. A single reader
    blocks in os.read; Job/group termination closes all owned write handles on
    every exit path, then the reader is joined before its pipe is closed.
    """
    if (
        type(max_bytes) is not int
        or max_bytes < 1
        or type(timeout) not in (int, float)
        or not math.isfinite(timeout)
        or timeout <= 0
    ):
        raise BoundedReadError("arguments")
    end = time.monotonic() + timeout
    stopped, chunks = threading.Event(), queue.Queue(maxsize=2)
    worker = stream = None
    try:
        with command_group(
            args, wait_only=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0
        ) as (process, _stop):
            stream = process.stdout
            worker = threading.Thread(
                target=_pump_stdout,
                args=(stream, chunks, stopped, min(65536, max_bytes + 1)),
                name="bounded-command-stdout",
                daemon=True,
            )
            try:
                worker.start()
                return _collect_stdout(process, chunks, end, max_bytes)
            finally:
                stopped.set()
    finally:
        stopped.set()
        try:
            if worker is not None and worker.ident is not None:
                worker.join(timeout=5)
                if worker.is_alive():
                    raise BoundedReadError("cleanup")
        finally:
            if stream is not None:
                stream.close()
