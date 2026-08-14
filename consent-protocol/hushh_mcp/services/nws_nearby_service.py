"""Server-side proxy for the NWS Nearby Intelligence API.

Keeps the ``X-NWS-API-Key`` on the backend. The frontend never sees it; RIA app
code calls our own ``/api/ria/nearby/*`` endpoints, which call this service.

Two properties of the upstream shape this module.

It scales to zero with no minimum instance, so the first request after an idle
period pays a cold start (measured ~6s against ~0.35s warm). And it rate-limits
on ``{api_key}:{client_ip}`` in process, so every Hushh caller in the world
arrives on this backend's egress address under one key — the upstream's 60/min
is the whole surface's budget, not one user's. Both are why responses are
cached here rather than proxied straight through: the approved dataset is a
handful of reviewed records that change only when the upstream redeploys, so a
repeat query has nothing to gain from a second call and everything to lose.

Coverage is never rewritten. A location outside an approved market comes back
``NOT_COVERED`` with an empty result set, and that is a correct answer, not an
error — it is passed to the caller intact so the UI can say so honestly rather
than substituting a fallback market.
"""

from __future__ import annotations

import logging
import os
import time
from typing import Any

import httpx

logger = logging.getLogger(__name__)

# Sized for a scale-to-zero cold start plus the upstream's own work, with the
# read timeout well clear of the ~6s cold path measured against production.
_DEFAULT_TIMEOUT_SECONDS = 25.0

# The upstream coarsens coordinates to 2dp before retrieval and does not log
# the raw value. Rounding here means the precise coordinate never leaves this
# process either, so no upstream access log can record one we sent.
_COORDINATE_DECIMALS = 2

_DISCOVER_PATH = "/v2/nearby-network/discover"

_LANES = frozenset({"BUILDER", "CAPITAL", "KNOWLEDGE", "CIVIC", "CONNECTOR", "GENERAL"})
_CONFIDENCE_GRADES = frozenset({"A", "B", "C", "D"})
_MAX_TAGS = 20

# A covered answer can change when the upstream publishes a new snapshot; an
# uncovered one cannot change until a whole market is approved and deployed,
# which is a human-reviewed event measured in weeks. Caching the second for
# longer costs nothing and absorbs the common case of a caller outside any
# approved market retrying.
_COVERED_TTL_SECONDS = 300.0
_UNCOVERED_TTL_SECONDS = 1800.0
# Bounded so a spray of distinct coordinates cannot grow this without limit
# (CWE-400). Far above the working set of any real browsing session.
_MAX_CACHE_ENTRIES = 512


class NwsNearbyError(RuntimeError):
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
    return _env("NWS_NEARBY_API_BASE_URL").rstrip("/")


def is_configured() -> bool:
    return bool(base_url() and _env("NWS_NEARBY_API_KEY"))


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


class _ResponseCache:
    """Tiny TTL cache keyed on the normalized query.

    Process-local by design. The payload is public-record data with no user
    identifier in it, and the key is built from the query alone, so an entry is
    never scoped to a caller and cannot leak one caller's context to another.
    """

    def __init__(self) -> None:
        self._entries: dict[str, tuple[float, dict[str, Any]]] = {}

    def get(self, key: str, *, now: float) -> dict[str, Any] | None:
        entry = self._entries.get(key)
        if entry is None:
            return None
        expires_at, payload = entry
        if now >= expires_at:
            self._entries.pop(key, None)
            return None
        return payload

    def set(self, key: str, payload: dict[str, Any], *, ttl: float, now: float) -> None:
        if len(self._entries) >= _MAX_CACHE_ENTRIES:
            # Drop whatever expires soonest rather than tracking access order:
            # the working set is tiny and this keeps the structure a plain dict.
            oldest = min(self._entries, key=lambda item: self._entries[item][0])
            self._entries.pop(oldest, None)
        self._entries[key] = (now + ttl, payload)

    def clear(self) -> None:
        self._entries.clear()


_cache = _ResponseCache()


def reset_cache() -> None:
    """Drop every cached response. Used by tests; safe at runtime."""
    _cache.clear()


class NwsNearbyService:
    """Async client for the NWS Nearby Intelligence discovery API."""

    def __init__(
        self,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        use_cache: bool = True,
    ) -> None:
        self._base_url = base_url()
        self._api_key = _env("NWS_NEARBY_API_KEY")
        self._timeout = (
            _coerce_float(_env("NWS_NEARBY_API_TIMEOUT_SECONDS")) or _DEFAULT_TIMEOUT_SECONDS
        )
        self._transport = transport
        self._use_cache = use_cache

    # ---------------------------------------------------------------- internals

    def _client(self) -> httpx.AsyncClient:
        if not self._base_url or not self._api_key:
            raise NwsNearbyError(
                "Nearby intelligence is not configured on this backend.",
                status_code=503,
            )
        return httpx.AsyncClient(
            base_url=self._base_url,
            timeout=httpx.Timeout(self._timeout, connect=5.0),
            headers={"X-NWS-API-Key": self._api_key},
            transport=self._transport,
        )

    @staticmethod
    def _raise_for_status(status_code: int, headers: Any = None) -> None:
        """Map an upstream status onto a client-safe error.

        A 401 here means *our* key is wrong. That is never the caller's
        business and must not teach a client to retry with credentials of its
        own, so it is reported as an upstream failure and logged for us.
        """
        if status_code < 400:
            return
        if status_code == 422:
            # The upstream re-validates what we already validated. Reaching this
            # means our request builder and its contract have diverged.
            logger.error("nws_nearby.upstream_rejected_request status=422")
            raise NwsNearbyError("That search could not be completed.", status_code=502)
        if status_code == 429:
            retry_after = None
            if headers is not None:
                try:
                    retry_after = _coerce_int(headers.get("retry-after"))
                except (AttributeError, TypeError):
                    retry_after = None
            raise NwsNearbyError(
                "Nearby intelligence is busy. Try again shortly.",
                status_code=429,
                retry_after_seconds=retry_after,
            )
        if status_code in (401, 403):
            logger.error(
                "nws_nearby.upstream_auth_rejected status=%s — check NWS_NEARBY_API_KEY",
                status_code,
            )
        raise NwsNearbyError("Nearby intelligence is unavailable right now.", status_code=502)

    # ------------------------------------------------------------------ request

    def build_query(
        self,
        *,
        latitude: float | None,
        longitude: float | None,
        postal_code: str | None,
        country_code: str | None,
    ) -> dict[str, Any]:
        """Build the upstream ``query`` block, or reject the input.

        The upstream forbids extra keys and requires postal XOR coordinates, so
        a malformed request is refused here rather than spent against a shared
        upstream quota.
        """
        has_coordinates = latitude is not None or longitude is not None
        has_postal = bool(postal_code)

        if has_coordinates and has_postal:
            raise NwsNearbyError("Send a postal code or coordinates, not both.", status_code=400)
        if not has_coordinates and not has_postal:
            raise NwsNearbyError("A location is required.", status_code=400)

        normalized_country = (country_code or "").strip().upper() or None
        if normalized_country is not None and (
            len(normalized_country) != 2 or not normalized_country.isalpha()
        ):
            raise NwsNearbyError("That country code is not valid.", status_code=400)

        if has_coordinates:
            if latitude is None or longitude is None:
                raise NwsNearbyError(
                    "Latitude and longitude must be sent together.", status_code=400
                )
            if not (-90.0 <= latitude <= 90.0) or not (-180.0 <= longitude <= 180.0):
                raise NwsNearbyError("Those coordinates are not valid.", status_code=400)
            query: dict[str, Any] = {
                "latitude": round(latitude, _COORDINATE_DECIMALS),
                "longitude": round(longitude, _COORDINATE_DECIMALS),
            }
            # A country context that disagrees with the coordinate suppresses
            # results outright (COUNTRY_CONTEXT_DOES_NOT_MATCH_APPROVED_MARKET).
            # We do no reverse geocoding, so we have no country *fact* to send
            # for a coordinate — attaching a guess would hide real results from
            # a caller whose device locale differs from where they are standing.
            return query

        normalized_postal = str(postal_code or "").strip().upper()
        if not 3 <= len(normalized_postal) <= 16 or not all(
            ch.isalnum() or ch in {" ", "-"} for ch in normalized_postal
        ):
            raise NwsNearbyError("Enter a valid postal code.", status_code=400)

        # The upstream requires a country with every postal code except the
        # legacy US bootstrap value, which it still accepts bare.
        if normalized_country is None and normalized_postal != "98033":
            raise NwsNearbyError("A country is required with a postal code.", status_code=400)

        postal_query: dict[str, Any] = {"postal_code": normalized_postal}
        if normalized_country is not None:
            postal_query["country_code"] = normalized_country
        return postal_query

    def build_filters(
        self,
        *,
        lanes: list[str] | None,
        tags: list[str] | None,
        minimum_confidence_grade: str | None,
    ) -> dict[str, Any]:
        normalized_lanes: list[str] = []
        for lane in lanes or []:
            candidate = str(lane or "").strip().upper()
            if candidate not in _LANES:
                raise NwsNearbyError("That focus is not recognised.", status_code=400)
            if candidate not in normalized_lanes:
                normalized_lanes.append(candidate)

        normalized_tags: list[str] = []
        for tag in tags or []:
            candidate = str(tag or "").strip()
            if not candidate:
                continue
            if candidate not in normalized_tags:
                normalized_tags.append(candidate)
        if len(normalized_tags) > _MAX_TAGS:
            raise NwsNearbyError("Too many sectors selected.", status_code=400)

        grade = str(minimum_confidence_grade or "B").strip().upper()
        if grade not in _CONFIDENCE_GRADES:
            raise NwsNearbyError("That confidence grade is not recognised.", status_code=400)

        return {
            "lanes": normalized_lanes,
            "tags": normalized_tags,
            "minimum_confidence_grade": grade,
        }

    # ----------------------------------------------------------------- discover

    async def discover(
        self,
        *,
        latitude: float | None = None,
        longitude: float | None = None,
        postal_code: str | None = None,
        country_code: str | None = None,
        top_n: int = 100,
        initial_radius_km: float = 20.0,
        max_radius_km: float = 100.0,
        lanes: list[str] | None = None,
        tags: list[str] | None = None,
        minimum_confidence_grade: str | None = None,
    ) -> dict[str, Any]:
        query = self.build_query(
            latitude=latitude,
            longitude=longitude,
            postal_code=postal_code,
            country_code=country_code,
        )
        filters = self.build_filters(
            lanes=lanes,
            tags=tags,
            minimum_confidence_grade=minimum_confidence_grade,
        )

        if not 1 <= top_n <= 400:
            raise NwsNearbyError("That result count is out of range.", status_code=400)
        if not 0 < initial_radius_km <= 250:
            raise NwsNearbyError("That radius is out of range.", status_code=400)
        if not 0 < max_radius_km <= 500 or max_radius_km < initial_radius_km:
            raise NwsNearbyError("That maximum radius is out of range.", status_code=400)

        body: dict[str, Any] = {
            "query": query,
            "top_n": top_n,
            "initial_radius_km": initial_radius_km,
            "max_radius_km": max_radius_km,
            "filters": filters,
        }

        cache_key = repr(sorted(_flatten(body).items()))
        now = time.monotonic()
        if self._use_cache:
            cached = _cache.get(cache_key, now=now)
            if cached is not None:
                return cached

        try:
            async with self._client() as client:
                response = await client.post(_DISCOVER_PATH, json=body)
                self._raise_for_status(response.status_code, response.headers)
                payload = response.json()
        except NwsNearbyError:
            raise
        except httpx.HTTPError as exc:
            logger.warning("nws_nearby.discover_transport_error error=%s", type(exc).__name__)
            raise NwsNearbyError(
                "Nearby intelligence is unavailable right now.", status_code=502
            ) from exc
        except ValueError as exc:
            raise NwsNearbyError(
                "Nearby intelligence is unavailable right now.", status_code=502
            ) from exc

        if not isinstance(payload, dict):
            raise NwsNearbyError("Nearby intelligence is unavailable right now.", status_code=502)

        normalized = _normalize_discovery(payload)
        if self._use_cache:
            covered = normalized.get("coverage", {}).get("status") == "COVERED"
            _cache.set(
                cache_key,
                normalized,
                ttl=_COVERED_TTL_SECONDS if covered else _UNCOVERED_TTL_SECONDS,
                now=now,
            )
        return normalized


def _flatten(value: Any, prefix: str = "") -> dict[str, Any]:
    """Flatten a nested request body into scalar leaves for a stable cache key."""
    out: dict[str, Any] = {}
    if isinstance(value, dict):
        for key, item in value.items():
            out.update(_flatten(item, f"{prefix}.{key}" if prefix else str(key)))
    elif isinstance(value, list):
        for index, item in enumerate(value):
            out.update(_flatten(item, f"{prefix}[{index}]"))
    else:
        out[prefix] = value
    return out


def _text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _normalize_discovery(payload: dict[str, Any]) -> dict[str, Any]:
    """Reshape the upstream response for the app, preserving coverage exactly.

    Coverage is the one block that is carried through field-for-field. Anything
    that trimmed or reinterpreted it would risk turning an honest "we have no
    data here" into something that reads like a failure or, worse, a result.
    """
    coverage = _as_dict(payload.get("coverage"))
    snapshot = _as_dict(payload.get("snapshot"))
    summary = _as_dict(payload.get("summary"))
    results = [item for item in _as_list(payload.get("results")) if isinstance(item, dict)]

    return {
        "coverage": {
            "status": _text(coverage.get("status")) or "NOT_COVERED",
            "reasonCode": _text(coverage.get("reason_code")),
            "marketId": _text(coverage.get("market_id")),
            "marketLabel": _text(coverage.get("market_label")),
            "countryCode": _text(coverage.get("country_code")),
            "message": _text(coverage.get("message")),
            "complete": bool(coverage.get("complete")),
        },
        "snapshot": {
            "scoreStatus": _text(snapshot.get("score_status")),
            "complete": bool(snapshot.get("complete")),
            "modelVersion": _text(snapshot.get("model_version")),
            "dataMode": _text(snapshot.get("data_mode")),
            "verifiedAt": _text(snapshot.get("verified_at")),
        },
        "summary": {
            "returnedCount": _coerce_int(summary.get("returned_count")) or 0,
            "candidateCount": _coerce_int(summary.get("verified_seed_candidate_count")) or 0,
            "searchPerformed": bool(summary.get("search_performed")),
            "effectiveRadiusKm": _coerce_float(summary.get("effective_radius_km")),
        },
        "release": _normalize_release(payload.get("release")),
        "reviewScope": _normalize_review_scope(payload.get("discovery")),
        "financialContext": _normalize_financial_context(payload.get("financial_context")),
        "scoreDefinition": _text(payload.get("score_definition")),
        "results": [_normalize_result(item) for item in results],
    }


def _normalize_release(value: Any) -> dict[str, Any] | None:
    """Which reviewed release answered, so an advisor can cite what they saw."""
    block = _as_dict(value)
    release_id = _text(block.get("release_id"))
    if not release_id:
        return None
    return {
        "releaseId": release_id,
        "sourceRetrievedAt": _text(block.get("source_retrieved_at")),
        "sourcePolicyVersion": _text(block.get("source_policy_version")),
    }


def _normalize_review_scope(value: Any) -> dict[str, Any] | None:
    """How much of the market has actually been reviewed.

    Sixty records in one postcode reads like everyone there. It is thirteen
    reviewed organisations, and the release says so rather than leaving the
    count to imply a census.
    """
    block = _as_dict(value)
    if not block:
        return None
    return {
        "organizationAnchorCount": _coerce_int(block.get("organization_anchor_count")),
        "marketCensusComplete": bool(block.get("market_census_complete")),
    }


def _normalize_financial_context(value: Any) -> dict[str, Any] | None:
    """The service's own statement that none of this is about money.

    Carried because the surface renders a component literally named "capital
    access" to advisers whose job is assessing whether someone can invest.
    That is the one reading this product must not invite, and the sentence
    that prevents it belongs next to the number rather than in a document.
    """
    block = _as_dict(value)
    status = _text(block.get("status"))
    if not status:
        return None
    return {
        "status": status,
        "capitalAccessNote": _text(block.get("nws_capital_access_component")),
        "notUsedForRanking": [
            text
            for text in (_text(item) for item in _as_list(block.get("not_used_for_ranking")))
            if text
        ],
    }


def _normalize_result(row: dict[str, Any]) -> dict[str, Any]:
    """Flatten one ranked record onto the shape the RIA list and sheet render.

    ``nearbyRankScore`` is what the upstream orders by, and ``globalNws`` is the
    person's standing score — they disagree often enough that showing the second
    in the first's order reads as a sorting bug. Both travel so the UI can rank
    by one and label the other.
    """
    confidence = _as_dict(row.get("confidence"))
    location = _as_dict(row.get("public_location"))
    sources = [item for item in _as_list(row.get("sources")) if isinstance(item, dict)]

    return {
        "rank": _coerce_int(row.get("rank")),
        "personId": _text(row.get("person_id")) or "",
        "displayName": _text(row.get("display_name")),
        "headline": _text(row.get("headline")),
        "organization": _text(row.get("organization")),
        "lane": _text(row.get("lane")),
        "globalNws": _coerce_float(row.get("global_nws")),
        "nearbyRankScore": _coerce_float(row.get("nearby_rank_score")),
        "scoreStatus": _text(row.get("score_status")),
        "confidence": {
            "score": _coerce_float(confidence.get("score")),
            "grade": _text(confidence.get("grade")),
        },
        "publicLocation": {
            "label": _text(location.get("label")),
            "associationKind": _text(location.get("association_kind")),
            "granularity": _text(location.get("granularity")),
            "distanceBand": _text(location.get("approximate_distance_band")),
            "note": _text(location.get("note")),
        },
        "scoreBreakdown": _normalize_breakdown(row.get("score_breakdown")),
        "reasons": [
            text for text in (_text(item) for item in _as_list(row.get("reasons"))) if text
        ],
        "warnings": [
            text for text in (_text(item) for item in _as_list(row.get("warnings"))) if text
        ],
        "tags": [text for text in (_text(item) for item in _as_list(row.get("tags"))) if text],
        "revalidationRequired": bool(row.get("revalidation_required")),
        "evidence": _normalize_evidence(row.get("evidence")),
        "associationContext": _normalize_association_context(row.get("public_association_context")),
        "sources": [
            {
                "publisher": _text(item.get("publisher")),
                "title": _text(item.get("title")),
                "url": _text(item.get("url")),
                # What this citation actually establishes — identity, current
                # role, organization identity, public association. An advisor
                # doing diligence needs to know which claim a link supports.
                "factTypes": [
                    text
                    for text in (_text(fact) for fact in _as_list(item.get("fact_types")))
                    if text
                ],
                "retrievedAt": _text(item.get("retrieved_at")),
            }
            for item in sources
        ],
        "modelVersion": _text(row.get("model_version")),
    }


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _normalize_association_context(value: Any) -> dict[str, Any] | None:
    """What "in this market" means for this particular person.

    The category alone reads like a claim about where someone lives. The
    release ships its own definition alongside it, and that definition is the
    part keeping the claim honest, so the two travel together or not at all.
    """
    block = _as_dict(value)
    category = _text(block.get("category"))
    if not category:
        return None
    return {"category": category, "definition": _text(block.get("definition"))}


def _normalize_evidence(value: Any) -> dict[str, Any] | None:
    """How well-sourced a record is, as the reviewed release reports it.

    This is the diligence signal. Two links from the same organization are not
    two independent confirmations, and the release says so per record rather
    than leaving a reader to count publishers by eye.
    """
    block = _as_dict(value)
    if not block:
        return None

    return {
        "citationCount": _coerce_int(block.get("citation_count")),
        # Distinct publishing organizations behind the citations.
        "sourceFamilyCount": _coerce_int(block.get("source_family_count")),
        "factCount": _coerce_int(block.get("evidence_fact_count")),
        "independentSourceFamilies": bool(block.get("independent_source_families")),
        "reviewFlags": [
            text for text in (_text(flag) for flag in _as_list(block.get("review_flags"))) if text
        ],
    }


def _normalize_breakdown(value: Any) -> dict[str, Any] | None:
    """Carry the upstream's own working through, or nothing at all.

    Returns None rather than an empty scaffold when the upstream omits it. A
    half-populated breakdown would render as a score explained by zeros, which
    is worse than a score with no explanation offered.
    """
    block = _as_dict(value)
    if not block:
        return None

    components = [
        {
            "key": _text(item.get("key")),
            "label": _text(item.get("label")),
            "value": _coerce_float(item.get("value")),
            "weight": _coerce_float(item.get("weight")),
            "contribution": _coerce_float(item.get("contribution")),
        }
        for item in _as_list(block.get("components"))
        if isinstance(item, dict) and _text(item.get("key"))
    ]
    if not components:
        return None

    return {
        "components": components,
        "evidenceCount": _coerce_int(block.get("evidence_count")),
        "coverageMultiplier": _coerce_float(block.get("coverage_multiplier")),
        "integrityPenalty": _coerce_float(block.get("integrity_penalty")),
        "localRelevance": _coerce_float(block.get("local_relevance")),
        "method": _text(block.get("method")),
    }


def _as_dict(value: Any) -> dict[str, Any]:
    """Treat a missing or wrong-typed block as empty.

    The upstream is a separate service on its own release train, so every nested
    block is read defensively: a contract change should degrade one field, not
    raise on a response that is otherwise fine.
    """
    return value if isinstance(value, dict) else {}


__all__ = [
    "NwsNearbyError",
    "NwsNearbyService",
    "is_configured",
    "reset_cache",
]
