"""Shared public-page admission, never a claim that a page belongs to its owner."""

import ipaddress
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator


def public_source_urls(values: list[str]) -> list[str]:
    if len(set(values)) != len(values):
        raise ValueError("Supply distinct sources")
    for value in values:
        parsed = urlsplit(value)
        host = parsed.hostname or ""
        if (
            len(value) > 2048
            or parsed.scheme != "https"
            or not host
            or "." not in host
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
            or parsed.port not in {None, 443}
            or host.endswith((".localhost", ".local", ".internal"))
        ):
            raise ValueError("Supply public HTTPS pages without query strings or credentials")
        try:
            ipaddress.ip_address(host)
        except ValueError:
            pass
        else:
            raise ValueError("IP-address sources are not accepted")
    return values


class OwnerPublicProfiles(BaseModel):
    model_config = ConfigDict(extra="forbid")
    urls: list[str] = Field(min_length=1, max_length=3)
    permitted_public_sources: bool = Field(strict=True)

    _urls = field_validator("urls")(public_source_urls)

    @field_validator("permitted_public_sources")
    @classmethod
    def permission(cls, value):
        if not value:
            raise ValueError("Confirm public profile permission")
        return value
