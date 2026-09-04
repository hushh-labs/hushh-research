"""Server-side proxy for the Insurance Agents (Nationwide locator) directory API.

The sibling of ``advisor_directory_service``. Same reasons for every choice it
shares: the bearer key stays on the backend, and the upstream NDJSON stream is
consumed here rather than passed through because the native shells enable
``CapacitorHttp``, which patches ``fetch`` and buffers the whole body — a
client-side reader would never yield progressively on iOS/Android.

Two things differ from the advisor directory, both upstream facts rather than
choices:

* A search row is already complete — the locator returns full agency data
  inline — so there is no per-record detail fetch and no profile endpoint.
* The locator answers HTTP 200 with zero rows for a location it does not cover
  *and* for an unparseable postal code. Neither is an error, so neither is
  mapped to one; both surface as an empty list the UI can offer a way out of.

Scope: Nationwide agencies, which is what the locator covers. Not a
carrier-neutral feed, and the attribution says so.
"""

from __future__ import annotations

import json
import logging
import os
from datetime import UTC, datetime
from typing import Any

import httpx

logger = logging.getLogger(__name__)

# The locator sits behind bot protection and paces itself, so a cold query for a
# dense metro is measurably slower than a warm one. This matches the advisor
# directory's ceiling rather than inventing a second number to reason about.
_DEFAULT_TIMEOUT_SECONDS = 35.0
_DEFAULT_RADIUS_MI = 10.0
_MIN_RADIUS_MI = 0.1
_MAX_RADIUS_MI = 100.0
_DEFAULT_LIMIT = 10
_MAX_LIMIT = 50

# CWE-400 bounds on an upstream stream we do not control.
_MAX_STREAM_LINES = 4_000
_MAX_STREAM_BYTES = 8 * 1024 * 1024

# Every row in this directory is a Nationwide agency and the attribution line
# already says so, so the per-row repetition is noise in a list. Stripped for
# display only — the upstream id is what identifies the record.
_NAME_PREFIXES = ("Nationwide Insurance: ", "Nationwide Insurance - ")


class InsuranceAgentDirectoryError(RuntimeError):
    """Raised for a missing config (503), bad input (400) or upstream failure (502)."""

    def __init__(
        self,
        message: str,
        *,
        status_code: int,
        retry_after_seconds: int | None = None,
    ) -> None:
        self.status_code = status_code
        self.retry_after_seconds = retry_after_seconds
        super().__init__(message)


def _env(name: str, default: str = "") -> str:
    return str(os.getenv(name, default)).strip()


def base_url() -> str:
    return (_env("INSURANCE_AGENTS_API_BASE_URL") or _env("INSURANCE_AGENTS_API_BASE")).rstrip("/")


def is_configured() -> bool:
    return bool(base_url() and _env("INSURANCE_AGENTS_API_KEY"))


def _coerce_float(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed == parsed else None  # reject NaN


def _coerce_int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def _text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


class InsuranceAgentDirectoryService:
    """Async client for the insurance agent directory."""

    def __init__(self, *, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self._base_url = base_url()
        self._api_key = _env("INSURANCE_AGENTS_API_KEY")
        self._timeout = _coerce_float(_env("INSURANCE_AGENTS_API_TIMEOUT_SECONDS")) or (
            _DEFAULT_TIMEOUT_SECONDS
        )
        self._transport = transport

    # ---------------------------------------------------------------- internals

    def _client(self) -> httpx.AsyncClient:
        if not self._base_url or not self._api_key:
            raise InsuranceAgentDirectoryError(
                "The insurance agent directory is not configured on this backend.",
                status_code=503,
            )
        return httpx.AsyncClient(
            base_url=self._base_url,
            timeout=httpx.Timeout(self._timeout, connect=5.0),
            headers={"Authorization": f"Bearer {self._api_key}"},
            transport=self._transport,
        )

    @staticmethod
    def _raise_for_status(status_code: int, headers: Any = None) -> None:
        """Map an upstream status onto a client-safe error.

        A 401 here means *our* key is wrong, which is never the caller's
        business and must not teach a caller to retry with different
        credentials — so it is reported as an upstream failure, not as auth.
        """
        if status_code < 400:
            return
        if status_code == 400:
            raise InsuranceAgentDirectoryError(
                "That search could not be completed.", status_code=400
            )
        if status_code == 429:
            # The upstream limit is per-IP and every user shares this backend's
            # egress address, so its Retry-After applies to the whole surface.
            retry_after = None
            if headers is not None:
                try:
                    retry_after = _coerce_int(headers.get("retry-after"))
                except (AttributeError, TypeError):
                    retry_after = None
            raise InsuranceAgentDirectoryError(
                "The insurance agent directory is busy. Try again shortly.",
                status_code=429,
                retry_after_seconds=retry_after,
            )
        if status_code in (401, 403):
            logger.error(
                "insurance_agents.upstream_auth_rejected status=%s"
                " — check INSURANCE_AGENTS_API_KEY",
                status_code,
            )
        raise InsuranceAgentDirectoryError(
            "The insurance agent directory is unavailable right now.", status_code=502
        )

    # ------------------------------------------------------------------- search

    def _search_params(
        self,
        *,
        lat: float | None,
        lng: float | None,
        postal_code: str | None,
        radius_mi: float | None,
        limit: int | None,
        offset: int | None,
    ) -> dict[str, str]:
        params: dict[str, str] = {}

        if lat is not None and lng is not None:
            if not (-90.0 <= lat <= 90.0) or not (-180.0 <= lng <= 180.0):
                raise InsuranceAgentDirectoryError(
                    "Those coordinates are not valid.", status_code=400
                )
            params["lat"] = f"{lat:.6f}"
            params["lng"] = f"{lng:.6f}"
        elif postal_code:
            normalized = "".join(ch for ch in postal_code if ch.isalnum())[:10]
            if not normalized:
                raise InsuranceAgentDirectoryError("Enter a valid postal code.", status_code=400)
            params["postalCode"] = normalized
        else:
            raise InsuranceAgentDirectoryError(
                "A location or postal code is required.", status_code=400
            )

        params["radiusMi"] = (
            f"{_clamp(radius_mi or _DEFAULT_RADIUS_MI, _MIN_RADIUS_MI, _MAX_RADIUS_MI):.1f}"
        )
        params["limit"] = str(int(_clamp(float(limit or _DEFAULT_LIMIT), 1, _MAX_LIMIT)))
        params["offset"] = str(max(0, offset or 0))
        params["stream"] = "ndjson"
        return params

    async def search(
        self,
        *,
        lat: float | None = None,
        lng: float | None = None,
        postal_code: str | None = None,
        radius_mi: float | None = None,
        limit: int | None = None,
        offset: int | None = None,
    ) -> dict[str, Any]:
        params = self._search_params(
            lat=lat,
            lng=lng,
            postal_code=postal_code,
            radius_mi=radius_mi,
            limit=limit,
            offset=offset,
        )

        meta: dict[str, Any] = {}
        rows: list[dict[str, Any]] = []

        try:
            async with self._client() as client:
                async with client.stream("GET", "/v1/agents", params=params) as response:
                    self._raise_for_status(response.status_code, response.headers)

                    read_bytes = 0
                    read_lines = 0
                    async for line in response.aiter_lines():
                        if not line.strip():
                            continue
                        read_lines += 1
                        read_bytes += len(line)
                        if read_lines > _MAX_STREAM_LINES or read_bytes > _MAX_STREAM_BYTES:
                            logger.warning("insurance_agents.stream_truncated lines=%s", read_lines)
                            break
                        try:
                            frame = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        if not isinstance(frame, dict):
                            continue

                        frame_type = frame.get("type")
                        if frame_type == "meta":
                            meta = frame
                        elif frame_type == "batch":
                            items = frame.get("items")
                            if isinstance(items, list):
                                rows.extend(item for item in items if isinstance(item, dict))
                        elif frame_type == "error":
                            # A terminal error frame arrives on an HTTP 200 body,
                            # so the status alone never reveals it.
                            raise InsuranceAgentDirectoryError(
                                "The insurance agent directory is unavailable right now.",
                                status_code=502,
                            )
                        elif frame_type == "done":
                            break
        except httpx.HTTPError as exc:
            logger.warning("insurance_agents.search_transport_error error=%s", type(exc).__name__)
            raise InsuranceAgentDirectoryError(
                "The insurance agent directory is unavailable right now.", status_code=502
            ) from exc

        return {
            "items": [_normalize_row(row) for row in rows],
            "meta": _normalize_meta(meta, requested_limit=int(params["limit"])),
            "attribution": _normalize_attribution(meta.get("attribution")),
        }


# Used only when the upstream omits its own block. The locator's own credit
# carries a source, a link and a notice — and, unlike BrokerCheck, no terms or
# error-reporting URL. Inventing either would be worse than omitting it, so the
# shape here is exactly what the source actually provides.
_ATTRIBUTION_FALLBACK = {
    "source": "Nationwide Agency Locator",
    "sourceUrl": "https://agency.nationwide.com",
    "notice": "Agency data retrieved from the Nationwide agency locator.",
}


def _normalize_attribution(attribution: Any) -> dict[str, Any]:
    """Carry the upstream's own credit through, field for field.

    ``retrievedAt`` is stamped here because it is when *this* response was
    produced; a warm upstream cache can be up to a day older, which is why
    ``meta.cache`` travels alongside it.
    """
    block = dict(_ATTRIBUTION_FALLBACK)
    if isinstance(attribution, dict):
        for key in ("source", "sourceUrl", "termsUrl", "notice", "errorReporting"):
            value = _text(attribution.get(key))
            if value:
                block[key] = value
    block["retrievedAt"] = datetime.now(UTC).isoformat()
    return block


def _normalize_meta(meta: dict[str, Any], *, requested_limit: int) -> dict[str, Any]:
    next_offset = _coerce_int(meta.get("nextOffset"))
    resolved = meta.get("resolvedLocation")
    resolved_location = None
    if isinstance(resolved, dict):
        city = _text(resolved.get("city"))
        state = _text(resolved.get("state"))
        zip_code = _text(resolved.get("zip"))
        # An uncovered coordinate resolves to a row of empty strings. A block of
        # all-None is indistinguishable from having resolved nothing, and the UI
        # would render an empty "in  ,  " label — so it is dropped outright.
        if city or state or zip_code:
            resolved_location = {"city": city, "state": state, "zip": zip_code}

    return {
        "hasMore": bool(meta.get("hasMore")),
        "nextOffset": next_offset if next_offset is not None else None,
        "returned": _coerce_int(meta.get("returned")) or 0,
        # `available` is what the upstream actually ranked and can page through.
        # `estimatedTotal` is the locator's count for the whole query and is
        # larger whenever `truncatedBy` is set — showing it would promise rows
        # this API cannot deliver, so it is deliberately not carried forward.
        "available": _coerce_int(meta.get("available")),
        "limit": _coerce_int(meta.get("limit")) or requested_limit,
        # "cold" | "warm". A warm result can trail the locator by up to the
        # upstream's 24h query cache, which is why it is disclosed, not hidden.
        "cache": _text(meta.get("cache")),
        "radiusMi": _coerce_float(meta.get("radiusMi")),
        "truncated": bool(meta.get("truncatedBy")),
        "resolvedLocation": resolved_location,
    }


def _display_name(value: Any) -> str | None:
    name = _text(value)
    if not name:
        return None
    for prefix in _NAME_PREFIXES:
        if name.startswith(prefix):
            # Only strip when something survives: a row literally named
            # "Nationwide Insurance" must not become an empty card.
            remainder = name[len(prefix) :].strip()
            if remainder:
                return remainder
    return name


def _normalize_address(address: Any) -> dict[str, Any] | None:
    if not isinstance(address, dict):
        return None
    block = {
        "line1": _text(address.get("line1")),
        "line2": _text(address.get("line2")),
        "city": _text(address.get("city")),
        "region": _text(address.get("region")),
        "postalCode": _text(address.get("postalCode")),
        "formatted": _text(address.get("formatted")),
    }
    return block if any(block.values()) else None


_WEEKDAYS = ("MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY")


def _normalize_hours(hours: Any) -> dict[str, Any] | None:
    """Opening hours, kept as posted rather than judged against a clock.

    The locator gives times as bare HHMM integers with no timezone, and the
    reader is routinely in a different one — this app is used from India against
    US agencies. So no "open now" is derived anywhere: that would need the
    agency's timezone, which is not in the payload, and a wrong answer here
    sends someone to call a closed office.

    About one agency in ten posts anything at all, so the whole block is dropped
    when empty rather than rendering an "Hours" heading with nothing under it.
    """
    if not isinstance(hours, dict):
        return None

    days: list[dict[str, Any]] = []
    for entry in hours.get("days") if isinstance(hours.get("days"), list) else []:
        if not isinstance(entry, dict):
            continue
        day = _text(entry.get("day"))
        if not day or day.upper() not in _WEEKDAYS:
            continue
        intervals = [
            {"start": start, "end": end}
            for start, end in (
                (_coerce_int(i.get("start")), _coerce_int(i.get("end")))
                for i in (
                    entry.get("intervals") if isinstance(entry.get("intervals"), list) else []
                )
                if isinstance(i, dict)
            )
            if start is not None and end is not None
        ]
        # A day with no intervals is a real answer — "closed" — so it is kept.
        days.append({"day": day.upper(), "intervals": intervals})

    note = _text(hours.get("additionalText"))
    if not days and not note:
        return None
    return {"days": days, "note": note}


def _normalize_row(row: dict[str, Any]) -> dict[str, Any]:
    """Flatten one locator row onto the card shape the app renders."""
    distance_miles = _coerce_float(row.get("distanceMiles"))
    if distance_miles is None:
        meters = _coerce_float(row.get("distanceMeters"))
        distance_miles = meters / 1609.344 if meters is not None else None

    address = _normalize_address(row.get("address"))
    products = [
        product
        for product in (
            _text(item)
            for item in (row.get("products") if isinstance(row.get("products"), list) else [])
        )
        if product
    ]

    return {
        "id": _text(row.get("id")) or "",
        "name": _display_name(row.get("name")),
        "phone": _text(row.get("phone")),
        "email": _text(row.get("email")),
        "website": _text(row.get("website")),
        "products": products,
        "agencyType": _text(row.get("agencyType")),
        "tier": _text(row.get("tier")),
        "hours": _normalize_hours(row.get("hours")),
        "distanceMiles": distance_miles,
        "address": address,
        "city": address.get("city") if address else None,
        "state": address.get("region") if address else None,
    }


__all__ = [
    "InsuranceAgentDirectoryError",
    "InsuranceAgentDirectoryService",
    "is_configured",
]
