"""Native worker identity and private scratch lifecycle; no cloud qualification."""

import pytest

from hushh_mcp.services.pod_browser.contracts import BrowserRefused


def test_browser_worker_death_restarts_owner_generation_without_inherited_fd(monkeypatch):
    import runpy
    from pathlib import Path
    from types import SimpleNamespace

    lifecycle = runpy.run_path(
        str(Path(__file__).parents[1] / "browser_runtime/gunicorn_lifecycle.py")
    )
    halted = []
    server = SimpleNamespace(alive=True, halt=lambda **result: halted.append(result))
    monkeypatch.setenv("POD_COMPUTER_USE_ENABLED", "true")
    monkeypatch.delenv("HUSSH_BROWSER_LAUNCH_FD", raising=False)
    lifecycle["child_exit"](server, None)
    assert halted == [{"reason": "Private browser worker generation ended", "exit_status": 1}]
    halted.clear()
    monkeypatch.setenv("POD_COMPUTER_USE_ENABLED", "false")
    lifecycle["child_exit"](server, None)
    assert halted == []


def test_worker_privilege_drop_refuses_retained_authority_before_private_scratch(monkeypatch):
    from types import SimpleNamespace

    from hushh_mcp.services.pod_browser import worker_identity as worker

    ids = {"uid": (0, 0, 0), "gid": (0, 0, 0)}
    environment = {}
    capability = "0"
    native = SimpleNamespace(
        geteuid=lambda: ids["uid"][1],
        getgroups=lambda: [],
        setresuid=lambda *values: ids.update(uid=values),
        setresgid=lambda *values: ids.update(gid=values),
        getresuid=lambda: ids["uid"],
        getresgid=lambda: ids["gid"],
        environ=environment,
    )
    monkeypatch.setattr(worker, "os", native)
    monkeypatch.setattr(worker, "sys", SimpleNamespace(platform="linux"))
    monkeypatch.setattr(
        worker,
        "ctypes",
        SimpleNamespace(CDLL=lambda *_args, **_kw: SimpleNamespace(prctl=lambda *_: 0)),
    )
    monkeypatch.setattr(
        worker,
        "Path",
        lambda _: SimpleNamespace(
            read_text=lambda: f"NoNewPrivs: 1\nCapPrm: 0\nCapEff: {capability}\nCapAmb: 0"
        ),
    )
    monkeypatch.setattr(worker, "MemoryScratch", lambda: SimpleNamespace(path="private-scratch"))
    worker.prepare_worker_identity()
    assert ids == {"uid": (10002, 10002, 10002), "gid": (10002, 10002, 10002)}
    assert environment["HOME"] == "private-scratch"

    capability = "1"
    environment.clear()
    with pytest.raises(BrowserRefused, match="WORKER_IDENTITY_REFUSED"):
        worker.prepare_worker_identity()
    assert not environment  # no browser/home initialization under retained authority


async def test_native_probe_releases_private_scratch_if_browser_startup_fails(
    monkeypatch, tmp_path
):
    import sys
    from types import SimpleNamespace

    from hushh_mcp.services.pod_browser import gcp_probe, worker_identity

    closed = []
    monkeypatch.setattr(
        worker_identity,
        "prepare_worker_identity",
        lambda: SimpleNamespace(
            close=lambda: closed.append(True),
        ),
    )
    monkeypatch.setitem(sys.modules, "playwright.async_api", None)
    with pytest.raises(ModuleNotFoundError):
        await gcp_probe._inside(tmp_path)
    assert closed == [True]


def test_builtin_guard_refuses_agent_identity_before_touching_environment(monkeypatch, tmp_path):
    from types import SimpleNamespace

    from hushh_mcp.services.pod_browser import process_guard

    environment = {"APP_SIGNING_KEY": "synthetic-not-a-secret"}
    monkeypatch.setattr(process_guard, "sys", SimpleNamespace(platform="linux"))
    monkeypatch.setattr(process_guard, "platform", SimpleNamespace(machine=lambda: "x86_64"))
    monkeypatch.setattr(
        process_guard,
        "os",
        SimpleNamespace(getresuid=lambda: (10001,) * 3, environ=environment),
    )
    with pytest.raises(process_guard.ProcessGuardRefused, match="WORKER_IDENTITY_REFUSED"):
        process_guard.restrict_browser_process(scratch=tmp_path, bridge_fd=3)
    assert environment == {"APP_SIGNING_KEY": "synthetic-not-a-secret"}


def test_builtin_probe_never_starts_chromium_after_a_missing_process_guard(monkeypatch, tmp_path):
    from hushh_mcp.services.pod_browser import process_probe

    def unavailable(**_arguments):
        raise process_probe.ProcessGuardRefused("BROWSER_FILESYSTEM_GUARD_UNAVAILABLE")

    def unexpected_frame(_scratch):
        pytest.fail("An unavailable filesystem guard must prevent Chromium startup")

    monkeypatch.setattr(process_probe, "restrict_browser_process", unavailable)
    monkeypatch.setattr(process_probe, "_frame", unexpected_frame)
    result = process_probe._inside(3, tmp_path, tmp_path / "canary")
    assert result == {
        "guard_verified": False,
        "frame_verified": False,
        "code": "BROWSER_FILESYSTEM_GUARD_UNAVAILABLE",
    }


@pytest.mark.parametrize("launcher", [False, True])
def test_syscall_guard_preserves_chromium_connected_ipc_without_external_datagrams(
    monkeypatch, launcher
):
    import ctypes
    import socket
    from types import SimpleNamespace

    from hushh_mcp.services.pod_browser import process_guard

    calls = []
    numbers = {}

    def resolve(name):
        numbers.setdefault(name, len(numbers) + 1)
        return numbers[name]

    def add(_context, _action, number, count, pointer):
        for index in range(count):
            comparison = ctypes.cast(pointer, ctypes.POINTER(process_guard._Comparison))[index]
            calls.append(
                (
                    number,
                    comparison.argument,
                    comparison.operation,
                    comparison.value,
                    comparison.mask,
                )
            )
        return 0

    library = SimpleNamespace(
        seccomp_init=lambda _action: 17,
        seccomp_release=lambda _context: None,
        seccomp_load=lambda _context: 0,
        seccomp_syscall_resolve_name=resolve,
        seccomp_rule_add_array=add,
        seccomp_attr_set=lambda *_args: 0,
    )
    monkeypatch.setattr(process_guard.ctypes, "CDLL", lambda *_args, **_kwargs: library)
    process_guard._syscalls(namespace_launcher=launcher)

    def denied_kinds(name):
        return {row[4] for row in calls if row[0] == numbers[name] and row[1:4] == (1, 7, 0xF)}

    assert socket.SOCK_SEQPACKET not in denied_kinds(b"socketpair")
    if launcher:
        assert b"bind" not in numbers and b"mount" not in numbers
        denied = {row[3] for row in calls if row[0] == numbers[b"socket"] and row[1:3] == (0, 4)}
        assert socket.AF_INET in denied and socket.AF_INET6 in denied
        # NETLINK appears once only in the rule refusing non-ROUTE protocols.
        assert calls.count((numbers[b"socket"], 0, 4, 16, 0)) == 1
        assert (numbers[b"socket"], 2, 1, 0, 0) in calls
        assert socket.AF_UNIX not in denied
        assert (numbers[b"socket"], 0, 5, 65, 0) in calls
        assert b"connect" in numbers and b"ptrace" in numbers
        return
    assert socket.SOCK_SEQPACKET in denied_kinds(b"socket")
    for name in (b"socket", b"socketpair"):
        assert socket.SOCK_DGRAM in denied_kinds(name)
        assert socket.SOCK_STREAM not in denied_kinds(name)
        assert (numbers[name], 0, 1, socket.AF_UNIX, 0) in calls
