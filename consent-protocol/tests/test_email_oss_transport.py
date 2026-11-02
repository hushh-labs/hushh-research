"""SDK byte transport bounds and authentic OAuth/batch compatibility, provider-free."""

import gzip
import zlib

import httpx
import pytest

from hushh_mcp.services.email_oss.gmail_execution import GmailExecutionError


class TrackedHttpStream(httpx.SyncByteStream):
    def __init__(self, chunks):
        self.chunks = chunks
        self.yielded = 0
        self.closed = False

    def __iter__(self):
        for chunk in self.chunks:
            self.yielded += 1
            yield chunk

    def close(self):
        self.closed = True


def test_http_transport_stops_encoded_stream_before_sdk_full_read(monkeypatch):
    from hushh_mcp.services.email_oss import transport as bindings

    monkeypatch.setattr(bindings, "GMAIL_HTTP_RESPONSE_LIMIT", 100_000)
    stream = TrackedHttpStream([b"x" * 65536] * 10)
    client = httpx.Client(
        transport=httpx.MockTransport(lambda request: httpx.Response(200, stream=stream))
    )
    transport = bindings._BoundedGmailHttp(client=client)
    try:
        with pytest.raises(GmailExecutionError, match="response_too_large") as error:
            transport.request("https://synthetic.invalid/batch")
        assert error.value.outcome_unknown is True
        # Negative control: httplib2.response.read() would consume all ten
        # chunks before the application could reject or parse the response.
        assert stream.yielded == 2 and stream.closed
    finally:
        transport.close()


def test_http_transport_checks_declared_size_before_consuming_any_bytes(monkeypatch):
    from hushh_mcp.services.email_oss import transport as bindings

    monkeypatch.setattr(bindings, "GMAIL_HTTP_RESPONSE_LIMIT", 100)
    stream = TrackedHttpStream([b"x"])
    client = httpx.Client(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(200, headers={"Content-Length": "101"}, stream=stream)
        )
    )
    transport = bindings._BoundedGmailHttp(client=client)
    try:
        with pytest.raises(GmailExecutionError, match="response_too_large"):
            transport.request("https://synthetic.invalid/batch")
        assert stream.yielded == 0 and stream.closed
    finally:
        transport.close()


def test_expired_body_deadline_is_checked_on_native_chunks_without_rebuffering():
    from hushh_mcp.services.email_oss.transport import _bounded_content

    stream = TrackedHttpStream([b"x"] * 100)
    response = httpx.Response(200, stream=stream)
    try:
        with pytest.raises(TimeoutError, match="deadline exceeded"):
            _bounded_content(response, limit=1000, deadline=0)
        # A 64 KiB application rebuffer would consume all slow chunks before
        # exposing one to the deadline check. Stop on the first native chunk.
        assert stream.yielded == 1
    finally:
        response.close()
    assert stream.closed


def test_instrumented_httpx_cannot_export_private_mail_urls():
    from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

    from hushh_mcp.services.email_oss.transport import _BoundedGmailHttp

    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    client = httpx.Client(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(200, stream=httpx.ByteStream(b"{}"))
        )
    )
    HTTPXClientInstrumentor.instrument_client(client, tracer_provider=provider)
    transport = _BoundedGmailHttp(client=client)
    private_url = (
        "https://gmail.googleapis.com/gmail/v1/users/me/messages?q=synthetic-private-query"
    )
    try:
        transport.request(private_url)
        assert not exporter.get_finished_spans()
        # Independent negative control proves the instrumented client would
        # otherwise retain the private query, rather than a disabled exporter.
        client.get(private_url)
        spans = exporter.get_finished_spans()
        assert len(spans) == 1 and private_url in spans[0].attributes.values()
    finally:
        transport.close()
        provider.shutdown()


@pytest.mark.parametrize("encoding", ["gzip", "deflate"])
def test_http_transport_caps_decompression_before_full_allocation(monkeypatch, encoding):
    from hushh_mcp.services.email_oss import transport as bindings

    monkeypatch.setattr(bindings, "GMAIL_HTTP_RESPONSE_LIMIT", 512)
    content = b"x" * 4096
    compressed = gzip.compress(content) if encoding == "gzip" else zlib.compress(content)
    assert len(compressed) < 512 < len(content)
    stream = TrackedHttpStream([compressed])
    client = httpx.Client(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(
                200, headers={"Content-Encoding": encoding}, stream=stream
            )
        )
    )
    transport = bindings._BoundedGmailHttp(client=client)
    try:
        with pytest.raises(GmailExecutionError, match="response_too_large"):
            transport.request("https://synthetic.invalid/batch")
        assert stream.closed
    finally:
        transport.close()


@pytest.mark.parametrize("encoding", ["identity", "gzip", "deflate"])
def test_real_sdk_single_batch_and_oauth_use_bounded_transport_without_network(encoding):
    from google.oauth2.credentials import Credentials
    from google_auth_httplib2 import AuthorizedHttp
    from googleapiclient.discovery import build

    from hushh_mcp.services.email_oss.transport import _BoundedGmailHttp

    observed = []
    stream = None
    batch = None

    def reply(request):
        nonlocal stream
        observed.append(request)
        boundary = "synthetic_response_boundary"
        response = (
            f"--{boundary}\r\nContent-Type: application/http\r\n"
            f"Content-ID: {batch._id_to_header('m1')}\r\n\r\n"
            'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"id":"m1"}\r\n'
            f"--{boundary}--\r\n"
        ).encode()
        if encoding == "gzip":
            response = gzip.compress(response)
        elif encoding == "deflate":
            response = zlib.compress(response)
        stream = TrackedHttpStream([response])
        return httpx.Response(
            200,
            headers={
                "Content-Type": f"multipart/mixed; boundary={boundary}",
                "Content-Encoding": encoding,
            },
            stream=stream,
        )

    client = httpx.Client(transport=httpx.MockTransport(reply))
    transport = _BoundedGmailHttp(client=client)
    synthetic_token = "synthetic-offline-token"
    service = build(
        "gmail",
        "v1",
        http=AuthorizedHttp(Credentials(token=synthetic_token), http=transport),
        static_discovery=True,
        cache_discovery=False,
    )
    received = []
    try:
        batch = service.new_batch_http_request(callback=lambda *args: received.append(args))
        batch.add(service.users().messages().get(userId="me", id="m1"), request_id="m1")
        batch.execute()
        assert len(observed) == 1 and observed[0].method == "POST"
        assert observed[0].headers["authorization"] == "Bearer " + synthetic_token
        assert received == [("m1", {"id": "m1"}, None)]
        assert stream is not None and stream.closed
    finally:
        service.close()
    assert client.is_closed


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["get_message", "create_draft"])
async def test_sdk_401_uses_vault_owned_refresh_and_never_retries_an_effect(monkeypatch, operation):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock

    from hushh_mcp.services.email_oss import bindings
    from hushh_mcp.services.email_oss.transport import _BoundedGmailHttp

    requests = []

    def rejected(request):
        requests.append(request)
        return httpx.Response(
            401,
            headers={"Content-Type": "application/json"},
            stream=TrackedHttpStream(
                [b'{"error":{"code":401,"message":"synthetic rejected credential"}}']
            ),
        )

    client = httpx.Client(transport=httpx.MockTransport(rejected))
    monkeypatch.setattr(
        bindings, "_BoundedGmailHttp", lambda **kwargs: _BoundedGmailHttp(client=client)
    )
    grant = ("owner", "gmail", "account-A", "connected", "revision-A")
    vault = SimpleNamespace(
        get_bound_read_access_token=AsyncMock(return_value=("synthetic-access", grant))
    )
    execution = bindings.OwnerGmailExecution(vault, "owner", AsyncMock())
    arguments = (
        {"message_id": "m1"}
        if operation == "get_message"
        else {"to": ["recipient@example.com"], "subject": "Draft", "body": "Draft only"}
    )
    with pytest.raises(GmailExecutionError) as caught:
        await getattr(execution, operation)(**arguments)
    assert caught.value.code == "reconnect_required"
    assert caught.value.outcome_unknown is False
    assert len(requests) == 1
    assert vault.get_bound_read_access_token.await_count == 1
    assert client.is_closed
