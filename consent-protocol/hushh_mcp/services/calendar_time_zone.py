"""One place that decides which IANA zone a Calendar request is allowed to use."""

from __future__ import annotations

from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from hushh_mcp.services.google_connection_contract import GoogleConnectionError

# Browsers still report several retired tzdb names. Google Calendar accepts the
# current names, so every request is normalised to them before it is stored,
# checked for conflicts or sent. Offsets and daylight-saving rules always come
# from the tz database (ZoneInfo), never from a fixed offset.
LEGACY_TIME_ZONES: dict[str, str] = {
    "Asia/Calcutta": "Asia/Kolkata",
    "Asia/Katmandu": "Asia/Kathmandu",
    "Asia/Saigon": "Asia/Ho_Chi_Minh",
    "Asia/Rangoon": "Asia/Yangon",
    "Asia/Dacca": "Asia/Dhaka",
    "Europe/Kiev": "Europe/Kyiv",
    "America/Buenos_Aires": "America/Argentina/Buenos_Aires",
    "Pacific/Enderbury": "Pacific/Kanton",
}


def normalize_time_zone(value: object | None, *, default: str = "UTC") -> str:
    """Return the current IANA name, or refuse a zone that cannot be applied."""
    name = str(value or "").strip() or default
    name = LEGACY_TIME_ZONES.get(name, name)
    try:
        ZoneInfo(name)
    except (ValueError, ZoneInfoNotFoundError, OSError) as exc:
        raise GoogleConnectionError(
            "Choose a valid time zone", status_code=422, reason_code="calendar_invalid_request"
        ) from exc
    return name
