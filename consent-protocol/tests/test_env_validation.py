import pytest

from utils.env_validation import validate_required_env_vars


def test_missing_required_env_vars(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)

    with pytest.raises(RuntimeError):
        validate_required_env_vars()


def test_valid_required_env_vars(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setenv("SUPABASE_URL", "https://test.com")
    monkeypatch.setenv("SUPABASE_KEY", "secret")

    validate_required_env_vars()