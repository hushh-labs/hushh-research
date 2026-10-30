"""Keep private API responses and admission errors out of shared caches."""

from fastapi import Request
from fastapi.routing import APIRoute
from starlette.exceptions import HTTPException as StarletteHTTPException

PRIVATE_NO_STORE_HEADERS = {"Cache-Control": "private, no-store"}


class PrivateNoStoreRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def private_handler(request: Request):
            try:
                response = await handler(request)
            except StarletteHTTPException as exc:
                exc.headers = {**(exc.headers or {}), **PRIVATE_NO_STORE_HEADERS}
                raise
            response.headers.update(PRIVATE_NO_STORE_HEADERS)
            return response

        return private_handler
