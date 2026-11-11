"""Synthetic provider proof for complete, account-fenced follow-up body reads."""

from __future__ import annotations

import base64

import httpx
import pytest

from hushh_mcp.services.calendar_email_followup_reader import (
    CompleteMailReadError,
    read_complete_message,
    split_complete_body,
)

_SYNTHETIC_BEARER = "synthetic-access"  # noqa: S105 - local mock transport only


def _encoded(text: str) -> str:
    return base64.urlsafe_b64encode(text.encode()).decode().rstrip("=")


def _message(payload: dict, *, message_id: str = "mail-1") -> dict:
    return {
        "id": message_id,
        "threadId": "thread-1",
        "internalDate": "1791590400000",
        "payload": {
            "mimeType": "multipart/mixed",
            "headers": [
                {"name": "Subject", "value": "Project follow-up"},
                {"name": "From", "value": "Jhumma <jhumma@example.test>"},
            ],
            "parts": [payload],
        },
    }


def _json_response(value: dict, status: int = 200) -> httpx.Response:
    return httpx.Response(status, json=value)


def test_sections_cover_last_paragraph_and_overlap_without_gaps() -> None:
    body = "\n\n".join(
        ["Background and context. " * 35 for _ in range(4)]
        + ["Please send the document before 26 October. Call proposed for 27 October."]
    )
    sections = split_complete_body(body, max_section_bytes=512, overlap_chars=48)
    assert len(sections) > 4
    assert sections[0].start == 0
    assert sections[-1].end == len(body)
    assert "Call proposed for 27 October." in sections[-1].text
    assert all(left.end >= right.start for left, right in zip(sections, sections[1:], strict=False))
    assert all(len(item.text.encode()) <= 512 for item in sections)
    assert all(item.text == body[item.start : item.end] for item in sections)


@pytest.mark.asyncio
async def test_external_body_part_is_read_fully_and_file_attachment_is_not_fetched() -> None:
    ending = "Please send the document before 26 October. Call proposed for 27 October."
    body = "\n\n".join(["Background paragraph. " * 30 for _ in range(4)] + [ending])
    paths: list[str] = []
    checks = 0

    def respond(request: httpx.Request) -> httpx.Response:
        paths.append(request.url.path)
        assert request.headers["Authorization"] == f"Bearer {_SYNTHETIC_BEARER}"
        if request.url.path.endswith("/attachments/body-part"):
            return _json_response({"data": _encoded(body), "size": len(body.encode())})
        if request.url.path.endswith("/messages/mail-1"):
            source = _message(
                {
                    "mimeType": "text/plain",
                    "body": {"attachmentId": "body-part", "size": len(body.encode())},
                }
            )
            source["payload"]["parts"].append(
                {
                    "mimeType": "text/plain",
                    "filename": "private-notes.txt",
                    "body": {"attachmentId": "file-part", "size": 20},
                }
            )
            return _json_response(source)
        raise AssertionError(f"unexpected request {request.url.path}")

    async def current() -> None:
        nonlocal checks
        checks += 1

    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        result = await read_complete_message(
            client=client,
            token=_SYNTHETIC_BEARER,
            message_id="mail-1",
            require_current=current,
        )
    assert result.body.endswith(ending)
    assert result.sections[-1].end == len(result.body)
    assert len(paths) == 2
    assert not any(path.endswith("/attachments/file-part") for path in paths)
    assert checks >= 4


@pytest.mark.asyncio
async def test_missing_external_body_part_does_not_become_empty_mail() -> None:
    def respond(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/messages/mail-1"):
            return _json_response(
                _message({"mimeType": "text/plain", "body": {"attachmentId": "part-1", "size": 40}})
            )
        return _json_response({"data": "", "size": 40})

    async def current() -> None:
        return None

    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        with pytest.raises(CompleteMailReadError, match="incomplete_body"):
            await read_complete_message(
                client=client,
                token=_SYNTHETIC_BEARER,
                message_id="mail-1",
                require_current=current,
            )


@pytest.mark.asyncio
async def test_grant_change_during_external_part_refuses_content() -> None:
    calls = 0

    def respond(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/messages/mail-1"):
            return _json_response(
                _message({"mimeType": "text/plain", "body": {"attachmentId": "part-1", "size": 5}})
            )
        return _json_response({"data": _encoded("hello"), "size": 5})

    async def current() -> None:
        nonlocal calls
        calls += 1
        if calls == 4:
            raise CompleteMailReadError("connection_changed")

    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        with pytest.raises(CompleteMailReadError, match="connection_changed"):
            await read_complete_message(
                client=client,
                token=_SYNTHETIC_BEARER,
                message_id="mail-1",
                require_current=current,
            )


@pytest.mark.asyncio
async def test_oversized_body_fails_without_returning_a_prefix() -> None:
    text = "a" * (512 * 1024 + 1)

    def respond(request: httpx.Request) -> httpx.Response:
        return _json_response(
            _message(
                {"mimeType": "text/plain", "body": {"data": _encoded(text), "size": len(text)}}
            )
        )

    async def current() -> None:
        return None

    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        with pytest.raises(CompleteMailReadError, match="body_too_large"):
            await read_complete_message(
                client=client,
                token=_SYNTHETIC_BEARER,
                message_id="mail-1",
                require_current=current,
            )
