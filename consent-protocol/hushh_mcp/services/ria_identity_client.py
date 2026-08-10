"""HTTP client for the RIA Identity API (phone → SEC firm + adviser claim targets).

The upstream service resolves a NANP phone number to the SEC-registered firm and
advisers currently filed at that number, and scores claim evidence our backend
asserts (``phone_otp``). The bearer key stays server-side; browsers never call
the upstream directly.
"""

from __future__ import annotations

import logging
import os
from typing import Any

import httpx

logger = logging.getLogger(__name__)


class RIAIdentityNotConfiguredError(Exception):
    """The RIA Identity API base URL is not configured in this environment."""


class RIAIdentityUnavailableError(Exception):
    """The RIA Identity API could not be reached or returned a server fault."""


class RIAIdentityRequestError(Exception):
    """The RIA Identity API rejected the request (4xx)."""

    def __init__(self, message: str, *, status_code: int, field: str | None = None):
        super().__init__(message)
        self.status_code = status_code
        self.field = field


class RIAIdentityClient:
    """Thin async client mirroring the adapter pattern in ``ria_verification``."""

    def __init__(self, *, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self._base_url = str(os.getenv("RIA_IDENTITY_BASE_URL", "")).strip().rstrip("/")
        self._api_key = str(os.getenv("RIA_IDENTITY_API_KEY", "")).strip()
        self._timeout_seconds = float(os.getenv("RIA_IDENTITY_TIMEOUT_SECONDS", "30"))
        self._transport = transport

    @property
    def configured(self) -> bool:
        return bool(self._base_url)

    def _headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"
        return headers

    async def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json_body: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        if not self._base_url:
            raise RIAIdentityNotConfiguredError(
                "RIA_IDENTITY_BASE_URL is not configured in this environment."
            )
        url = f"{self._base_url}{path}"
        try:
            async with httpx.AsyncClient(
                timeout=self._timeout_seconds,
                transport=self._transport,
                headers=self._headers(),
            ) as client:
                response = await client.request(method, url, params=params, json=json_body)
        except httpx.HTTPError as exc:
            logger.warning("ria_identity.request_failed path=%s error=%s", path, type(exc).__name__)
            raise RIAIdentityUnavailableError(
                "The RIA identity service could not be reached."
            ) from exc

        payload: dict[str, Any] | None
        try:
            parsed = response.json()
            payload = parsed if isinstance(parsed, dict) else None
        except ValueError:
            payload = None

        if response.status_code >= 500:
            logger.warning(
                "ria_identity.upstream_fault path=%s status=%s", path, response.status_code
            )
            raise RIAIdentityUnavailableError("The RIA identity service returned a fault.")
        if response.status_code >= 400:
            message = "The RIA identity service rejected the request."
            field: str | None = None
            if isinstance(payload, dict):
                message = str(payload.get("error") or payload.get("message") or message)
                raw_field = payload.get("field")
                field = str(raw_field) if raw_field else None
            raise RIAIdentityRequestError(message, status_code=response.status_code, field=field)
        if payload is None:
            raise RIAIdentityUnavailableError(
                "The RIA identity service returned an unreadable payload."
            )
        return payload

    async def claim_lookup(
        self,
        phone: str,
        *,
        mode: str = "auto",
        limit: int = 10,
        detail: bool = False,
    ) -> dict[str, Any]:
        """Resolve a phone number to firm + adviser claim targets (buffered).

        ``detail=True`` hydrates each candidate with its full public record
        (exams, state registrations, employment history, branch offices), which
        is what lets a claimed profile be built without asking any questions.
        """
        params: dict[str, Any] = {
            "phone": phone,
            "mode": mode,
            "limit": limit,
            "stream": "off",
        }
        if detail:
            params["detail"] = 1
        return await self._request("GET", "/v1/claim/lookup", params=params)

    async def advisor_record(self, individual_crd: int) -> dict[str, Any]:
        """One adviser's full public regulatory record."""
        return await self._request("GET", f"/v1/advisors/{individual_crd}")

    async def claim_evaluate(
        self,
        *,
        phone: str,
        claim_type: str,
        firm_crd: int,
        individual_crd: int | None = None,
        assert_phone_otp: bool = False,
        extra_evidence: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        """Score a claim. ``assert_phone_otp`` must only ever be set after this
        backend has itself verified possession of the filed number, and every
        entry in ``extra_evidence`` only after this backend has itself verified
        the signal it asserts (e.g. a ``domain_email`` alias the user proved
        they control)."""
        body: dict[str, Any] = {
            "phone": phone,
            "claimType": claim_type,
            "firmCrd": firm_crd,
        }
        if individual_crd is not None:
            body["individualCrd"] = individual_crd
        if assert_phone_otp:
            body["evidence"] = [{"signal": "phone_otp"}]
        if extra_evidence:
            body.setdefault("evidence", []).extend(extra_evidence)
        return await self._request("POST", "/v1/claim/evaluate", json_body=body)
