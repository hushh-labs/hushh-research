import time
from typing import Callable, cast

from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware


class ResponseTimingMiddleware(BaseHTTPMiddleware):
    """
    Middleware for tracking API response execution time.
    """

    async def dispatch(
        self,
        request: Request,
        call_next: Callable,
    ) -> Response:
        start_time = time.perf_counter()

        response = await call_next(request)

        process_time = time.perf_counter() - start_time

        response.headers["X-Response-Time"] = (
            f"{process_time:.4f}s"
        )

        return cast(Response, response)
