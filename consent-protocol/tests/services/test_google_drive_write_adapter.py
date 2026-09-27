"""Synthetic HTTP only: no Google account, grant, credential or real Drive file is used."""

# ruff: noqa: S106

import json

import httpx
import pytest

from hushh_mcp.services import google_drive_write_adapter as writes

FILE_ID = "synthetic_file_1"
TOKEN = "synthetic-token"


class Stream(httpx.AsyncByteStream):
    def __init__(self, data: bytes):
        self.data = data

    async def __aiter__(self):
        yield self.data


def response(status=200, payload=None):
    return httpx.Response(status, stream=Stream(json.dumps(payload or {}).encode()))


def install(monkeypatch, handler):
    requests: list[httpx.Request] = []

    def record(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return handler(request)

    original = httpx.AsyncClient
    monkeypatch.setattr(
        httpx, "AsyncClient", lambda **kw: original(**kw, transport=httpx.MockTransport(record))
    )
    return requests


@pytest.mark.asyncio
async def test_share_adds_one_exact_user_permission(monkeypatch):
    requests = install(
        monkeypatch, lambda _: response(payload={"id": "p1", "type": "user", "role": "commenter"})
    )
    result = await writes.GoogleDriveWriteAdapter().share(
        access_token=TOKEN,
        target=FILE_ID,
        email="recipient@example.invalid",
        role="commenter",
        notify=True,
    )
    assert result == {"role": "commenter"}
    (request,) = requests
    assert request.method == "POST"
    assert request.url.path == f"/drive/v3/files/{FILE_ID}/permissions"
    assert request.url.params["sendNotificationEmail"] == "true"
    assert json.loads(request.content) == {
        "type": "user",
        "role": "commenter",
        "emailAddress": "recipient@example.invalid",
    }


@pytest.mark.asyncio
@pytest.mark.parametrize("role", ["owner", "organizer", "fileOrganizer", ""])
async def test_share_never_grants_ownership_or_an_unknown_role(monkeypatch, role):
    requests = install(monkeypatch, lambda _: response(payload={}))
    with pytest.raises(writes.DriveWriteError, match="invalid_argument"):
        await writes.GoogleDriveWriteAdapter().share(
            access_token=TOKEN, target=FILE_ID, email="a@example.invalid", role=role, notify=True
        )
    assert requests == []


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [500, 503, 429, 408])
async def test_a_failed_mutation_is_unknown_and_never_retried(monkeypatch, status):
    # Google may have applied a write it did not confirm. Report "unknown" so
    # nobody repeats it blindly, and send it exactly once.
    requests = install(monkeypatch, lambda _: response(status))
    with pytest.raises(writes.DriveWriteError) as raised:
        await writes.GoogleDriveWriteAdapter().update(
            access_token=TOKEN, target=FILE_ID, trash=True
        )
    assert raised.value.outcome_unknown is True
    assert len(requests) == 1


@pytest.mark.asyncio
async def test_markdown_becomes_a_google_doc_through_one_multipart_upload(monkeypatch):
    requests = install(
        monkeypatch,
        lambda _: response(
            payload={"id": "new_doc", "name": "Plan", "mimeType": writes.DOCUMENT_MIME}
        ),
    )
    created = await writes.GoogleDriveWriteAdapter().create(
        access_token=TOKEN, name="Plan", kind="document", parent=None, content="# Plan\n- one"
    )
    assert created == {
        "id": "new_doc",
        "title": "Plan",
        "mimeType": writes.DOCUMENT_MIME,
        "viewUrl": None,
    }
    (request,) = requests
    assert str(request.url).startswith(writes.UPLOAD_BASE + "/files?")
    assert request.url.params["uploadType"] == "multipart"
    body = request.content.decode()
    assert json.dumps({"name": "Plan", "mimeType": writes.DOCUMENT_MIME}) in body
    assert "Content-Type: text/markdown; charset=UTF-8\r\n\r\n# Plan\n- one" in body


@pytest.mark.asyncio
@pytest.mark.parametrize("parent,expected", [(None, "root"), ("private_folder", "private_folder")])
async def test_a_copy_always_names_its_parent(monkeypatch, parent, expected):
    # Without a parent Drive files the copy beside its source, which may be a
    # shared folder: that would share the copy with no review.
    requests = install(
        monkeypatch,
        lambda _: response(payload={"id": "copy_1", "name": "Plan", "mimeType": "text/plain"}),
    )
    await writes.GoogleDriveWriteAdapter().copy(
        access_token=TOKEN, source=FILE_ID, name=None, parent=parent
    )
    assert json.loads(requests[0].content)["parents"] == [expected]
