"""Bounded, non-echoing private transport for People messages and calls."""

import asyncio

from fastapi import HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.routing import APIRoute

from hushh_mcp.services.direct_messages_service import MAX_DIRECT_ATTACHMENT_BASE64_LENGTH


class PrivateMessageRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def bounded(request: Request):
            try:
                is_call = request.url.path.startswith("/api/one/messages/calls/")
                if request.method == "POST" and (
                    is_call or request.url.path.rstrip("/") == "/api/one/messages"
                ):
                    maximum = 650_000 if is_call else MAX_DIRECT_ATTACHMENT_BASE64_LENGTH + 64_000
                    declared = request.headers.get("content-length")
                    if declared and declared.isdigit() and int(declared) > maximum:
                        raise HTTPException(413, "Message request is too large.")
                    chunks, size = [], 0
                    async with asyncio.timeout(30):
                        async for chunk in request.stream():
                            size += len(chunk)
                            if size > maximum:
                                raise HTTPException(413, "Message request is too large.")
                            chunks.append(chunk)
                    request._body = b"".join(chunks)
                result = await handler(request)
                result.headers["Cache-Control"] = "private, no-store"
                return result
            except RequestValidationError:
                # Validation errors must never echo an attachment's base64 data.
                raise HTTPException(
                    422, "Invalid message request.", headers={"Cache-Control": "private, no-store"}
                ) from None
            except TimeoutError:
                raise HTTPException(
                    408,
                    "Message request timed out.",
                    headers={"Cache-Control": "private, no-store"},
                ) from None
            except HTTPException as exc:
                exc.headers = {**(exc.headers or {}), "Cache-Control": "private, no-store"}
                raise

        return bounded
