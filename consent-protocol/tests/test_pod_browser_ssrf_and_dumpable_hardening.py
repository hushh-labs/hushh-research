# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Wave 3 verification for post-execve dumpable/core hardening and browser SSRF defenses."""

from __future__ import annotations

from io import StringIO
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from hushh_mcp.services.pod_browser import container_worker
from hushh_mcp.services.pod_browser.contracts import BrowserAction, BrowserRefused
from hushh_mcp.services.pod_browser.launch_protocol import LaunchRefused
from hushh_mcp.services.pod_browser.origin import public_origin
from hushh_mcp.services.pod_browser.playwright_executor import PlaywrightExecutor
from hushh_mcp.services.public_endpoint_policy import UnsafeMcpEndpoint, validate_mcp_endpoint


def test_gunicorn_lifecycle_restores_non_dumpable_and_zero_core_after_execve(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import browser_runtime.gunicorn_lifecycle as gl

    calls: list[tuple] = []

    class FakeLibc:
        def prctl(self, option: int, arg2: int, arg3: int, arg4: int, arg5: int) -> int:
            calls.append(("prctl", option, arg2))
            return 0

    monkeypatch.setattr(gl.sys, "platform", "linux")
    monkeypatch.setattr(
        gl.resource, "setrlimit", lambda kind, limits: calls.append(("rlimit", kind, limits))
    )
    monkeypatch.setattr(gl.ctypes, "CDLL", lambda *_args, **_kw: FakeLibc())
    monkeypatch.setattr(
        gl,
        "open",
        lambda *_args, **_kw: StringIO("Name:\tgunicorn\nDumpable:\t0\n"),
        raising=False,
    )
    monkeypatch.setenv("HUSSH_POD_MODE", "1")
    monkeypatch.setattr(gl.os.path, "exists", lambda p: False)

    gl.post_worker_init(SimpleNamespace())
    assert ("rlimit", gl.resource.RLIMIT_CORE, (0, 0)) in calls
    assert ("prctl", 38, 1) in calls  # PR_SET_NO_NEW_PRIVS
    assert ("prctl", 4, 0) in calls  # PR_SET_DUMPABLE = 0


def test_gunicorn_lifecycle_fails_closed_if_dumpable_remains_set(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import browser_runtime.gunicorn_lifecycle as gl

    monkeypatch.setattr(gl.sys, "platform", "linux")
    monkeypatch.setattr(gl.resource, "setrlimit", lambda *_args: None)
    monkeypatch.setattr(
        gl.ctypes,
        "CDLL",
        lambda *_args, **_kw: SimpleNamespace(prctl=lambda *_a: 0),
    )
    monkeypatch.setattr(
        gl,
        "open",
        lambda *_args, **_kw: StringIO("Name:\tgunicorn\nDumpable:\t1\n"),
        raising=False,
    )
    with pytest.raises(RuntimeError, match="POD_WORKER_HARDENING_REFUSED"):
        gl.harden_worker_process()


def test_container_worker_enforces_non_dumpable_no_new_privs_and_zero_core(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    recorded: list[tuple] = []

    monkeypatch.setattr(container_worker.sys, "platform", "linux")
    monkeypatch.setattr(container_worker.os, "geteuid", lambda: 10001)
    monkeypatch.setattr(container_worker.os, "getuid", lambda: 10001)
    monkeypatch.setattr(container_worker.os, "umask", lambda mask: recorded.append(("umask", mask)))
    monkeypatch.setattr(
        container_worker.resource,
        "setrlimit",
        lambda kind, limits: recorded.append(("rlimit", kind, limits)),
    )
    monkeypatch.setattr(
        container_worker.ctypes,
        "CDLL",
        lambda *_args, **_kw: SimpleNamespace(
            prctl=lambda opt, val, *_rest: recorded.append(("prctl", opt, val)) or 0
        ),
    )

    container_worker.require_owner_process()
    assert ("umask", 0o077) in recorded
    assert ("rlimit", container_worker.resource.RLIMIT_CORE, (0, 0)) in recorded
    assert ("prctl", 38, 1) in recorded
    assert ("prctl", 4, 0) in recorded

    monkeypatch.setattr(
        container_worker.ctypes,
        "CDLL",
        lambda *_args, **_kw: SimpleNamespace(prctl=lambda *_a: -1),
    )
    with pytest.raises(LaunchRefused):
        container_worker.require_owner_process()


@pytest.mark.parametrize(
    "blocked_url",
    [
        "https://metadata.goog",
        "https://compute.metadata.goog",
        "https://metadata.google.internal",
        "https://kubernetes.default.svc",
        "https://api.default.svc.cluster.local",
        "https://router.home.arpa",
        "https://169.254.169.254",
        "https://169.254.170.2",
        "https://100.100.100.200",
        "https://127.0.0.1",
        "https://[::ffff:169.254.169.254]",
        "https://[fd00:ec2::254]",
        "http://example.com",
        "file:///etc/passwd",
        "chrome://version",
    ],
)
def test_pre_dns_policy_and_browser_origin_refuse_metadata_cluster_and_local_targets(
    blocked_url: str,
) -> None:
    with pytest.raises(UnsafeMcpEndpoint):
        validate_mcp_endpoint(blocked_url)
    with pytest.raises(BrowserRefused, match="BROWSER_DESTINATION_REFUSED"):
        public_origin(blocked_url)


async def test_playwright_executor_blocks_unbrokered_dns_webrtc_and_non_public_frames(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import sys

    cdp = SimpleNamespace(
        send=AsyncMock(return_value={"frameTree": {"frame": {"id": "main"}}}),
        on=Mock(),
    )
    goto = AsyncMock()
    page = SimpleNamespace(
        set_default_timeout=Mock(),
        set_default_navigation_timeout=Mock(),
        is_closed=lambda: False,
        goto=goto,
        screenshot=AsyncMock(return_value=b"\x89PNG\r\n\x1a\n"),
        viewport_size={"width": 1280, "height": 720},
        url="https://example.com/docs#section-1",
    )
    context = SimpleNamespace(
        new_page=AsyncMock(return_value=page),
        new_cdp_session=AsyncMock(return_value=cdp),
        route_web_socket=AsyncMock(),
        on=Mock(),
    )
    browser = SimpleNamespace(new_context=AsyncMock(return_value=context), close=AsyncMock())
    launch = AsyncMock(return_value=browser)
    playwright = SimpleNamespace(chromium=SimpleNamespace(launch=launch), stop=AsyncMock())
    monkeypatch.setitem(
        sys.modules,
        "playwright.async_api",
        SimpleNamespace(
            async_playwright=lambda: SimpleNamespace(start=AsyncMock(return_value=playwright))
        ),
    )

    executor = PlaywrightExecutor(network=SimpleNamespace(fetch=AsyncMock()), chromium_sandbox=True)
    try:
        await executor.initialize()
        launch_args = launch.call_args.kwargs["args"]
        assert "--host-resolver-rules=MAP * ~NOTFOUND" in launch_args
        assert "--webrtc-ip-handling-policy=disable_non_proxied_udp" in launch_args
        assert "--force-webrtc-ip-handling-policy" in launch_args

        # Direct executor call refuses cloud metadata before page.goto() is ever invoked.
        with pytest.raises(BrowserRefused, match="BROWSER_DESTINATION_REFUSED"):
            await executor.execute(
                BrowserAction(
                    operation="navigate",
                    sequence=1,
                    control_epoch=1,
                    url="https://metadata.goog/computeMetadata/v1/",
                )
            )
        assert goto.await_count == 0

        # Valid HTTPS navigation with #fragment succeeds.
        frame = await executor.execute(
            BrowserAction(
                operation="navigate",
                sequence=2,
                control_epoch=1,
                url="https://example.com/docs",
            )
        )
        assert frame.url == "https://example.com/docs#section-1"

        # If a page transitions to a non-HTTPS scheme (e.g. chrome:// or file://), execute fails closed.
        page.url = "file:///proc/self/environ"
        with pytest.raises(BrowserRefused, match="BROWSER_DESTINATION_REFUSED"):
            await executor.execute(BrowserAction(operation="observe", sequence=3, control_epoch=1))
    finally:
        await executor.close()
