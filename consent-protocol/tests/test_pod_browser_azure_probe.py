"""Native Azure policy, payload custody and uncertain termination boundaries."""

from __future__ import annotations

import asyncio
import copy
import json
import time

import httpx
import pytest
from pydantic import ValidationError

from hushh_mcp.services.pod_browser import azure_probe as probe
from hushh_mcp.services.pod_browser.contracts import BrowserAction, BrowserRefused

_AUTH_MARKER = "synthetic.host.only.token"


def config(**overrides):
    return probe.AzureProbeConfig(
        subscription_id="11111111-1111-1111-1111-111111111111",
        resource_group="synthetic-rg",
        sandbox_group="synthetic-group",
        region="eastus2",
        **overrides,
    )


class Credential:
    def __init__(self, *, expired=False):
        self.scopes = []
        self.expired = expired

    async def get_token(self, scope):
        self.scopes.append(scope)
        return probe.AzureAccessToken(
            token=_AUTH_MARKER,
            expires_at=int(time.time()) + (-1 if self.expired else 3600),
        )


class NativeAPI:
    def __init__(self, *, change=None, lose=None, inventory=None, exec_response=None):
        self.change, self.lose, self.inventory = change, lose, inventory
        self.exec_response = exec_response
        self.requests = []
        self.document = None
        self.deleted = False
        self.exec_started = asyncio.Event()
        self.hold_exec = False
        self.gets = 0

    async def __call__(self, request):
        self.requests.append(request)
        path = request.url.path
        if request.method == "PUT":
            self.document = {**json.loads(request.content), "id": "synthetic-1", "state": "Running"}
            if self.lose == "create":
                raise httpx.ReadError("synthetic lost response")
            return httpx.Response(201, json=self.document)
        if request.method == "DELETE":
            assert path.endswith("/synthetic-1")
            self.deleted = True
            if self.lose == "delete":
                raise httpx.ReadError("synthetic lost delete response")
            return httpx.Response(202)
        if request.method == "GET" and path.endswith("/sandboxes"):
            assert (
                request.url.params["labels"]
                == "hushhProbe=" + self.document["labels"]["hushhProbe"]
            )
            return httpx.Response(
                200,
                json=self.inventory if self.inventory is not None else {"value": [self.document]},
            )
        if request.method == "GET":
            if self.deleted:
                return httpx.Response(404)
            self.gets += 1
            value = copy.deepcopy(self.document)
            if self.change:
                self.change(value, self.gets)
            return httpx.Response(200, json=value)
        if request.method == "POST":
            assert path.endswith("/executeShellCommand")
            assert json.loads(request.content) == {"command": probe._COMMAND}
            self.exec_started.set()
            if self.hold_exec:
                await asyncio.Future()
            if self.lose == "exec":
                raise httpx.ReadError("synthetic lost execution response")
            return httpx.Response(
                200,
                json=self.exec_response
                if self.exec_response is not None
                else {"exitCode": 0, "stdout": probe._MARKER, "stderr": ""},
            )
        raise AssertionError("Unexpected native request")


async def run(api, **kwargs):
    return await probe.qualify_azure_sandbox(
        config(), credential=Credential(), transport=httpx.MockTransport(api), **kwargs
    )


@pytest.mark.asyncio
async def test_native_qualification_is_synthetic_metadata_and_not_browser_readiness():
    api, credential = NativeAPI(), Credential()
    result = await probe.qualify_azure_sandbox(
        config(), credential=credential, transport=httpx.MockTransport(api)
    )
    assert result.policy_verified and result.synthetic_execution_verified
    assert result.termination_confirmed and not result.private_bridge_verified
    assert result.code == "AZURE_BROWSER_BRIDGE_UNSUPPORTED"
    assert set(credential.scopes) == {"https://dynamicsessions.io/.default"}
    for request in api.requests:
        assert request.url.host == "management.eastus2.azuredevcompute.io"
        assert request.url.params["api-version"] == "2026-02-01-preview"
        assert "/providers/" not in request.url.path
        assert request.headers["Authorization"] == "Bearer synthetic.host.only.token"
        assert b"synthetic.host.only.token" not in request.content
        assert not any(
            word in request.url.path
            for word in ("snapshot", "/stop", "/commit", "/resume", "/files")
        )
    assert api.document["egressPolicy"] == {"defaultAction": "Deny", "trafficInspection": "Full"}
    assert api.document["lifecycle"] == {"autoSuspendPolicy": {"enabled": False}}
    assert not any(
        key in api.document for key in ("environment", "volumes", "ports", "connections")
    )
    assert "synthetic.host.only.token" not in result.model_dump_json()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "policy",
    [
        None,
        {"defaultAction": "Allow", "trafficInspection": "Full"},
        {"defaultAction": "Deny", "trafficInspection": "Partial"},
        {"defaultAction": "Deny", "trafficInspection": "None"},
        {
            "defaultAction": "Deny",
            "trafficInspection": "Full",
            "hostRules": [{"pattern": "*", "action": "Allow"}],
        },
        {
            "defaultAction": "Deny",
            "trafficInspection": "Full",
            "rules": [{"action": {"type": "Rewrite"}}],
        },
        {"defaultAction": "Deny", "trafficInspection": "Full", "unknownBypass": True},
    ],
)
async def test_permissive_or_missing_readback_never_reaches_native_execution(policy):
    api = NativeAPI(change=lambda value, _: value.update(egressPolicy=policy))
    result = await run(api)
    assert result.code == "AZURE_PROBE_EGRESS_REFUSED"
    assert result.termination_confirmed and not result.synthetic_execution_verified
    assert not api.exec_started.is_set()


@pytest.mark.asyncio
async def test_egress_regression_has_a_negative_control(monkeypatch):
    def change(value, _):
        value["egressPolicy"].update(defaultAction="Allow")

    result = await run(NativeAPI(change=change))
    assert not result.synthetic_execution_verified
    # Removing the real admission gate makes the same insecure readback execute.
    monkeypatch.setattr(probe._NativeClient, "verify_policy", lambda *_: None)
    broken = await run(NativeAPI(change=change))
    assert broken.synthetic_execution_verified


@pytest.mark.asyncio
async def test_policy_drift_after_synthetic_execution_cannot_issue_qualification():
    def drift(value, reads):
        if reads > 1:
            value["egressPolicy"]["trafficInspection"] = "Partial"

    api = NativeAPI(change=drift)
    result = await run(api)
    assert api.exec_started.is_set()
    assert result.code == "AZURE_PROBE_EGRESS_REFUSED"
    assert not result.synthetic_execution_verified and result.termination_confirmed


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "change,code",
    [
        (
            lambda d, _: d.update(
                lifecycle={
                    "autoSuspendPolicy": {"enabled": True, "mode": "Memory", "interval": 300}
                }
            ),
            "AZURE_PROBE_SUSPENSION_REFUSED",
        ),
        (
            lambda d, _: d.update(lifecycle={"autoSuspendPolicy": {"enabled": 0}}),
            "AZURE_PROBE_SUSPENSION_REFUSED",
        ),
        (
            lambda d, _: d.update(environment={"CORE_KEY": "synthetic"}),
            "AZURE_PROBE_PRIVATE_RESOURCES_REFUSED",
        ),
        (
            lambda d, _: d.update(environment=None),
            "AZURE_PROBE_PRIVATE_RESOURCES_REFUSED",
        ),
        (
            lambda d, _: d.update(ports=[{"port": 8080, "auth": {"anonymous": True}}]),
            "AZURE_PROBE_PRIVATE_RESOURCES_REFUSED",
        ),
        (
            lambda d, _: d.update(volumes=[{"mountPath": "/recovery"}]),
            "AZURE_PROBE_PRIVATE_RESOURCES_REFUSED",
        ),
        (lambda d, _: d.update(skipEgressProxy=True), "AZURE_PROBE_EGRESS_REFUSED"),
        (
            lambda d, _: d.update(sourcesRef={"snapshot": {"id": "old-state"}}),
            "AZURE_PROBE_IMAGE_REFUSED",
        ),
        (
            lambda d, _: d.update(labels={"hushhProbe": "other-task"}),
            "AZURE_PROBE_RESOURCE_BINDING_REFUSED",
        ),
    ],
)
async def test_non_ephemeral_or_cross_task_readback_is_refused(change, code):
    api = NativeAPI(change=change)
    result = await run(api)
    assert result.code == code and result.termination_confirmed
    assert not api.exec_started.is_set()


@pytest.mark.asyncio
@pytest.mark.parametrize("lost", ["create", "exec"])
async def test_lost_effect_response_is_not_replayed_and_task_owned_resource_is_deleted(lost):
    api = NativeAPI(lose=lost)
    result = await run(api)
    assert result.code == "AZURE_PROBE_TRANSPORT_UNCERTAIN"
    assert not result.synthetic_execution_verified and result.termination_confirmed
    assert sum(r.method == "PUT" for r in api.requests) == 1
    assert sum(r.method == "POST" for r in api.requests) == (1 if lost == "exec" else 0)
    assert sum(r.method == "DELETE" for r in api.requests) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "inventory", [{"value": []}, {"value": [], "nextLink": "https://other.invalid/credentials"}]
)
async def test_uncertain_create_with_incomplete_inventory_never_claims_termination(inventory):
    api = NativeAPI(lose="create", inventory=inventory)
    result = await run(api)
    assert result.code == "AZURE_PROBE_STOP_UNCONFIRMED" and not result.termination_confirmed
    assert not any(r.method == "DELETE" or r.url.host == "other.invalid" for r in api.requests)


@pytest.mark.asyncio
async def test_lost_delete_response_requires_terminal_readback_without_replay():
    api = NativeAPI(lose="delete")
    result = await run(api)
    assert result.termination_confirmed
    assert sum(r.method == "DELETE" for r in api.requests) == 1
    assert api.requests[-1].method == "GET"


@pytest.mark.asyncio
async def test_unconfirmed_delete_is_not_reported_as_cleanup():
    api = NativeAPI(lose="delete")

    async def deny_readback(request):
        if api.deleted and request.method == "GET":
            return httpx.Response(403)
        return await api(request)

    result = await probe.qualify_azure_sandbox(
        config(), credential=Credential(), transport=httpx.MockTransport(deny_readback)
    )
    assert result.code == "AZURE_PROBE_STOP_UNCONFIRMED"
    assert not result.termination_confirmed
    assert result.failure_code == "AZURE_BROWSER_BRIDGE_UNSUPPORTED"


@pytest.mark.asyncio
async def test_auth_expiry_refuses_before_any_cloud_dispatch():
    api = NativeAPI()
    result = await probe.qualify_azure_sandbox(
        config(), credential=Credential(expired=True), transport=httpx.MockTransport(api)
    )
    assert result.code == "AZURE_PROBE_AUTH_REFUSED" and result.termination_confirmed
    assert not api.requests


@pytest.mark.asyncio
async def test_redirect_does_not_forward_host_bearer_to_another_origin():
    requests = []

    async def redirect(request):
        requests.append(request)
        return httpx.Response(302, headers={"Location": "https://other.invalid/credentials"})

    result = await probe.qualify_azure_sandbox(
        config(), credential=Credential(), transport=httpx.MockTransport(redirect)
    )
    assert not result.synthetic_execution_verified
    assert all(r.url.host == "management.eastus2.azuredevcompute.io" for r in requests)


@pytest.mark.asyncio
async def test_duplicate_or_oversized_provider_json_never_enters_execution():
    for payload in (b'{"id":"first","id":"last"}', b"x" * 65537):
        calls = []

        async def respond(request, calls=calls, payload=payload):
            calls.append(request)
            return httpx.Response(200, content=payload)

        result = await probe.qualify_azure_sandbox(
            config(), credential=Credential(), transport=httpx.MockTransport(respond)
        )
        assert not result.synthetic_execution_verified and not result.termination_confirmed
        assert not any(r.method == "POST" for r in calls)


@pytest.mark.asyncio
async def test_cancel_stops_native_resource_before_acknowledging_cancellation():
    api = NativeAPI()
    api.hold_exec = True
    task = asyncio.create_task(run(api))
    await asyncio.wait_for(api.exec_started.wait(), timeout=2)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert api.deleted
    assert api.requests[-1].method == "GET"


@pytest.mark.asyncio
async def test_owner_execution_port_refuses_private_payloads_without_native_bridge():
    executor = probe.UnqualifiedAzureBrowserExecutor()
    action = BrowserAction(
        operation="type", sequence=1, control_epoch=1, x=1, y=1, text="synthetic-private-field"
    )
    for invocation in (executor.initialize(), executor.execute(action)):
        with pytest.raises(BrowserRefused, match="^AZURE_BROWSER_BRIDGE_UNSUPPORTED$"):
            await invocation
    await executor.close()


def test_operator_config_cannot_choose_an_arbitrary_credential_endpoint():
    with pytest.raises(ValidationError):
        probe.AzureProbeConfig.model_validate(
            {**config().model_dump(), "region": "eastus2/../../other.invalid"}
        )
    with pytest.raises(ValidationError):
        probe.AzureProbeConfig.model_validate(
            {**config().model_dump(), "endpoint": "https://other.invalid"}
        )
