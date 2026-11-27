"""Ciphertext-only host bridge; ephemeral Browser worker performs the unwrap."""

from __future__ import annotations

from .contracts import BrowserBinding, BrowserExecutionScope, BrowserRefused
from .credential_contracts import CredentialUseRequest
from .credential_transient import open_worker_lease


async def worker_fill(executor, payload, *, keys) -> dict:
    binding = BrowserBinding.model_validate(payload["binding"])
    scope = BrowserExecutionScope.model_validate(payload["scope"])
    request = CredentialUseRequest.model_validate(payload["request"])
    if request.control_epoch + 1 != scope.control_epoch or scope.deadline_at > binding.expires_at:
        raise BrowserRefused("BROWSER_CREDENTIAL_PAYLOAD_REFUSED")

    async def check():
        scope.remaining()

    async with open_worker_lease(keys, binding, request, payload["envelope"], check=check) as lease:
        lease.expected_target = payload["target"]
        return await executor.fill_credentials(request, lease, scope=scope, check=check)
