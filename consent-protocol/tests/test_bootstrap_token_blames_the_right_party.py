"""A hushh-side failure must not be reported as the customer's missing grant.

Observed live on 2026-08-16: `mint_bootstrap_token` was handed an empty caller token,
IAM answered 401, and the error said "the user's grant is missing or revoked". That
names the wrong party. In production it sends an operator into a customer's project --
which they cannot even see -- looking for a binding that is present and correct, while
the real fault is entirely on hushh's side.
"""

import pytest

from hushh_mcp.services.user_gcp_bootstrap import (
    BootstrapError,
    mint_bootstrap_token,
    probe_project_liveness,
)


class _Resp:
    def __init__(self, code):
        self.status_code, self.text = code, "{}"

    def json(self):
        return {"accessToken": "t"}


class _Session:
    def __init__(self, code):
        self.code, self.calls = code, 0

    def post(self, *a, **k):
        self.calls += 1
        return _Resp(self.code)


def test_an_empty_caller_token_never_blames_the_user():
    """Broken on purpose: delete the empty-token guard and this reports the user."""
    s = _Session(401)
    with pytest.raises(BootstrapError) as e:
        mint_bootstrap_token(
            bootstrap_sa="one-bootstrap@theirs.iam.gserviceaccount.com",
            session=s,
            source_token="   ",  # noqa: S106 -- whitespace, the empty-caller case under test
        )
    msg = str(e.value)
    assert "hushh-side" in msg
    assert "user's grant" not in msg
    assert s.calls == 0, "an empty bearer was sent to IAM instead of failing fast"


def test_a_401_is_hushh_and_a_403_is_the_user():
    """The two are different parties and must read differently."""
    with pytest.raises(BootstrapError) as e401:
        mint_bootstrap_token(
            bootstrap_sa="x@y.iam.gserviceaccount.com",
            session=_Session(401),
            source_token="real-token",  # noqa: S106 -- a placeholder; IAM is faked here
        )
    assert "hushh-side" in str(e401.value)

    with pytest.raises(BootstrapError) as e403:
        mint_bootstrap_token(
            bootstrap_sa="x@y.iam.gserviceaccount.com",
            session=_Session(403),
            source_token="real-token",  # noqa: S106 -- a placeholder; IAM is faked here
        )
    assert "user's grant" in str(e403.value)


# --- probe_project_liveness: the tri-state schedule-time re-proof --------------
# Same impersonation call as mint, CLASSIFIED instead of raised. The GONE/FORBIDDEN
# split is what lets /managed/select route a deleted project to reinit and a revoked
# grant to re-authorize, while never treating a transient blip as gone.


def test_liveness_live_when_impersonation_succeeds():
    v = probe_project_liveness(
        bootstrap_sa="x@y.iam.gserviceaccount.com",
        session=_Session(200),
        source_token="real-token",  # noqa: S106 -- IAM is faked here
    )
    assert v.state == "live" and v.is_live and v.is_conclusive


def test_liveness_gone_on_404_project_deleted():
    v = probe_project_liveness(
        bootstrap_sa="x@y.iam.gserviceaccount.com",
        session=_Session(404),
        source_token="real-token",  # noqa: S106
    )
    assert v.state == "gone" and v.is_gone


def test_liveness_forbidden_on_403_grant_revoked():
    v = probe_project_liveness(
        bootstrap_sa="x@y.iam.gserviceaccount.com",
        session=_Session(403),
        source_token="real-token",  # noqa: S106
    )
    assert v.state == "forbidden" and v.is_forbidden
    assert not v.is_gone  # a revoked grant is NOT a deleted project


def test_liveness_401_is_unknown_never_gone():
    # A hushh-side 401 must not read as the user's project being gone.
    v = probe_project_liveness(
        bootstrap_sa="x@y.iam.gserviceaccount.com",
        session=_Session(401),
        source_token="real-token",  # noqa: S106
    )
    assert v.state == "unknown" and not v.is_gone and not v.is_conclusive


def test_liveness_empty_caller_token_is_unknown_not_gone():
    # A hushh-side missing credential returns unknown WITHOUT calling IAM -- never gone.
    s = _Session(200)
    v = probe_project_liveness(
        bootstrap_sa="x@y.iam.gserviceaccount.com",
        session=s,
        source_token="   ",  # noqa: S106 -- the empty-caller case
    )
    assert v.state == "unknown" and not v.is_gone
    assert s.calls == 0  # never sent an empty bearer to IAM


def test_mint_blame_strings_unchanged_after_the_refactor():
    # The refactor factored the raw call out of mint; mint's raise/blame must be
    # byte-for-byte what test_a_401_is_hushh_and_a_403_is_the_user already pins.
    with pytest.raises(BootstrapError) as e403:
        mint_bootstrap_token(
            bootstrap_sa="x@y.iam.gserviceaccount.com",
            session=_Session(403),
            source_token="real-token",  # noqa: S106
        )
    assert "roles/iam.serviceAccountTokenCreator is missing or revoked" in str(e403.value)
    with pytest.raises(BootstrapError) as e500:
        mint_bootstrap_token(
            bootstrap_sa="x@y.iam.gserviceaccount.com",
            session=_Session(500),
            source_token="real-token",  # noqa: S106
        )
    assert "IAM refused the impersonation" in str(e500.value)
