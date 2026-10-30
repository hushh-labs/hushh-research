"""Pure managed-runtime configuration; no resource or processing authority."""

from __future__ import annotations

import re
from typing import Any


def validate_frozen_inference_selection(deployment: Any) -> None:
    """Cleanup checks recorded model shape; current processing policy cannot strand it."""
    if deployment.hosting_mode != "hussh_hosted" or deployment.environment != "dev":
        raise ValueError("Frozen validation is restricted to retained managed authority")
    if not all(
        (
            isinstance(deployment.inference_model, str)
            and re.fullmatch(r"gemini-[A-Za-z0-9._-]{1,100}", deployment.inference_model),
            isinstance(deployment.inference_profile_hash, str)
            and re.fullmatch(r"[a-f0-9]{64}", deployment.inference_profile_hash),
            re.fullmatch(r"[a-z][a-z0-9-]{4,28}[a-z0-9]", deployment.model_project),
        )
    ):
        raise ValueError("Retained inference selection is invalid")


def writer_environment(spec: Any, deployment: Any) -> list[dict[str, str]]:
    if deployment.hosting_mode != "hussh_hosted":
        return []
    operation = spec.upgrade_operation_id or spec.provision_attempt_id
    if not operation:
        if spec.hosted_admission_guard is None:
            return []  # An inert plan cannot claim a qualified writer protocol.
        raise ValueError("Managed writer rendering requires its retained operation")
    return [
        {"name": "HUSSH_POD_WRITER_PROTOCOL", "value": "1"},
        {
            "name": "HUSSH_POD_WRITER_OPERATION",
            "value": operation,
        },
    ]
