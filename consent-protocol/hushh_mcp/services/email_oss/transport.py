"""Bounded byte transport underneath Google's SDK and AuthorizedHttp."""

from __future__ import annotations

import time
import zlib

import httpx
from opentelemetry.instrumentation.utils import suppress_instrumentation

from .execution_types import GmailExecutionError

GMAIL_HTTP_RESPONSE_LIMIT = 16 * 1024 * 1024


def _validate_length(headers, limit):
    length = headers.get("content-length")
    if length is None:
        return
    try:
        declared = int(length)
    except ValueError:
        raise GmailExecutionError("invalid_provider_response", outcome_unknown=True) from None
    if declared < 0:
        raise GmailExecutionError("invalid_provider_response", outcome_unknown=True)
    if declared > limit:
        raise GmailExecutionError("response_too_large", outcome_unknown=True)


def _content_decoder(headers):
    encoding = headers.get("content-encoding", "identity").strip().lower()
    if encoding == "gzip":
        return zlib.decompressobj(16 + zlib.MAX_WBITS)
    if encoding == "deflate":
        return zlib.decompressobj()
    if encoding != "identity":
        raise GmailExecutionError("invalid_provider_response", outcome_unknown=True)
    return None


def _bounded_content(response, *, limit, deadline):
    _validate_length(response.headers, limit)
    decoder = _content_decoder(response.headers)
    content, encoded_size = bytearray(), 0
    try:
        # Native chunks, not a 64 KiB rebuffer: slow drips must reach the
        # deadline check without waiting for an application chunk to fill.
        for chunk in response.iter_raw():
            if time.monotonic() > deadline:
                raise TimeoutError("Gmail response deadline exceeded")
            encoded_size += len(chunk)
            if encoded_size > limit:
                raise GmailExecutionError("response_too_large", outcome_unknown=True)
            remaining = limit - len(content)
            decoded = decoder.decompress(chunk, remaining + 1) if decoder else chunk
            if len(decoded) > remaining:
                raise GmailExecutionError("response_too_large", outcome_unknown=True)
            content.extend(decoded)
        # Do not use unbounded decoder.flush(). Reject incomplete/extra members.
        if decoder is not None and (
            not decoder.eof or decoder.unused_data or decoder.unconsumed_tail
        ):
            raise GmailExecutionError("invalid_provider_response", outcome_unknown=True)
    except zlib.error:
        raise GmailExecutionError("invalid_provider_response", outcome_unknown=True) from None
    return bytes(content)


class _BoundedGmailHttp:
    """SDK-compatible HTTP; caps encoded and decoded bytes before SDK parsing.

    OAuth remains in AuthorizedHttp. Request/batch construction remains in the
    generated SDK. The aggregate cap accommodates a 10 MiB attachment's base64
    JSON while preventing httplib2's unbounded response.read() allocation.
    """

    def __init__(self, *, timeout: float = 8, client: httpx.Client | None = None):
        self.timeout = timeout
        self._client = client or httpx.Client(
            timeout=timeout,
            follow_redirects=False,
            headers={"Accept-Encoding": "gzip, deflate"},
        )

    def close(self) -> None:
        self._client.close()

    def request(
        self, uri, method="GET", body=None, headers=None, redirections=0, connection_type=None
    ):
        del redirections, connection_type  # No credential-forwarding redirects.
        from httplib2 import Response

        deadline = time.monotonic() + self.timeout
        # Match existing Gmail read ports: global HTTPX instrumentation must
        # never retain mailbox queries or provider IDs in URL span attributes.
        with (
            suppress_instrumentation(),
            self._client.stream(method, uri, content=body, headers=headers) as response,
        ):
            content = _bounded_content(response, limit=GMAIL_HTTP_RESPONSE_LIMIT, deadline=deadline)
            response_headers = dict(response.headers)
            response_headers.pop("content-encoding", None)
            response_headers.update(
                {
                    "content-length": str(len(content)),
                    "status": str(response.status_code),
                    "reason": response.reason_phrase,
                }
            )
            return Response(response_headers), content
