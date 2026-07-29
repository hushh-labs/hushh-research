import uuid
from typing import cast

from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware


class CorrelationIDMiddleware(BaseHTTPMiddleware):
    """
    Middleware for attaching correlation IDs to requests.
    """

    async def dispatch(
        self,
        request: Request,
        call_next,
    ) -> Response:
        correlation_id = str(uuid.uuid4())

        response = cast(
            Response,
            await call_next(request),
        )

        response.headers["X-Correlation-ID"] = (
            correlation_id
        )

        return response