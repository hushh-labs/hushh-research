"""The pod's own workload identity: an access token minted for the pod, as the pod.

Two cloud platforms; credentials are minted by the selected workload:

* **Azure Container Apps.** The platform injects ``IDENTITY_ENDPOINT`` (measured:
  ``http://localhost:12356/msi/token``, not an IMDS address) and ``IDENTITY_HEADER``.
  The pod's user-assigned identity is selected explicitly with ``AZURE_CLIENT_ID``,
  rendered by the hub as deployment topology, so a token is never silently minted
  for some other identity attached to the app.
* **Azure VM qualification.** Startup verifies a root-protected installation
  against fixed-address IMDS before custody. Only that registered installation
  can select its explicit user-assigned identity through the VM token transport.
* **Google Cloud.** The GCE metadata server. Its callers keep their own request
  mechanics; :func:`google_metadata_access_endpoint` is the one seam they ask first, and
  it refuses on Azure so an Azure pod never reaches for ``metadata.google.internal``.

Selection is by what the platform provides, never by a new behaviour flag
(``docs/reference/architecture/byoc-azure.md``, agent environment contract).
"""

from __future__ import annotations

import ipaddress
import re
import threading
import time
import urllib.parse
from dataclasses import dataclass, field
from typing import Any

from hushh_mcp.services.pod_azure_vm_identity import (
    IMDS_IDENTITY_ENDPOINT,
    AzureVmIdentityRefused,
    active_vm_installation,
    imds_json,
)
from hushh_mcp.services.pod_platform import WorkloadPlatform, workload_platform

GCE_METADATA_ACCESS_ENDPOINT = (
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token"
)

_API_VERSION = "2019-08-01"
#: Stop reusing a token this long before the issuer says it dies.
_REFRESH_MARGIN_SECONDS = 300
_TIMEOUT_SECONDS = 10
_MAX_TOKEN_CHARS = 16384
_MAX_HEADER_CHARS = 1024
_RESOURCE = re.compile(r"https://[a-z0-9.-]{1,253}/?")
_CLIENT_ID = re.compile(r"[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}")


class PodWorkloadIdentityUnavailable(RuntimeError):
    """This process has no workload identity of the requested kind, or it refused."""


@dataclass(frozen=True)
class _AzureIdentity:
    endpoint: str
    header: str = field(repr=False)
    client_id: str
    vm: bool = False


@dataclass(frozen=True)
class WorkloadAccessToken:
    token: str = field(repr=False)
    expires_at: float


_cache: dict[tuple[str, str, str], WorkloadAccessToken] = {}
_cache_lock = threading.Lock()


def google_metadata_access_endpoint() -> str:
    """The GCE metadata token address, unless this workload is not Google's."""
    if workload_platform() == "azure":
        raise PodWorkloadIdentityUnavailable("the Google metadata server is not this workload's")
    return GCE_METADATA_ACCESS_ENDPOINT


def _local_endpoint(endpoint: str) -> bool:
    parsed = urllib.parse.urlsplit(endpoint)
    host = parsed.hostname or ""
    if parsed.scheme != "http" or parsed.username or parsed.password:
        return False
    if host == "localhost":
        return True
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return False
    return address.is_loopback or address.is_link_local


def _azure_identity() -> _AzureIdentity:
    import os  # noqa: PLC0415 - read per call; the platform owns these values

    try:
        vm = active_vm_installation()
    except AzureVmIdentityRefused:
        raise PodWorkloadIdentityUnavailable("VM installation identity changed") from None
    if vm is not None:
        return _AzureIdentity(
            endpoint=IMDS_IDENTITY_ENDPOINT, header="", client_id=vm.client_id, vm=True
        )
    endpoint = (os.getenv("IDENTITY_ENDPOINT") or "").strip()
    header = (os.getenv("IDENTITY_HEADER") or "").strip()
    client_id = (os.getenv("AZURE_CLIENT_ID") or "").strip()
    if not endpoint or not header:
        raise PodWorkloadIdentityUnavailable("this process is not an Azure workload")
    if not _local_endpoint(endpoint):
        raise PodWorkloadIdentityUnavailable("the workload identity endpoint is not local")
    if len(header) > _MAX_HEADER_CHARS or any(ord(c) < 33 or ord(c) > 126 for c in header):
        raise PodWorkloadIdentityUnavailable("the workload identity header is malformed")
    if not _CLIENT_ID.fullmatch(client_id):
        raise PodWorkloadIdentityUnavailable("AZURE_CLIENT_ID must name the pod's identity")
    return _AzureIdentity(endpoint=endpoint, header=header, client_id=client_id)


def workload_client_id() -> str:
    """The selected identity from verified VM installation or native ACA input."""
    return _azure_identity().client_id


def _expiry(body: dict[str, Any]) -> float:
    """Epoch seconds the token dies at; 0 when the issuer did not say."""
    raw = body.get("expires_on")
    if isinstance(raw, (str, int)) and str(raw).isdigit():
        return float(raw)
    lifetime = body.get("expires_in")
    if isinstance(lifetime, (str, int)) and str(lifetime).isdigit():
        return time.time() + float(lifetime)
    return 0.0


def _mint(identity: _AzureIdentity, resource: str, session: Any) -> tuple[str, float]:
    try:
        response = session.get(
            identity.endpoint,
            params={
                "api-version": _API_VERSION,
                "resource": resource,
                "client_id": identity.client_id,
            },
            headers={"X-IDENTITY-HEADER": identity.header},
            timeout=_TIMEOUT_SECONDS,
            allow_redirects=False,
        )
    except Exception:  # noqa: BLE001 - transport errors can echo the identity header
        raise PodWorkloadIdentityUnavailable("workload identity endpoint unreachable") from None
    status = getattr(response, "status_code", 0)
    if status != 200:
        raise PodWorkloadIdentityUnavailable(f"workload identity refused ({status})")
    try:
        body = response.json()
    except Exception:  # noqa: BLE001 - a malformed body is a refusal, never a token
        body = None
    token = body.get("access_token") if isinstance(body, dict) else None
    if not isinstance(token, str) or not token.strip() or len(token) > _MAX_TOKEN_CHARS:
        raise PodWorkloadIdentityUnavailable("workload identity returned no usable token")
    issued_to = str(body.get("client_id") or identity.client_id)
    if issued_to.lower() != identity.client_id.lower():
        raise PodWorkloadIdentityUnavailable("workload identity answered for another identity")
    return token, _expiry(body)


def _mint_vm(identity: _AzureIdentity, resource: str) -> tuple[str, float]:
    try:
        body = imds_json(
            IMDS_IDENTITY_ENDPOINT,
            {
                "api-version": "2018-02-01",
                "resource": resource,
                "client_id": identity.client_id,
            },
        )
        token = body.get("access_token")
        expiry = _expiry(body)
        if (
            not isinstance(token, str)
            or not token.strip()
            or len(token) > _MAX_TOKEN_CHARS
            or str(body.get("client_id", identity.client_id)).lower() != identity.client_id.lower()
            or body.get("resource") != resource
            or str(body.get("token_type", "")).lower() != "bearer"
            or expiry <= time.time()
        ):
            raise PodWorkloadIdentityUnavailable("VM identity response refused")
        return token, expiry
    except Exception:
        raise PodWorkloadIdentityUnavailable("VM workload identity unavailable") from None


def get_workload_access_token(resource: str, *, session: Any = None) -> WorkloadAccessToken:
    """Token and issuer expiry for the explicitly selected Azure workload.

    Cached per resource until five minutes before ``expires_on``. The cache guards
    only itself: the mint runs outside the lock, so a slow identity endpoint fails
    concurrent callers in parallel instead of queueing them behind one timeout.
    Raises :class:`PodWorkloadIdentityUnavailable` when not on an Azure workload.
    """
    if not isinstance(resource, str) or not _RESOURCE.fullmatch(resource):
        raise ValueError("resource must be an https origin")
    identity = _azure_identity()
    key = (identity.endpoint, identity.client_id, resource)
    now = time.time()
    with _cache_lock:
        cached = _cache.get(key)
        if cached is not None and now < cached.expires_at - _REFRESH_MARGIN_SECONDS:
            return cached
        _cache.pop(key, None)
    if identity.vm:
        token, expires_on = _mint_vm(identity, resource)
    else:
        token, expires_on = _mint_aca(identity, resource, session)
    issued = WorkloadAccessToken(token=token, expires_at=expires_on)
    refresh_at = expires_on - _REFRESH_MARGIN_SECONDS
    if refresh_at > time.time():
        with _cache_lock:
            _cache[key] = issued
    return issued


def _mint_aca(identity: _AzureIdentity, resource: str, session: Any) -> tuple[str, float]:
    if session is None:
        import requests  # type: ignore[import-untyped]  # noqa: PLC0415

        session = requests
    return _mint(identity, resource, session)


def get_workload_token(resource: str, *, session: Any = None) -> str:
    """Existing string-only interface; token custody and refresh stay shared."""
    return get_workload_access_token(resource, session=session).token


def forget_workload_token(resource: str) -> None:
    """Drop cached tokens for ``resource`` so the next call mints afresh."""
    with _cache_lock:
        for key in [key for key in _cache if key[2] == resource]:
            del _cache[key]


__all__ = [
    "GCE_METADATA_ACCESS_ENDPOINT",
    "PodWorkloadIdentityUnavailable",
    "WorkloadPlatform",
    "WorkloadAccessToken",
    "forget_workload_token",
    "get_workload_token",
    "get_workload_access_token",
    "google_metadata_access_endpoint",
    "workload_platform",
]
