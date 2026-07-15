from __future__ import annotations

import re

import phonenumbers
import pycountry

_PHONE_PREFIX_PATTERN = re.compile(r"^\s*([A-Za-z][A-Za-z .'-]{1,32})[\s:,-]+([+\d().\-\s]+)\s*$")
_EXPLICIT_PHONE_PATTERN = re.compile(r"^[+\d().\-\s]+$")
_COUNTRY_ALIASES = {
    "UK": "GB",
    "UAE": "AE",
    "USA": "US",
}


def normalize_country_hint(value: str | None) -> str | None:
    candidate = str(value or "").strip()
    if not candidate:
        return None

    compact = re.sub(r"[^A-Za-z]", "", candidate).upper()
    if not compact:
        return None

    aliased = _COUNTRY_ALIASES.get(compact, compact)
    if len(aliased) == 2 and aliased in phonenumbers.SUPPORTED_REGIONS:
        return aliased

    try:
        country = pycountry.countries.lookup(candidate)
    except LookupError:
        return None

    alpha2 = str(getattr(country, "alpha_2", "") or "").upper()
    if alpha2 in phonenumbers.SUPPORTED_REGIONS:
        return alpha2
    return None


def _extract_country_prefixed_phone(value: str) -> tuple[str | None, str]:
    candidate = str(value or "").strip()
    if not candidate:
        return None, ""

    matched = _PHONE_PREFIX_PATTERN.match(candidate)
    if not matched:
        return None, candidate

    country_token = matched.group(1).strip()
    phone_candidate = matched.group(2).strip()
    region = normalize_country_hint(country_token)
    if not region:
        return None, candidate
    return region, phone_candidate


def normalize_phone_identifier(
    value: str | None,
    *,
    country_iso2: str | None = None,
    country: str | None = None,
) -> str | None:
    candidate = str(value or "").strip()
    if not candidate:
        return None

    if candidate.lower().startswith("tel:"):
        candidate = candidate[4:].strip()

    if not candidate:
        return None

    prefixed_region, maybe_phone = _extract_country_prefixed_phone(candidate)
    region_hint = (
        normalize_country_hint(country_iso2) or normalize_country_hint(country) or prefixed_region
    )
    phone_candidate = maybe_phone if prefixed_region else candidate

    if not _EXPLICIT_PHONE_PATTERN.fullmatch(phone_candidate):
        return None

    if not phone_candidate.startswith("+") and not region_hint:
        return None

    parse_region = None if phone_candidate.startswith("+") else region_hint
    try:
        parsed = phonenumbers.parse(phone_candidate, parse_region)
    except phonenumbers.NumberParseException:
        return None

    if not phonenumbers.is_possible_number(parsed):
        return None
    if not phonenumbers.is_valid_number(parsed):
        return None

    return phonenumbers.format_number(parsed, phonenumbers.PhoneNumberFormat.E164)


def resolve_lookup_identifier(
    *,
    identifier: str | None,
    email: str | None,
    phone_number: str | None,
    country_iso2: str | None = None,
    country: str | None = None,
) -> tuple[str, str]:
    if identifier and str(identifier).strip():
        raw = str(identifier).strip()
    elif email and str(email).strip():
        raw = str(email).strip()
    elif phone_number and str(phone_number).strip():
        raw = str(phone_number).strip()
    else:
        raise ValueError("Missing lookup identifier")

    if "@" in raw:
        return "email", raw.lower()

    normalized_phone = normalize_phone_identifier(
        raw,
        country_iso2=country_iso2,
        country=country,
    )
    if normalized_phone:
        return "phone", normalized_phone

    return "uid", raw
