"""A hushh-side failure must not be reported as the customer's missing grant.

Observed live on 2026-08-16: `mint_bootstrap_token` was handed an empty caller token,
IAM answered 401, and the error said "the user's grant is missing or revoked". That
names the wrong party. In production it sends an operator into a customer's project --
which they cannot even see -- looking for a binding that is present and correct, while
the real fault is entirely on hushh's side.
"""

import pytest

from hushh_mcp.services.user_gcp_bootstrap import BootstrapError, mint_bootstrap_token


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
