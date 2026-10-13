from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Any

import httpx

logger = logging.getLogger(__name__)

DEFAULT_RIA_INTELLIGENCE_API_BASE_URL = "https://hushh-ria-intelligence-api-yxfa6ba3aq-uc.a.run.app"
DEFAULT_RIA_INTELLIGENCE_TIMEOUT_SECONDS = 65.0


def _positive_float_env(name: str, default: float) -> float:
    raw_value = str(os.getenv(name) or "").strip()
    if not raw_value:
        return default
    try:
        value = float(raw_value)
    except ValueError:
        logger.warning("Invalid %s=%r; using default %.1fs", name, raw_value, default)
        return default
    if value <= 0:
        logger.warning("Invalid %s=%r; using default %.1fs", name, raw_value, default)
        return default
    return value


def normalize_crd_number(value: str | int | None) -> str:
    normalized = "".join(ch for ch in str(value or "") if ch.isdigit())
    if not normalized:
        raise ValueError("crdNumber must contain digits")
    if len(normalized) > 10:
        raise ValueError("crdNumber is too long")
    return normalized


def _resolve_base_url() -> str:
    return (
        (
            os.getenv("RIA_INTELLIGENCE_CRD_SCRAPER_BASE_URL")
            or os.getenv("RIA_INTELLIGENCE_VERIFY_BASE_URL")
            or DEFAULT_RIA_INTELLIGENCE_API_BASE_URL
        )
        .strip()
        .rstrip("/")
    )


@dataclass(frozen=True)
class CrdScrapeProviderResponse:
    status_code: int
    payload: dict[str, Any]


class CrdScrapeProxyError(RuntimeError):
    def __init__(self, message: str, *, status_code: int = 502) -> None:
        super().__init__(message)
        self.status_code = status_code


class CrdScrapeProxyService:
    """Thin Hushh Research backend facade for the RIA Intelligence CRD scraper."""

    def __init__(
        self,
        *,
        base_url: str | None = None,
        api_key: str | None = None,
        timeout_seconds: float | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._base_url = (base_url or _resolve_base_url()).strip().rstrip("/")
        self._api_key = (
            api_key
            if api_key is not None
            else os.getenv("RIA_INTELLIGENCE_CRD_SCRAPER_API_KEY", "")
        ).strip()
        self._timeout_seconds = (
            timeout_seconds
            if timeout_seconds is not None
            else _positive_float_env(
                "RIA_INTELLIGENCE_CRD_SCRAPER_TIMEOUT_SECONDS",
                DEFAULT_RIA_INTELLIGENCE_TIMEOUT_SECONDS,
            )
        )
        self._transport = transport

    async def create_job(
        self,
        *,
        crd_number: str,
        request_id: str | None = None,
    ) -> CrdScrapeProviderResponse:
        normalized_crd = normalize_crd_number(crd_number)
        return await self._request(
            "POST",
            "/v1/crd-scrape-jobs",
            json_payload={"crdNumber": normalized_crd},
            request_id=request_id,
        )

    async def get_job(
        self,
        *,
        job_id: str,
        request_id: str | None = None,
    ) -> CrdScrapeProviderResponse:
        normalized_job_id = str(job_id or "").strip()
        if not normalized_job_id:
            raise CrdScrapeProxyError("jobId is required", status_code=400)
        return await self._request(
            "GET", f"/v1/crd-scrape-jobs/{normalized_job_id}", request_id=request_id
        )

    async def broker_intelligence(
        self,
        *,
        query: str,
        request_id: str | None = None,
    ) -> CrdScrapeProviderResponse:
        if not query or not query.strip():
            raise ValueError("broker intelligence query must be non-empty")
        return await self._request(
            "POST",
            "/v1/ria/broker-intelligence",
            json_payload={"query": query.strip()},
            request_id=request_id,
        )

    async def create_financial_verification_job(
        self,
        *,
        payload: dict[str, Any],
        request_id: str | None = None,
    ) -> CrdScrapeProviderResponse:
        if not isinstance(payload, dict) or not payload:
            raise ValueError("financial verification payload must be a non-empty object")
        return await self._request(
            "POST",
            "/v1/financial-verification-jobs",
            json_payload=payload,
            request_id=request_id,
        )

    async def get_financial_verification_job(
        self,
        *,
        job_id: str,
        request_id: str | None = None,
    ) -> CrdScrapeProviderResponse:
        normalized_job_id = str(job_id or "").strip()
        if not normalized_job_id:
            raise CrdScrapeProxyError("jobId is required", status_code=400)
        return await self._request(
            "GET",
            f"/v1/financial-verification-jobs/{normalized_job_id}",
            request_id=request_id,
        )

    async def _request(
        self,
        method: str,
        path: str,
        *,
        json_payload: dict[str, Any] | None = None,
        request_id: str | None = None,
    ) -> CrdScrapeProviderResponse:
        if not self._base_url:
            raise CrdScrapeProxyError(
                "RIA Intelligence CRD scraper base URL is not configured", status_code=503
            )

        headers = {"Accept": "application/json"}
        if json_payload is not None:
            headers["Content-Type"] = "application/json"
        if self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"
        if request_id:
            headers["X-Request-ID"] = request_id

        try:
            async with httpx.AsyncClient(
                timeout=self._timeout_seconds,
                headers=headers,
                transport=self._transport,
            ) as client:
                response = await client.request(
                    method,
                    f"{self._base_url}{path}",
                    json=json_payload,
                )
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "crd_scrape.proxy_request_failed method=%s path=%s error=%s",
                method,
                path,
                type(exc).__name__,
            )
            raise CrdScrapeProxyError(
                "CRD scrape provider request failed", status_code=502
            ) from exc

        payload = await _json_or_error_payload(response)
        return CrdScrapeProviderResponse(status_code=response.status_code, payload=payload)


async def _json_or_error_payload(response: httpx.Response) -> dict[str, Any]:
    try:
        payload = response.json()
    except ValueError:
        payload = {
            "error": "CRD scrape provider returned a non-JSON response",
            "statusCode": response.status_code,
            "body": response.text[:500],
        }
    if isinstance(payload, dict):
        return payload
    return {"payload": payload}
