from typing import cast

from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """
    Middleware for applying standard security headers.
    """

    async def dispatch(
        self,
        request: Request,
        call_next,
    ) -> Response:
        response = cast(
            Response,
            await call_next(request),
        )

        response.headers["X-Content-Type-Options"] = (
            "nosniff"
        )

        response.headers["X-Frame-Options"] = (
            "DENY"
        )

        response.headers["Referrer-Policy"] = (
            "no-referrer"
        )

        return response