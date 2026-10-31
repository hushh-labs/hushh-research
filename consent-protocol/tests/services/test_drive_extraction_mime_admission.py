"""Original Drive MIME admission must match the page parser's actual inputs."""

import pytest

from hushh_mcp.services.google_drive_adapter import (
    LIVE_EXPORT_FALLBACKS,
    LIVE_EXPORTS,
    LIVE_EXTRACTABLE_CONTENT_TYPES,
    LIVE_EXTRACTABLE_ORIGINAL_TYPES,
    LIVE_SUPPORTED_TYPES,
)

PARSER_INPUTS = frozenset(
    {
        "application/pdf",
        "text/plain",
        "text/markdown",
        "text/csv",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }
)


@pytest.mark.parametrize("original", sorted(LIVE_SUPPORTED_TYPES))
def test_every_provider_type_routes_to_a_real_page_parser_or_is_retired(original):
    exported = LIVE_EXPORTS.get(original, original)
    expected = exported in PARSER_INPUTS
    assert LIVE_EXTRACTABLE_CONTENT_TYPES == PARSER_INPUTS
    assert (original in LIVE_EXTRACTABLE_ORIGINAL_TYPES) is expected


def test_google_native_export_fallbacks_remain_parseable():
    assert LIVE_EXPORT_FALLBACKS
    assert all(
        original in LIVE_EXTRACTABLE_ORIGINAL_TYPES and fallback in PARSER_INPUTS
        for original, fallback in LIVE_EXPORT_FALLBACKS.items()
    )
    assert {
        "application/vnd.google-apps.document",
        "application/vnd.google-apps.spreadsheet",
        "application/vnd.google-apps.presentation",
    } <= LIVE_EXTRACTABLE_ORIGINAL_TYPES
    assert {
        "application/msword",
        "image/jpeg",
    }.isdisjoint(LIVE_EXTRACTABLE_ORIGINAL_TYPES)
