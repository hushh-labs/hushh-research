import os

REQUIRED_ENV_VARS = {
    "APP_SIGNING_KEY",
    "VAULT_DATA_KEY",
    "HUSHH_DEVELOPER_TOKEN",
}


class MissingEnvironmentVariableError(Exception):
    """
    Raised when a required environment variable is missing.
    """


def validate_required_env() -> None:
    """
    Validate required environment variables.
    """

    missing_vars = []

    for env_var in REQUIRED_ENV_VARS:
        if not os.getenv(env_var):
            missing_vars.append(env_var)

    if missing_vars:
        missing = ", ".join(sorted(missing_vars))

        raise MissingEnvironmentVariableError(
            f"Missing required environment variables: "
            f"{missing}"
        )