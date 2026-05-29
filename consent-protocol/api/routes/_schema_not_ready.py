"""Shared opaque API responses for schema-not-ready conditions."""

from __future__ import annotations

from fastapi.responses import JSONResponse

IAM_SCHEMA_NOT_READY_BODY = {
    "error": "RIA verification service is temporarily unavailable",
    "code": "IAM_SCHEMA_NOT_READY",
}


def iam_schema_not_ready_response() -> JSONResponse:
    return JSONResponse(status_code=503, content=IAM_SCHEMA_NOT_READY_BODY)
