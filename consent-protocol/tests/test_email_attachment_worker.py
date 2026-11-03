"""Worker identity, input custody and private attachment transport contracts."""

from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI

from api.routes import email_attachment_worker as route
from hushh_mcp.services.drive_document_parser import ParsedText
from hushh_mcp.services.email_oss import attachment_worker as port
from hushh_mcp.services.google_drive_adapter import DriveReadError

_CLAIMS = {
    "iss": "https://accounts.google.com",
    "aud": port.WORKER_ORIGIN,
    "email": port.WORKER_PRINCIPAL,
    "email_verified": True,
}
_HEADERS = {"Authorization": "Bearer synthetic", "Content-Type": "text/csv"}


@pytest.fixture
def worker(monkeypatch):
    app = FastAPI()
    app.include_router(route.router)
    monkeypatch.setenv("ENVIRONMENT", "uat")
    verify = AsyncMock(return_value=_CLAIMS)
    monkeypatch.setattr(route, "run_in_threadpool", verify)
    scan = AsyncMock()
    parse = AsyncMock(return_value=ParsedText(("bounded text",)))
    monkeypatch.setattr(route, "ClamAvScanner", lambda: type("Scanner", (), {"scan": scan})())
    monkeypatch.setattr(
        route, "IsolatedDocumentParser", lambda: type("Parser", (), {"parse": parse})()
    )
    return app, verify, scan, parse


@pytest.mark.parametrize(
    "bad_claim",
    [
        {"email": "other@example.invalid"},
        {"aud": "https://other.example.invalid"},
        {"iss": "https://other.example.invalid"},
        {"email_verified": False},
    ],
)
async def test_refused_machine_never_reads_body(worker, bad_claim):
    app, verify, scan, parse = worker
    verify.return_value = {**_CLAIMS, **bad_claim}

    async def unreadable_body():
        pytest.fail("Unauthorized body was consumed")
        yield b"unreadable"

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.post(port.WORKER_PATH, headers=_HEADERS, content=unreadable_body())
    assert response.status_code == 401
    scan.assert_not_awaited()
    parse.assert_not_awaited()


async def test_scan_precedes_parse_and_failures_publish_no_text(worker, monkeypatch):
    app, _, scan, parse = worker
    monkeypatch.setattr(route, "MAX_ATTACHMENT_BYTES", 8)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        oversized = await client.post(port.WORKER_PATH, headers=_HEADERS, content=b"x" * 9)
        assert oversized.status_code == 413
        scan.assert_not_awaited()
        scan.side_effect = DriveReadError("unsafe_document")
        blocked = await client.post(port.WORKER_PATH, headers=_HEADERS, content=b"a,b")
        assert blocked.status_code == 422
        parse.assert_not_awaited()
        scan.side_effect = None
        ok = await client.post(port.WORKER_PATH, headers=_HEADERS, content=b"a,b")
    assert ok.json() == {"pages": ["bounded text"], "truncated": False}
    assert ok.headers["cache-control"] == "no-store"
    parse.assert_awaited_once_with(content=b"a,b", mime_type="text/csv", live=True)


async def test_client_requires_exact_uat_origin_and_sends_only_bytes(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "uat")
    monkeypatch.setenv(port.WORKER_ORIGIN_ENV, "https://other.example.invalid")
    calls = []

    def reply(request):
        calls.append(request)
        if request.method == "GET":
            assert request.url.params["audience"] == port.WORKER_ORIGIN
            return httpx.Response(200, content=b"synthetic", headers={"Metadata-Flavor": "Google"})
        assert str(request.url) == port.WORKER_ORIGIN + port.WORKER_PATH
        assert request.headers["authorization"] == "Bearer synthetic"
        assert request.content == b"a,b"
        return httpx.Response(200, json={"pages": ["safe fixture"], "truncated": False})

    client_factory = httpx.AsyncClient
    monkeypatch.setattr(
        port.httpx,
        "AsyncClient",
        lambda **kwargs: client_factory(transport=httpx.MockTransport(reply), **kwargs),
    )
    parser = port.WorkerAttachmentParser()
    with pytest.raises(DriveReadError):
        await parser(content=b"a,b", mime_type="text/csv")
    assert calls == []
    monkeypatch.setenv(port.WORKER_ORIGIN_ENV, port.WORKER_ORIGIN)
    assert (await parser(content=b"a,b", mime_type="text/csv")).pages == ("safe fixture",)
    assert len(calls) == 2
