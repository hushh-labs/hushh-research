"""Pure PWM Azure endpoint/deployment contract; selection stays in managed_ai_config."""

import re
from urllib.parse import urlsplit
from uuid import UUID


def validate_azure_config(config):
    if not isinstance(config, dict) or set(config) != {
        "tenant_id",
        "client_id",
        "primary_endpoint",
        "primary_deployment",
        "phi_endpoint",
        "phi_deployment",
    }:
        raise ValueError("PWM Azure runtime fields do not match the contract")
    for key in ("tenant_id", "client_id"):
        try:
            if str(UUID(config[key])) != config[key]:
                raise ValueError
        except (TypeError, ValueError, AttributeError) as error:
            raise ValueError(f"Invalid PWM Azure {key}") from error
    for key, suffix in (
        ("primary_endpoint", ".openai.azure.com"),
        ("phi_endpoint", ".services.ai.azure.com"),
    ):
        endpoint = config[key]
        if not isinstance(endpoint, str):
            raise ValueError(f"Invalid PWM Azure {key}")
        parsed = urlsplit(endpoint)
        if (
            parsed.scheme != "https"
            or not (parsed.hostname or "").endswith(suffix)
            or parsed.path.rstrip("/") != "/openai/v1"
            or parsed.username
            or parsed.password
            or parsed.port is not None
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError(f"Invalid PWM Azure {key}")
    for key in ("primary_deployment", "phi_deployment"):
        if not isinstance(config[key], str) or not re.fullmatch(
            r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}", config[key]
        ):
            raise ValueError(f"Invalid PWM Azure {key}")
