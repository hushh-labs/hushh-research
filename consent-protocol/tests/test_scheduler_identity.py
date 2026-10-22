"""A maintenance endpoint must be reachable by Cloud Scheduler and by nothing else.

WHAT THESE PROTECT

Both retention jobs used to carry a Secret Manager value as a literal
`X-Hushh-Maintenance-Token` header. `gcloud scheduler jobs describe` prints
`httpTarget.headers`, so the credential was readable by anyone with scheduler view
access; it never rotated; and because BOTH jobs used the same header name, one value
opened both endpoints.

The replacement is a per-invocation Google-signed OIDC token. The tests below assert
the four properties that make that an improvement rather than a rename:

  1. an unconfigured allowlist REFUSES rather than allows -- a fail-closed control
     that fails open on a forgotten environment variable is not a control;
  2. an identity outside the allowlist is refused even with a perfectly valid token;
  3. a token minted for one endpoint does not work on another, which is the property
     the shared header could not have at any secret length;
  4. a presented-but-invalid token never falls through to the weaker legacy path.
"""

from __future__ import annotations

import pytest

from hushh_mcp.services.scheduler_identity import (
    SchedulerIdentityError,
    allowed_service_accounts,
    bearer_token,
    expected_audience,
    legacy_shared_token_allowed,
    verified_scheduler_identity,
    verify_scheduler_request,
)

SCHEDULER_SA = "one-maintenance@hushh-pda-uat.iam.gserviceaccount.com"
AUDIENCE = "https://consent-protocol-uat.a.run.app"


def _verifier(claims: dict):
    """Stand in for Google's verifier, which needs live signing keys."""

    def _verify(token: str, audience: str) -> dict:
        if claims.get("aud") not in (None, audience):
            raise ValueError("audience mismatch")
        return claims

    return _verify


def _claims(**overrides) -> dict:
    base = {"email": SCHEDULER_SA, "email_verified": True, "aud": AUDIENCE, "sub": "1234"}
    base.update(overrides)
    return base


class _Request:
    def __init__(self, authorization: str | None = None):
        self.headers = {"authorization": authorization} if authorization else {}
        self.url = f"{AUDIENCE}/api/one/location/retention/purge?older_than_hours=12"


# -- the control must fail closed ------------------------------------------------------


def test_an_unconfigured_allowlist_refuses_everyone() -> None:
    """The single most important case. A forgotten env var must not mean 'open'."""
    with pytest.raises(SchedulerIdentityError) as caught:
        verify_scheduler_request(
            authorization_header="Bearer t",
            audience=AUDIENCE,
            allowed_emails=(),
            verifier=_verifier(_claims()),
        )
    assert caught.value.reason == "scheduler_identity_not_configured"


def test_an_unconfigured_audience_refuses() -> None:
    with pytest.raises(SchedulerIdentityError) as caught:
        verify_scheduler_request(
            authorization_header="Bearer t",
            audience="",
            allowed_emails=(SCHEDULER_SA,),
            verifier=_verifier(_claims()),
        )
    assert caught.value.reason == "scheduler_audience_not_configured"


def test_a_valid_token_from_the_wrong_identity_is_refused() -> None:
    """Signed by Google, verifies cleanly, still not this endpoint's caller."""
    with pytest.raises(SchedulerIdentityError) as caught:
        verify_scheduler_request(
            authorization_header="Bearer t",
            audience=AUDIENCE,
            allowed_emails=(SCHEDULER_SA,),
            verifier=_verifier(_claims(email="someone-else@example.iam.gserviceaccount.com")),
        )
    assert caught.value.reason == "scheduler_identity_not_allowed"


def test_a_token_for_another_endpoint_is_refused() -> None:
    """THE property the shared header never had.

    Under the old scheme the location purge and the KYC purge accepted the same
    header, so a value read off one job authorised the other. Here the token names
    the audience it was minted for and cannot be re-aimed.
    """
    with pytest.raises(SchedulerIdentityError) as caught:
        verify_scheduler_request(
            authorization_header="Bearer t",
            audience="https://consent-protocol-uat.a.run.app/other",
            allowed_emails=(SCHEDULER_SA,),
            verifier=_verifier(_claims(aud=AUDIENCE)),
        )
    assert caught.value.reason == "scheduler_token_invalid"


def test_an_unverified_email_claim_is_refused() -> None:
    with pytest.raises(SchedulerIdentityError) as caught:
        verify_scheduler_request(
            authorization_header="Bearer t",
            audience=AUDIENCE,
            allowed_emails=(SCHEDULER_SA,),
            verifier=_verifier(_claims(email_verified=False)),
        )
    assert caught.value.reason == "scheduler_token_email_unverified"


def test_the_configured_scheduler_is_accepted() -> None:
    identity = verify_scheduler_request(
        authorization_header=f"Bearer {'t' * 20}",
        audience=AUDIENCE,
        allowed_emails=(SCHEDULER_SA.upper(),),
        verifier=_verifier(_claims()),
    )
    assert identity.email == SCHEDULER_SA
    assert identity.audience == AUDIENCE


# -- the route adapter's None/raise split ----------------------------------------------


def test_no_bearer_token_returns_none_so_the_legacy_path_can_still_run(monkeypatch) -> None:
    """Pre-migration jobs must keep working until their config is flipped."""
    monkeypatch.setenv("X_SCHEDULER_SERVICE_ACCOUNTS", SCHEDULER_SA)
    monkeypatch.setenv("X_AUDIENCE", AUDIENCE)
    assert verified_scheduler_identity(_Request(), "X") is None


def test_a_bad_bearer_token_raises_rather_than_falling_through(monkeypatch) -> None:
    """Otherwise the stronger control is only a suggestion.

    A caller that presents a forged OIDC token must be refused outright, not handed
    a second attempt at the shared header it might also have stolen.
    """
    monkeypatch.setenv("X_SCHEDULER_SERVICE_ACCOUNTS", SCHEDULER_SA)
    monkeypatch.setenv("X_AUDIENCE", AUDIENCE)
    with pytest.raises(SchedulerIdentityError):
        verified_scheduler_identity(_Request("Bearer forged"), "X")


def test_a_non_bearer_authorization_header_is_not_treated_as_a_token(monkeypatch) -> None:
    monkeypatch.setenv("X_SCHEDULER_SERVICE_ACCOUNTS", SCHEDULER_SA)
    monkeypatch.setenv("X_AUDIENCE", AUDIENCE)
    assert verified_scheduler_identity(_Request("Basic dXNlcjpwYXNz"), "X") is None


# -- configuration reading -------------------------------------------------------------


def test_the_allowlist_accepts_several_identities_for_a_rotation(monkeypatch) -> None:
    """Listing old and new at once means no call is refused mid-rotation."""
    monkeypatch.setenv("X_SCHEDULER_SERVICE_ACCOUNTS", f" {SCHEDULER_SA} , Old@x.com ,, ")
    assert allowed_service_accounts("X_SCHEDULER_SERVICE_ACCOUNTS") == (
        "old@x.com",
        SCHEDULER_SA,
    )


def test_the_audience_is_configured_and_never_inferred(monkeypatch) -> None:
    """Inferring it from the request URL would include the query string.

    That mismatches the token's `aud` and presents as an opaque 401 on a job that is
    configured correctly -- so the value is required on both sides instead.
    """
    monkeypatch.delenv("X_AUDIENCE", raising=False)
    assert expected_audience("X_AUDIENCE") == ""


def test_the_legacy_path_defaults_open_and_closes_on_one_variable(monkeypatch) -> None:
    """Flipping the server must not break jobs that still send the old header."""
    monkeypatch.delenv("HUSHH_MAINTENANCE_LEGACY_TOKEN_ENABLED", raising=False)
    assert legacy_shared_token_allowed() is True
    monkeypatch.setenv("HUSHH_MAINTENANCE_LEGACY_TOKEN_ENABLED", "0")
    assert legacy_shared_token_allowed() is False


def test_bearer_parsing_ignores_anything_that_is_not_a_bearer() -> None:
    assert bearer_token("Bearer abc") == "abc"
    assert bearer_token("bearer abc") == ""
    assert bearer_token("Bearer   ") == ""
    assert bearer_token(None) == ""
