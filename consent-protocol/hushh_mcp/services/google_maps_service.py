"""Server-side proxy for Google Maps Platform (Places New + Routes).

Keeps the Maps key on the backend. The frontend never sees it; browser code
calls our own /api/one/location/maps/* endpoints, which call this service.
"""

from __future__ import annotations

import asyncio
import logging
import math
from typing import Any, Literal
from urllib.parse import quote

import httpx

from hushh_mcp.config import GOOGLE_MAPS_API_KEY

logger = logging.getLogger(__name__)

_TIMEOUT = httpx.Timeout(10.0, connect=5.0)
_PLACES_BASE = "https://places.googleapis.com"
_PLACES_NEARBY_URL = f"{_PLACES_BASE}/v1/places:searchNearby"
_ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes"
_GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json"
_NEARBY_CHECK_IN_RADIUS_METERS = 500.0
# Search Nearby (New) hard-caps a single response at 20. That cap is per
# request, not per area, which is why "All" alone can never be complete in a
# dense block: 20 cafes within 40 m bury the hotel 120 m away.
_NEARBY_CHECK_IN_RESULT_LIMIT = 20
# Ceiling for the merged multi-request sweep. Each category bucket contributes
# its own 20-result budget, so a hotel is never crowded out by restaurants.
_NEARBY_CHECK_IN_MERGED_LIMIT = 80

NearbyPlaceCategory = Literal[
    "all",
    "food_drink",
    "health",
    "shopping_services",
    "hotels_stays",
    "education",
    "outdoors_landmarks",
    "transit",
]

# One foreground request is used for the default list. Category filters are
# explicit follow-up requests so opening the drawer never fans out into several
# billable provider calls. These are broad Table A types from Places API (New):
# Google includes matching specialized subtypes (for example an Indian
# restaurant when `restaurant` is requested).
_NEARBY_PLACE_CATEGORY_TYPES: dict[str, tuple[str, ...]] = {
    "food_drink": ("restaurant", "cafe", "bakery", "bar", "meal_takeaway"),
    "health": ("hospital", "medical_clinic", "doctor", "dentist", "pharmacy"),
    "shopping_services": (
        "store",
        "shopping_mall",
        "supermarket",
        "convenience_store",
        "beauty_salon",
        "hair_salon",
        "barber_shop",
        "laundry",
        # Vehicle service stops are somewhere a person genuinely waits, so they
        # belong in the picker. They already surfaced under "All" (which sends no
        # includedTypes filter) but were unreachable from every category chip.
        "car_repair",
        "car_wash",
        "car_dealer",
        # Everyday errands people wait at, same reasoning.
        "bank",
        "atm",
        "post_office",
        "gym",
    ),
    "hotels_stays": (
        "hotel",
        "lodging",
        "motel",
        "hostel",
        "bed_and_breakfast",
        "campground",
    ),
    "education": (
        "school",
        "university",
        "preschool",
        "library",
        "educational_institution",
    ),
    "outdoors_landmarks": (
        "park",
        "tourist_attraction",
        "museum",
        "art_gallery",
        "historical_landmark",
        "beach",
        "garden",
        "plaza",
    ),
    "transit": (
        "transit_station",
        "bus_stop",
        "train_station",
        "subway_station",
        "airport",
        "parking",
        "gas_station",
    ),
}

# Search Nearby can return geographical/address records when no category filter
# is supplied. They are useful for geocoding but are not places a person can
# meaningfully check in to.
_NON_CHECK_IN_PRIMARY_TYPES = frozenset(
    {
        "colloquial_area",
        "continent",
        "country",
        "geocode",
        "intersection",
        "locality",
        "neighborhood",
        "political",
        "plus_code",
        "postal_town",
        "premise",
        "route",
        "room",
        "school_district",
        "street_address",
        "street_number",
        "subpremise",
    }
)
_NON_CHECK_IN_PRIMARY_TYPE_PREFIXES = (
    "administrative_area_level_",
    "postal_code",
    "sublocality",
)

# Types that prove a record is a real venue rather than a geocoded address, but
# are too vague to display as its category.
_GENERIC_ESTABLISHMENT_TYPES = frozenset({"establishment", "point_of_interest"})

def _build_category_index() -> dict[str, tuple[str, ...]]:
    """Reverse index from a Places type to the drawer's category chips.

    Built from the same table the requests use, so a place surfaced by the
    unfiltered sweep still lands under the right chip without a second call.
    """

    index: dict[str, tuple[str, ...]] = {}
    for category, place_types in _NEARBY_PLACE_CATEGORY_TYPES.items():
        for place_type in place_types:
            index[place_type] = (*index.get(place_type, ()), category)
    return index


_CATEGORY_BY_PLACE_TYPE = _build_category_index()


def _place_types(place: dict[str, Any]) -> list[str]:
    """Every type Google reported, primary first, de-duplicated."""

    ordered: list[str] = []
    seen: set[str] = set()
    for raw in (place.get("primaryType"), *(place.get("types") or [])):
        if not isinstance(raw, str):
            continue
        value = raw.strip()[:80]
        if not value or value in seen:
            continue
        seen.add(value)
        ordered.append(value)
    return ordered


def _is_non_check_in_type(place_type: str) -> bool:
    return place_type in _NON_CHECK_IN_PRIMARY_TYPES or place_type.startswith(
        _NON_CHECK_IN_PRIMARY_TYPE_PREFIXES
    )


def _place_categories(place_types: list[str]) -> list[str]:
    """Category chips this place belongs to, in the table's declared order."""

    matched = {
        category
        for place_type in place_types
        for category in _CATEGORY_BY_PLACE_TYPE.get(place_type, ())
    }
    return [category for category in _NEARBY_PLACE_CATEGORY_TYPES if category in matched]


class GoogleMapsError(RuntimeError):
    """Raised for a missing key (503) or an upstream Maps failure (502)."""

    def __init__(
        self,
        message: str,
        *,
        status_code: int,
        code: str = "ONE_LOCATION_MAPS_FAILED",
    ) -> None:
        self.status_code = status_code
        self.code = code
        super().__init__(message)


def is_configured() -> bool:
    return bool(GOOGLE_MAPS_API_KEY)


def _async_client() -> httpx.AsyncClient:
    # Wrapped so tests can inject a MockTransport client.
    return httpx.AsyncClient(timeout=_TIMEOUT)


def _require_key() -> str:
    if not GOOGLE_MAPS_API_KEY:
        raise GoogleMapsError("Maps is not configured on this backend.", status_code=503)
    return GOOGLE_MAPS_API_KEY


def _parse_duration_seconds(value: Any) -> int:
    text = str(value or "").strip()
    if text.endswith("s"):
        text = text[:-1]
    try:
        return int(float(text))
    except (TypeError, ValueError):
        return 0


def _classify_traffic(eta_seconds: int, static_seconds: int) -> str | None:
    """Classify congestion from the traffic-aware vs free-flow duration ratio."""
    if static_seconds <= 0 or eta_seconds <= 0:
        return None
    ratio = eta_seconds / static_seconds
    if ratio < 1.15:
        return "light"
    if ratio < 1.40:
        return "moderate"
    return "heavy"


def _country_code_from_components(components: Any) -> str | None:
    """Read an ISO alpha-2 country code from Geocoding or Places components."""
    if not isinstance(components, list):
        return None
    for component in components:
        if not isinstance(component, dict):
            continue
        types = component.get("types") or []
        if "country" not in types:
            continue
        value = component.get("short_name") or component.get("shortText")
        normalized = str(value or "").strip().upper()
        if len(normalized) == 2 and normalized.isalpha():
            return normalized
    return None


def _distance_meters(
    *,
    origin_lat: float,
    origin_lng: float,
    destination_lat: float,
    destination_lng: float,
) -> float:
    radius = 6_371_000.0
    lat1 = math.radians(origin_lat)
    lat2 = math.radians(destination_lat)
    delta_lat = math.radians(destination_lat - origin_lat)
    delta_lng = math.radians(destination_lng - origin_lng)
    value = (
        math.sin(delta_lat / 2.0) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin(delta_lng / 2.0) ** 2
    )
    clamped = max(0.0, min(1.0, value))
    return radius * (2.0 * math.atan2(math.sqrt(clamped), math.sqrt(max(0.0, 1.0 - clamped))))


def _valid_coordinates(*, lat: float, lng: float) -> bool:
    return (
        math.isfinite(lat)
        and math.isfinite(lng)
        and -90.0 <= lat <= 90.0
        and -180.0 <= lng <= 180.0
    )


def _provider_object(response: httpx.Response, operation: str) -> dict[str, Any]:
    try:
        payload = response.json()
    except ValueError as exc:
        raise GoogleMapsError(
            f"{operation} returned an invalid response.",
            status_code=502,
        ) from exc
    if not isinstance(payload, dict):
        raise GoogleMapsError(
            f"{operation} returned an invalid response.",
            status_code=502,
        )
    return payload


def _check_in_place_identity(
    place: dict[str, Any],
) -> tuple[str, str, list[str]] | None:
    """Return name, category type and types for a physical, usable check-in place.

    `primaryType` is absent on a large share of real venues -- independent
    hotels, clinics and shops routinely come back with `types` only. Requiring
    it silently deleted exactly those places from the picker, which is how a
    second hotel behind the first went missing. Any non-address type now
    qualifies, and a bare `establishment` still counts as a venue while a
    geocoded address (`street_address`, `premise`, ...) still does not.
    """

    business_status = str(place.get("businessStatus") or "").strip().upper()
    if business_status and business_status != "OPERATIONAL":
        return None
    pure_service_area = place.get("pureServiceAreaBusiness")
    if pure_service_area is True or (
        pure_service_area is not None and not isinstance(pure_service_area, bool)
    ):
        return None
    display_name = place.get("displayName") or {}
    if not isinstance(display_name, dict):
        return None
    raw_display = display_name.get("text")
    if not isinstance(raw_display, str):
        return None
    display = raw_display.strip()[:160]
    if not display:
        return None

    place_types = _place_types(place)
    if not place_types:
        return None
    descriptive = [
        place_type
        for place_type in place_types
        if not _is_non_check_in_type(place_type)
        and place_type not in _GENERIC_ESTABLISHMENT_TYPES
    ]
    if descriptive:
        return display, descriptive[0], place_types
    # No descriptive type left. Keep it only when Google still calls it a venue,
    # so a named business survives while an address record does not.
    if any(
        place_type in _GENERIC_ESTABLISHMENT_TYPES for place_type in place_types
    ):
        return display, "establishment", place_types
    return None


class GoogleMapsService:
    async def _nearest_place_address(
        self,
        *,
        key: str,
        lat: float,
        lng: float,
    ) -> dict[str, Any]:
        """Resolve a nearby address when Geocoding is unavailable for this key."""
        async with _async_client() as client:
            try:
                response = await client.post(
                    _PLACES_NEARBY_URL,
                    headers={
                        "Content-Type": "application/json",
                        "X-Goog-Api-Key": key,
                        "X-Goog-FieldMask": (
                            "places.displayName,places.formattedAddress,places.addressComponents"
                        ),
                    },
                    json={
                        "maxResultCount": 1,
                        "rankPreference": "DISTANCE",
                        "locationRestriction": {
                            "circle": {
                                "center": {
                                    "latitude": lat,
                                    "longitude": lng,
                                },
                                # Keep the fallback tightly bounded so a distant
                                # landmark is never presented as the user's place.
                                "radius": 100.0,
                            }
                        },
                    },
                )
            except httpx.HTTPError as exc:
                raise GoogleMapsError(
                    f"Nearby place lookup failed: {exc}",
                    status_code=502,
                ) from exc
        if response.status_code >= 400:
            logger.warning(
                "maps.reverse_geocode nearby upstream %s",
                response.status_code,
            )
            raise GoogleMapsError("Nearby place lookup failed.", status_code=502)

        places = response.json().get("places") or []
        if not places:
            return {
                "name": None,
                "formattedAddress": None,
                "countryCode": None,
            }
        place = places[0]
        name = (place.get("displayName") or {}).get("text") or None
        formatted = place.get("formattedAddress") or None
        return {
            "name": str(name) if name else None,
            "formattedAddress": str(formatted) if formatted else None,
            "countryCode": _country_code_from_components(place.get("addressComponents")),
        }

    async def autocomplete(
        self,
        input_text: str,
        *,
        session_token: str | None = None,
        lat: float | None = None,
        lng: float | None = None,
        nearby_only: bool = False,
    ) -> list[dict[str, Any]]:
        key = _require_key()
        body: dict[str, Any] = {"input": input_text}
        if session_token:
            body["sessionToken"] = session_token
        if lat is not None and lng is not None:
            location_area = {
                "circle": {
                    "center": {
                        "latitude": float(lat),
                        "longitude": float(lng),
                    },
                    "radius": (_NEARBY_CHECK_IN_RADIUS_METERS if nearby_only else 2_000.0),
                }
            }
            body["locationRestriction" if nearby_only else "locationBias"] = location_area
            if nearby_only:
                body["origin"] = {
                    "latitude": float(lat),
                    "longitude": float(lng),
                }
        async with _async_client() as client:
            try:
                response = await client.post(
                    f"{_PLACES_BASE}/v1/places:autocomplete",
                    headers={
                        "Content-Type": "application/json",
                        "X-Goog-Api-Key": key,
                    },
                    json=body,
                )
            except httpx.HTTPError as exc:
                raise GoogleMapsError(
                    f"Places autocomplete failed: {exc}", status_code=502
                ) from exc
        if response.status_code >= 400:
            logger.warning("maps.autocomplete upstream %s", response.status_code)
            raise GoogleMapsError("Places autocomplete failed.", status_code=502)
        data = _provider_object(response, "Places autocomplete")
        provider_suggestions = data.get("suggestions") or []
        if not isinstance(provider_suggestions, list):
            raise GoogleMapsError(
                "Places autocomplete returned an invalid response.",
                status_code=502,
            )
        results: list[dict[str, Any]] = []
        for suggestion in provider_suggestions[:20]:
            if not isinstance(suggestion, dict):
                continue
            prediction = suggestion.get("placePrediction") or {}
            if not isinstance(prediction, dict):
                continue
            place_id = prediction.get("placeId")
            prediction_text = prediction.get("text") or {}
            if not isinstance(prediction_text, dict):
                prediction_text = {}
            text = prediction_text.get("text")
            normalized_place_id = str(place_id or "").strip()
            normalized_text = str(text or "").strip()[:500]
            if normalized_place_id and len(normalized_place_id) <= 300 and normalized_text:
                distance = prediction.get("distanceMeters")
                if nearby_only and isinstance(distance, (int, float)):
                    normalized_distance = float(distance)
                    if (
                        not math.isfinite(normalized_distance)
                        or normalized_distance < 0
                        or normalized_distance > _NEARBY_CHECK_IN_RADIUS_METERS
                    ):
                        continue
                results.append(
                    {
                        "placeId": normalized_place_id,
                        "text": normalized_text,
                        **(
                            {"distanceMeters": int(round(float(distance)))}
                            if nearby_only and isinstance(distance, (int, float))
                            else {}
                        ),
                    }
                )
        return results

    async def _search_nearby_once(
        self,
        client: httpx.AsyncClient,
        *,
        key: str,
        lat: float,
        lng: float,
        included_types: tuple[str, ...] | None,
    ) -> list[dict[str, Any]]:
        """One Search Nearby call. Returns the raw provider place records."""

        body: dict[str, Any] = {
            "maxResultCount": _NEARBY_CHECK_IN_RESULT_LIMIT,
            "rankPreference": "DISTANCE",
            "locationRestriction": {
                "circle": {
                    "center": {
                        "latitude": float(lat),
                        "longitude": float(lng),
                    },
                    "radius": _NEARBY_CHECK_IN_RADIUS_METERS,
                }
            },
        }
        if included_types:
            body["includedTypes"] = list(included_types)
        try:
            response = await client.post(
                _PLACES_NEARBY_URL,
                headers={
                    "Content-Type": "application/json",
                    "X-Goog-Api-Key": key,
                    "X-Goog-FieldMask": (
                        "places.id,places.displayName,places.shortFormattedAddress,"
                        "places.formattedAddress,places.location,places.primaryType,"
                        "places.types,places.primaryTypeDisplayName,"
                        "places.businessStatus,places.pureServiceAreaBusiness"
                    ),
                },
                json=body,
            )
        except httpx.HTTPError as exc:
            raise GoogleMapsError(
                f"Nearby places lookup failed: {exc}",
                status_code=502,
            ) from exc
        if response.status_code >= 400:
            logger.warning("maps.nearby_places upstream %s", response.status_code)
            raise GoogleMapsError("Nearby places lookup failed.", status_code=502)
        payload = _provider_object(response, "Nearby places lookup")
        provider_places = payload.get("places") or []
        if not isinstance(provider_places, list):
            raise GoogleMapsError(
                "Nearby places lookup returned an invalid response.",
                status_code=502,
            )
        return [place for place in provider_places if isinstance(place, dict)]

    def _normalize_nearby_place(
        self,
        place: dict[str, Any],
        *,
        lat: float,
        lng: float,
    ) -> dict[str, Any] | None:
        """Shape one provider record, or drop it if it is not check-in-able."""

        place_id = str(place.get("id") or "").strip()
        if not place_id or len(place_id) > 300:
            return None
        location = place.get("location") or {}
        if not isinstance(location, dict):
            return None
        try:
            place_lat = float(location.get("latitude"))
            place_lng = float(location.get("longitude"))
        except (TypeError, ValueError):
            return None
        if not _valid_coordinates(lat=place_lat, lng=place_lng):
            return None
        identity = _check_in_place_identity(place)
        if identity is None:
            return None
        display, primary_type, place_types = identity
        address = str(
            place.get("shortFormattedAddress") or place.get("formattedAddress") or ""
        ).strip()[:300]
        text = ", ".join(part for part in (display, address) if part)
        if not text:
            return None
        raw_distance_meters = _distance_meters(
            origin_lat=float(lat),
            origin_lng=float(lng),
            destination_lat=place_lat,
            destination_lng=place_lng,
        )
        if (
            not math.isfinite(raw_distance_meters)
            or raw_distance_meters > _NEARBY_CHECK_IN_RADIUS_METERS
        ):
            return None
        primary_type_display = place.get("primaryTypeDisplayName") or {}
        if not isinstance(primary_type_display, dict):
            primary_type_display = {}
        category_label = str(primary_type_display.get("text") or "").strip()[:80]
        if not category_label and primary_type:
            category_label = primary_type.replace("_", " ").title()
        return {
            "placeId": place_id,
            "name": display,
            "address": address or None,
            "text": text,
            "distanceMeters": int(round(raw_distance_meters)),
            # The owner's own chosen venue is public Google data, so its point
            # may travel to the client -- it is what the map pins and what the
            # backend anchors co-presence on. A nearby *person* never gets one.
            "latitude": place_lat,
            "longitude": place_lng,
            "primaryType": primary_type or None,
            "category": category_label or "Place",
            "categories": _place_categories(place_types),
        }

    async def nearby_places(
        self,
        *,
        lat: float,
        lng: float,
        category: NearbyPlaceCategory = "all",
    ) -> list[dict[str, Any]]:
        """Return the nearest check-in-able places, complete rather than merely bounded.

        A single Search Nearby response is capped at 20 records by the provider.
        On "All" that cap is spent on whatever happens to be closest, so a hotel
        one street back disappears behind twenty cafes -- and the drawer looked
        like it had simply skipped it. "All" therefore sweeps every category
        bucket concurrently and merges: each bucket brings its own 20-result
        budget, so no category can crowd out another.

        The request point is sent to Google only for this foreground request and
        is not cached or logged by this service. Exact distance helps the owner
        choose a place but is never included in nearby-person responses.
        """

        key = _require_key()
        # (chip this request stands for, types it filters on). The leading
        # (None, None) sweep is unfiltered and catches anything the buckets miss.
        requests: list[tuple[str | None, tuple[str, ...] | None]]
        if category == "all":
            requests = [
                (None, None),
                *(
                    (chip, types)
                    for chip, types in _NEARBY_PLACE_CATEGORY_TYPES.items()
                ),
            ]
        else:
            requests = [(category, _NEARBY_PLACE_CATEGORY_TYPES.get(category))]

        async with _async_client() as client:
            batches = await asyncio.gather(
                *(
                    self._search_nearby_once(
                        client,
                        key=key,
                        lat=lat,
                        lng=lng,
                        included_types=included_types,
                    )
                    for _chip, included_types in requests
                ),
                return_exceptions=True,
            )

        merged: dict[str, dict[str, Any]] = {}
        order: dict[str, int] = {}
        chips: dict[str, set[str]] = {}
        fallback_chips: dict[str, set[str]] = {}
        failures = 0
        for (request_chip, _types), batch in zip(requests, batches, strict=True):
            if isinstance(batch, BaseException):
                # One bucket failing must not empty the whole picker; the rest
                # of the sweep is still a better list than no list.
                failures += 1
                continue
            for source_index, place in enumerate(batch):
                normalized = self._normalize_nearby_place(place, lat=lat, lng=lng)
                if normalized is None:
                    continue
                place_id = str(normalized["placeId"])
                chips.setdefault(place_id, set()).update(normalized["categories"])
                if request_chip:
                    # Remember which filters surfaced this place. Used only as a
                    # fallback below, so a precisely-typed venue keeps precise
                    # chips and is never filed under a category it is not in.
                    fallback_chips.setdefault(place_id, set()).add(request_chip)
                if place_id not in merged:
                    merged[place_id] = normalized
                    order[place_id] = source_index
                else:
                    order[place_id] = min(order[place_id], source_index)

        for place_id, place in merged.items():
            # A venue Google reports with only `establishment` maps to no chip
            # of its own, yet a category filter still surfaced it -- an
            # independent hotel is the common case. File it under the filters
            # that found it so tapping "Hotels" cannot hide it.
            matched = chips.get(place_id) or fallback_chips.get(place_id, set())
            place["categories"] = [
                chip for chip in _NEARBY_PLACE_CATEGORY_TYPES if chip in matched
            ]

        if not merged and failures == len(batches):
            raise GoogleMapsError("Nearby places lookup failed.", status_code=502)

        results = sorted(
            merged.values(),
            key=lambda item: (
                int(item["distanceMeters"]),
                order[str(item["placeId"])],
                str(item["name"]).casefold(),
            ),
        )
        limit = (
            _NEARBY_CHECK_IN_MERGED_LIMIT
            if category == "all"
            else _NEARBY_CHECK_IN_RESULT_LIMIT
        )
        return results[:limit]

    async def place_details(
        self,
        place_id: str,
        *,
        require_check_inable: bool = False,
    ) -> dict[str, Any]:
        key = _require_key()
        async with _async_client() as client:
            try:
                response = await client.get(
                    f"{_PLACES_BASE}/v1/places/{quote(place_id, safe='')}",
                    headers={
                        "X-Goog-Api-Key": key,
                        "X-Goog-FieldMask": (
                            "id,location,displayName,formattedAddress,primaryType,"
                            # `types` must stay in step with the picker's field
                            # mask: a venue with no primaryType is listable, so
                            # it has to stay confirmable at check-in too.
                            "types,businessStatus,pureServiceAreaBusiness"
                        ),
                    },
                )
            except httpx.HTTPError as exc:
                raise GoogleMapsError(f"Place details failed: {exc}", status_code=502) from exc
        if response.status_code >= 400:
            logger.warning("maps.place_details upstream %s", response.status_code)
            raise GoogleMapsError("Place details failed.", status_code=502)
        data = _provider_object(response, "Place details lookup")
        location = data.get("location") or {}
        if not isinstance(location, dict):
            raise GoogleMapsError(
                "Place details lookup returned an invalid location.",
                status_code=502,
            )
        try:
            latitude = float(location.get("latitude"))
            longitude = float(location.get("longitude"))
        except (TypeError, ValueError) as exc:
            raise GoogleMapsError(
                "Place details lookup returned an invalid location.",
                status_code=502,
            ) from exc
        if not _valid_coordinates(lat=latitude, lng=longitude):
            raise GoogleMapsError(
                "Place details lookup returned an invalid location.",
                status_code=502,
            )
        if require_check_inable and _check_in_place_identity(data) is None:
            raise GoogleMapsError(
                "The selected place is not available for check-in.",
                status_code=422,
                code="ONE_LOCATION_PLACE_NOT_CHECK_INABLE",
            )
        display_name = data.get("displayName") or {}
        if not isinstance(display_name, dict):
            display_name = {}
        display = str(display_name.get("text") or "").strip()[:160]
        address = str(data.get("formattedAddress") or "").strip()[:300]
        label = ", ".join(part for part in (display, address) if part) or display or address
        return {
            "placeId": str(data.get("id") or place_id),
            "label": label,
            "latitude": latitude,
            "longitude": longitude,
        }

    async def reverse_geocode(self, *, lat: float, lng: float) -> dict[str, Any]:
        key = _require_key()
        async with _async_client() as client:
            try:
                response = await client.get(
                    _GEOCODE_URL,
                    params={"latlng": f"{lat},{lng}", "key": key},
                )
            except httpx.HTTPError as exc:
                raise GoogleMapsError(f"Reverse geocode failed: {exc}", status_code=502) from exc
        if response.status_code >= 400:
            logger.warning("maps.reverse_geocode upstream %s", response.status_code)
            raise GoogleMapsError("Reverse geocode failed.", status_code=502)
        data = response.json()
        results = data.get("results") or []
        if not results:
            provider_status = str(data.get("status") or "").strip().upper()
            if provider_status == "REQUEST_DENIED":
                return await self._nearest_place_address(key=key, lat=lat, lng=lng)
            if provider_status in {"", "OK", "ZERO_RESULTS"}:
                return {
                    "name": None,
                    "formattedAddress": None,
                    "countryCode": None,
                }
            logger.warning(
                "maps.reverse_geocode logical status %s",
                provider_status,
            )
            raise GoogleMapsError("Reverse geocode failed.", status_code=502)
        formatted = results[0].get("formatted_address") or None
        country_code: str | None = None
        name: str | None = None
        for result in results:
            if country_code is None:
                country_code = _country_code_from_components(result.get("address_components"))
            types = result.get("types") or []
            if name is None and any(
                t in types for t in ("point_of_interest", "establishment", "premise")
            ):
                components = result.get("address_components") or []
                if components:
                    name = components[0].get("long_name") or None
        return {
            "name": name,
            "formattedAddress": formatted,
            "countryCode": country_code,
        }

    async def route_eta(
        self,
        *,
        origin_lat: float,
        origin_lng: float,
        dest_lat: float,
        dest_lng: float,
    ) -> dict[str, Any]:
        key = _require_key()
        body = {
            "origin": {"location": {"latLng": {"latitude": origin_lat, "longitude": origin_lng}}},
            "destination": {"location": {"latLng": {"latitude": dest_lat, "longitude": dest_lng}}},
            "travelMode": "DRIVE",
            "routingPreference": "TRAFFIC_AWARE",
        }
        async with _async_client() as client:
            try:
                response = await client.post(
                    _ROUTES_URL,
                    headers={
                        "Content-Type": "application/json",
                        "X-Goog-Api-Key": key,
                        "X-Goog-FieldMask": "routes.duration,routes.staticDuration,routes.distanceMeters",
                    },
                    json=body,
                )
            except httpx.HTTPError as exc:
                raise GoogleMapsError(f"Route ETA failed: {exc}", status_code=502) from exc
        if response.status_code >= 400:
            logger.warning("maps.route_eta upstream %s", response.status_code)
            raise GoogleMapsError("Route ETA failed.", status_code=502)
        routes = response.json().get("routes") or []
        if not routes:
            raise GoogleMapsError("No route found.", status_code=502)
        route = routes[0]
        eta_seconds = _parse_duration_seconds(route.get("duration"))
        static_seconds = _parse_duration_seconds(route.get("staticDuration"))
        return {
            "etaSeconds": eta_seconds,
            "distanceMeters": int(route.get("distanceMeters", 0) or 0),
            "trafficLevel": _classify_traffic(eta_seconds, static_seconds),
        }
