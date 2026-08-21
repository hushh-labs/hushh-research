"""Classify a provider failure so a release can tell an outage from a regression.

``vertex_failover.is_retryable_vertex_error`` answers a narrower, in-request
question: may this idempotent call be retried in another location? It excludes
403 deliberately, because re-issuing a denied request elsewhere cannot help.

A release gate asks a different question, and needs a different answer:

    Is this failure OURS, or is the provider simply unavailable?

A billing-enforcement 403 is the clearest example of the divergence. It is not
retryable, so the failover classifier correctly rejects it -- but it is also
emphatically not a defect in the candidate build, so blocking a release on it
strands healthy code. Hence a second, release-scoped vocabulary here rather
than a change to the failover rules.
"""

from __future__ import annotations

import asyncio

from .vertex_failover import _status_code

DEPENDENCY_OK = "dependency_ok"
PROVIDER_UNAVAILABLE = "provider_unavailable"
CANDIDATE_MISCONFIGURED = "candidate_misconfigured"
APPLICATION_BROKEN = "application_broken"

#: Classifications that must NOT block a release. The provider is down; our
#: candidate has not been shown to be at fault.
ADVISORY_CLASSIFICATIONS = frozenset({DEPENDENCY_OK, PROVIDER_UNAVAILABLE})

# Transport/quota/server statuses that always mean "their side, not ours".
_PROVIDER_STATUS_CODES = {408, 429, 500, 502, 503, 504}
_PROVIDER_STATUS_NAMES = {
    "INTERNAL",
    "RESOURCE_EXHAUSTED",
    "UNAVAILABLE",
    "DEADLINE_EXCEEDED",
    "ABORTED",
}

# A 403 is ambiguous, so it is resolved on wording. These substrings mark
# account-level enforcement -- billing, dunning, suspension, quota -- which is
# an availability problem, not a candidate problem.
#
# "Lightning dunning decision is deny for project: projects/..." is the exact
# string Google returned across every project on the billing account on
# 2026-08-20, while the same candidate image had deployed cleanly hours earlier.
_ACCOUNT_ENFORCEMENT_MARKERS = (
    "dunning",
    "billing account",
    "billing is not enabled",
    "billing has not been enabled",
    "account is suspended",
    "consumer has been suspended",
    "quota exceeded",
    "has been disabled",
)

# A 403 carrying these instead is a permission or configuration fault that a
# release genuinely can introduce -- a wrong service account, a project the
# candidate should not be reaching, an unenabled API.
#
# These must stay SPECIFIC. A bare "permission" substring is useless here: the
# dunning outage arrives as "403 PERMISSION_DENIED. Lightning dunning decision
# is deny...", so matching the generic status name would classify a billing
# outage as our defect -- the exact failure this module exists to prevent.
_PERMISSION_FAULT_MARKERS = (
    "permission '",
    'permission "',
    "does not have access",
    "does not have permission",
    "caller does not have",
    "denied on resource",
    "api has not been used",
    "api is not enabled",
    "service_disabled",
)

# Our own guardrails raise these with authored messages. They mean the candidate
# declared something impossible -- a model no manifest supports, a binding with
# no project -- and they must keep blocking.
_CANDIDATE_FAULT_STATUS_CODES = {400, 401, 404}


def _iter_causes(error: BaseException):
    """Walk the exception chain once, without cycling."""
    current: BaseException | None = error
    seen: set[int] = set()
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        yield current
        current = current.__cause__ or current.__context__


def _message(error: BaseException) -> str:
    return str(error).strip().lower()


def classify_provider_error(error: BaseException) -> str:
    """Return the release classification for a failed provider call.

    Ordering matters. Provider-side signals are checked across the whole cause
    chain first, because a transport failure is often wrapped by one of our own
    ``RuntimeError`` guards on the way out -- and the outer type must not make
    an outage look like a candidate defect.
    """
    for current in _iter_causes(error):
        if isinstance(current, (asyncio.TimeoutError, TimeoutError, ConnectionError)):
            return PROVIDER_UNAVAILABLE

        status = _status_code(current) if isinstance(current, Exception) else None
        if status in _PROVIDER_STATUS_CODES:
            return PROVIDER_UNAVAILABLE

        name = str(getattr(current, "status", "") or "").strip().upper()
        if name in _PROVIDER_STATUS_NAMES:
            return PROVIDER_UNAVAILABLE

        text = _message(current)

        # Account-enforcement wording is decisive on its OWN, whatever the
        # transport carried it. The Live API is a websocket, so the same billing
        # denial arrives as close code 1008 ("policy violation") rather than an
        # HTTP 403 -- observed in the 2026-08-20 outage as
        # "1008 None. Lightning dunning decision is deny for project: ...".
        # Gating this on 403 alone let one websocket probe classify an outage as
        # an application bug, and summarize() then escalated the whole release
        # to blocking. The wording is unambiguous; the status code is not.
        if any(marker in text for marker in _ACCOUNT_ENFORCEMENT_MARKERS):
            return PROVIDER_UNAVAILABLE

        if status == 403:
            # Enforcement wording was already ruled out above, so a 403 reaching
            # here is a permission or configuration fault -- ours to fix.
            if any(marker in text for marker in _PERMISSION_FAULT_MARKERS):
                return CANDIDATE_MISCONFIGURED
            # An unexplained 403 is treated as ours. Blocking a release we may
            # have broken is the safer failure than shipping past a real denial.
            return CANDIDATE_MISCONFIGURED

        if status in _CANDIDATE_FAULT_STATUS_CODES:
            return CANDIDATE_MISCONFIGURED

    for current in _iter_causes(error):
        if isinstance(current, (RuntimeError, ValueError, KeyError, LookupError)):
            return CANDIDATE_MISCONFIGURED

    return APPLICATION_BROKEN


def is_advisory(classification: str) -> bool:
    """Whether a classification should be reported without failing the release."""
    return classification in ADVISORY_CLASSIFICATIONS


def summarize(classifications: list[str]) -> str:
    """Reduce many probe results to the one that decides the release.

    A single candidate fault outranks any number of provider outages: if even
    one failure is ours, the release is not safe regardless of what else broke.
    """
    if not classifications:
        return DEPENDENCY_OK
    if APPLICATION_BROKEN in classifications:
        return APPLICATION_BROKEN
    if CANDIDATE_MISCONFIGURED in classifications:
        return CANDIDATE_MISCONFIGURED
    if PROVIDER_UNAVAILABLE in classifications:
        return PROVIDER_UNAVAILABLE
    return DEPENDENCY_OK
