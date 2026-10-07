"""Synthetic native SandboxGroups qualification; never an owner browser launcher.

Wire contract: Microsoft's azure-containerapps-sandbox 0.1.0b4, dataplane
2026-02-01-preview. No SDK dependency, exec/files bridge, snapshots, suspension,
provider key in a sandbox, or fallback executor. Policy readback is configuration
evidence; it does not prove network isolation or an ephemeral private bridge.

Primary contracts:
https://learn.microsoft.com/en-us/azure/container-apps/sandboxes-quickstart-python-sdk
https://learn.microsoft.com/en-us/azure/container-apps/sandboxes-egress-policies
https://pypi.org/project/azure-containerapps-sandbox/0.1.0b4/
"""

from __future__ import annotations

import asyncio
import json
import re
import time
import uuid
from dataclasses import dataclass, field
from typing import Literal, Protocol

import httpx
from pydantic import Field

from .contracts import BrowserAction, BrowserFrame, BrowserRefused, StrictContract

API_VERSION = "2026-02-01-preview"
DATA_PLANE_SCOPE = "https://dynamicsessions.io/.default"
_MARKER = "hushh-azure-native-synthetic-v1\n"
_COMMAND = "printf '%s\\n' 'hushh-azure-native-synthetic-v1'"
_SEGMENT = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_MAX_RESPONSE = 65536


class AzureProbeConfig(StrictContract):
    # Trusted operator configuration, never a model/request-selected endpoint.
    subscription_id: str = Field(pattern=r"^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$")
    resource_group: str = Field(pattern=r"^[A-Za-z0-9_-]{1,90}$")
    sandbox_group: str = Field(pattern=r"^[A-Za-z0-9_-]{1,63}$")
    region: str = Field(pattern=r"^[a-z][a-z0-9]{1,31}$")
    timeout_seconds: int = Field(default=60, ge=1, le=120)


@dataclass(frozen=True)
class AzureAccessToken:
    token: str = field(repr=False)
    expires_at: int


class AzureCredentialPort(Protocol):
    async def get_token(self, scope: str) -> AzureAccessToken: ...


class AzureCliCredential:
    """Existing operator CLI identity. Captures tokens only in host memory."""

    def __init__(self, subscription_id: str) -> None:
        # Share the configuration validator instead of accepting CLI options.
        AzureProbeConfig(
            subscription_id=subscription_id,
            resource_group="probe",
            sandbox_group="probe",
            region="eastus2",
        )
        self._subscription_id = subscription_id

    async def get_token(self, scope: str) -> AzureAccessToken:
        if scope != DATA_PLANE_SCOPE:
            raise BrowserRefused("AZURE_PROBE_AUTH_REFUSED")
        try:
            process = await asyncio.create_subprocess_exec(
                "az",
                "account",
                "get-access-token",
                "--subscription",
                self._subscription_id,
                "--scope",
                scope,
                "--output",
                "json",
                "--only-show-errors",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
            try:
                stdout, _ = await asyncio.wait_for(process.communicate(), timeout=10)
            except BaseException:
                if process.returncode is None:
                    process.kill()
                await process.wait()
                raise
            if process.returncode or len(stdout) > _MAX_RESPONSE:
                raise BrowserRefused("AZURE_PROBE_AUTH_REFUSED")
            value = json.loads(stdout)
            token = value["accessToken"]
            expires_at = int(value["expires_on"])
            if not isinstance(token, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,16384}", token):
                raise BrowserRefused("AZURE_PROBE_AUTH_REFUSED")
            return AzureAccessToken(token=token, expires_at=expires_at)
        except asyncio.CancelledError:
            raise
        except Exception:
            raise BrowserRefused("AZURE_PROBE_AUTH_REFUSED") from None


JSONType = Literal["absent", "null", "boolean", "number", "string", "array", "object"]
PolicyField = Literal["defaultAction", "trafficInspection", "hostRules", "rules"]


class AzurePolicyRefusalDiagnostics(StrictContract):
    # Fixed provenance and enums only; unknown field names/values are never exported.
    operation: Literal["initial_policy_readback", "post_execution_policy_readback"]
    method: Literal["GET"] = "GET"
    http_status: Literal[200] = 200
    policy_type: JSONType
    known_field_types: dict[PolicyField, JSONType]
    unknown_field_count: int = Field(ge=0)
    default_action: Literal["Allow", "Deny", "absent", "unknown"]
    traffic_inspection: Literal["Full", "Partial", "None", "Legacy", "absent", "unknown"]
    host_rule_count: int | None = Field(ge=0)
    rule_count: int | None = Field(ge=0)
    skip_egress_proxy: Literal["absent", "false", "true", "unknown"]
    customer_vnet_connection_present: bool


class AzureNativeQualification(StrictContract):
    probe_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    sandbox_id: str | None = Field(default=None, pattern=r"^[A-Za-z0-9_-]{1,128}$")
    api_version: Literal["2026-02-01-preview"] = API_VERSION
    policy_verified: bool = False
    synthetic_execution_verified: bool = False
    termination_confirmed: bool = False
    # This probe cannot issue a BrowserReadiness receipt.
    private_bridge_verified: Literal[False] = False
    code: str = Field(pattern=r"^[A-Z0-9_]{1,128}$")
    failure_code: str | None = Field(default=None, pattern=r"^[A-Z0-9_]{1,128}$")
    refusal_diagnostics: AzurePolicyRefusalDiagnostics | None = None


class UnqualifiedAzureBrowserExecutor:
    """Existing BrowserExecutionPort shape, explicitly unavailable.

    Native exec stdout and filesystem APIs are not a verified memory-only task
    channel. Owner actions, frames and remembered state must never use them.
    This is not instantiated as a default launcher.
    """

    async def initialize(self) -> None:
        raise BrowserRefused("AZURE_BROWSER_BRIDGE_UNSUPPORTED")

    async def execute(self, action: BrowserAction) -> BrowserFrame:
        raise BrowserRefused("AZURE_BROWSER_BRIDGE_UNSUPPORTED")

    async def close(self) -> None:
        pass


def _unique_object(pairs: list[tuple[str, object]]) -> dict:
    result = {}
    for key, value in pairs:
        if key in result:
            raise BrowserRefused("AZURE_PROBE_RESPONSE_REFUSED")
        result[key] = value
    return result


def _json_type(value: object, *, present: bool = True) -> JSONType:
    if not present:
        return "absent"
    if value is None:
        return "null"
    return {
        bool: "boolean",
        int: "number",
        float: "number",
        str: "string",
        list: "array",
        dict: "object",
    }[type(value)]


class _NativeClient:
    def __init__(
        self, config: AzureProbeConfig, credential: AzureCredentialPort, client: httpx.AsyncClient
    ) -> None:
        self.config, self.credential, self.client = config, credential, client
        self.endpoint = f"https://management.{config.region}.azuredevcompute.io"
        self.path = (
            f"/subscriptions/{config.subscription_id}/resourceGroups/{config.resource_group}"
            f"/sandboxGroups/{config.sandbox_group}/sandboxes"
        )
        self.probe_id = uuid.uuid4().hex
        self.sandbox_id: str | None = None
        self.create_attempted = False
        self.policy_read_count = 0
        self.refusal_diagnostics: AzurePolicyRefusalDiagnostics | None = None

    async def request(
        self, method: str, suffix: str = "", *, body: dict | None = None, labels: bool = False
    ) -> tuple[int, object]:
        try:
            credential = await self.credential.get_token(DATA_PLANE_SCOPE)
            if (
                type(credential.expires_at) is not int
                or credential.expires_at <= time.time() + 30
                or not re.fullmatch(r"[A-Za-z0-9_.-]{1,16384}", credential.token)
            ):
                raise BrowserRefused("AZURE_PROBE_AUTH_REFUSED")
            params = {"api-version": API_VERSION}
            if labels:
                params["labels"] = f"hushhProbe={self.probe_id}"
            if method == "PUT" and not suffix:
                self.create_attempted = True
            async with self.client.stream(
                method,
                self.endpoint + self.path + suffix,
                params=params,
                json=body,
                headers={
                    "Authorization": f"Bearer {credential.token}",
                    "Accept-Encoding": "identity",
                },
            ) as response:
                # No redirects, provider diagnostics, or arbitrary continuation URLs.
                if response.status_code in {401, 403}:
                    raise BrowserRefused("AZURE_PROBE_AUTH_REFUSED")
                if response.status_code not in {200, 201, 202, 204, 404}:
                    raise BrowserRefused("AZURE_PROBE_RESPONSE_REFUSED")
                if response.headers.get("content-encoding", "identity") != "identity":
                    raise BrowserRefused("AZURE_PROBE_RESPONSE_REFUSED")
                chunks = bytearray()
                async for chunk in response.aiter_bytes():
                    if len(chunks) + len(chunk) > _MAX_RESPONSE:
                        raise BrowserRefused("AZURE_PROBE_RESPONSE_REFUSED")
                    chunks.extend(chunk)
                if response.status_code in {204, 404} or not chunks:
                    return response.status_code, None
                return response.status_code, json.loads(chunks, object_pairs_hook=_unique_object)
        except BrowserRefused:
            raise
        except Exception:
            raise BrowserRefused("AZURE_PROBE_TRANSPORT_UNCERTAIN") from None

    def owned_id(self, value: object) -> str:
        if (
            not isinstance(value, dict)
            or value.get("labels") != {"hushhProbe": self.probe_id}
            or not isinstance(value.get("id"), str)
            or not _SEGMENT.fullmatch(value["id"])
        ):
            raise BrowserRefused("AZURE_PROBE_RESOURCE_BINDING_REFUSED")
        return value["id"]

    def policy_refused(self, code: str, value: dict) -> None:
        policy = value.get("egressPolicy")
        fields = policy if isinstance(policy, dict) else {}
        names = ("defaultAction", "trafficInspection", "hostRules", "rules")
        default = fields.get("defaultAction")
        inspection = fields.get("trafficInspection")
        skip = value.get("skipEgressProxy")
        self.refusal_diagnostics = AzurePolicyRefusalDiagnostics(
            operation="initial_policy_readback"
            if self.policy_read_count == 1
            else "post_execution_policy_readback",
            policy_type=_json_type(policy, present="egressPolicy" in value),
            known_field_types={key: _json_type(fields[key]) for key in names if key in fields},
            unknown_field_count=sum(key not in names for key in fields),
            default_action=default
            if isinstance(default, str) and default in ("Allow", "Deny")
            else "absent"
            if "defaultAction" not in fields
            else "unknown",
            traffic_inspection=inspection
            if isinstance(inspection, str) and inspection in ("Full", "Partial", "None", "Legacy")
            else "absent"
            if "trafficInspection" not in fields
            else "unknown",
            host_rule_count=len(fields["hostRules"])
            if isinstance(fields.get("hostRules"), list)
            else None,
            rule_count=len(fields["rules"]) if isinstance(fields.get("rules"), list) else None,
            skip_egress_proxy="absent"
            if "skipEgressProxy" not in value
            else "false"
            if skip is False
            else "true"
            if skip is True
            else "unknown",
            customer_vnet_connection_present="customerVnetConnectionName" in value,
        )
        raise BrowserRefused(code)

    def verify_policy(self, value: dict) -> None:
        self.policy_read_count += 1
        if self.owned_id(value) != self.sandbox_id:
            raise BrowserRefused("AZURE_PROBE_RESOURCE_BINDING_REFUSED")
        policy = value.get("egressPolicy")
        if not isinstance(policy, dict) or {
            key: item
            for key, item in policy.items()
            if key not in {"hostRules", "rules"} or item != []
        } != {"defaultAction": "Deny", "trafficInspection": "Full"}:
            self.policy_refused("AZURE_PROBE_EGRESS_REFUSED", value)
        lifecycle = value.get("lifecycle")
        if (
            lifecycle != {"autoSuspendPolicy": {"enabled": False}}
            or lifecycle["autoSuspendPolicy"]["enabled"] is not False
        ):
            self.policy_refused("AZURE_PROBE_SUSPENSION_REFUSED", value)
        # No inherited secrets, volumes, exposed ports or alternate networking.
        for name in ("environment", "ports", "connections", "volumes"):
            item = value.get(name, {} if name == "environment" else [])
            if type(item) is not (dict if name == "environment" else list) or item:
                self.policy_refused("AZURE_PROBE_PRIVATE_RESOURCES_REFUSED", value)
        if value.get("skipEgressProxy", False) is not False or value.get(
            "customerVnetConnectionName"
        ):
            self.policy_refused("AZURE_PROBE_EGRESS_REFUSED", value)
        if (
            value.get("sourcesRef") != {"diskImage": {"name": "ubuntu", "isPublic": True}}
            or value["sourcesRef"]["diskImage"]["isPublic"] is not True
        ):
            self.policy_refused("AZURE_PROBE_IMAGE_REFUSED", value)

    def qualification_receipt(
        self, *, policy_verified: bool, execution_verified: bool, termination: bool, code: str
    ) -> AzureNativeQualification:
        return AzureNativeQualification(
            probe_id=self.probe_id,
            sandbox_id=self.sandbox_id,
            policy_verified=policy_verified,
            synthetic_execution_verified=execution_verified,
            termination_confirmed=termination,
            code=code if termination else "AZURE_PROBE_STOP_UNCONFIRMED",
            failure_code=code if not termination else None,
            refusal_diagnostics=self.refusal_diagnostics,
        )

    async def terminate(self) -> bool:
        if not self.create_attempted:
            return True
        try:
            async with asyncio.timeout(15):
                if self.sandbox_id is None:
                    status, inventory = await self.request("GET", labels=True)
                    if status != 200:
                        return False
                    if isinstance(inventory, dict):
                        if inventory.get("nextLink"):
                            return False
                        inventory = inventory.get("value")
                    if not isinstance(inventory, list) or len(inventory) != 1:
                        # Empty eventual inventory cannot prove no late creation.
                        return False
                    self.sandbox_id = self.owned_id(inventory[0])
                suffix = f"/{self.sandbox_id}"
                try:
                    status, _ = await self.request("DELETE", suffix)
                    if status == 404:
                        return True
                except BrowserRefused:
                    # A lost DELETE reply is resolved only by terminal GET404,
                    # not by replaying an effect or assuming a response arrived.
                    pass
                # DELETE is out of band; POST /stop would capture/suspend state.
                while True:
                    status, _ = await self.request("GET", suffix)
                    if status == 404:
                        return True
                    await asyncio.sleep(0.25)
        except Exception:
            return False


async def qualify_azure_sandbox(
    config: AzureProbeConfig,
    *,
    credential: AzureCredentialPort,
    transport: httpx.AsyncBaseTransport | None = None,
) -> AzureNativeQualification:
    """Explicit operator-invoked cloud mutation, restricted to synthetic content.

    Assumes an already-created native SandboxGroup and its Data Owner role.
    Does not create groups/roles, install software, submit real tasks, or retry
    uncertain creation/execution. Cleanup selects only this random probe label.
    ``transport`` is a trusted testing seam, never an ingress request field.
    """
    async with httpx.AsyncClient(
        timeout=10,
        follow_redirects=False,
        trust_env=False,
        transport=transport,
        limits=httpx.Limits(max_connections=1),
    ) as client:
        native = _NativeClient(config, credential, client)
        policy_verified = execution_verified = cancelled = False
        code = "AZURE_BROWSER_BRIDGE_UNSUPPORTED"
        try:
            async with asyncio.timeout(config.timeout_seconds):
                status, value = await native.request(
                    "PUT",
                    body={
                        "sourcesRef": {"diskImage": {"name": "ubuntu", "isPublic": True}},
                        "resources": {"cpu": "1000m", "memory": "2048Mi"},
                        "labels": {"hushhProbe": native.probe_id},
                        "lifecycle": {"autoSuspendPolicy": {"enabled": False}},
                        "egressPolicy": {"defaultAction": "Deny", "trafficInspection": "Full"},
                        "skipEgressProxy": False,
                    },
                )
                if status not in {200, 201, 202}:
                    raise BrowserRefused("AZURE_PROBE_CREATE_UNCERTAIN")
                native.sandbox_id = native.owned_id(value)
                suffix = f"/{native.sandbox_id}"
                while True:
                    status, value = await native.request("GET", suffix)
                    if status != 200 or not isinstance(value, dict):
                        raise BrowserRefused("AZURE_PROBE_RESOURCE_BINDING_REFUSED")
                    if native.owned_id(value) != native.sandbox_id:
                        raise BrowserRefused("AZURE_PROBE_RESOURCE_BINDING_REFUSED")
                    if value.get("state") == "Running":
                        break
                    if value.get("state") != "Creating":
                        raise BrowserRefused("AZURE_PROBE_STATE_REFUSED")
                    await asyncio.sleep(0.25)
                native.verify_policy(value)
                policy_verified = True
                status, result = await native.request(
                    "POST", suffix + "/executeShellCommand", body={"command": _COMMAND}
                )
                if (
                    status != 200
                    or not isinstance(result, dict)
                    or set(result) != {"exitCode", "stdout", "stderr"}
                    or type(result["exitCode"]) is not int
                    or result["exitCode"] != 0
                    or result["stdout"] != _MARKER
                    or result["stderr"] != ""
                ):
                    raise BrowserRefused("AZURE_PROBE_EXECUTION_REFUSED")
                status, value = await native.request("GET", suffix)
                if status != 200 or not isinstance(value, dict) or value.get("state") != "Running":
                    raise BrowserRefused("AZURE_PROBE_STATE_REFUSED")
                native.verify_policy(value)
                execution_verified = True
        except asyncio.CancelledError:
            cancelled = True
        except BrowserRefused as exc:
            code = exc.code
        except TimeoutError:
            code = "AZURE_PROBE_TRANSPORT_UNCERTAIN"
        finally:
            try:
                termination = await native.terminate()
            except asyncio.CancelledError:
                raise BrowserRefused("AZURE_PROBE_STOP_UNCONFIRMED") from None
        if cancelled:
            if not termination:
                raise BrowserRefused("AZURE_PROBE_STOP_UNCONFIRMED")
            raise asyncio.CancelledError
        return native.qualification_receipt(
            policy_verified=policy_verified,
            execution_verified=execution_verified,
            termination=termination,
            code=code,
        )
