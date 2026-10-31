"""Synthetic, offline proofs for the server-only Drive blob boundary."""

import hashlib
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest

from hushh_mcp.hushh_adk.context import HushhContext
from hushh_mcp.services.google_connection_service import GoogleConnectionError
from hushh_mcp.services.google_drive_blob_attachment_service import (
    MAX_BLOB_BYTES,
    GoogleDriveBlobAttachmentService,
)

FILE_ID = "drive_blob_1"
OWNER = "authenticated-owner"
CONTENT = b"ordinary text\n"
SHA = hashlib.sha256(CONTENT).hexdigest()


def _metadata(**changes):
    return {
        "id": FILE_ID,
        "name": "note.txt",
        "mimeType": "text/plain",
        "size": str(len(CONTENT)),
        "version": "17",
        "headRevisionId": "revision_17",
        "sha256Checksum": SHA,
        "capabilities": {"canDownload": True},
        "trashed": False,
        **changes,
    }


def _service(*, before=None, after=None, media=CONTENT, media_headers=None, connection=None):
    before = _metadata() if before is None else before
    after = before if after is None else after
    calls = []

    def respond(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        assert request.url.host == "www.googleapis.com"
        assert request.url.path == f"/drive/v3/files/{FILE_ID}"
        assert request.headers["authorization"] == "Bearer synthetic-grant-token"
        if request.url.params.get("alt") == "media":
            return httpx.Response(
                200,
                stream=httpx.ByteStream(media),
                headers={"content-type": "text/plain", **(media_headers or {})},
            )
        payload = before if len([r for r in calls if r.url.params.get("fields")]) == 1 else after
        return httpx.Response(
            200,
            stream=httpx.ByteStream(json.dumps(payload).encode()),
            headers={"content-type": "application/json"},
        )

    connections = connection or SimpleNamespace(
        access_token=AsyncMock(return_value="synthetic-grant-token")
    )
    service = GoogleDriveBlobAttachmentService(
        connections=connections, transport=httpx.MockTransport(respond)
    )
    return service, connections, calls


async def _resolve(service, **kwargs):
    return await service.resolve(
        file_id=FILE_ID,
        authenticated_owner_user_id=OWNER,
        expected_revision="revision_17",
        **kwargs,
    )


@pytest.mark.asyncio
async def test_verified_blob_returns_bytes_only_to_server_caller():
    service, connections, calls = _service()
    result = await _resolve(service, expected_sha256=SHA)
    assert result.content == CONTENT
    assert result.descriptor.sha256 == SHA
    assert result.descriptor.filename == "note.txt"
    assert CONTENT.decode().strip() not in repr(result)
    assert connections.access_token.await_count == 2
    assert all(
        call.kwargs == {"user_id": OWNER, "service": "drive", "access_level": "read"}
        for call in connections.access_token.await_args_list
    )
    assert len(calls) == 3
    assert calls[1].url.params["alt"] == "media"


@pytest.mark.asyncio
async def test_large_file_is_rejected_before_media_download():
    service, _, calls = _service(before=_metadata(size=str(MAX_BLOB_BYTES + 1)))
    with pytest.raises(GoogleConnectionError, match="attachment limit"):
        await _resolve(service)
    assert len(calls) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "changes",
    [
        {"mimeType": "application/vnd.google-apps.document", "name": "note.txt"},
        {"mimeType": "application/x-msdownload", "name": "malware.exe"},
        {"name": "../note.txt"},
        {"name": "note.pdf"},
    ],
)
async def test_unsupported_type_or_unsafe_filename_is_rejected(changes):
    service, _, calls = _service(before=_metadata(**changes))
    with pytest.raises(GoogleConnectionError):
        await _resolve(service)
    assert len(calls) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("changes", [{"capabilities": {"canDownload": False}}, {"id": "other"}])
async def test_permission_or_provider_identity_mismatch_is_rejected(changes):
    service, _, calls = _service(before=_metadata(**changes))
    with pytest.raises(GoogleConnectionError) as error:
        await _resolve(service)
    assert error.value.status_code in {403, 409}
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_missing_owner_never_requests_a_grant():
    service, connections, calls = _service()
    with pytest.raises(GoogleConnectionError) as error:
        await service.resolve(
            file_id=FILE_ID, authenticated_owner_user_id="", expected_revision="revision_17"
        )
    assert error.value.status_code == 403
    connections.access_token.assert_not_called()
    assert calls == []


@pytest.mark.asyncio
async def test_owner_mismatch_with_active_agent_context_never_requests_a_grant():
    service, connections, calls = _service()
    with HushhContext(user_id="different-owner", consent_token=SHA):
        with pytest.raises(GoogleConnectionError) as error:
            await _resolve(service)
    assert error.value.status_code == 403
    connections.access_token.assert_not_called()
    assert calls == []


@pytest.mark.asyncio
async def test_owner_grant_rejection_prevents_provider_call():
    connections = SimpleNamespace(
        access_token=AsyncMock(
            side_effect=GoogleConnectionError("No owner Drive grant", status_code=403)
        )
    )
    service, _, calls = _service(connection=connections)
    with pytest.raises(GoogleConnectionError) as error:
        await _resolve(service)
    assert error.value.status_code == 403
    assert calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize("media", [CONTENT[:-1], CONTENT + b"extra"])
async def test_truncation_or_growth_rejects_download(media):
    service, _, calls = _service(media=media)
    with pytest.raises(GoogleConnectionError):
        await _resolve(service)
    assert len(calls) == 2


@pytest.mark.asyncio
async def test_digest_change_rejects_download():
    altered = b"ordinary texT\n"
    assert len(altered) == len(CONTENT)
    service, _, calls = _service(media=altered)
    with pytest.raises(GoogleConnectionError, match="checksum changed"):
        await _resolve(service)
    assert len(calls) == 2


@pytest.mark.asyncio
async def test_matching_digest_with_disguised_binary_content_is_rejected():
    disguised = b"\x00binary\x01"
    before = _metadata(
        size=str(len(disguised)), sha256Checksum=hashlib.sha256(disguised).hexdigest()
    )
    service, _, calls = _service(before=before, media=disguised)
    with pytest.raises(GoogleConnectionError, match="does not match"):
        await _resolve(service)
    assert len(calls) == 2


@pytest.mark.asyncio
async def test_grant_revoked_after_download_does_not_release_bytes():
    connection = SimpleNamespace(
        access_token=AsyncMock(
            side_effect=[
                "synthetic-grant-token",
                GoogleConnectionError("Drive grant revoked", status_code=403),
            ]
        )
    )
    service, _, calls = _service(connection=connection)
    with pytest.raises(GoogleConnectionError) as error:
        await _resolve(service)
    assert error.value.status_code == 403
    assert len(calls) == 3


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "after",
    [
        _metadata(headRevisionId="revision_18", version="18"),
        _metadata(version="18"),
        _metadata(sha256Checksum="0" * 64),
        _metadata(capabilities={"canDownload": False}),
    ],
)
async def test_revision_digest_or_permission_change_during_download_rejects_bytes(after):
    service, _, calls = _service(after=after)
    with pytest.raises(GoogleConnectionError):
        await _resolve(service)
    assert len(calls) == 3


@pytest.mark.asyncio
async def test_expected_revision_or_digest_mismatch_rejects_before_media():
    service, _, calls = _service()
    with pytest.raises(GoogleConnectionError, match="changed since review"):
        await service.resolve(
            file_id=FILE_ID,
            authenticated_owner_user_id=OWNER,
            expected_revision="revision_16",
        )
    assert len(calls) == 1
    service, _, calls = _service()
    with pytest.raises(GoogleConnectionError, match="changed since review"):
        await _resolve(service, expected_sha256="0" * 64)
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_provider_error_body_does_not_escape():
    secret = "provider-private-body"

    def respond(_request):
        return httpx.Response(403, content=json.dumps({"error": secret}))

    connections = SimpleNamespace(access_token=AsyncMock(return_value="synthetic-grant-token"))
    service = GoogleDriveBlobAttachmentService(
        connections=connections, transport=httpx.MockTransport(respond)
    )
    with pytest.raises(GoogleConnectionError) as error:
        await _resolve(service)
    assert secret not in str(error.value)
