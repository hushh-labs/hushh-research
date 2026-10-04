"""Referral display handle normalization and validation."""

from __future__ import annotations

from hushh_mcp.operons.referral.handle import (
    HANDLE_MAX_LENGTH,
    is_valid_handle,
    normalize_handle,
)


def test_normalizes_case_and_unicode():
    assert normalize_handle("Ánkit") == "ankit"


def test_normalizes_spaces_to_hyphens():
    assert normalize_handle("Top Referrer") == "top-referrer"


def test_truncates_to_the_handle_bound():
    long_input = "a" * 50
    normalized = normalize_handle(long_input)

    assert len(normalized) <= HANDLE_MAX_LENGTH


def test_valid_handle_accepted():
    assert is_valid_handle("top-referrer") is True


def test_too_short_handle_rejected():
    assert is_valid_handle("ab") is False


def test_reserved_word_rejected():
    assert is_valid_handle("admin") is False


def test_unnormalized_input_is_not_a_valid_handle():
    """A caller must normalize first; is_valid_handle does not silently
    accept a form that would normalize to something different."""
    assert is_valid_handle("Top Referrer") is False


def test_empty_or_none_rejected():
    assert is_valid_handle("") is False
    assert is_valid_handle(None) is False
