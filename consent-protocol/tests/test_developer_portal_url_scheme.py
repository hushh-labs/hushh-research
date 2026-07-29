"""
Tests for URL scheme validation on DeveloperPortalProfileUpdateRequest.

Developer app profiles store four URL fields (support_url, policy_url,
website_url, brand_image_url) that are persisted to the database and
surfaced to end users inside consent flows.  Accepting arbitrary URI
schemes (javascript:, data:, vbscript:) creates a stored XSS / phishing
vector when the frontend renders these values as anchor hrefs.

These tests confirm that non-http/https URIs are rejected at the Pydantic
layer before the profile update handler runs.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from api.routes.developer import DeveloperPortalProfileUpdateRequest

_URL_FIELDS = ("support_url", "policy_url", "website_url", "brand_image_url")
_SAFE_HTTPS = "https://example.com/page"
_SAFE_HTTP = "http://example.com/page"
_DANGEROUS_SCHEMES = [
    "javascript:alert(1)",
    "javascript:void(0)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:MsgBox(1)",
    "file:///etc/passwd",
    "ftp://internal-server/secret",
]


# ---------------------------------------------------------------------------
# Accepted values
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("field", _URL_FIELDS)
def test_https_url_accepted(field):
    req = DeveloperPortalProfileUpdateRequest(**{field: _SAFE_HTTPS})
    assert getattr(req, field) == _SAFE_HTTPS


@pytest.mark.parametrize("field", _URL_FIELDS)
def test_http_url_accepted(field):
    req = DeveloperPortalProfileUpdateRequest(**{field: _SAFE_HTTP})
    assert getattr(req, field) == _SAFE_HTTP


@pytest.mark.parametrize("field", _URL_FIELDS)
def test_none_accepted(field):
    req = DeveloperPortalProfileUpdateRequest(**{field: None})
    assert getattr(req, field) is None


@pytest.mark.parametrize("field", _URL_FIELDS)
def test_omitted_defaults_to_none(field):
    req = DeveloperPortalProfileUpdateRequest()
    assert getattr(req, field) is None


# ---------------------------------------------------------------------------
# Rejected values -- dangerous URI schemes
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("field", _URL_FIELDS)
@pytest.mark.parametrize("bad_url", _DANGEROUS_SCHEMES)
def test_dangerous_scheme_rejected(field, bad_url):
    with pytest.raises(ValidationError):
        DeveloperPortalProfileUpdateRequest(**{field: bad_url})
