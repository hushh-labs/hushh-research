"""Disposable public-document search probe; no owner/model/production authority.

Only fixed Python documentation URLs and their same-origin static assets may be
read. This policy is a synthetic qualification fixture, never a website-safety
classifier or the production approval port.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import socket
import sys
import time
from pathlib import Path
from urllib.parse import urlsplit

from .connected_executor import ConnectedBrowserExecutor, ConnectedBrowserWorker
from .contracts import (
    BrowserAction,
    BrowserBinding,
    BrowserNetworkPermit,
    BrowserRefused,
    BrowserRequest,
    BrowserResponse,
)
from .namespace_bridge_probe import _stop_worker
from .namespace_probe import PREFIX, _command, verify_isolation
from .network import BrowserNetworkBroker
from .playwright_executor import PlaywrightExecutor

_ORIGIN = "https://docs.python.org"
_PAGES = (_ORIGIN + "/3/", _ORIGIN + "/3/search.html?q=browser")
_BINDING = BrowserBinding(
    owner_id="synthetic-public-probe",
    pod_id="disposable",
    incarnation="qualification",
    task_id="public-doc-search",
    environment="development",
    expires_at=2**31 - 1,
)


class _PublicFixtureAuthority:
    def __init__(self) -> None:
        self.requests = 0

    async def check_binding(self, binding: BrowserBinding) -> None:
        if binding != _BINDING or time.time() >= binding.expires_at:
            raise BrowserRefused("BROWSER_BINDING_REFUSED")

    async def check_no_pending_dispatch(self, binding: BrowserBinding) -> None:
        await self.check_binding(binding)

    async def authorize_action(self, *args, **kwargs) -> None:
        raise BrowserRefused("BROWSER_APPROVAL_REQUIRED")

    async def require(self, *args, **kwargs) -> None:
        raise BrowserRefused("BROWSER_APPROVAL_REQUIRED")

    async def authorize_request(
        self, binding: BrowserBinding, request: BrowserRequest, commitment: str
    ) -> BrowserNetworkPermit:
        await self.check_binding(binding)
        self.requests += 1
        url = urlsplit(request.url)
        resource = url.path.startswith(("/3/_static/", "/3/_images/")) or url.path in {
            "/3/searchindex.js",
            "/favicon.ico",
        }
        if (
            self.requests > 80
            or request.method != "GET"
            or request.body
            or url.scheme != "https"
            or url.netloc != "docs.python.org"
            or (request.url not in _PAGES and not resource)
            or commitment != request.commitment()
            or any(name.lower() in {"cookie", "authorization"} for name, _ in request.headers)
        ):
            raise BrowserRefused("BROWSER_DESTINATION_REFUSED")
        return BrowserNetworkPermit(effect_receipt_required=False)

    async def journal_dispatch(self, *args, **kwargs) -> None:
        raise BrowserRefused("BROWSER_APPROVAL_REQUIRED")

    async def settle_dispatch(self, *args, **kwargs) -> None:
        raise BrowserRefused("BROWSER_APPROVAL_REQUIRED")


class _ReceiptBroker(BrowserNetworkBroker):
    def __init__(self, authority: _PublicFixtureAuthority) -> None:
        super().__init__(
            binding=_BINDING, allowed_origins=frozenset({_ORIGIN}), authority=authority
        )
        self.documents: dict[int, int] = {}

    async def fetch(self, request: BrowserRequest) -> BrowserResponse:
        response = await super().fetch(request)
        if request.url in _PAGES:
            self.documents[_PAGES.index(request.url) + 1] = response.status
        return response


async def _worker() -> None:
    guards = verify_isolation()
    print(PREFIX + json.dumps({"guards": guards}), flush=True)
    if guards.get("code") != "BROWSER_NAMESPACE_GUARDS_VERIFIED":
        raise BrowserRefused("BROWSER_ISOLATION_NOT_READY")
    worker = ConnectedBrowserWorker(_BINDING)
    executor = PlaywrightExecutor(network=worker, chromium_sandbox=True)
    await worker.serve(socket.socket(fileno=int(sys.argv[3])), executor)


async def _visit(host: ConnectedBrowserExecutor) -> dict:
    start = time.monotonic()
    await host.initialize()
    startup = round(time.monotonic() - start, 3)
    frames = []
    for sequence, url in enumerate(_PAGES, start=1):
        start = time.monotonic()
        frame = await host.execute(
            BrowserAction(operation="navigate", url=url, sequence=sequence, control_epoch=1)
        )
        if frame.url != url:
            raise BrowserRefused("BROWSER_DESTINATION_REFUSED")
        frames.append(
            {
                "sequence": sequence,
                "seconds": round(time.monotonic() - start, 3),
                "bytes": len(frame.png),
                "sha256": hashlib.sha256(frame.png).hexdigest(),
            }
        )
    return {
        "code": "BROWSER_PUBLIC_SEARCH_FRAMES_VERIFIED",
        "startup_seconds": startup,
        "frames": frames,
    }


async def run_probe() -> dict:
    if os.geteuid() != 10002 or not Path("/agent/synthetic-secret").is_file():
        return {"code": "BROWSER_NEGATIVE_CONTROL_MISSING"}
    authority = _PublicFixtureAuthority()
    broker = _ReceiptBroker(authority)
    parent, child = socket.socketpair()
    process = host = None
    result: dict = {"code": "BROWSER_PUBLIC_SEARCH_REFUSED"}

    async def terminate() -> None:
        if process is not None:
            # Closing the channel lets the worker release Chromium; the trusted
            # process-group backstop still verifies/reaps a stuck worker.
            if host is not None:
                await host._channel.close()
            result.update(await _stop_worker(process, grace_seconds=3))

    try:
        process = await asyncio.create_subprocess_exec(
            *_command(bridge_fd=child.fileno(), public_probe=True),
            pass_fds=(child.fileno(),),
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            env={"PATH": "/usr/local/bin:/usr/bin:/bin"},
            start_new_session=True,
        )
        child.close()
        host = await ConnectedBrowserExecutor.connect(
            parent, binding=_BINDING, broker=broker, terminate=terminate
        )
        result.update(await _visit(host))
    except Exception as exc:
        result["failure"] = (
            exc.code if isinstance(exc, BrowserRefused) else "BROWSER_PUBLIC_PROBE_FAILED"
        )
    finally:
        child.close()
        try:
            if host is not None:
                await host.close()
            else:
                parent.close()
                await terminate()
                await broker.close()
        finally:
            result["broker_requests"] = authority.requests
            result["document_statuses"] = broker.documents
            if process is not None and process.stdout is not None:
                output = await process.stdout.read(16384)
                for line in output.decode().splitlines():
                    if line.startswith(PREFIX):
                        result.update(json.loads(line[len(PREFIX) :]))
    if (
        not result.get("process_group_absent")
        or result.get("worker_exit") != 0
        or broker.documents != {1: 200, 2: 200}
    ):
        result["code"] = "BROWSER_PUBLIC_SEARCH_REFUSED"
    return result


async def run_inpod_probe() -> dict:
    """Qualify production launch/stop with synthetic authority, never enable it."""
    from . import inpod_launcher
    from .contracts import BrowserReadiness

    if os.geteuid() != 10001 or not Path("/app/synthetic-secret").is_file():
        return {"code": "BROWSER_NEGATIVE_CONTROL_MISSING"}
    authority = _PublicFixtureAuthority()
    broker = _ReceiptBroker(authority)
    # Instrument only document HTTP statuses. The actual network/binding policy
    # and connected launcher/worker remain their authored implementations.
    inpod_launcher.BrowserNetworkBroker = lambda **_kwargs: broker  # type: ignore[misc,assignment]
    launcher = inpod_launcher.InPodBrowserLauncher.from_bootstrap(
        readiness=BrowserReadiness(
            cloud="gcp",
            component_digest="sha256:" + "0" * 64,
            isolated=True,
            direct_egress_denied=True,
            broker_bridge_verified=True,
            ephemeral_bridge_verified=True,
            private_access_denied=True,
            model_transport_verified=True,
            model_name="synthetic-no-model",
            model_transport="qualification-only",
        ),
        network_authority=lambda *_args: authority,
    )
    result: dict = {"code": "BROWSER_INPOD_PROBE_REFUSED", "agent_uid": os.geteuid()}
    host = None
    try:
        result["stage"] = "launch"
        host = await launcher.launch(
            _BINDING, allowed_origins=(_ORIGIN,), consent=authority, authority=authority
        )
        result["stage"] = "visit"
        result.update(await _visit(host))
        result["stage"] = "stop"
        await host.close()
        result["stop_confirmed"] = True
    except Exception as exc:
        result["failure"] = (
            exc.code if isinstance(exc, BrowserRefused) else "BROWSER_INPOD_PROBE_FAILED"
        )
        result["failure_type"] = type(exc).__name__
    finally:
        try:
            if host is not None:
                await host.close()
            await launcher.close()
        except Exception:
            result["cleanup_unconfirmed"] = True
        finally:
            await broker.close()
        result["document_statuses"] = broker.documents
        result["broker_requests"] = authority.requests
    if (
        not result.get("stop_confirmed")
        or result.get("cleanup_unconfirmed")
        or broker.documents != {1: 200, 2: 200}
    ):
        result["code"] = "BROWSER_INPOD_PROBE_REFUSED"
    return result


async def run_container_probe(cloud: str) -> dict:
    """Synthetic shared-owner launch/stop proof; never issues release readiness."""
    from . import inpod_launcher
    from .contracts import BrowserReadiness

    if cloud not in {"gcp", "azure"} or os.geteuid() == 0:
        raise BrowserRefused("BROWSER_PROBE_IDENTITY_REFUSED")
    authority = _PublicFixtureAuthority()
    broker = _ReceiptBroker(authority)
    # Fixture instrumentation, not owner consent or an enablement receipt.
    original = inpod_launcher.BrowserNetworkBroker
    inpod_launcher.BrowserNetworkBroker = lambda **_kwargs: broker  # type: ignore[misc,assignment]
    ready = BrowserReadiness(
        version=2,
        cloud=cloud,
        component_digest="sha256:" + "0" * 64,
        boundary="shared_owner_container",
        chromium_sandbox=cloud == "gcp",
        browser_start_verified=True,
        runtime_uid_verified=True,
        lifecycle_verified=True,
        broker_bridge_verified=True,
        ephemeral_bridge_verified=True,
        model_transport_verified=True,
        model_name="synthetic-no-model",
        model_transport="qualification-only",
    )
    launcher = None
    host = None
    result = {
        "code": "BROWSER_CONTAINER_PROBE_REFUSED",
        "runtime_uid": os.geteuid(),
        "cloud": cloud,
        "chromium_sandbox": ready.chromium_sandbox,
        "boundary": ready.boundary,
        "model_executed": False,
    }
    try:
        launcher = inpod_launcher.InPodBrowserLauncher.from_container(
            readiness=ready, network_authority=lambda *_: authority
        )
        host = await launcher.launch(
            _BINDING, allowed_origins=(_ORIGIN,), consent=authority, authority=authority
        )
        result.update(await _visit(host))
        await host.close()
        result["stop_confirmed"] = True
    except Exception as exc:
        result["failure_type"] = type(exc).__name__
        result["failure"] = exc.code if isinstance(exc, BrowserRefused) else "BROWSER_PROBE_FAILED"
        cause = exc.__context__
        if cause is not None:
            result["cause_type"] = type(cause).__name__
    finally:
        try:
            try:
                if host is not None:
                    await host.close()
            finally:
                if launcher is not None:
                    await launcher.close()
                    result["supervisor_exit"] = launcher._supervisor.returncode
        except Exception:
            result["cleanup_unconfirmed"] = True
        finally:
            await broker.close()
            inpod_launcher.BrowserNetworkBroker = original
        result["document_statuses"] = broker.documents
        result["broker_requests"] = authority.requests
    if (
        result.get("stop_confirmed")
        and not result.get("cleanup_unconfirmed")
        and result.get("supervisor_exit") == 0
        and broker.documents == {1: 200, 2: 200}
    ):
        result["code"] = "BROWSER_CONTAINER_EXECUTION_VERIFIED"
    else:
        result["code"] = "BROWSER_CONTAINER_PROBE_REFUSED"
    return result


if __name__ == "__main__":
    try:
        if len(sys.argv) == 4 and sys.argv[1] == "--inside":
            asyncio.run(_worker())
        else:
            print(PREFIX + json.dumps(asyncio.run(run_probe())), flush=True)
    except Exception:
        raise SystemExit(1) from None
