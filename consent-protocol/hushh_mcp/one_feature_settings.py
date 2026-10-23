"""One feature rollout readers; runtime_settings keeps compatibility exports."""


def one_business_directory_enabled() -> bool:
    """Real read-only suggestions have an independent default-off rollout gate."""
    from hushh_mcp.runtime_settings import _clean_env

    return _clean_env("ONE_BUSINESS_DIRECTORY_ENABLED").lower() == "true"


def one_profile_research_enabled() -> bool:
    """Default-off rollout for One's reviewed public-profile card."""
    from hushh_mcp.runtime_settings import _clean_env

    return _clean_env("ONE_PROFILE_RESEARCH_ENABLED").lower() == "true"


def one_todo_suggestions_enabled() -> bool:
    """Explicit rollout for owner-approved task summary processing."""
    from hushh_mcp.runtime_settings import _clean_env

    return _clean_env("ONE_TODO_SUGGESTIONS_ENABLED").lower() == "true"
