"""Readable public location URLs; the name never grants access or identifies the owner."""

import re
import unicodedata
from urllib.parse import quote


def public_invite_url(token: str, owner_label: str = "") -> str:
    """Add only the first name from the caller's already privacy-filtered label."""
    words = unicodedata.normalize("NFKC", owner_label).strip().split()
    first_name = words[0].casefold() if words else ""
    slug = "".join(
        char for char in first_name if unicodedata.category(char)[0] in {"L", "M"} or char == "-"
    )[:40].strip("-")
    segment = f"{quote(slug, safe='')}.{token}" if slug else token
    return f"/one/location/view/{segment}"


def public_invite_bearer_token(value: str) -> str:
    """Accept named URLs and existing bare tokens without changing bearer authority."""
    normalized = str(value or "").strip()
    name, separator, token = normalized.rpartition(".")
    if (
        separator
        and 0 < len(name) <= 40
        and all(unicodedata.category(char)[0] in {"L", "M"} or char == "-" for char in name)
        and re.fullmatch(r"[A-Za-z0-9_-]{43}", token)
    ):
        return token
    return normalized
