from typing import cast

from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware

SENSITIVE_HEADERS = {
    "authorization",
    "cookie",
    "set-cookie",
}


class HeaderMaskingMiddleware(BaseHTTPMiddleware):
    """
    Middleware for masking sensitive request headers.
    """

    async def dispatch(
        self,
        request: Request,
        call_next,
    ) -> Response:
        masked_headers = {}

        for key, value in request.headers.items():
            if key.lower() in SENSITIVE_HEADERS:
                masked_headers[key] = "*****"
            else:
                masked_headers[key] = value

        request.state.masked_headers = masked_headers

        response = cast(
            Response,
            await call_next(request),
        )

        return response