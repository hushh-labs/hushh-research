"""Places directory routes — businesses near a coordinate, streamed by category.

The Maps key never leaves the backend, so the app calls these endpoints instead
of Google directly. Coordinates arrive per request, are used only to build the
upstream query, and are never persisted, cached, or logged.

Every route here is a POST, including the two that only read. A GET would put
the reader's exact position in the request line, which the access log records
verbatim and which also lands in browser history and any Referer header. The
advisor directory and the Maps proxy endpoints are POST for the same reason, and
`tests/test_places_coordinate_privacy.py` holds this route to it.

`/places/stream` exists because the alternative is worse, not because streaming
is fashionable. A category's results come from one provider call; ten categories
are ten calls. Gathering them and answering once makes every reader wait for the
slowest one. Streaming each as it lands costs the same provider calls and puts
the first rows on screen roughly a round trip sooner. `/places/search` answers
the same question in one response for callers that cannot read a stream.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from collections.abc import AsyncGenerator
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from api.middleware import require_firebase_auth
from api.middlewares.rate_limit import RateLimits, limiter
from hushh_mcp.services.google_maps_service import (
    DIRECTORY_CATEGORY_SLUGS,
    GoogleMapsError,
    GoogleMapsService,
    is_configured,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/one", tags=["Places"])

_METERS_PER_MILE = 1609.344
_DEFAULT_RADIUS_MI = 5.0
_MAX_RADIUS_MI = 31.0  # Google rejects a radius above 50 km.
_DEFAULT_LIMIT = 20

# A stalled provider call must not look like a dead connection to whatever sits
# between this process and the reader. `api/routes/sse.py` uses 30s for the same
# reason; this is shorter because a directory that has said nothing for fifteen
# seconds is already a bad experience worth signalling.
_HEARTBEAT_SECONDS = 15.0

# The whole fan-out is bounded so one wedged provider call cannot hold a
# connection open indefinitely.
_STREAM_BUDGET_SECONDS = 45.0

_ATTRIBUTION = {
    "source": "Google",
    "sourceUrl": "https://www.google.com/maps",
    "termsUrl": "https://cloud.google.com/maps-platform/terms",
    "notice": "Place data from Google Maps Platform.",
}


def _env_truthy(name: str, fallback: str = "false") -> bool:
    return str(os.getenv(name) or fallback).strip().lower() in {"1", "true", "yes", "on"}


def _directory_enabled() -> bool:
    """Whether this deployment serves the Places directory.

    Deliberately NOT the nearby-presence flag. That flag governs co-presence,
    where the risk is an unattestable check-in point being shown to other
    people; this is a business directory read by one signed-in owner. Sharing a
    switch would mean closing co-presence in production also closes the
    directory, which is a coupling neither feature asked for.

    Non-production environments default open so UAT can verify without a secret
    change. Production stays closed until it is turned on explicitly.
    """

    environment = (
        str(os.getenv("ENVIRONMENT") or os.getenv("HUSHH_DEPLOY_ENV") or "").strip().lower()
    )
    if environment in {"development", "dev", "local", "test", "uat", "staging"}:
        return _env_truthy("ONE_PLACES_DIRECTORY_ENABLED", "true")
    return _env_truthy("ONE_PLACES_DIRECTORY_ENABLED", "false")


class PlacesSearchRequest(BaseModel):
    """A location to search around, and which categories to search for."""

    model_config = ConfigDict(populate_by_name=True)

    lat: float | None = Field(default=None, ge=-90, le=90)
    lng: float | None = Field(default=None, ge=-180, le=180)
    postal_code: str | None = Field(default=None, alias="postalCode", max_length=12)
    categories: list[str] = Field(default_factory=list, max_length=12)
    radius_mi: float = Field(default=_DEFAULT_RADIUS_MI, alias="radiusMi", gt=0, le=_MAX_RADIUS_MI)
    limit: int = Field(default=_DEFAULT_LIMIT, ge=1, le=20)


class PlaceDetailsRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    place_id: str = Field(alias="placeId", min_length=1, max_length=300)


def _service() -> GoogleMapsService:
    return GoogleMapsService()


def _no_store(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-store"
    response.headers["Pragma"] = "no-cache"


def _guard() -> None:
    """Refuse before any coordinate is used when this surface is not serving."""

    if not _directory_enabled():
        raise HTTPException(
            status_code=404,
            detail={
                "code": "ONE_PLACES_UNAVAILABLE",
                "message": "Places near you is not available on this account yet.",
            },
        )
    if not is_configured():
        # 503, not 404: the surface exists, this deployment just has no key.
        # The client turns this into "Not available yet." rather than repeating
        # our plumbing back at the reader.
        raise HTTPException(
            status_code=503,
            detail={
                "code": "ONE_PLACES_NOT_CONFIGURED",
                "message": "The places directory is not configured on this backend.",
            },
        )


def _resolve_categories(requested: list[str]) -> list[str]:
    """Requested categories, in the table's declared order, deduplicated.

    An unknown slug is dropped rather than raising: a client one release ahead
    asking for a category this backend does not have yet should get the nine it
    does have, not an error for the whole request.
    """

    wanted = {str(slug).strip() for slug in requested if str(slug).strip()}
    if not wanted:
        return []
    return [slug for slug in DIRECTORY_CATEGORY_SLUGS if slug in wanted]


async def _resolve_origin(payload: PlacesSearchRequest) -> tuple[float, float]:
    """The point to search around, from coordinates or a postal code."""

    if payload.lat is not None and payload.lng is not None:
        return float(payload.lat), float(payload.lng)

    postal = (payload.postal_code or "").strip()
    if not postal:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "ONE_PLACES_NO_ORIGIN",
                "message": "A location or a postal code is required.",
            },
        )
    try:
        place = await _service().resolve_place(query=postal)
    except GoogleMapsError as exc:
        raise _handle(exc) from exc

    try:
        return float(place["latitude"]), float(place["longitude"])
    except (KeyError, TypeError, ValueError) as exc:
        # An unparseable postal code is not an error the reader caused. The
        # client shows the same quiet "nothing here" block it shows for a real
        # zero-result answer, and keeps the postal box on screen.
        raise HTTPException(
            status_code=422,
            detail={
                "code": "ONE_PLACES_UNRESOLVED_POSTAL_CODE",
                "message": "That postal code could not be located.",
            },
        ) from exc


def _handle(exc: GoogleMapsError) -> HTTPException:
    return HTTPException(
        status_code=exc.status_code,
        detail={
            "code": getattr(exc, "code", None) or "ONE_PLACES_UNAVAILABLE",
            "message": str(exc),
        },
    )


def _meta(*, categories: list[str], radius_mi: float, limit: int) -> dict[str, Any]:
    return {
        "categories": categories,
        "radiusMi": radius_mi,
        "limit": limit,
        "attribution": {
            **_ATTRIBUTION,
            "retrievedAt": datetime.now(timezone.utc).isoformat(),
        },
    }


def _frame(event: str, data: dict[str, Any]) -> bytes:
    """One Server-Sent Events block.

    `event` is repeated inside the payload so the client can verify the frame it
    parsed is the frame it was handed -- the same check `kai-stream-client.ts`
    makes.
    """

    body = json.dumps({"event": event, **data}, separators=(",", ":"))
    return f"event: {event}\ndata: {body}\n\n".encode()


async def _stream_categories(
    *,
    request: Request,
    lat: float,
    lng: float,
    categories: list[str],
    radius_meters: float,
    limit: int,
    meta: dict[str, Any],
) -> AsyncGenerator[bytes, None]:
    """Emit each category the moment its provider call returns.

    Deliberately not `asyncio.gather`: gathering waits for the slowest call
    before anything can be sent, which is exactly the delay this route exists to
    remove. `asyncio.wait(FIRST_COMPLETED)` gives the same concurrency and lets
    each result leave as it lands, with the idle gaps used for heartbeats.
    """

    service = _service()
    tasks: dict[asyncio.Task[list[dict[str, Any]]], str] = {}
    for slug in categories:
        task = asyncio.create_task(
            service.search_directory_category(
                lat=lat,
                lng=lng,
                category=slug,
                radius_meters=radius_meters,
                limit=limit,
            )
        )
        tasks[task] = slug

    pending: set[asyncio.Task[list[dict[str, Any]]]] = set(tasks)
    loop = asyncio.get_running_loop()
    deadline = loop.time() + _STREAM_BUDGET_SECONDS
    delivered = 0
    failed: list[str] = []

    try:
        yield _frame("meta", meta)

        while pending:
            if await request.is_disconnected():
                return

            remaining = deadline - loop.time()
            if remaining <= 0:
                for slug in (tasks[task] for task in pending):
                    failed.append(slug)
                    yield _frame(
                        "category_error",
                        {"category": slug, "message": "This category timed out."},
                    )
                break

            done, pending = await asyncio.wait(
                pending,
                timeout=min(_HEARTBEAT_SECONDS, remaining),
                return_when=asyncio.FIRST_COMPLETED,
            )

            if not done:
                # Nothing finished inside the window. Say so, so intermediaries
                # do not read the quiet as a dead connection.
                yield _frame("heartbeat", {})
                continue

            for task in done:
                slug = tasks[task]
                try:
                    items = task.result()
                except GoogleMapsError as exc:
                    # One category failing must never empty the list. The others
                    # are still a better answer than an error page.
                    failed.append(slug)
                    logger.warning("places.stream category failed: %s", slug)
                    yield _frame(
                        "category_error",
                        {"category": slug, "message": str(exc)},
                    )
                    continue
                except asyncio.CancelledError:
                    raise
                except Exception:
                    failed.append(slug)
                    logger.exception("places.stream category crashed: %s", slug)
                    yield _frame(
                        "category_error",
                        {"category": slug, "message": "This category is unavailable."},
                    )
                    continue

                delivered += len(items)
                yield _frame("results", {"category": slug, "items": items})

        yield _frame(
            "done",
            {"delivered": delivered, "failed": failed, "terminal": True},
        )
    finally:
        # A reader who navigated away must not leave provider calls running.
        for task in tasks:
            if not task.done():
                task.cancel()


@router.post("/places/stream")
@limiter.limit(RateLimits.ONE_PLACES_DIRECTORY_READ)
async def places_stream(
    request: Request,
    payload: PlacesSearchRequest,
    firebase_uid: str = Depends(require_firebase_auth),
):
    _ = firebase_uid  # auth-gate only; results are not user-scoped
    _guard()

    categories = _resolve_categories(payload.categories)
    if not categories:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "ONE_PLACES_NO_CATEGORY",
                "message": "At least one known category is required.",
            },
        )

    lat, lng = await _resolve_origin(payload)
    radius_meters = float(payload.radius_mi) * _METERS_PER_MILE
    meta = _meta(categories=categories, radius_mi=payload.radius_mi, limit=payload.limit)

    return StreamingResponse(
        _stream_categories(
            request=request,
            lat=lat,
            lng=lng,
            categories=categories,
            radius_meters=radius_meters,
            limit=payload.limit,
            meta=meta,
        ),
        media_type="text/event-stream",
        headers={
            # `no-transform` is doing real work, not decoration: the frontend
            # runs with `compress: true`, and a compressing intermediary is
            # free to buffer a response body to compress it. That turns a
            # stream back into one lump. The Kai stream lanes carry it for the
            # same reason. `private, no-store` matches the two sibling
            # directories, because this response is derived from a position.
            "Cache-Control": "private, no-store, no-cache, no-transform",
            "Pragma": "no-cache",
            "Connection": "keep-alive",
            # And this stops an nginx-shaped proxy buffering it regardless.
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/places/search")
@limiter.limit(RateLimits.ONE_PLACES_DIRECTORY_READ)
async def places_search(
    request: Request,
    response: Response,
    payload: PlacesSearchRequest,
    firebase_uid: str = Depends(require_firebase_auth),
):
    """The same question, answered once.

    The fallback for anything that cannot read a stream -- a buffering proxy, an
    older client, a test. Same inputs, same shapes, so the UI renders one code
    path either way.
    """

    _ = firebase_uid
    _guard()
    _no_store(response)

    categories = _resolve_categories(payload.categories)
    if not categories:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "ONE_PLACES_NO_CATEGORY",
                "message": "At least one known category is required.",
            },
        )

    lat, lng = await _resolve_origin(payload)
    radius_meters = float(payload.radius_mi) * _METERS_PER_MILE
    service = _service()

    results = await asyncio.gather(
        *(
            service.search_directory_category(
                lat=lat,
                lng=lng,
                category=slug,
                radius_meters=radius_meters,
                limit=payload.limit,
            )
            for slug in categories
        ),
        return_exceptions=True,
    )

    groups: list[dict[str, Any]] = []
    failed: list[str] = []
    for slug, outcome in zip(categories, results, strict=True):
        if isinstance(outcome, BaseException):
            failed.append(slug)
            logger.warning("places.search category failed: %s", slug)
            continue
        groups.append({"category": slug, "items": outcome})

    if not groups and failed:
        raise HTTPException(
            status_code=502,
            detail={
                "code": "ONE_PLACES_UNAVAILABLE",
                "message": "Places are unavailable right now.",
            },
        )

    return {
        "groups": groups,
        "failed": failed,
        "meta": _meta(categories=categories, radius_mi=payload.radius_mi, limit=payload.limit),
    }


@router.post("/places/details")
@limiter.limit(RateLimits.ONE_PLACES_DIRECTORY_READ)
async def place_details(
    request: Request,
    response: Response,
    payload: PlaceDetailsRequest,
    firebase_uid: str = Depends(require_firebase_auth),
):
    """The richer record behind one row, bought only when a row is opened."""

    _ = firebase_uid
    _guard()
    _no_store(response)
    try:
        return {"place": await _service().directory_place_details(payload.place_id)}
    except GoogleMapsError as exc:
        raise _handle(exc) from exc
