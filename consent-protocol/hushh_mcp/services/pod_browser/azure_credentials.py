"""Explicit operator or owner-workload credentials for native Azure sandboxes.

Tokens remain in controller memory. No interactive/personal identity fallback is
permitted for a workload; admission uses the expiry returned by the issuer.
"""

from __future__ import annotations

import asyncio
import json
import re
from dataclasses import dataclass, field
from typing import Protocol

from .contracts import BrowserRefused

DATA_PLANE_SCOPE = "https://management.azuredevcompute.io/.default"
_MAX_RESPONSE = 65536


@dataclass(frozen=True)
class AzureAccessToken:
    token: str = field(repr=False)
    expires_at: int


class AzureCredentialPort(Protocol):
    async def get_token(self, scope: str) -> AzureAccessToken: ...


class AzureWorkloadCredential:
    """Native sandbox access as the explicitly configured owner workload.

    Personal CLI authorization is never a fallback. Reuse the platform-token
    owner, including its real issuer expiry and per-resource refresh cache.
    """

    def __init__(self, client_id: str) -> None:
        if not re.fullmatch(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}", client_id):
            raise BrowserRefused("AZURE_PROBE_AUTH_REFUSED")
        self._client_id = client_id

    async def get_token(self, scope: str) -> AzureAccessToken:
        from hushh_mcp.services.pod_workload_identity import (
            get_workload_access_token,
            workload_client_id,
        )

        if scope != DATA_PLANE_SCOPE:
            raise BrowserRefused("AZURE_PROBE_AUTH_REFUSED")
        try:
            if workload_client_id() != self._client_id:
                raise BrowserRefused("AZURE_PROBE_AUTH_REFUSED")
            access = await asyncio.to_thread(
                get_workload_access_token, "https://management.azuredevcompute.io/"
            )
            if workload_client_id() != self._client_id:
                raise BrowserRefused("AZURE_PROBE_AUTH_REFUSED")
            return AzureAccessToken(token=access.token, expires_at=int(access.expires_at))
        except asyncio.CancelledError:
            raise
        except Exception:
            raise BrowserRefused("AZURE_PROBE_AUTH_REFUSED") from None


class AzureCliCredential:
    """Existing operator CLI identity. Captures tokens only in host memory."""

    def __init__(self, subscription_id: str) -> None:
        if not re.fullmatch(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}", subscription_id):
            raise BrowserRefused("AZURE_PROBE_AUTH_REFUSED")
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
