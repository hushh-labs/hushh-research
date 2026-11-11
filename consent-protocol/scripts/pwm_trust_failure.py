"""Closed trust-failure verdicts for the Azure readiness exam: authored names only."""

from __future__ import annotations

import json
import re

# An authored code: lowercase identifier. Anything else (model, provider or test
# text) never reaches a verdict, even if an exception happens to carry it.
_AUTHORED = re.compile(r"[a-z][a-z0-9_]{0,63}")


def _authored(value: object) -> str | None:
    return value if isinstance(value, str) and _AUTHORED.fullmatch(value) else None


class AzurePwmTrustError(RuntimeError):
    """A received model answer violated an authored attribution/trust case."""

    def __init__(
        self,
        message: str,
        *,
        stage: str | None = None,
        reason: str | None = None,
        leg: str | None = None,
    ) -> None:
        super().__init__(message)
        self.stage = stage
        self.reason = reason
        self.leg = leg


def trust_failure(
    check: str, fields: list[str], *, planner_conditions: dict[str, bool] | None = None
) -> None:
    """Emit authored names and booleans only; suppress model and provider text."""
    event: dict[str, object] = {"azure_pwm_probe_failure": check, "failed_fields": fields}
    if planner_conditions is not None:
        event["planner_conditions"] = planner_conditions
    print(json.dumps(event), flush=True)
    raise AzurePwmTrustError(
        f"Azure {check} evaluation failed",
        stage="pwm." + check.replace(" ", "_"),
        reason=_authored(fields[0]) if fields else None,
    )


def planner_trust_error(error: BaseException) -> AzurePwmTrustError:
    """Carry a grade's case, reason and leg only when the grader raised it with codes."""
    case = _authored(getattr(error, "case", None))
    return AzurePwmTrustError(
        "Drive activity planner contract failed",
        stage="drive_planner." + case if case else "drive_planner",
        reason=_authored(error.args[0]) if case and error.args else None,
        leg=_authored(getattr(error, "leg", None)) if case else None,
    )


def trust_fields(error: BaseException) -> dict[str, str]:
    """A trust failure's stage, reason and leg for the terminal verdict."""
    if not isinstance(error, AzurePwmTrustError):
        return {}
    named = {"failure_stage": error.stage, "failure_reason": error.reason, "leg": error.leg}
    return {key: value for key, value in named.items() if value}
