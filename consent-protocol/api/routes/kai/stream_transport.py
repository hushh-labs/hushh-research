"""SSE transport accounting and cursor validation, independent of analysis routing."""

import logging
import time
from typing import AsyncGenerator, Optional

from fastapi import HTTPException
from sse_starlette.sse import EventSourceResponse

from api.middlewares.observability import get_request_id

logger = logging.getLogger("api.routes.kai.stream")


def _create_sse_response(
    generator: AsyncGenerator[dict, None], *, response_factory=EventSourceResponse
) -> EventSourceResponse:
    async def _instrumented() -> AsyncGenerator[dict, None]:
        started = time.perf_counter()
        event_count = 0
        saw_terminal = False
        request_id = get_request_id() or "unknown"
        logger.info(
            "stream.lifecycle_start stream=kai_analyze request_id=%s",
            request_id,
        )
        try:
            async for frame in generator:
                event_count += 1
                data = frame.get("data") if isinstance(frame, dict) else None
                if isinstance(data, str) and '"terminal":true' in data.replace(" ", "").lower():
                    saw_terminal = True
                yield frame
        finally:
            duration_ms = round((time.perf_counter() - started) * 1000, 2)
            logger.info(
                "stream.lifecycle_end stream=kai_analyze request_id=%s duration_ms=%s event_count=%s terminal=%s",
                request_id,
                duration_ms,
                event_count,
                saw_terminal,
            )

    return response_factory(
        _instrumented(),
        ping=15,
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
            "Access-Control-Allow-Origin": "*",
        },
    )


def _parse_cursor(cursor: Optional[int]) -> int:
    if cursor is None:
        return 0
    try:
        parsed = int(cursor)
    except Exception as exc:  # pragma: no cover - guard
        raise HTTPException(status_code=422, detail="cursor must be an integer") from exc
    if parsed < 0:
        raise HTTPException(status_code=422, detail="cursor must be >= 0")
    return parsed
