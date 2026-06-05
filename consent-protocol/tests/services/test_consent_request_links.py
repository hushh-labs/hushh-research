"""Behavioral tests for URL-building helpers in consent_request_links.py.

Canonical attach point: ``hushh_mcp/services/consent_request_links.py`` is
called by ``hushh_mcp/services/consent_db.py`` (``build_consent_request_url``)
to produce the deep-link URL embedded in consent-request push notifications,
emails, and SSE events. A wrong URL breaks the consent flow for the end user.

Functions under test:
- ``build_consent_request_path``: query-param composition, actor/manager_view
  whitelist, view default, empty-string fallback
- ``build_connection_request_path``: selected param, tab default
- ``build_consent_request_url`` / ``build_connection_request_url``: full URL
  assembly with patched ``frontend_origin()``

All tests are hermetic -- no DB, network, or real env vars required.
"""

from __future__ import annotations

from unittest.mock import patch
from urllib.parse import parse_qs, urlparse

from hushh_mcp.services.consent_request_links import (
    build_connection_request_path,
    build_connection_request_url,
    build_consent_request_path,
    build_consent_request_url,
)

_ORIGIN = "https://app.hushh.ai"


def _parse_path(path: str) -> tuple[str, dict[str, list[str]]]:
    parsed = urlparse(path)
    return parsed.path, parse_qs(parsed.query)


# ---------------------------------------------------------------------------
# build_consent_request_path
# ---------------------------------------------------------------------------


class TestBuildConsentRequestPath:
    def test_default_tab_is_pending(self):
        path, params = _parse_path(build_consent_request_path())
        assert path == "/consents"
        assert params["tab"] == ["pending"]

    def test_request_id_included_when_provided(self):
        _, params = _parse_path(build_consent_request_path(request_id="req-123"))
        assert params["requestId"] == ["req-123"]

    def test_request_id_omitted_when_none(self):
        _, params = _parse_path(build_consent_request_path(request_id=None))
        assert "requestId" not in params

    def test_bundle_id_included_when_provided(self):
        _, params = _parse_path(build_consent_request_path(bundle_id="bundle-abc"))
        assert params["bundleId"] == ["bundle-abc"]

    def test_bundle_id_omitted_when_none(self):
        _, params = _parse_path(build_consent_request_path(bundle_id=None))
        assert "bundleId" not in params

    def test_view_overrides_tab(self):
        _, params = _parse_path(build_consent_request_path(view="approved"))
        assert params["tab"] == ["approved"]

    def test_empty_view_falls_back_to_pending(self):
        _, params = _parse_path(build_consent_request_path(view=""))
        assert params["tab"] == ["pending"]

    def test_actor_investor_included(self):
        _, params = _parse_path(build_consent_request_path(actor="investor"))
        assert params["actor"] == ["investor"]

    def test_actor_ria_included(self):
        _, params = _parse_path(build_consent_request_path(actor="ria"))
        assert params["actor"] == ["ria"]

    def test_actor_unknown_excluded(self):
        _, params = _parse_path(build_consent_request_path(actor="admin"))
        assert "actor" not in params

    def test_actor_none_excluded(self):
        _, params = _parse_path(build_consent_request_path(actor=None))
        assert "actor" not in params

    def test_manager_view_incoming_included(self):
        _, params = _parse_path(build_consent_request_path(manager_view="incoming"))
        assert params["view"] == ["incoming"]

    def test_manager_view_outgoing_included(self):
        _, params = _parse_path(build_consent_request_path(manager_view="outgoing"))
        assert params["view"] == ["outgoing"]

    def test_manager_view_unknown_excluded(self):
        _, params = _parse_path(build_consent_request_path(manager_view="all"))
        assert "view" not in params

    def test_manager_view_none_excluded(self):
        _, params = _parse_path(build_consent_request_path(manager_view=None))
        assert "view" not in params

    def test_all_params_together(self):
        path = build_consent_request_path(
            request_id="r1",
            bundle_id="b1",
            view="approved",
            actor="investor",
            manager_view="incoming",
        )
        _, params = _parse_path(path)
        assert params["requestId"] == ["r1"]
        assert params["bundleId"] == ["b1"]
        assert params["tab"] == ["approved"]
        assert params["actor"] == ["investor"]
        assert params["view"] == ["incoming"]

    def test_result_starts_with_consents_route(self):
        path = build_consent_request_path()
        assert path.startswith("/consents?")


# ---------------------------------------------------------------------------
# build_consent_request_url
# ---------------------------------------------------------------------------


class TestBuildConsentRequestUrl:
    def _build(self, **kwargs) -> str:
        with patch(
            "hushh_mcp.services.consent_request_links.frontend_origin",
            return_value=_ORIGIN,
        ):
            return build_consent_request_url(**kwargs)

    def test_url_starts_with_origin(self):
        url = self._build()
        assert url.startswith(_ORIGIN)

    def test_url_contains_consents_path(self):
        url = self._build()
        assert "/consents?" in url

    def test_url_contains_request_id(self):
        url = self._build(request_id="req-999")
        assert "requestId=req-999" in url

    def test_url_contains_actor(self):
        url = self._build(actor="ria")
        assert "actor=ria" in url

    def test_url_no_double_slash(self):
        url = self._build()
        assert "//" not in url.replace("https://", "")

    def test_url_carries_bundle_id(self):
        url = self._build(bundle_id="b1")
        assert "bundleId=b1" in url

    def test_canonical_caller_path_consent_db(self):
        """Exercises the same call pattern used by consent_db.py.

        hushh_mcp/services/consent_db.py calls build_consent_request_url(
            request_id=<id>, bundle_id=<id>
        ) to embed in push notification payloads. This test mirrors that call.
        """
        url = self._build(request_id="consent-req-001", bundle_id="bundle-002")
        parsed = urlparse(url)
        params = parse_qs(parsed.query)
        assert parsed.scheme == "https"
        assert parsed.path == "/consents"
        assert params["requestId"] == ["consent-req-001"]
        assert params["bundleId"] == ["bundle-002"]


# ---------------------------------------------------------------------------
# build_connection_request_path
# ---------------------------------------------------------------------------


class TestBuildConnectionRequestPath:
    def test_default_tab_is_pending(self):
        path, params = _parse_path(build_connection_request_path())
        assert path == "/marketplace/connections"
        assert params["tab"] == ["pending"]

    def test_selected_included_when_provided(self):
        _, params = _parse_path(build_connection_request_path(selected="conn-abc"))
        assert params["selected"] == ["conn-abc"]

    def test_selected_omitted_when_none(self):
        _, params = _parse_path(build_connection_request_path(selected=None))
        assert "selected" not in params

    def test_tab_override(self):
        _, params = _parse_path(build_connection_request_path(tab="accepted"))
        assert params["tab"] == ["accepted"]

    def test_empty_tab_falls_back_to_pending(self):
        _, params = _parse_path(build_connection_request_path(tab=""))
        assert params["tab"] == ["pending"]

    def test_result_starts_with_marketplace_route(self):
        path = build_connection_request_path()
        assert path.startswith("/marketplace/connections?")


# ---------------------------------------------------------------------------
# build_connection_request_url
# ---------------------------------------------------------------------------


class TestBuildConnectionRequestUrl:
    def _build(self, **kwargs) -> str:
        with patch(
            "hushh_mcp.services.consent_request_links.frontend_origin",
            return_value=_ORIGIN,
        ):
            return build_connection_request_url(**kwargs)

    def test_url_starts_with_origin(self):
        assert self._build().startswith(_ORIGIN)

    def test_url_contains_marketplace_path(self):
        assert "/marketplace/connections?" in self._build()

    def test_url_contains_selected(self):
        url = self._build(selected="xyz")
        assert "selected=xyz" in url

    def test_url_no_double_slash(self):
        url = self._build()
        assert "//" not in url.replace("https://", "")

    def test_tab_included_in_url(self):
        url = self._build(tab="active")
        assert "tab=active" in url


# ---------------------------------------------------------------------------
# Tracking-parameter absence — URL sanitization proof
# ---------------------------------------------------------------------------
# The URL builder is the canonical place where consent deep-links are composed.
# It constructs output from an explicit allowlist of parameters, so common
# ad-tracking and telemetry params (fbclid, gclid, utm_*) must NEVER appear
# in any generated URL, regardless of inputs.

_TRACKING_PARAMS: frozenset[str] = frozenset({
    "fbclid",       # Facebook Click ID
    "gclid",        # Google Ads Click ID
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "msclkid",      # Microsoft Advertising Click ID
    "twclid",       # Twitter Click ID
    "ttclid",       # TikTok Click ID
})

_ALLOWED_CONSENT_PARAMS: frozenset[str] = frozenset({
    "tab", "requestId", "bundleId", "actor", "view",
})


def _query_keys(url_or_path: str) -> set[str]:
    """Extract the set of top-level query parameter keys from a URL or path."""
    return set(parse_qs(urlparse(url_or_path).query).keys())


class TestTrackingParameterAbsence:
    """URL builders must never emit tracking or telemetry query parameters.

    Each test asserts an explicit negative: none of the well-known ad-tracking
    parameters (fbclid, gclid, utm_*, msclkid …) appear in the output,
    regardless of what valid consent parameters are supplied.
    """

    def test_consent_path_with_all_valid_params_contains_no_tracking_params(self):
        """Full parameter set — output must be pristine."""
        path = build_consent_request_path(
            request_id="req-abc",
            bundle_id="bundle-xyz",
            view="pending",
            actor="investor",
            manager_view="incoming",
        )
        leaked = _TRACKING_PARAMS & _query_keys(path)
        assert not leaked, f"Tracking params leaked into consent path: {leaked}"

    def test_consent_path_default_call_is_clean(self):
        """Zero-argument call must produce a clean path."""
        path = build_consent_request_path()
        leaked = _TRACKING_PARAMS & _query_keys(path)
        assert not leaked, f"Tracking params in default consent path: {leaked}"

    def test_connection_path_contains_no_tracking_params(self):
        """Connection URL builder must also produce a clean path."""
        path = build_connection_request_path(selected="conn-1", tab="active")
        leaked = _TRACKING_PARAMS & _query_keys(path)
        assert not leaked, f"Tracking params leaked into connection path: {leaked}"

    def test_request_id_with_embedded_tracking_string_is_url_encoded_not_injected(self):
        """A request_id value that contains tracking-like text must be
        URL-encoded as a value, not interpreted as a separate query parameter.

        Scenario: an untrusted caller passes request_id="req-123&fbclid=abc".
        urlencode() must percent-encode the ampersand so 'fbclid' never
        surfaces as a top-level key in the parsed output.
        """
        path = build_consent_request_path(request_id="req-123&fbclid=abc")
        params = parse_qs(urlparse(path).query)

        # Tracking key must NOT be injected as a top-level parameter.
        assert "fbclid" not in params, \
            "fbclid was injected as a query parameter — urlencode is not escaping correctly"

        # The requestId value itself must be present (encoding should not drop it).
        assert "requestId" in params
        # The raw value is stored as a URL-encoded blob — base part is traceable.
        assert params["requestId"][0].startswith("req-123")

    def test_consent_url_built_with_patched_origin_contains_no_tracking_params(self):
        """Full URL assembly must produce a clean output."""
        with patch(
            "hushh_mcp.services.consent_request_links.frontend_origin",
            return_value=_ORIGIN,
        ):
            url = build_consent_request_url(
                request_id="req-1",
                bundle_id="b-1",
                actor="ria",
                manager_view="outgoing",
            )

        leaked = _TRACKING_PARAMS & _query_keys(url)
        assert not leaked, f"Tracking params found in full consent URL: {leaked}"

    def test_output_contains_only_whitelisted_consent_params(self):
        """No extra query keys may appear beyond the declared allowlist."""
        path = build_consent_request_path(
            request_id="req-1",
            bundle_id="b-1",
            view="approved",
            actor="investor",
            manager_view="outgoing",
        )
        unexpected = _query_keys(path) - _ALLOWED_CONSENT_PARAMS
        assert not unexpected, \
            f"Unexpected query params in consent path: {unexpected}"

    def test_utm_params_absent_across_all_valid_view_and_actor_combinations(self):
        """UTM parameters must never appear for any view+actor combination.

        This sweeps every allowed view value and every allowed actor value to
        ensure there is no code path that conditionally injects tracking params.
        """
        views = ("pending", "approved", "history", "active", "previous")
        actors = (None, "investor", "ria")

        for view in views:
            for actor in actors:
                path = build_consent_request_path(
                    view=view,
                    actor=actor,
                    request_id="req-sweep",
                )
                utm_leaked = {
                    k for k in _query_keys(path)
                    if k.startswith("utm_")
                }
                assert not utm_leaked, (
                    f"UTM params {utm_leaked} appeared for view={view!r}, "
                    f"actor={actor!r}"
                )

    def test_all_known_tracking_params_absent_in_connection_url(self):
        """Every tracking param in the full set must be absent from connection URLs."""
        with patch(
            "hushh_mcp.services.consent_request_links.frontend_origin",
            return_value=_ORIGIN,
        ):
            url = build_connection_request_url(selected="conn-abc", tab="active")

        leaked = _TRACKING_PARAMS & _query_keys(url)
        assert not leaked, f"Tracking params leaked into connection URL: {leaked}"
