import logging
import os

logger = logging.getLogger(__name__)

REQUIRED_ENV_VARS = [
    "OPENAI_API_KEY",
    "SUPABASE_URL",
    "SUPABASE_KEY",
]


def validate_required_env_vars() -> None:
    missing_vars = []

    for env_var in REQUIRED_ENV_VARS:
        value = os.getenv(env_var)

        if value is None or value.strip() == "":
            missing_vars.append(env_var)

    if missing_vars:
        logger.error(
            "Missing required environment variables: %s",
            ", ".join(missing_vars),
        )

        raise RuntimeError(
            f"Missing required environment variables: {', '.join(missing_vars)}"
        )