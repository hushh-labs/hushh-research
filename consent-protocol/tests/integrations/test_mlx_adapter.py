# tests/integrations/test_mlx_adapter.py
"""Tests for the HCT-gated MLX inference adapter.

These verify the consent boundary reuses the canonical token contract and
denies by default. No real MLX model is loaded; the inference callable is a
spy so tests run on any platform (including CI where mlx cannot import).
"""

import pytest

from hushh_mcp.consent.token import issue_token, revoke_token
from hushh_mcp.constants import ConsentScope
from hushh_mcp.integrations.mlx import ConsentDenied, HCTGatedMLXAdapter
from hushh_mcp.integrations.mlx.adapter import MLXInferenceResult

USER_ID = "user_mlx_test"
AGENT_ID = "agent_mlx_test"
SCOPE = ConsentScope.AGENT_KAI_INFER


class _Spy:
    """Records whether the inference callable was invoked."""

    def __init__(self, output: str = "ok") -> None:
        self.called = False
        self.last_prompt = None
        self._output = output

    def __call__(self, prompt, token):
        self.called = True
        self.last_prompt = prompt
        return self._output


def _adapter(spy: _Spy, **kwargs) -> HCTGatedMLXAdapter:
    return HCTGatedMLXAdapter(spy, required_scope=SCOPE, **kwargs)


def test_valid_token_runs_inference():
    spy = _Spy(output="generated text")
    token = issue_token(USER_ID, AGENT_ID, SCOPE)
    result = _adapter(spy).run("hello", token.token)
    assert isinstance(result, MLXInferenceResult)
    assert result.output == "generated text"
    assert result.user_id == USER_ID
    assert result.agent_id == AGENT_ID
    assert result.scope == SCOPE.value
    assert spy.called is True
    assert spy.last_prompt == "hello"


def test_missing_token_denied_and_inference_not_called():
    spy = _Spy()
    with pytest.raises(ConsentDenied) as exc:
        _adapter(spy).run("hello", None)
    assert "Missing consent token" in str(exc.value)
    assert spy.called is False


def test_empty_token_denied():
    spy = _Spy()
    with pytest.raises(ConsentDenied):
        _adapter(spy).run("hello", "")
    assert spy.called is False


def test_magic_string_is_rejected():
    """The old fake-consent approach (a hardcoded string) must NOT pass."""
    spy = _Spy()
    with pytest.raises(ConsentDenied):
        _adapter(spy).run("hello", "HUSHH_LOCAL_CONSENT_GRANTED")
    assert spy.called is False


def test_forged_prefix_only_token_is_rejected():
    """A string that merely looks like a token must fail signature checks."""
    spy = _Spy()
    with pytest.raises(ConsentDenied):
        _adapter(spy).run("hello", "HCT:not-a-real-signed-token.deadbeef")
    assert spy.called is False


def test_wrong_scope_denied():
    spy = _Spy()
    token = issue_token(USER_ID, AGENT_ID, ConsentScope.PKM_WRITE)
    with pytest.raises(ConsentDenied) as exc:
        _adapter(spy).run("hello", token.token)
    assert "Scope mismatch" in str(exc.value)
    assert spy.called is False


def test_expired_token_denied():
    spy = _Spy()
    token = issue_token(USER_ID, AGENT_ID, SCOPE, expires_in_ms=-1000)
    with pytest.raises(ConsentDenied) as exc:
        _adapter(spy).run("hello", token.token)
    assert "expired" in str(exc.value).lower()
    assert spy.called is False


def test_revoked_token_denied():
    spy = _Spy()
    token = issue_token(USER_ID, AGENT_ID, SCOPE)
    revoke_token(token.token)
    with pytest.raises(ConsentDenied) as exc:
        _adapter(spy).run("hello", token.token)
    assert "revoked" in str(exc.value).lower()
    assert spy.called is False


def test_signature_tampering_denied():
    spy = _Spy()
    token = issue_token(USER_ID, AGENT_ID, SCOPE)
    tampered = token.token[:-2] + ("aa" if not token.token.endswith("aa") else "bb")
    with pytest.raises(ConsentDenied):
        _adapter(spy).run("hello", tampered)
    assert spy.called is False


def test_commercial_gate_rejects_non_commercial():
    spy = _Spy()
    token = issue_token(USER_ID, AGENT_ID, SCOPE, commercial=False)
    adapter = _adapter(spy, require_commercial=True)
    with pytest.raises(ConsentDenied):
        adapter.run("hello", token.token)
    assert spy.called is False


def test_commercial_gate_accepts_commercial():
    spy = _Spy(output="paid")
    token = issue_token(USER_ID, AGENT_ID, SCOPE, commercial=True)
    adapter = _adapter(spy, require_commercial=True)
    result = adapter.run("hello", token.token)
    assert result.output == "paid"
    assert result.commercial is True
    assert spy.called is True


def test_empty_prompt_rejected_after_consent():
    """Consent passes, but an empty prompt is a caller error, not an exec."""
    spy = _Spy()
    token = issue_token(USER_ID, AGENT_ID, SCOPE)
    with pytest.raises(ValueError):
        _adapter(spy).run("", token.token)
    assert spy.called is False


def test_non_callable_inference_fn_rejected():
    with pytest.raises(TypeError):
        HCTGatedMLXAdapter("not-callable")  # type: ignore[arg-type]
