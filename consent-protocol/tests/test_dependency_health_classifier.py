"""A provider outage must not read as a candidate defect, and vice versa.

Written after 2026-08-20, when a Google billing hold returned 403 for every
project on the account. The Vertex release probe had no way to say "their side",
so a healthy backend revision was built and then stranded at 0% traffic.

The single most important case here is `test_dunning_403_is_a_provider_outage`.
The real message is "403 PERMISSION_DENIED. Lightning dunning decision is deny
for project: projects/745506018753" -- it contains the word PERMISSION, so a
naive substring rule classifies an account-level billing outage as our own
misconfiguration and blocks the release. That is the exact regression this file
exists to prevent.
"""

from __future__ import annotations

import asyncio

import pytest

from hushh_mcp.runtime_providers.dependency_health import (
    APPLICATION_BROKEN,
    CANDIDATE_MISCONFIGURED,
    DEPENDENCY_OK,
    PROVIDER_UNAVAILABLE,
    classify_provider_error,
    is_advisory,
    summarize,
)

DUNNING_403 = (
    "403 PERMISSION_DENIED. {'error': {'code': 403, 'message': "
    "'Lightning dunning decision is deny for project: projects/745506018753', "
    "'status': 'PERMISSION_DENIED'}}"
)


class _ProviderError(Exception):
    """Shaped like google.genai errors: a message plus status_code/status."""

    def __init__(self, message: str, status_code: int | None = None, status: str = "") -> None:
        super().__init__(message)
        self.status_code = status_code
        self.status = status


def test_dunning_403_is_a_provider_outage() -> None:
    assert classify_provider_error(_ProviderError(DUNNING_403, 403)) == PROVIDER_UNAVAILABLE


def test_dunning_403_is_advisory_so_a_release_may_continue() -> None:
    assert is_advisory(classify_provider_error(_ProviderError(DUNNING_403, 403))) is True


def test_depleted_developer_api_prepayment_is_a_provider_availability_failure() -> None:
    error = _ProviderError(
        "1011 None. Your prepayment credits are depleted. "
        "Please go to AI Studio to manage your project and billing",
        None,
    )

    classification = classify_provider_error(error)

    assert classification == PROVIDER_UNAVAILABLE
    assert is_advisory(classification) is True


def test_permission_denial_on_a_resource_still_blocks() -> None:
    """A wrong service account is ours to fix, and must keep blocking."""
    error = _ProviderError(
        "Permission 'aiplatform.endpoints.predict' denied on resource //aiplatform...", 403
    )
    assert classify_provider_error(error) == CANDIDATE_MISCONFIGURED
    assert is_advisory(CANDIDATE_MISCONFIGURED) is False


def test_unenabled_api_blocks_because_a_release_can_cause_it() -> None:
    error = _ProviderError("Cloud AI Platform API has not been used in project 123 before", 403)
    assert classify_provider_error(error) == CANDIDATE_MISCONFIGURED


def test_unexplained_403_defaults_to_blocking() -> None:
    """Ambiguity resolves toward blocking: never ship past an unexplained denial."""
    assert classify_provider_error(_ProviderError("forbidden", 403)) == CANDIDATE_MISCONFIGURED


@pytest.mark.parametrize("status_code", [408, 429, 500, 502, 503, 504])
def test_transport_and_quota_statuses_are_provider_outages(status_code: int) -> None:
    assert classify_provider_error(_ProviderError("upstream", status_code)) == PROVIDER_UNAVAILABLE


@pytest.mark.parametrize("status_name", ["UNAVAILABLE", "RESOURCE_EXHAUSTED", "INTERNAL"])
def test_provider_status_names_are_outages_even_without_a_code(status_name: str) -> None:
    assert classify_provider_error(_ProviderError("x", None, status_name)) == PROVIDER_UNAVAILABLE


@pytest.mark.parametrize(
    "error", [asyncio.TimeoutError(), TimeoutError(), ConnectionError("refused")]
)
def test_timeouts_and_connection_failures_are_provider_outages(error: BaseException) -> None:
    assert classify_provider_error(error) == PROVIDER_UNAVAILABLE


@pytest.mark.parametrize("status_code", [400, 401, 404])
def test_client_faults_block(status_code: int) -> None:
    assert classify_provider_error(_ProviderError("bad", status_code)) == CANDIDATE_MISCONFIGURED


def test_our_own_manifest_guard_blocks() -> None:
    error = RuntimeError("No managed Gemini text model is declared by a product manifest")
    assert classify_provider_error(error) == CANDIDATE_MISCONFIGURED


def test_an_outage_wrapped_in_our_own_error_is_still_an_outage() -> None:
    """The outer type must not decide the verdict.

    Our binding code wraps provider failures in RuntimeError on the way out. If
    the classifier stopped at the outermost exception it would read every
    wrapped outage as a candidate defect.
    """
    wrapped = RuntimeError("managed vertex probe failed")
    wrapped.__cause__ = _ProviderError(DUNNING_403, 403)
    assert classify_provider_error(wrapped) == PROVIDER_UNAVAILABLE


def test_unexpected_exception_is_an_application_bug() -> None:
    assert classify_provider_error(AttributeError("NoneType")) == APPLICATION_BROKEN


def test_summarize_lets_one_candidate_fault_outrank_many_outages() -> None:
    """If even one failure is ours, the release is unsafe regardless."""
    assert (
        summarize([PROVIDER_UNAVAILABLE, PROVIDER_UNAVAILABLE, CANDIDATE_MISCONFIGURED])
        == CANDIDATE_MISCONFIGURED
    )


def test_summarize_reports_an_outage_when_every_failure_is_theirs() -> None:
    assert summarize([PROVIDER_UNAVAILABLE, PROVIDER_UNAVAILABLE]) == PROVIDER_UNAVAILABLE


def test_summarize_of_nothing_is_ok() -> None:
    assert summarize([]) == DEPENDENCY_OK
    assert is_advisory(DEPENDENCY_OK) is True


def test_application_broken_outranks_everything() -> None:
    assert summarize([PROVIDER_UNAVAILABLE, APPLICATION_BROKEN]) == APPLICATION_BROKEN
    assert is_advisory(APPLICATION_BROKEN) is False


# The Live API is a websocket, so the SAME billing denial arrives with a
# websocket close code instead of an HTTP status. Observed verbatim in the
# 2026-08-20 build log. Gating enforcement wording on 403 alone classified this
# probe as application_broken, and summarize() escalated the whole release to
# blocking -- one websocket frame undid the entire fix.
LIVE_WEBSOCKET_DUNNING = (
    "1008 None. Lightning dunning decision is deny for project: projects/745506018753"
)


def test_websocket_close_code_dunning_is_still_a_provider_outage() -> None:
    error = _ProviderError(LIVE_WEBSOCKET_DUNNING, 1008)
    assert classify_provider_error(error) == PROVIDER_UNAVAILABLE


def test_enforcement_wording_decides_without_any_status_code() -> None:
    """Wording is unambiguous; transport codes are not."""
    error = _ProviderError("Lightning dunning decision is deny", None)
    assert classify_provider_error(error) == PROVIDER_UNAVAILABLE


def test_the_real_nine_probe_outage_summarizes_as_an_outage() -> None:
    """The exact shape of the 2026-08-20 build: 8 HTTP 403s and 1 websocket 1008.

    Before the fix this summarized to application_broken and blocked a release
    whose backend image had already deployed correctly.
    """
    http_403 = _ProviderError(DUNNING_403, 403)
    websocket_1008 = _ProviderError(LIVE_WEBSOCKET_DUNNING, 1008)
    classifications = [classify_provider_error(http_403) for _ in range(8)]
    classifications.append(classify_provider_error(websocket_1008))

    assert set(classifications) == {PROVIDER_UNAVAILABLE}
    assert summarize(classifications) == PROVIDER_UNAVAILABLE
    assert is_advisory(summarize(classifications)) is True
