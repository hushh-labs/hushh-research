"""Spherical venue geometry shared by discovery and radius enforcement."""

import math


def distance_meters(
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


def offset_coordinates(
    lat: float, lng: float, meters: float, bearing: float
) -> tuple[float, float]:
    """Destination on the same spherical model as the radius check."""
    angular = meters / 6_371_000.0
    latitude, longitude, heading = map(math.radians, (lat, lng, bearing))
    # A tangent basis avoids the destination-longitude singularity at ±90°.
    position = (
        math.cos(latitude) * math.cos(longitude),
        math.cos(latitude) * math.sin(longitude),
        math.sin(latitude),
    )
    north = (
        -math.sin(latitude) * math.cos(longitude),
        -math.sin(latitude) * math.sin(longitude),
        math.cos(latitude),
    )
    east = (-math.sin(longitude), math.cos(longitude), 0.0)
    x, y, z = (
        p * math.cos(angular) + (n * math.cos(heading) + e * math.sin(heading)) * math.sin(angular)
        for p, n, e in zip(position, north, east, strict=True)
    )
    return math.degrees(math.atan2(z, math.hypot(x, y))), math.degrees(math.atan2(y, x))
