"""Private bridge decoding for selected credential entry, never an ADK payload."""

from __future__ import annotations

import base64
import json

from .contracts import BrowserBinding, BrowserExecutionScope, BrowserRefused
from .credential_contracts import CredentialLease, CredentialUseRequest


async def worker_fill(executor, payload) -> dict:
    lease = None
    buffers = []
    try:
        binding = BrowserBinding.model_validate(payload["binding"])
        scope = BrowserExecutionScope.model_validate(payload["scope"])
        request = CredentialUseRequest.model_validate_json(json.dumps(payload["request"]))
        values = payload["values"]
        if (
            set(values) != {"username", "password", "totp_secret"}
            or request.control_epoch + 1 != scope.control_epoch
            or scope.deadline_at > binding.expires_at
        ):
            raise BrowserRefused("BROWSER_CREDENTIAL_PAYLOAD_REFUSED")
        for name in ("username", "password", "totp_secret"):
            value = values[name]
            if value is None and name == "totp_secret":
                buffers.append(None)
            elif isinstance(value, str) and 0 < len(value) <= 5500:
                buffers.append(bytearray(base64.b64decode(value, validate=True)))
            else:
                raise BrowserRefused("BROWSER_CREDENTIAL_PAYLOAD_REFUSED")

        async def check():
            scope.remaining()

        lease = CredentialLease(buffers[0], buffers[1], check, buffers[2])
        lease.expected_target = payload["target"]
        return await executor.fill_credentials(request, lease, scope=scope, check=check)
    except (ValueError, TypeError, KeyError):
        raise BrowserRefused("BROWSER_CREDENTIAL_PAYLOAD_REFUSED") from None
    finally:
        if lease is not None:
            lease.clear()
        for value in buffers:
            if isinstance(value, bytearray):
                value[:] = b"\0" * len(value)
        if isinstance(payload.get("values"), dict):
            payload["values"].clear()
