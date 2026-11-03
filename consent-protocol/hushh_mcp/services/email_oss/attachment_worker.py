"""Bounded Email attachment transport to the existing private UAT worker."""

import asyncio
import json
import os

import httpx
from opentelemetry.instrumentation.utils import suppress_instrumentation

from hushh_mcp.services.drive_document_parser import ParsedText
from hushh_mcp.services.google_drive_adapter import DriveReadError

WORKER_ORIGIN = "https://consent-protocol-drive-worker-f2gsa4kfsq-uc.a.run.app"
WORKER_PATH = "/api/internal/email-attachment/parse"
WORKER_PRINCIPAL = "consent-protocol-runtime@hushh-pda-uat.iam.gserviceaccount.com"
WORKER_ORIGIN_ENV = "HUSHH_EMAIL_ATTACHMENT_WORKER_ORIGIN"
MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024
MAX_ATTACHMENT_TEXT = 30000
ATTACHMENT_MIMES = frozenset({"application/pdf", "text/csv"})
_METADATA_IDENTITY = (
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity"
)


async def _bounded_response(response: httpx.Response, limit: int) -> bytes:
    if response.headers.get("content-encoding", "identity").lower() != "identity":
        raise DriveReadError("processor_unavailable")
    body = bytearray()
    async for chunk in response.aiter_bytes():
        if len(body) + len(chunk) > limit:
            raise DriveReadError("processor_unavailable")
        body.extend(chunk)
    return bytes(body)


async def _identity(client: httpx.AsyncClient) -> str:
    async with client.stream(
        "GET",
        _METADATA_IDENTITY,
        params={"audience": WORKER_ORIGIN, "format": "full"},
        headers={"Metadata-Flavor": "Google", "Accept-Encoding": "identity"},
        timeout=2,
    ) as response:
        response.raise_for_status()
        if response.headers.get("Metadata-Flavor") != "Google":
            raise DriveReadError("processor_unavailable")
        token = (await _bounded_response(response, 8192)).decode("ascii").strip()
    if not token or any(char.isspace() for char in token):
        raise DriveReadError("processor_unavailable")
    return token


class WorkerAttachmentParser:
    @property
    def available(self) -> bool:
        return (
            os.getenv("HUSHH_DEPLOY_ENV") == "uat"
            and os.getenv("ENVIRONMENT") == "uat"
            and os.getenv(WORKER_ORIGIN_ENV) == WORKER_ORIGIN
        )

    async def __call__(self, *, content: bytes, mime_type: str) -> ParsedText:
        if (
            not self.available
            or mime_type not in ATTACHMENT_MIMES
            or not 0 < len(content) <= MAX_ATTACHMENT_BYTES
        ):
            raise DriveReadError("processor_unavailable")
        try:
            with suppress_instrumentation():
                async with (
                    asyncio.timeout(12),
                    httpx.AsyncClient(trust_env=False, follow_redirects=False) as client,
                ):
                    token = await _identity(client)
                    async with client.stream(
                        "POST",
                        WORKER_ORIGIN + WORKER_PATH,
                        content=content,
                        headers={
                            "Authorization": f"Bearer {token}",
                            "Content-Type": mime_type,
                            "Accept-Encoding": "identity",
                        },
                    ) as response:
                        if response.status_code == 504:
                            raise TimeoutError
                        response.raise_for_status()
                        if (
                            response.headers.get("content-type", "").split(";")[0]
                            != "application/json"
                        ):
                            raise DriveReadError("processor_unavailable")
                        result = json.loads(await _bounded_response(response, 192 * 1024))
        except (httpx.HTTPError, ValueError):
            raise DriveReadError("processor_unavailable") from None
        if (
            not isinstance(result, dict)
            or set(result) != {"pages", "truncated"}
            or not isinstance(result["pages"], list)
            or len(result["pages"]) != 1
            or not isinstance(result["pages"][0], str)
            or len(result["pages"][0]) > MAX_ATTACHMENT_TEXT
            or type(result["truncated"]) is not bool
        ):
            raise DriveReadError("processor_unavailable")
        return ParsedText(tuple(result["pages"]), result["truncated"])
