"""Synthetic Drive 403 reason classification and retry contract."""

# ruff: noqa: S106 -- synthetic bearer values only.

import json

import httpx
import pytest

from hushh_mcp.services import google_drive_adapter as drive


@pytest.fixture
def adapter():
    return drive.GoogleDriveAdapter()


@pytest.mark.parametrize("operation", ["file", "list"])
@pytest.mark.parametrize(
    "reason,retryable,provider_reason",
    [
        ("rateLimitExceeded", True, None),
        ("userRateLimitExceeded", True, None),
        ("insufficientFilePermissions", False, "resource_denied"),
        ("SERVICE_DISABLED", False, "provider_configuration"),
        ("accessNotConfigured", False, "provider_configuration"),
        ("ORG_RESTRICTION", False, "provider_policy"),
    ],
)
async def test_rest_403_rate_limits_are_retryable_without_marking_sources_unavailable(
    adapter, monkeypatch, operation, reason, retryable, provider_reason
):
    original = httpx.AsyncClient
    requests = []

    def handler(request):
        requests.append(request)
        body = {"error": {"code": 403, "errors": [{"reason": reason}], "message": "private"}}
        return httpx.Response(403, stream=httpx.ByteStream(json.dumps(body).encode()))

    monkeypatch.setattr(
        httpx, "AsyncClient", lambda **kw: original(**kw, transport=httpx.MockTransport(handler))
    )
    with pytest.raises(drive.DriveReadError) as caught:
        if operation == "file":
            await adapter.get_file_facts(file_id="selected-file", access_token="synthetic-token")
        else:
            await adapter.list_files(
                access_token="synthetic-token", query="trashed = false", page_size=25
            )
    assert str(caught.value) == ("provider_unavailable" if retryable else "source_unavailable")
    assert caught.value.retryable is retryable
    assert caught.value.provider_reason == provider_reason
    assert len(requests) == 1 and requests[0].method == "GET"


@pytest.mark.parametrize(
    "entries",
    [
        [{"reason": "rateLimitExceeded"}, {"unexpected": "malformed"}],
        [{"reason": "rateLimitExceeded"}] * 16 + [{"reason": "insufficientFilePermissions"}],
        [{"reason": "rateLimitExceeded"}, {"reason": "insufficientFilePermissions"}],
    ],
)
async def test_mixed_or_oversized_drive_403_never_becomes_retryable(adapter, monkeypatch, entries):
    original = httpx.AsyncClient

    def handler(_request):
        body = {"error": {"code": 403, "errors": entries}}
        return httpx.Response(403, stream=httpx.ByteStream(json.dumps(body).encode()))

    monkeypatch.setattr(
        httpx, "AsyncClient", lambda **kw: original(**kw, transport=httpx.MockTransport(handler))
    )
    with pytest.raises(drive.DriveReadError) as caught:
        await adapter.get_file_facts(file_id="selected-file", access_token="synthetic-token")
    assert str(caught.value) == "source_unavailable"
    assert caught.value.status_code == 403
    assert caught.value.retryable is False
