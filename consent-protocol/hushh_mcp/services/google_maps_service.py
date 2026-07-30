"""Server-side proxy for Google Maps Platform (Places New + Routes).

Keeps the Maps key on the backend. The frontend never sees it; browser code
calls our own /api/one/location/maps/* endpoints, which call this service.
"""

from __future__ import annotations

import logging
import math
from typing import Any
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
_NEARBY_CHECK_IN_RESULT_LIMIT = 8


class GoogleMapsError(RuntimeError):
    """Raised for a missing key (503) or an upstream Maps failure (502)."""

    def __init__(self, message: str, *, status_code: int) -> None:
        self.status_code = status_code
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
    ) -> list[dict[str, Any]]:
        key = _require_key()
        body: dict[str, Any] = {"input": input_text}
        if session_token:
            body["sessionToken"] = session_token
        if lat is not None and lng is not None:
            body["locationBias"] = {
                "circle": {
                    "center": {
                        "latitude": float(lat),
                        "longitude": float(lng),
                    },
                    "radius": 2_000.0,
                }
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
        data = response.json()
        results: list[dict[str, Any]] = []
        for suggestion in data.get("suggestions", []):
            prediction = suggestion.get("placePrediction") or {}
            place_id = prediction.get("placeId")
            text = (prediction.get("text") or {}).get("text")
            if place_id and text:
                results.append({"placeId": str(place_id), "text": str(text)})
        return results

    async def nearby_places(
        self,
        *,
        lat: float,
        lng: float,
    ) -> list[dict[str, Any]]:
        """Return a bounded nearest-place picker for explicit check-in.

        The request point is sent to Google only for this foreground request and
        is not cached or logged by this service. Exact distance helps the owner
        choose a place but is never included in nearby-person responses.
        """

        key = _require_key()
        async with _async_client() as client:
            try:
                response = await client.post(
                    _PLACES_NEARBY_URL,
                    headers={
                        "Content-Type": "application/json",
                        "X-Goog-Api-Key": key,
                        "X-Goog-FieldMask": (
                            "places.id,places.displayName,places.formattedAddress,places.location"
                        ),
                    },
                    json={
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
                    },
                )
            except httpx.HTTPError as exc:
                raise GoogleMapsError(
                    f"Nearby places lookup failed: {exc}",
                    status_code=502,
                ) from exc
        if response.status_code >= 400:
            logger.warning("maps.nearby_places upstream %s", response.status_code)
            raise GoogleMapsError("Nearby places lookup failed.", status_code=502)

        results: list[dict[str, Any]] = []
        for place in (response.json().get("places") or [])[:_NEARBY_CHECK_IN_RESULT_LIMIT]:
            place_id = str(place.get("id") or "").strip()
            location = place.get("location") or {}
            try:
                place_lat = float(location.get("latitude"))
                place_lng = float(location.get("longitude"))
            except (TypeError, ValueError):
                continue
            if not place_id:
                continue
            display = str((place.get("displayName") or {}).get("text") or "").strip()
            address = str(place.get("formattedAddress") or "").strip()
            text = ", ".join(part for part in (display, address) if part)
            if not text:
                continue
            results.append(
                {
                    "placeId": place_id,
                    "text": text,
                    "distanceMeters": int(
                        round(
                            _distance_meters(
                                origin_lat=float(lat),
                                origin_lng=float(lng),
                                destination_lat=place_lat,
                                destination_lng=place_lng,
                            )
                        )
                    ),
                }
            )
        return results

    async def place_details(self, place_id: str) -> dict[str, Any]:
        key = _require_key()
        async with _async_client() as client:
            try:
                response = await client.get(
                    f"{_PLACES_BASE}/v1/places/{quote(place_id, safe='')}",
                    headers={
                        "X-Goog-Api-Key": key,
                        "X-Goog-FieldMask": "id,location,displayName,formattedAddress",
                    },
                )
            except httpx.HTTPError as exc:
                raise GoogleMapsError(f"Place details failed: {exc}", status_code=502) from exc
        if response.status_code >= 400:
            logger.warning("maps.place_details upstream %s", response.status_code)
            raise GoogleMapsError("Place details failed.", status_code=502)
        data = response.json()
        location = data.get("location") or {}
        display = (data.get("displayName") or {}).get("text") or ""
        address = data.get("formattedAddress") or ""
        label = ", ".join(part for part in (display, address) if part) or display or address
        return {
            "placeId": str(data.get("id") or place_id),
            "label": label,
            "latitude": float(location.get("latitude", 0.0)),
            "longitude": float(location.get("longitude", 0.0)),
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
