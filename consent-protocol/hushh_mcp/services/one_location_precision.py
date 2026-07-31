"""Pure precision-mode helpers for One Location points and grant metadata."""

from __future__ import annotations

import math
from typing import Any

APPROXIMATE_AREA_GRID_METERS = 1_000
APPROXIMATE_AREA_MIN_RADIUS_M = 1_000
APPROXIMATE_AREA_MAX_RADIUS_M = 20_000
APPROXIMATE_AREA_RADIUS_STEP_M = 250

_EARTH_RADIUS_M = 6_378_137.0
_MAX_WEB_MERCATOR_LATITUDE = 85.05112878
_WORLD_WIDTH_M = 2 * math.pi * _EARTH_RADIUS_M


def normalize_location_mode(value: Any) -> str:
    mode = str(value or "precise").strip().lower()
    if mode not in {"precise", "approximate"}:
        raise ValueError("Location mode must be precise or approximate.")
    return mode


def normalize_approximate_radius_m(*, mode: str, value: Any) -> int | None:
    if mode == "precise":
        if value not in {None, ""}:
            raise ValueError("Precise location must not include an approximate radius.")
        return None
    radius = APPROXIMATE_AREA_MIN_RADIUS_M if value in {None, ""} else int(value)
    if not APPROXIMATE_AREA_MIN_RADIUS_M <= radius <= APPROXIMATE_AREA_MAX_RADIUS_M:
        raise ValueError("Approximate location radius is outside the supported range.")
    if radius % APPROXIMATE_AREA_RADIUS_STEP_M != 0:
        raise ValueError("Approximate location radius must use a 250 metre step.")
    return radius


def _normalize_longitude(longitude: float) -> float:
    normalized = ((longitude + 180.0) % 360.0) - 180.0
    return 180.0 if normalized == -180.0 and longitude > 0 else normalized


def approximate_area_center(*, latitude: float, longitude: float) -> tuple[float, float]:
    bounded_latitude = min(
        _MAX_WEB_MERCATOR_LATITUDE,
        max(-_MAX_WEB_MERCATOR_LATITUDE, latitude),
    )
    bounded_longitude = _normalize_longitude(longitude)
    latitude_radians = math.radians(bounded_latitude)
    projected_x = _EARTH_RADIUS_M * math.radians(bounded_longitude)
    projected_y = _EARTH_RADIUS_M * math.log(math.tan(math.pi / 4 + latitude_radians / 2))

    def grid_center(value: float) -> float:
        return (
            math.floor((value + _WORLD_WIDTH_M / 2) / APPROXIMATE_AREA_GRID_METERS)
            * APPROXIMATE_AREA_GRID_METERS
            + APPROXIMATE_AREA_GRID_METERS / 2
            - _WORLD_WIDTH_M / 2
        )

    center_x = grid_center(projected_x)
    center_y = grid_center(projected_y)
    center_longitude = _normalize_longitude(math.degrees(center_x / _EARTH_RADIUS_M))
    center_latitude = min(
        _MAX_WEB_MERCATOR_LATITUDE,
        max(
            -_MAX_WEB_MERCATOR_LATITUDE,
            math.degrees(2 * math.atan(math.exp(center_y / _EARTH_RADIUS_M)) - math.pi / 2),
        ),
    )
    return center_latitude, center_longitude


def approximate_area_radius_m(accuracy_m: float | None) -> int:
    source_accuracy = accuracy_m if accuracy_m is not None and accuracy_m > 0 else 0.0
    required_radius = max(
        APPROXIMATE_AREA_MIN_RADIUS_M,
        source_accuracy + math.sqrt(2) * (APPROXIMATE_AREA_GRID_METERS / 2),
    )
    stepped = (
        math.ceil(required_radius / APPROXIMATE_AREA_RADIUS_STEP_M) * APPROXIMATE_AREA_RADIUS_STEP_M
    )
    return min(APPROXIMATE_AREA_MAX_RADIUS_M, max(APPROXIMATE_AREA_MIN_RADIUS_M, stepped))
