"""Default-off rollout and compatibility readers for reviewed One features."""

import pytest

from hushh_mcp import runtime_settings


@pytest.mark.parametrize(
    "name,key",
    [
        ("one_business_directory_enabled", "ONE_BUSINESS_DIRECTORY_ENABLED"),
        ("one_profile_research_enabled", "ONE_PROFILE_RESEARCH_ENABLED"),
        ("one_todo_suggestions_enabled", "ONE_TODO_SUGGESTIONS_ENABLED"),
    ],
)
def test_one_feature_readers_preserve_default_off_and_recheck_environment(monkeypatch, name, key):
    monkeypatch.delenv(key, raising=False)
    reader = getattr(runtime_settings, name)
    assert reader() is False
    monkeypatch.setenv(key, "true")
    assert reader() is True
    monkeypatch.setenv(key, "false")
    assert reader() is False
