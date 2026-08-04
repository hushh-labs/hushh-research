"""Server-side proxy for the Advisors (FINRA BrokerCheck) directory API.

Keeps the directory bearer key on the backend. The frontend never sees it;
app code calls our own ``/api/one/advisors/*`` endpoints, which call this
service.

Why the upstream stream is consumed here rather than passed through: the
native shells enable ``CapacitorHttp``, which patches ``fetch`` and buffers the
whole body, so a client-side NDJSON reader would never yield progressively on
iOS/Android. Assembling here gives web and native one identical, testable JSON
contract. List rows are requested with ``detail=false`` because a search row
already carries everything a card needs; full profiles are fetched on demand.
"""

from __future__ import annotations

import json
import logging
import os
from collections.abc import Iterable
from typing import Any

import httpx

logger = logging.getLogger(__name__)

_DEFAULT_TIMEOUT_SECONDS = 20.0
_DEFAULT_RADIUS_MI = 10.0
_MIN_RADIUS_MI = 0.1
_MAX_RADIUS_MI = 100.0
_DEFAULT_LIMIT = 10
_MAX_LIMIT = 50

# CWE-400 bounds on an upstream stream we do not control. The upstream caps
# `limit` at 500 rows, so these ceilings sit far above any legitimate response
# while still refusing an unbounded body.
_MAX_STREAM_LINES = 4_000
_MAX_STREAM_BYTES = 8 * 1024 * 1024

_ADVISOR_TYPES = frozenset({"ia", "broker", "both"})


class AdvisorDirectoryError(RuntimeError):
    """Raised for a missing config (503), bad input (400) or upstream failure (502)."""

    def __init__(self, message: str, *, status_code: int) -> None:
        self.status_code = status_code
        super().__init__(message)


def _env(name: str, default: str = "") -> str:
    return str(os.getenv(name, default)).strip()


def base_url() -> str:
    return (_env("ADVISORS_API_BASE_URL") or _env("ADVISORS_API_BASE")).rstrip("/")


def is_configured() -> bool:
    return bool(base_url() and _env("ADVISORS_API_KEY"))


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


def _unique(values: Iterable[str | None], limit: int | None = None) -> list[str]:
    """Order-preserving dedupe, dropping blanks.

    ``limit`` is opt-in because the caller decides whether the list is being
    shown or counted. Truncating a list the UI reports as a count turns it into
    a wrong number: an adviser registered in 51 states rendered as "12".
    """
    seen: set[str] = set()
    out: list[str] = []
    for value in values:
        if not value or value in seen:
            continue
        seen.add(value)
        out.append(value)
        if limit is not None and len(out) >= limit:
            break
    return out


class AdvisorDirectoryService:
    """Async client for the advisors directory."""

    def __init__(self, *, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self._base_url = base_url()
        self._api_key = _env("ADVISORS_API_KEY")
        self._timeout = _coerce_float(_env("ADVISORS_API_TIMEOUT_SECONDS")) or (
            _DEFAULT_TIMEOUT_SECONDS
        )
        self._transport = transport

    # ---------------------------------------------------------------- internals

    def _client(self) -> httpx.AsyncClient:
        if not self._base_url or not self._api_key:
            raise AdvisorDirectoryError(
                "The advisor directory is not configured on this backend.",
                status_code=503,
            )
        return httpx.AsyncClient(
            base_url=self._base_url,
            timeout=httpx.Timeout(self._timeout, connect=5.0),
            headers={"Authorization": f"Bearer {self._api_key}"},
            transport=self._transport,
        )

    @staticmethod
    def _raise_for_status(status_code: int) -> None:
        """Map an upstream status onto a client-safe error.

        Auth failures are deliberately reported as an upstream failure: a 401
        here means *our* key is wrong, which is never the caller's business and
        must not teach a caller to retry with different credentials.
        """
        if status_code < 400:
            return
        if status_code == 400:
            raise AdvisorDirectoryError("That search could not be completed.", status_code=400)
        if status_code == 429:
            raise AdvisorDirectoryError(
                "The advisor directory is busy. Try again shortly.", status_code=429
            )
        if status_code in (401, 403):
            logger.error(
                "advisors.upstream_auth_rejected status=%s — check ADVISORS_API_KEY",
                status_code,
            )
        raise AdvisorDirectoryError(
            "The advisor directory is unavailable right now.", status_code=502
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
        advisor_type: str | None,
    ) -> dict[str, str]:
        params: dict[str, str] = {}

        if lat is not None and lng is not None:
            if not (-90.0 <= lat <= 90.0) or not (-180.0 <= lng <= 180.0):
                raise AdvisorDirectoryError("Those coordinates are not valid.", status_code=400)
            params["lat"] = f"{lat:.6f}"
            params["lng"] = f"{lng:.6f}"
        elif postal_code:
            normalized = "".join(ch for ch in postal_code if ch.isalnum())[:10]
            if not normalized:
                raise AdvisorDirectoryError("Enter a valid postal code.", status_code=400)
            params["postalCode"] = normalized
        else:
            raise AdvisorDirectoryError("A location or postal code is required.", status_code=400)

        params["radiusMi"] = (
            f"{_clamp(radius_mi or _DEFAULT_RADIUS_MI, _MIN_RADIUS_MI, _MAX_RADIUS_MI):.1f}"
        )
        params["limit"] = str(int(_clamp(float(limit or _DEFAULT_LIMIT), 1, _MAX_LIMIT)))
        params["offset"] = str(max(0, offset or 0))
        params["type"] = advisor_type if advisor_type in _ADVISOR_TYPES else "ia"
        params["status"] = "active"
        # A search row already carries name, firm, distance and disclosure flag,
        # so profile hydration is pure latency for a list. Profiles load on tap.
        params["detail"] = "false"
        params["firmContact"] = "true"
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
        advisor_type: str | None = None,
    ) -> dict[str, Any]:
        params = self._search_params(
            lat=lat,
            lng=lng,
            postal_code=postal_code,
            radius_mi=radius_mi,
            limit=limit,
            offset=offset,
            advisor_type=advisor_type,
        )

        meta: dict[str, Any] = {}
        rows: list[dict[str, Any]] = []
        grouped = False

        try:
            async with self._client() as client:
                async with client.stream("GET", "/v1/advisors", params=params) as response:
                    self._raise_for_status(response.status_code)

                    read_bytes = 0
                    read_lines = 0
                    async for line in response.aiter_lines():
                        if not line.strip():
                            continue
                        read_lines += 1
                        read_bytes += len(line)
                        if read_lines > _MAX_STREAM_LINES or read_bytes > _MAX_STREAM_BYTES:
                            logger.warning("advisors.stream_truncated lines=%s", read_lines)
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
                            grouped = bool(frame.get("grouped"))
                        elif frame_type in ("batch", "branches"):
                            if frame_type == "branches":
                                grouped = True
                            items = frame.get("items")
                            if isinstance(items, list):
                                rows.extend(item for item in items if isinstance(item, dict))
                        elif frame_type == "error":
                            raise AdvisorDirectoryError(
                                "The advisor directory is unavailable right now.",
                                status_code=502,
                            )
                        elif frame_type == "done":
                            break
        except httpx.HTTPError as exc:
            logger.warning("advisors.search_transport_error error=%s", type(exc).__name__)
            raise AdvisorDirectoryError(
                "The advisor directory is unavailable right now.", status_code=502
            ) from exc

        return {
            "items": [_normalize_row(row, grouped=grouped) for row in rows],
            "meta": _normalize_meta(meta, grouped=grouped, requested_limit=int(params["limit"])),
            "attribution": _ATTRIBUTION,
        }

    # ------------------------------------------------------------------ profile

    async def profile(self, crd: str) -> dict[str, Any]:
        normalized = "".join(ch for ch in str(crd or "") if ch.isdigit())[:12]
        if not normalized:
            raise AdvisorDirectoryError("That advisor id is not valid.", status_code=400)

        try:
            async with self._client() as client:
                response = await client.get(f"/v1/advisors/{normalized}")
                self._raise_for_status(response.status_code)
                payload = response.json()
        except AdvisorDirectoryError:
            raise
        except httpx.HTTPError as exc:
            logger.warning("advisors.profile_transport_error error=%s", type(exc).__name__)
            raise AdvisorDirectoryError(
                "That advisor could not be loaded.", status_code=502
            ) from exc
        except ValueError as exc:
            raise AdvisorDirectoryError(
                "That advisor could not be loaded.", status_code=502
            ) from exc

        if not isinstance(payload, dict):
            raise AdvisorDirectoryError("That advisor could not be loaded.", status_code=502)

        # The standalone endpoint answers {ok, profile, firm, attribution}; the
        # same record arrives flat inside a stream `detail` frame. Accept both
        # so this keeps working whichever one a caller hands us.
        record = payload.get("profile") if isinstance(payload.get("profile"), dict) else payload
        firm = payload.get("firm") if isinstance(payload.get("firm"), dict) else None
        return {
            "profile": _normalize_profile(record, firm=firm),
            "attribution": _ATTRIBUTION,
        }


_ATTRIBUTION = {
    "source": "FINRA BrokerCheck",
    "url": "https://brokercheck.finra.org",
}


def _normalize_meta(meta: dict[str, Any], *, grouped: bool, requested_limit: int) -> dict[str, Any]:
    next_offset = _coerce_int(meta.get("nextOffset"))
    radius = _coerce_float(meta.get("radiusMi"))
    radius_requested = _coerce_float(meta.get("radiusRequested"))
    return {
        "grouped": grouped,
        "hasMore": bool(meta.get("hasMore")),
        "nextOffset": next_offset if next_offset is not None else None,
        "returned": _coerce_int(meta.get("returned")) or 0,
        "available": _coerce_int(meta.get("available")),
        "limit": _coerce_int(meta.get("limit")) or requested_limit,
        "radiusMi": radius,
        "radiusRequested": radius_requested,
        "radiusAdjusted": bool(meta.get("radiusAdjusted")),
        "truncated": bool(meta.get("truncatedBy")),
    }


def _normalize_firm(firm: Any) -> dict[str, Any]:
    if not isinstance(firm, dict):
        return {}
    office = firm.get("officeAddress")
    office_city = office.get("city") if isinstance(office, dict) else None
    return {
        "firmId": _text(firm.get("firmId")),
        "firmName": _text(firm.get("firmName")),
        "phone": _text(firm.get("phone")),
        "city": _text(firm.get("branchCity")) or _text(office_city),
        "state": _text(firm.get("branchState")),
    }


def _text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _normalize_row(row: dict[str, Any], *, grouped: bool) -> dict[str, Any]:
    """Flatten a person row or a branch row onto one card shape.

    Adviser density varies ~25x at the same radius, so the upstream switches
    from people to branch offices in dense metros. One card shape means the UI
    never forks on which one arrived.
    """
    distance_miles = _coerce_float(row.get("distanceMiles"))
    if distance_miles is None:
        meters = _coerce_float(row.get("distanceMeters"))
        distance_miles = meters / 1609.344 if meters is not None else None

    if grouped:
        firm_name = _text(row.get("firmName"))
        nested = row.get("advisors")
        return {
            "kind": "branch",
            "id": _text(row.get("branchOfficeId"))
            or _text(row.get("firmId"))
            or firm_name
            or "branch",
            "name": firm_name,
            "firmName": None,
            "advisorCount": _coerce_int(row.get("advisorCount")),
            "advisorNames": [
                name
                for name in (
                    _text(item.get("name")) if isinstance(item, dict) else None
                    for item in (nested if isinstance(nested, list) else [])
                )
                if name
            ][:3],
            "distanceMiles": distance_miles,
            "city": _text(row.get("city")) or _text(row.get("branchCity")),
            "state": _text(row.get("state")) or _text(row.get("branchState")),
            "phone": _text(row.get("phone")),
        }

    firm = _normalize_firm(row.get("firm"))
    return {
        "kind": "advisor",
        "id": _text(row.get("crd")) or "",
        "crd": _text(row.get("crd")),
        "name": _text(row.get("name")),
        "firmName": firm.get("firmName"),
        "yearsExperience": _coerce_float(row.get("yearsExperience")),
        "hasDisclosures": bool(row.get("hasDisclosures")),
        "distanceMiles": distance_miles,
        "city": firm.get("city"),
        "state": firm.get("state"),
        "phone": firm.get("phone"),
    }


def _normalize_profile(
    profile: dict[str, Any], *, firm: dict[str, Any] | None = None
) -> dict[str, Any]:
    # The standalone endpoint states the current employer outright; a stream
    # `detail` frame does not, so fall back to the flagged firm-history entry.
    current_firm = _text(firm.get("firmName")) if isinstance(firm, dict) else None
    firm_history = profile.get("firmHistory")
    if not current_firm and isinstance(firm_history, list):
        for entry in firm_history:
            if isinstance(entry, dict) and entry.get("current"):
                current_firm = _text(entry.get("firmName"))
                break

    disclosures = profile.get("disclosures")
    branches = profile.get("branches")
    first_branch = branches[0] if isinstance(branches, list) and branches else None

    return {
        "crd": _text(profile.get("crd")),
        "name": _text(profile.get("name")),
        "firmName": current_firm,
        "yearsExperience": _coerce_float(profile.get("yearsExperience")),
        "firmCount": _coerce_int(profile.get("firmCount")),
        "isBarred": bool(profile.get("isBarred")),
        "hasDisclosures": bool(profile.get("hasDisclosures")),
        "disclosureCount": len(disclosures) if isinstance(disclosures, list) else 0,
        # One state appears once per registration scope (BC and IA), so the raw
        # list double-counts. The UI reports the length of this list, so it is
        # deduped but never truncated — a cap here would render as a wrong count.
        "states": _unique(
            _text(entry.get("state")) if isinstance(entry, dict) else None
            for entry in (
                profile.get("registeredStates")
                if isinstance(profile.get("registeredStates"), list)
                else []
            )
        ),
        "exams": _unique(
            _text(entry.get("category")) if isinstance(entry, dict) else None
            for entry in (profile.get("exams") if isinstance(profile.get("exams"), list) else [])
        ),
        "office": _normalize_branch_address(first_branch),
        "reportUrl": _text(profile.get("reportUrl")),
    }


def _normalize_branch_address(branch: Any) -> dict[str, Any] | None:
    if not isinstance(branch, dict):
        return None
    return {
        "street": _text(branch.get("street1")),
        "city": _text(branch.get("city")),
        "state": _text(branch.get("state")),
        "zip": _text(branch.get("zip")),
    }


__all__ = [
    "AdvisorDirectoryError",
    "AdvisorDirectoryService",
    "is_configured",
]
