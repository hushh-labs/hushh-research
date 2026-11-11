"""Server-owned hosted return surfaces; callers never supply a redirect URL."""

from __future__ import annotations

from typing import Protocol
from urllib.parse import urlsplit


class ReturnSurfaceConfig(Protocol):
    frontend_origin: str
    return_path: str
    website_origin: str
    website_return_path: str


def validate_website_return(origin: str, path: str) -> None:
    parsed = urlsplit(origin)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.port is not None
        or parsed.path
        or parsed.query
        or parsed.fragment
        or origin != f"https://{parsed.netloc}"
        or path != "/profile"
    ):
        raise ValueError("invalid website commerce return surface")


def resolve_return_surface(config: ReturnSurfaceConfig, surface: str = "one") -> tuple[str, str]:
    if surface == "one":
        return config.frontend_origin, config.return_path
    if surface != "website" or not config.website_origin:
        raise ValueError("unavailable commerce return surface")
    validate_website_return(config.website_origin, config.website_return_path)
    return config.website_origin, config.website_return_path
