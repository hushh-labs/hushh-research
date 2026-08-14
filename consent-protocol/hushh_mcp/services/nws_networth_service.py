"""Server-side client for the NWS ``/v4/net-worth`` contract.

Deliberately a separate module from :mod:`nws_nearby_service`, which serves the
live ``/v2`` professional-network surface. v4 is not a path swap on that client:
it authenticates as a *registered consumer* rather than with the shared service
key, it needs a signed consent receipt before it will accept a coordinate, and
it answers with money rather than a network score. Sharing a module would put
all of that in the path of a surface that works today.

Three properties of the upstream shape everything below.

**A covered location is not a populated one.** ``coverage.status`` is ``COVERED``
for every ZIP in the 33,791-entry Census index, while a named net-worth estimate
exists for a small reviewed roster. The common answer is ``200`` with a large
``discovered_count`` and zero results, and that is correct, not a failure. The
caller must branch on ``result_set.returned_count``, never on coverage.

**``discovered_count`` is not an upper bound on results.** It counts the
discovery plane (SEC Section 16 and CMS NPPES), which is never joined to the
financial plane. Reporting it as "people found near you" above an empty list is
the single most misleading thing this API invites, so it travels under a name
that cannot be mistaken for a result count.

**The consent receipt is single-use and is burned before the search runs.** An
upstream 5xx consumes it permanently, so a retry needs a fresh receipt and a
coordinate answer may never be cached or shared between advisors.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import os
import re
import time
from typing import Any

import httpx

logger = logging.getLogger(__name__)

# The consent mint and the discovery call are two upstream hops, and the service
# scales to zero, so a cold first request pays the start-up on the first of them.
_DEFAULT_TIMEOUT_SECONDS = 25.0

# The upstream quantises to two decimals itself and does not log the raw value.
# Rounding here means the precise coordinate never leaves this process either.
_COORDINATE_DECIMALS = 2

_DISCOVER_PATH = "/v4/net-worth/discover"
_CONSENT_PATH = "/v4/location-consent/receipt"

# The upstream registry grants access per (route, purpose). Both must match the
# grant exactly -- there is no prefix or wildcard matching on either.
_PURPOSE_ID = "NET_WORTH_LOOKUP"
_CONSENT_SCOPE = "APPROXIMATE_LOCATION_QUERY"

# v4 serves exactly one tier. ``RESTRICTED_ANALYTICAL`` is accepted by the
# request schema and then refused at runtime, so it is not offered here.
_PUBLIC_SAFE = "PUBLIC_SAFE"

# Pinned against the deployed model. A mismatch is not an auth error -- it comes
# back as a 409 whose message reads like a coverage problem, so it is worth
# keeping this in config rather than discovering it from a support ticket.
_DEFAULT_MODEL_VERSION = "net-worth-v1.0.0"

# The only counts the upstream accepts.
_ALLOWED_COUNTS = (100, 150, 200)

# 100 km, the same expansion ceiling the v2 surface uses. Well under the
# ~155-mile point where the upstream's own strict-radius path starts to fault.
_MAX_RADIUS_MILES = 62.137119

# v4 does no normalisation of its own: " 94010 " and "us" are hard 422s. US ZIP
# or ZIP+4 only -- no other country's postal format is accepted at all.
_US_POSTAL = re.compile(r"^\d{5}(?:-\d{4})?$")

_CONFIDENCE_GRADES = frozenset({"A", "B", "C"})
_FINANCIAL_MODES = frozenset({"verified", "estimated", "observed-only"})

# Only the postal path is cacheable. A coordinate answer is bound to one
# advisor's single-use consent receipt and must never be replayed for another.
_COVERED_TTL_SECONDS = 300.0
_UNCOVERED_TTL_SECONDS = 1800.0
_MAX_CACHE_ENTRIES = 256


class NwsNetWorthError(RuntimeError):
    """Upstream or configuration failure, carrying the status the API should return.

    ``code`` is a stable discriminator so a caller can tell "you sent a bad ZIP"
    apart from "the upstream is down" without parsing prose.
    """

    def __init__(
        self,
        message: str,
        *,
        status_code: int,
        code: str,
        retry_after_seconds: int | None = None,
    ) -> None:
        self.status_code = status_code
        self.code = code
        self.retry_after_seconds = retry_after_seconds
        super().__init__(message)


def _env(name: str, default: str = "") -> str:
    return str(os.getenv(name, default)).strip()


def base_url() -> str:
    return _env("NWS_NEARBY_V4_API_BASE_URL").rstrip("/")


def project_id() -> str:
    return _env("NWS_NEARBY_V4_PROJECT_ID")


def model_version() -> str:
    return _env("NWS_NEARBY_V4_MODEL_VERSION") or _DEFAULT_MODEL_VERSION


def is_configured() -> bool:
    """True only when every part needed to make a *successful* call is present.

    The actor key is included deliberately. Without it there is no stable
    pseudonymous subject to send, and falling back to a shared constant would
    put every advisor in the country behind one audit identity upstream.
    """
    return bool(
        base_url()
        and _env("NWS_NEARBY_V4_API_KEY")
        and project_id()
        and _env("NWS_NEARBY_V4_ACTOR_HMAC_KEY")
    )


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


def _text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def audit_actor(firebase_uid: str) -> str:
    """Derive the opaque, product-scoped subject the upstream audits against.

    The advisor's Firebase UID never leaves this process. The upstream binds
    consent receipts to this value and truncates it again on its own side, so it
    must be stable for one advisor across the mint and the discovery call, and
    must not be a service-wide constant -- that would collapse every advisor
    into a single audit identity and make the receipt binding meaningless.
    """
    secret = _env("NWS_NEARBY_V4_ACTOR_HMAC_KEY")
    if not secret:
        raise NwsNetWorthError(
            "Net worth lookup is not configured on this backend.",
            status_code=503,
            code="RIA_NETWORTH_NOT_CONFIGURED",
        )
    digest = hmac.new(secret.encode("utf-8"), firebase_uid.encode("utf-8"), hashlib.sha256)
    # 32 hex characters keeps this well inside the upstream's 2..128 identifier
    # bound while leaving the prefix readable in our own logs.
    return f"ria-{digest.hexdigest()[:32]}"


class _ResponseCache:
    """TTL cache for postal answers only.

    Never holds a coordinate answer: those are bound to a single-use consent
    receipt issued for one advisor, and serving one from cache would hand a
    second advisor a result whose consent was never granted.
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
            oldest = min(self._entries, key=lambda item: self._entries[item][0])
            self._entries.pop(oldest, None)
        self._entries[key] = (now + ttl, payload)

    def clear(self) -> None:
        self._entries.clear()


_cache = _ResponseCache()


def reset_cache() -> None:
    """Drop every cached response. Used by tests; safe at runtime."""
    _cache.clear()


class NwsNetWorthService:
    """Async client for the NWS v4 net-worth contract."""

    def __init__(
        self,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        use_cache: bool = True,
    ) -> None:
        self._base_url = base_url()
        self._api_key = _env("NWS_NEARBY_V4_API_KEY")
        self._project_id = project_id()
        self._model_version = model_version()
        self._timeout = (
            _coerce_float(_env("NWS_NEARBY_V4_API_TIMEOUT_SECONDS")) or _DEFAULT_TIMEOUT_SECONDS
        )
        self._transport = transport
        self._use_cache = use_cache

    # ---------------------------------------------------------------- internals

    def _client(self) -> httpx.AsyncClient:
        if not is_configured():
            raise NwsNetWorthError(
                "Net worth lookup is not configured on this backend.",
                status_code=503,
                code="RIA_NETWORTH_NOT_CONFIGURED",
            )
        return httpx.AsyncClient(
            base_url=self._base_url,
            timeout=httpx.Timeout(self._timeout, connect=5.0),
            headers={"X-NWS-API-Key": self._api_key},
            transport=self._transport,
        )

    @staticmethod
    def _upstream_code(payload: Any) -> str | None:
        """Read the upstream error discriminator, tolerating both envelopes.

        A policy denial is ``{"detail": {"code": ...}}`` but a schema rejection
        is ``{"detail": [ ... ]}`` -- a list of Pydantic errors with no code at
        all. Treating the second as the first raises ``AttributeError`` inside
        the error handler, which is how a 422 becomes a 500.
        """
        detail = _as_dict(payload).get("detail")
        if isinstance(detail, dict):
            return _text(detail.get("code"))
        return None

    def _raise_for_status(
        self,
        status_code: int,
        headers: Any = None,
        payload: Any = None,
    ) -> None:
        """Map an upstream status onto a client-safe error.

        Anything that means *our* deployment is wrong -- a bad key, an
        unregistered project, a stale model pin -- is reported as a
        configuration fault rather than as "no results", because retrying will
        never fix it and an empty list would read as a truthful answer.
        """
        if status_code < 400:
            return

        code = self._upstream_code(payload)

        if status_code == 429:
            retry_after = None
            if headers is not None:
                try:
                    retry_after = _coerce_int(headers.get("retry-after"))
                except (AttributeError, TypeError):
                    retry_after = None
            raise NwsNetWorthError(
                "Net worth lookup is busy. Try again shortly.",
                status_code=429,
                code="RIA_NETWORTH_BUSY",
                retry_after_seconds=retry_after,
            )

        if status_code == 409:
            # The active snapshot cannot answer this shape of request. Distinct
            # from an empty result: the caller may be able to relax a filter.
            logger.warning("nws_networth.upstream_cannot_satisfy code=%s", code)
            raise NwsNetWorthError(
                "Net worth coverage cannot answer that search right now.",
                status_code=409,
                code="RIA_NETWORTH_COVERAGE_UNAVAILABLE",
            )

        if status_code == 503:
            # Includes a stale or unavailable financial snapshot, which is a
            # real, temporary state of the data plane rather than our fault.
            logger.warning("nws_networth.upstream_unavailable code=%s", code)
            raise NwsNetWorthError(
                "Net worth data is unavailable right now.",
                status_code=503,
                code="RIA_NETWORTH_SOURCE_UNAVAILABLE",
            )

        if status_code in (401, 403):
            # Our credential, our registered project, or our grant -- never the
            # caller's business, and never a reason to retry.
            logger.error(
                "nws_networth.upstream_access_rejected status=%s code=%s "
                "— check NWS_NEARBY_V4_API_KEY and NWS_NEARBY_V4_PROJECT_ID",
                status_code,
                code,
            )
            raise NwsNetWorthError(
                "Net worth lookup is not set up yet.",
                status_code=502,
                code="RIA_NETWORTH_NOT_CONFIGURED",
            )

        if status_code in (413, 422):
            # We re-validate everything the upstream validates, so reaching here
            # means our request builder and the contract have diverged.
            logger.error("nws_networth.upstream_rejected_request status=%s", status_code)
            raise NwsNetWorthError(
                "That search could not be completed.",
                status_code=502,
                code="RIA_NETWORTH_UNAVAILABLE",
            )

        raise NwsNetWorthError(
            "Net worth lookup is unavailable right now.",
            status_code=502,
            code="RIA_NETWORTH_UNAVAILABLE",
        )

    # ------------------------------------------------------------------ request

    def build_query(
        self,
        *,
        latitude: float | None,
        longitude: float | None,
        postal_code: str | None,
    ) -> tuple[dict[str, Any], bool]:
        """Build the upstream ``query`` block; return it with a coordinate flag.

        v4 applies no trimming or upper-casing of its own and accepts only a US
        ZIP, so anything else is refused here rather than spent against the
        consumer's own per-minute grant.
        """
        has_coordinates = latitude is not None or longitude is not None
        has_postal = bool(postal_code)

        if has_coordinates and has_postal:
            raise NwsNetWorthError(
                "Send a postal code or coordinates, not both.",
                status_code=400,
                code="RIA_NETWORTH_INVALID_LOCATION",
            )
        if not has_coordinates and not has_postal:
            raise NwsNetWorthError(
                "A location is required.",
                status_code=400,
                code="RIA_NETWORTH_INVALID_LOCATION",
            )

        if has_coordinates:
            if latitude is None or longitude is None:
                raise NwsNetWorthError(
                    "Latitude and longitude must be sent together.",
                    status_code=400,
                    code="RIA_NETWORTH_INVALID_LOCATION",
                )
            if not (-90.0 <= latitude <= 90.0) or not (-180.0 <= longitude <= 180.0):
                raise NwsNetWorthError(
                    "Those coordinates are not valid.",
                    status_code=400,
                    code="RIA_NETWORTH_INVALID_LOCATION",
                )
            return (
                {
                    "latitude": round(latitude, _COORDINATE_DECIMALS),
                    "longitude": round(longitude, _COORDINATE_DECIMALS),
                    "country_code": "US",
                },
                True,
            )

        normalized = str(postal_code or "").strip()
        if not _US_POSTAL.fullmatch(normalized):
            raise NwsNetWorthError(
                "Enter a US ZIP code.",
                status_code=400,
                code="RIA_NETWORTH_INVALID_LOCATION",
            )
        # ZIP+4 is accepted by the upstream and then reduced to its five-digit
        # base, so it buys no precision -- but it is not an error either.
        return ({"postal_code": normalized, "country_code": "US"}, False)

    def build_selection(
        self,
        *,
        count: int,
        financial_mode: str,
    ) -> dict[str, Any]:
        if count not in _ALLOWED_COUNTS:
            raise NwsNetWorthError(
                "That result count is not supported.",
                status_code=400,
                code="RIA_NETWORTH_INVALID_SELECTION",
            )
        mode = str(financial_mode or "estimated").strip()
        if mode not in _FINANCIAL_MODES:
            raise NwsNetWorthError(
                "That financial mode is not recognised.",
                status_code=400,
                code="RIA_NETWORTH_INVALID_SELECTION",
            )
        # ``nearest-count`` only. ``strict-radius`` forwards its full radius into
        # a legacy field capped at 250km, so any value above ~155 miles returns
        # an upstream 500 rather than a validation error.
        #
        # The radius is sent explicitly even though it is optional here. Omitted,
        # the upstream policy check sees the 500km ceiling and compares it against
        # our grant -- which passes today only because the grant is exactly 500.
        # A grant tightened later would then 403 a request that looks radius-free.
        return {
            "count": count,
            "financial_mode": mode,
            "geography_mode": "nearest-count",
            "maximum_radius_miles": _MAX_RADIUS_MILES,
        }

    def build_filters(
        self,
        *,
        minimum_confidence: str | None,
        minimum_coverage: float | None,
    ) -> dict[str, Any]:
        grade = str(minimum_confidence or "C").strip().upper()
        if grade not in _CONFIDENCE_GRADES:
            raise NwsNetWorthError(
                "That confidence grade is not recognised.",
                status_code=400,
                code="RIA_NETWORTH_INVALID_FILTER",
            )
        coverage = 0.55 if minimum_coverage is None else float(minimum_coverage)
        if not 0.0 <= coverage <= 1.0:
            raise NwsNetWorthError(
                "That coverage floor is out of range.",
                status_code=400,
                code="RIA_NETWORTH_INVALID_FILTER",
            )
        # ``asset_families`` is deliberately never sent. Every reviewed profile
        # publishes its components as INCLUDED_IN_DECLARED_TOTAL, which matches
        # none of the values the asset filter accepts, so any non-empty list
        # silently returns a normal 200 with zero eligible profiles.
        return {
            "minimum_confidence": grade,
            "minimum_coverage": coverage,
            "asset_families": [],
        }

    def _caller_context(self, *, actor: str) -> dict[str, Any]:
        return {
            "project_id": self._project_id,
            "purpose_id": _PURPOSE_ID,
            "authorization_scope": _PUBLIC_SAFE,
            "requested_data_tier": _PUBLIC_SAFE,
            "audit_actor": actor,
            "model_version": self._model_version,
        }

    # ------------------------------------------------------------------ consent

    async def mint_consent_receipt(
        self,
        client: httpx.AsyncClient,
        *,
        actor: str,
    ) -> dict[str, Any]:
        """Exchange an advisor's location permission for a signed receipt.

        The receipt carries no location -- it binds consumer, project, route,
        purpose, actor and expiry only. It is returned verbatim so it can be
        echoed back byte-identically; re-serialising the timestamps would break
        both the signature and the replay digest.
        """
        body = {
            "project_id": self._project_id,
            "purpose_id": _PURPOSE_ID,
            "audit_actor": actor,
            "scope": _CONSENT_SCOPE,
            "consent_granted": True,
        }
        try:
            response = await client.post(_CONSENT_PATH, json=body)
            payload = self._read_json(response)
            self._raise_for_status(response.status_code, response.headers, payload)
        except NwsNetWorthError:
            raise
        except httpx.HTTPError as exc:
            logger.warning("nws_networth.consent_transport_error error=%s", type(exc).__name__)
            raise NwsNetWorthError(
                "Net worth lookup is unavailable right now.",
                status_code=502,
                code="RIA_NETWORTH_UNAVAILABLE",
            ) from exc

        receipt = _as_dict(payload)
        if not _text(receipt.get("receipt_id")):
            raise NwsNetWorthError(
                "Net worth lookup is unavailable right now.",
                status_code=502,
                code="RIA_NETWORTH_UNAVAILABLE",
            )
        return receipt

    @staticmethod
    def _read_json(response: httpx.Response) -> Any:
        try:
            return response.json()
        except ValueError:
            return None

    # ----------------------------------------------------------------- discover

    async def discover(
        self,
        *,
        firebase_uid: str,
        latitude: float | None = None,
        longitude: float | None = None,
        postal_code: str | None = None,
        count: int = 100,
        financial_mode: str = "estimated",
        minimum_confidence: str | None = None,
        minimum_coverage: float | None = None,
    ) -> dict[str, Any]:
        """Run a net-worth discovery, minting consent first for a coordinate."""
        query, uses_coordinates = self.build_query(
            latitude=latitude,
            longitude=longitude,
            postal_code=postal_code,
        )
        selection = self.build_selection(count=count, financial_mode=financial_mode)
        filters = self.build_filters(
            minimum_confidence=minimum_confidence,
            minimum_coverage=minimum_coverage,
        )
        actor = audit_actor(firebase_uid)

        body: dict[str, Any] = {
            "query": query,
            "selection": selection,
            "filters": filters,
            "caller_context": self._caller_context(actor=actor),
        }

        # Only a postal answer is cacheable, and the key is built from the query
        # alone -- the caller context is excluded on purpose.
        #
        # A postal answer is public-safe data that is identical for every
        # advisor, so keying on the actor would make the cache miss on every
        # request and put each advisor's browsing straight onto a grant that is
        # 30 requests a minute for the whole product, not per person. The cost
        # is that a cache hit writes no upstream audit event for the second
        # advisor, which is why the entry is held for minutes rather than hours.
        #
        # A coordinate answer is never stored at all: it is produced under one
        # advisor's single-use consent receipt, and replaying it for someone
        # else would be serving a result whose consent was never given.
        cache_key = ""
        now = time.monotonic()
        if self._use_cache and not uses_coordinates:
            cacheable = {key: value for key, value in body.items() if key != "caller_context"}
            cacheable["project_id"] = self._project_id
            cache_key = repr(sorted(_flatten(cacheable).items()))
            cached = _cache.get(cache_key, now=now)
            if cached is not None:
                return cached

        try:
            async with self._client() as client:
                if uses_coordinates:
                    receipt = await self.mint_consent_receipt(client, actor=actor)
                    # Echoed unchanged: the signature covers the encoded payload
                    # and the timestamps are compared as truncated epoch seconds.
                    body["coordinate_consent"] = receipt
                response = await client.post(_DISCOVER_PATH, json=body)
                payload = self._read_json(response)
                self._raise_for_status(response.status_code, response.headers, payload)
        except NwsNetWorthError:
            raise
        except httpx.HTTPError as exc:
            logger.warning("nws_networth.discover_transport_error error=%s", type(exc).__name__)
            raise NwsNetWorthError(
                "Net worth lookup is unavailable right now.",
                status_code=502,
                code="RIA_NETWORTH_UNAVAILABLE",
            ) from exc

        if not isinstance(payload, dict):
            raise NwsNetWorthError(
                "Net worth lookup is unavailable right now.",
                status_code=502,
                code="RIA_NETWORTH_UNAVAILABLE",
            )

        normalized = normalize_networth(payload)
        if self._use_cache and not uses_coordinates:
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


# ------------------------------------------------------------------ normalizing


def normalize_networth(payload: dict[str, Any]) -> dict[str, Any]:
    """Reshape a v4 response for the app.

    Deliberately narrow. The upstream returns an expansion trace, a request
    policy echo, a component ledger and a rank interval, none of which an
    advisor can act on -- and several of which are constant across every
    profile in the current dataset, so rendering them would spend space on
    fields that cannot vary.

    Counts travel under names that keep the two planes apart. ``discoveredCount``
    is people the discovery plane saw; ``eligibleCount`` is people with a
    publishable estimate. They are unrelated, and conflating them turns an
    honest empty answer into an apparent bug.
    """
    coverage = _as_dict(payload.get("coverage"))
    financial = _as_dict(payload.get("financial_coverage"))
    result_set = _as_dict(payload.get("result_set"))
    snapshot = _as_dict(payload.get("snapshot"))
    query = _as_dict(payload.get("query"))
    results = [item for item in _as_list(payload.get("results")) if isinstance(item, dict)]

    return {
        "contractVersion": _text(payload.get("contract_version")),
        "query": {
            "label": _text(query.get("label")),
            "mode": _text(query.get("mode")),
            "postalCode": _text(query.get("postal_code")),
        },
        "coverage": {
            "status": _text(coverage.get("status")) or "NOT_COVERED",
            "reasonCode": _text(coverage.get("reason_code")),
            "marketLabel": _text(coverage.get("market_label")),
        },
        "snapshot": {
            "asOf": _text(snapshot.get("as_of")),
            "modelVersion": _text(snapshot.get("model_version")),
        },
        "counts": {
            # People the discovery plane saw. NOT an upper bound on results and
            # never to be rendered as "people near you".
            "discoveredCount": _coerce_int(financial.get("discovered_count")) or 0,
            # People with a publishable estimate. This is the only count that
            # describes the list on screen.
            "eligibleCount": _coerce_int(financial.get("v4_eligible_count")) or 0,
            "returnedCount": _coerce_int(result_set.get("returned_count")) or 0,
            "requestedCount": _coerce_int(result_set.get("requested_count")) or 0,
        },
        # ``shortfall`` and ``target_satisfied`` are deliberately dropped. The
        # smallest count the upstream accepts is 100 and the reviewed roster is
        # far smaller, so every successful call reports a large shortfall and an
        # unsatisfied target -- rendering either would make every real answer
        # look like a failure.
        "reasons": [
            text for text in (_text(item) for item in _as_list(result_set.get("reasons"))) if text
        ],
        "results": [_normalize_networth_result(item) for item in results],
    }


def _normalize_networth_result(row: dict[str, Any]) -> dict[str, Any]:
    """Flatten one ranked profile onto what an adviser can actually act on."""
    person = _as_dict(row.get("person"))
    estimate = _as_dict(row.get("estimated_net_worth"))
    floor = _as_dict(row.get("observed_net_worth_floor"))
    nws = _as_dict(row.get("nws"))
    confidence = _as_dict(row.get("confidence"))
    location = _as_dict(row.get("location_relationship"))

    return {
        "rank": _coerce_int(row.get("rank")),
        "personId": _text(person.get("id")) or "",
        "displayName": _text(person.get("name")),
        "headline": _text(person.get("headline")),
        "organization": _text(person.get("organization")),
        "estimate": {
            "status": _text(estimate.get("status")),
            "currency": _text(estimate.get("currency")),
            # p10/median/p90 all travel: the reviewed roster declares a single
            # sworn total, so they are presently equal, but a modelled estimate
            # will not be and the UI must not have to guess which it is holding.
            "p10Usd": _coerce_int(estimate.get("p10_usd")),
            "medianUsd": _coerce_int(estimate.get("median_usd")),
            "p90Usd": _coerce_int(estimate.get("p90_usd")),
            "method": _text(estimate.get("method")),
            "asOf": _text(estimate.get("as_of")),
        },
        "observedFloor": {
            "status": _text(floor.get("status")),
            # Legitimately negative: it is supported assets minus supported
            # liabilities, with no floor at zero.
            "amountUsd": _coerce_int(floor.get("amount_usd")),
        },
        "nws": {
            "value": _coerce_float(nws.get("value")),
            "scaleVersion": _text(nws.get("scale_version")),
        },
        "confidence": {
            "grade": _text(confidence.get("grade")),
            "coverage": _coerce_float(confidence.get("coverage")),
        },
        "association": {
            "label": _text(location.get("label")),
            "distanceBand": _text(location.get("approximate_distance_band")),
        },
        "lastFinancialUpdate": _text(row.get("last_financial_update")),
        "whyRanked": [
            text for text in (_text(item) for item in _as_list(row.get("why_ranked"))) if text
        ],
        # Host families rather than raw citations -- the upstream replaces the
        # documents themselves, so there is no link to offer.
        "sourceFamilies": [
            text for text in (_text(item) for item in _as_list(row.get("source_families"))) if text
        ],
    }
