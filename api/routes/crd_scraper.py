"""CRD Scraper proxy routes with bounded path parameters (CWE-400)."""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Path, Request
from fastapi.responses import JSONResponse
from pydantic import AliasChoices, BaseModel, ConfigDict, Field, field_validator

from api.middlewares.rate_limit import limiter
from hushh_mcp.services.crd_scrape_proxy_service import (
    CrdScrapeProviderResponse,
    CrdScrapeProxyError,
    CrdScrapeProxyService,
    normalize_crd_number,
)

router = APIRouter(prefix="/api/ria", tags=["RIA", "CRD Scraper"])

_JobId = Annotated[str, Path(min_length=1, max_length=128)]


class CrdScrapeJobRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    crdNumber: str = Field(
        ...,
        min_length=1,
        validation_alias=AliasChoices("crdNumber", "crd_number", "crd"),
    )

    @field_validator("crdNumber")
    @classmethod
    def normalize_crd(cls, value: str) -> str:
        return str(normalize_crd_number(value))


def get_crd_scrape_proxy_service() -> CrdScrapeProxyService:
    return CrdScrapeProxyService()


@router.post("/crd-scrape-jobs")
@limiter.limit("10/minute")
async def create_crd_scrape_job(
    payload: CrdScrapeJobRequest,
    request: Request,
    service: CrdScrapeProxyService = Depends(get_crd_scrape_proxy_service),
) -> JSONResponse:
    result = await _call_provider(
        service.create_job(
            crd_number=payload.crdNumber,
            request_id=_request_id(request),
        )
    )
    return JSONResponse(status_code=result.status_code, content=result.payload)


@router.get("/crd-scrape-jobs/{job_id}")
@limiter.limit("60/minute")
async def get_crd_scrape_job(
    job_id: _JobId,
    request: Request,
    service: CrdScrapeProxyService = Depends(get_crd_scrape_proxy_service),
) -> JSONResponse:
    result = await _call_provider(
        service.get_job(
            job_id=job_id,
            request_id=_request_id(request),
        )
    )
    return JSONResponse(status_code=result.status_code, content=result.payload)


@router.post("/financial-verification-jobs")
@limiter.limit("10/minute")
async def create_financial_verification_job(
    payload: dict[str, Any],
    request: Request,
    service: CrdScrapeProxyService = Depends(get_crd_scrape_proxy_service),
) -> JSONResponse:
    result = await _call_provider(
        service.create_financial_verification_job(
            payload=payload,
            request_id=_request_id(request),
        )
    )
    return JSONResponse(status_code=result.status_code, content=result.payload)


@router.get("/financial-verification-jobs/{job_id}")
@limiter.limit("60/minute")
async def get_financial_verification_job(
    job_id: _JobId,
    request: Request,
    service: CrdScrapeProxyService = Depends(get_crd_scrape_proxy_service),
) -> JSONResponse:
    result = await _call_provider(
        service.get_financial_verification_job(
            job_id=job_id,
            request_id=_request_id(request),
        )
    )
    return JSONResponse(status_code=result.status_code, content=result.payload)


async def _call_provider(coro: Any) -> CrdScrapeProviderResponse:
    try:
        return await coro
    except ValueError:
        raise HTTPException(
            status_code=422,
            detail={"code": "CRD_INVALID_REQUEST", "message": "Invalid request parameters."},
        )
    except CrdScrapeProxyError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


def _request_id(request: Request) -> str | None:
    value = request.headers.get("x-request-id") or request.headers.get("x-cloud-trace-context")
    return str(value).strip() or None
