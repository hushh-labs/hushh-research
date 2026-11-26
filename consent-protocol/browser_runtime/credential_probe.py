"""Local diagnostic of the installed Chromium private-entry path.

Run ``python -m browser_runtime.credential_probe --executable PATH``. Uses only
synthetic canaries and intercepted fixture responses, never real accounts or
network credentials. Passing does not qualify a deployment image, OS isolation,
renderer heap zeroization or Phase3 human acceptance.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import tempfile
import time
from contextlib import asynccontextmanager
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs

from hushh_mcp.services.pod_browser.contracts import (
    BrowserAction,
    BrowserBinding,
    BrowserReadiness,
    BrowserRefused,
)
from hushh_mcp.services.pod_browser.control import BrowserControl
from hushh_mcp.services.pod_browser.credential_contracts import (
    CredentialDescriptor,
    CredentialLease,
    CredentialUseRequest,
)
from hushh_mcp.services.pod_browser.credential_use import BrowserCredentialUse
from hushh_mcp.services.pod_browser.dispatch_journal import BrowserDispatchJournal
from hushh_mcp.services.pod_browser.execution_authority import (
    BrowserExecutionAuthority,
    PublicResearchNetworkAuthority,
    PublicResearchPolicy,
)
from hushh_mcp.services.pod_browser.network import BrowserNetworkBroker
from hushh_mcp.services.pod_browser.playwright_executor import PlaywrightExecutor
from hushh_mcp.services.pod_commit_log import LocalObjectStore, PodCommitLog

ORIGIN = "https://example.com"
HTML = b"""<!doctype html><head><link rel="icon" href="data:,"></head><form method="post" action="/session">
<input name="username" style="position:absolute;left:10px;top:10px;width:160px;height:30px">
<input name="password" type="password" style="position:absolute;left:10px;top:60px;width:160px;height:30px">
<input name="otp" autocomplete="one-time-code" style="position:absolute;left:10px;top:110px;width:160px;height:30px">
<button type="submit" style="position:absolute;left:10px;top:160px;width:160px;height:30px">Sign in</button>
</form>"""


ECHO_CASES = (
    "light_dom",
    "input_value",
    "textarea_value",
    "open_shadow_text",
    "open_shadow_value",
    "closed_shadow",
    "iframe_value",
)


def echoed_document(kind: str) -> bytes:
    encoded = base64.b64encode(b"synthetic-private-password").decode("ascii")
    if kind == "light_dom":
        script = "document.querySelector('#echo').textContent=atob(encoded);"
    elif kind in ("input_value", "textarea_value"):
        tag = "input" if kind == "input_value" else "textarea"
        script = (
            f"const field=document.createElement('{tag}'); document.body.append(field);"
            "field.value=atob(encoded);"
            "Object.defineProperty(field,'value',{get:()=>''});"
        )
    elif kind == "iframe_value":
        script = (
            "const frame=document.createElement('iframe');frame.sandbox='allow-scripts';"
            "frame.srcdoc='<input id=field><script>document.querySelector(\"#field\").value=atob(\"'+encoded+'\")<\\/script>';"
            "document.body.append(frame);"
        )
    else:
        mode = "closed" if kind == "closed_shadow" else "open"
        script = f"const root=document.querySelector('#echo').attachShadow({{mode:'{mode}'}});"
        script += (
            "root.textContent=atob(encoded);"
            if kind == "open_shadow_text"
            else "const field=document.createElement('input');root.append(field);field.value=atob(encoded);"
        )
    # No decoded canary exists in response markup or ordinary textContent.
    return (
        "<head><link rel=icon href='data:,'></head><body><div id=echo></div><script>"
        f"const encoded='{encoded}';"
        + script
        + "Object.defineProperties(document.documentElement,{outerHTML:{get:()=>''},textContent:{get:()=>''}})</script>"
    ).encode()


async def probe(
    executable: Path, *, echo_case: str = "light_dom", manual_control: bool = False
) -> dict:
    import httpcore
    from playwright.async_api import BrowserType

    if not executable.is_file():
        raise ValueError("BROWSER_PROBE_EXECUTABLE_MISSING")
    launch = BrowserType.launch

    async def installed(browser_type, **kwargs):
        return await launch(browser_type, **{**kwargs, "executable_path": str(executable)})

    binding = BrowserBinding(
        owner_id="synthetic-owner",
        pod_id="synthetic-pod",
        incarnation="synthetic-epoch",
        task_id="synthetic-task",
        environment="development",
        expires_at=int(time.time()) + 180,
    )
    ready = BrowserReadiness(
        version=2,
        boundary="shared_owner_container",
        cloud="gcp",
        component_digest="sha256:" + "a" * 64,
        isolated=False,
        direct_egress_denied=False,
        private_access_denied=False,
        chromium_sandbox=True,
        browser_start_verified=True,
        runtime_uid_verified=True,
        lifecycle_verified=True,
        broker_bridge_verified=True,
        ephemeral_bridge_verified=True,
        model_transport_verified=True,
        model_name="synthetic-no-model",
        model_transport="synthetic-no-model",
        credential_entry_verified=True,
        credential_cleanup_verified=True,
        credential_isolation_verified=True,
    )
    state = {"posts": 0, "opens": 0, "echo": False, "receipts": [], "reviews": [], "redirects": 0}
    leases = []

    class Authority:
        async def check_binding(self, candidate):
            if candidate != binding:
                raise BrowserRefused("BROWSER_BINDING_REFUSED")

        async def authorize_action(self, candidate, action, *, scope=None):
            await self.check_binding(candidate)

        async def check_no_pending_dispatch(self, candidate):
            await self.check_binding(candidate)

        async def journal_dispatch(self, candidate, action):
            state["receipts"].append("pending")

        async def settle_dispatch(self, candidate, action, *, uncertain):
            state["receipts"].append("uncertain" if uncertain else "settled")

        async def require(self, bound, purpose, terms):
            state["reviews"].append(purpose)
            raise BrowserRefused("BROWSER_OWNER_APPROVAL_REQUIRED")

    authority = Authority()

    temporary = tempfile.TemporaryDirectory(prefix="hussh-credential-probe-")
    log = PodCommitLog(LocalObjectStore(temporary.name), b"L" * 32, owner_id=binding.owner_id)
    journal = BrowserDispatchJournal(
        log, key=b"J" * 32, owner_id=binding.owner_id, pod_id=binding.pod_id
    )
    policy = PublicResearchPolicy(page_urls=(ORIGIN + "/login",), interactive_origins=(ORIGIN,))
    broker = BrowserNetworkBroker(
        binding=binding,
        allowed_origins=frozenset({ORIGIN}),
        authority=PublicResearchNetworkAuthority(binding, authority, journal, policy),
    )

    class Pool:
        async def handle_async_request(self, request):
            # httpcore's URL repr is not the network URL; use its raw fields.
            path = request.url.target.decode()
            if request.method == b"POST":
                body = b"".join([chunk async for chunk in request.stream])
                values = parse_qs(body.decode())
                if (
                    path != "/session"
                    or values
                    != {
                        "username": ["synthetic-user"],
                        "password": ["synthetic-private-password"],
                        "otp": [driver._credential_targets._otp_code.decode("ascii")],
                    }
                    or not driver._credential_targets.original_cleared
                ):
                    raise BrowserRefused("BROWSER_CREDENTIAL_PROBE_FAILED")
                state["posts"] += 1
                return httpcore.Response(303, headers=[(b"location", b"/account")], content=b"")
            if request.method != b"GET":
                raise BrowserRefused("BROWSER_CREDENTIAL_PROBE_FAILED")
            if path == "/account":
                state["redirects"] += 1
                body = (
                    b'<head><link rel="icon" href="data:,"></head><p>Signed in</p>'
                    if not state["echo"]
                    else echoed_document(echo_case)
                )
            elif path == "/login":
                body = HTML
            else:
                raise BrowserRefused("BROWSER_CREDENTIAL_PROBE_FAILED")
            return httpcore.Response(200, headers=[(b"content-type", b"text/html")], content=body)

        async def aclose(self):
            pass

    await broker._pool.aclose()
    broker._pool = Pool()

    descriptor = CredentialDescriptor(
        handle="cred_" + "a" * 32,
        origin=ORIGIN,
        record_revision=1,
        autonomy_policy="autonomous",
        policy_generation=1,
        custody_generation=1,
    )

    class Source:
        async def catalog(self, candidate, origin):
            await authority.check_binding(candidate)
            return (descriptor,)

        @asynccontextmanager
        async def open(self, candidate, selected):
            state["opens"] += 1
            lease = CredentialLease(
                bytearray(b"synthetic-user"),
                bytearray(b"synthetic-private-password"),
                lambda: authority.check_binding(candidate),
                bytearray(b"GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"),
            )
            leases.append(lease)
            try:
                if control.latest_frame is not None:
                    raise BrowserRefused("BROWSER_CREDENTIAL_PROBE_FAILED")
                with_paused = False
                try:
                    await control.require_model_observation()
                except BrowserRefused as exc:
                    with_paused = exc.code == "BROWSER_MODEL_OBSERVATION_PAUSED"
                if not (with_paused):
                    raise BrowserRefused("BROWSER_CREDENTIAL_PROBE_FAILED")
                yield lease
            finally:
                lease.clear()

    driver = PlaywrightExecutor(network=broker, chromium_sandbox=True)
    control = BrowserControl(
        binding=binding,
        readiness=ready,
        executor=driver,
        authority=BrowserExecutionAuthority(binding, authority, journal, policy),
    )
    port = BrowserCredentialUse(control, Source(), authority, allowed_origins=[ORIGIN])
    control.credentials = port
    request = CredentialUseRequest(
        operation_id="credential_probe_first",
        handle=descriptor.handle,
        origin=ORIGIN,
        control_epoch=1,
        targets={
            "username": {"x": 40, "y": 25},
            "password": {"x": 40, "y": 75},
            "otp": {"x": 40, "y": 125},
            "submit": {"x": 40, "y": 175},
        },
    )
    try:
        with patch.object(BrowserType, "launch", installed):
            await control.initialize()
        await control.execute(
            BrowserAction(operation="navigate", sequence=1, control_epoch=1, url=ORIGIN + "/login")
        )
        # Exact selected masked target and form destination are independently
        # refused before source.open; there is no selector or login inference.
        for mutation, restoration in (
            (
                "document.querySelector('[name=password]').type='text'",
                "document.querySelector('[name=password]').type='password'",
            ),
            (
                "document.querySelector('[name=password]').setAttribute('type','text'); Object.defineProperty(document.querySelector('[name=password]'),'type',{get:()=> 'password',configurable:true})",
                "delete document.querySelector('[name=password]').type; document.querySelector('[name=password]').type='password'",
            ),
            (
                "document.querySelector('form').action='https://other.example.com/session'",
                "document.querySelector('form').action='/session'",
            ),
            (
                "document.querySelector('form').method='get'",
                "document.querySelector('form').method='post'",
            ),
        ):
            await driver._page.evaluate(mutation)
            try:
                await driver.verify_credential_targets(request)
            except BrowserRefused:
                pass
            else:
                raise AssertionError("BROWSER_PROBE_TARGET_NEGATIVE_CONTROL_FAILED")
            await driver._page.evaluate(restoration)
        if not (state["opens"] == 0):
            raise BrowserRefused("BROWSER_CREDENTIAL_PROBE_FAILED")
        result = await port.use(request)
        if not (result == {"state": "submitted", "origin": ORIGIN}):
            raise BrowserRefused("BROWSER_CREDENTIAL_PROBE_FAILED")
        if not (
            state["posts"] == 1
            and state["redirects"] == 1
            and not state["reviews"]
            and control.latest_frame is not None
        ):
            raise BrowserRefused("BROWSER_CREDENTIAL_PROBE_FAILED")
        if not (await control.require_model_observation() == 2):
            raise BrowserRefused("BROWSER_CREDENTIAL_PROBE_FAILED")
        if not (all((not any(lease.password) for lease in leases))):
            raise BrowserRefused("BROWSER_CREDENTIAL_PROBE_FAILED")
        from hushh_mcp.services.pod_browser.contracts import BrowserExecutionScope, BrowserRequest

        try:
            await broker.fetch(
                BrowserRequest(
                    url=ORIGIN + "/unrelated-write",
                    method="POST",
                    body=b"synthetic",
                    scope=BrowserExecutionScope(
                        sequence=control.next_sequence,
                        control_epoch=2,
                        actor="agent",
                        deadline_at=time.time() + 10,
                    ),
                )
            )
        except BrowserRefused as exc:
            if exc.code != "BROWSER_OWNER_APPROVAL_REQUIRED":
                raise
        else:
            raise BrowserRefused("BROWSER_CREDENTIAL_PROBE_FAILED")
        if state["reviews"] != ["disclose"]:
            raise BrowserRefused("BROWSER_CREDENTIAL_PROBE_FAILED")
        if manual_control:
            from hushh_mcp.services.pod_browser.playwright_credentials import require_clear_inputs

            for surface in ("closed_shadow", "iframe"):
                await control.take_control()
                await driver._page.evaluate(
                    """surface => {
                    document.body.replaceChildren();
                    const host = document.createElement('div'); document.body.append(host);
                    if (surface === 'closed_shadow') host.attachShadow({mode:'closed'}).textContent='Owner content';
                    else { const frame=document.createElement('iframe');frame.srcdoc='Owner content';host.append(frame); }
                    for (const kind of ['password','otp']) {
                      const field=document.createElement('input');field.id=kind;
                      if (kind === 'password') field.type='password'; else field.autocomplete='one-time-code';
                      document.body.append(field);
                    }
                }""",
                    surface,
                )
                try:
                    await require_clear_inputs(
                        driver._page,
                        cdp=driver._cdp,
                        frame_id=driver._main_frame_id,
                        private_entry=True,
                    )
                except BrowserRefused as exc:
                    if exc.code != "BROWSER_SECRET_OBSERVATION_UNVERIFIABLE":
                        raise
                else:
                    raise AssertionError("BROWSER_PROBE_PRIVATE_SURFACE_REFUSAL_FAILED")
                for kind in ("password", "otp"):
                    await driver._page.evaluate(
                        "kind => document.getElementById(kind).value='synthetic-uncleared'", kind
                    )
                    try:
                        await control.resume_agent()
                    except BrowserRefused as exc:
                        if exc.code != "BROWSER_SECRET_FIELDS_NOT_CLEARED":
                            raise
                    else:
                        raise AssertionError("BROWSER_PROBE_MANUAL_CLEAR_CHECK_FAILED")
                    await driver._page.evaluate(
                        "kind => document.getElementById(kind).value=''", kind
                    )
                await control.resume_agent()
                if await control.require_model_observation() != control.control_epoch:
                    raise BrowserRefused("BROWSER_CREDENTIAL_PROBE_FAILED")
        await control.execute(
            BrowserAction(
                operation="navigate",
                sequence=control.next_sequence,
                control_epoch=control.control_epoch,
                url=ORIGIN + "/login",
            )
        )
        state["echo"] = True
        try:
            await port.use(
                request.model_copy(
                    update={
                        "operation_id": "credential_probe_echo",
                        "control_epoch": control.control_epoch,
                    }
                )
            )
        except BrowserRefused:
            pass
        else:
            raise AssertionError("BROWSER_PROBE_ECHO_NEGATIVE_CONTROL_FAILED")
        if not (control.latest_frame is None and control.control_owner == "uncertain"):
            raise BrowserRefused("BROWSER_CREDENTIAL_PROBE_FAILED")
        if not (
            state["posts"] == 2
            and all((not any(lease.password) and (not any(lease.username)) for lease in leases))
        ):
            raise BrowserRefused("BROWSER_CREDENTIAL_PROBE_FAILED")
        return {
            "installed_browser_entry": "passed",
            "post_submissions": state["posts"],
            "explicit_target_refusals": 4,
            "navigation_cleanup": "passed",
            "model_observation_fence": "passed",
            "dom_echo_refusal": "passed",
            "rendered_echo_case": echo_case,
            "explicit_manual_handback": "passed" if manual_control else "not_run",
            "mutable_buffers_scrubbed": "passed",
            "direct_totp_entry": "passed",
            "autonomous_without_owner_review": "passed",
            "host_observed_auth_redirects": state["redirects"],
            "unrelated_write_still_requires_owner": "passed",
            "untrusted_dom_override_refused": "passed",
            "deployment_qualified": False,
        }
    finally:
        await control.stop()
        await broker.close()
        temporary.cleanup()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--executable", type=Path, required=True)
    args = parser.parse_args()

    async def all_cases():
        results = [
            await probe(args.executable, echo_case=case, manual_control=index == 0)
            for index, case in enumerate(ECHO_CASES)
        ]
        return {
            **results[0],
            "rendered_echo_refusals": [result["rendered_echo_case"] for result in results],
            "post_submissions": sum(result["post_submissions"] for result in results),
            "host_observed_auth_redirects": sum(
                result["host_observed_auth_redirects"] for result in results
            ),
            "limits": [
                "pixel_content_unattested",
                "future_script_mutations_unattested",
                "renderer_heap_zeroization_unattested",
            ],
        }

    try:
        result = asyncio.run(all_cases())
    except BaseException:
        # Browser diagnostics may contain private document state. Fixed code only.
        print(
            json.dumps(
                {"installed_browser_entry": "failed", "code": "BROWSER_CREDENTIAL_PROBE_FAILED"}
            )
        )
        raise SystemExit(1) from None
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
