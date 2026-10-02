"""Apply a ``SetupPlan`` under the person's delegated token, one stage at a time.

The plan says WHAT; this module says how each step is safely repeated:

* ``create_only`` steps (the agent's key and signing secret) are read first and never
  re-written, so a retried setup cannot rotate the key the agent's log is sealed
  under or the secret its receipts are signed with;
* role assignments are idempotent by name (``RoleAssignmentExists`` is success) and
  retry ``PrincipalNotFound`` while a just-created identity replicates;
* provider registration waits for ``Registered``;
* an ``optional`` (model) refusal is a typed outcome: the remaining stages are
  rebuilt without the model and the agent serves the owner's own key instead;
* a step that still carries a ``${placeholder}`` is never sent.

Values created along the way (principal ids, the key version, the image digest)
are captured into ``values`` and substituted into later steps. The signing secret's
value exists only in this process's memory for the one PUT that creates it.
"""

from __future__ import annotations

import logging
import re
import secrets
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from hushh_mcp.services.azure_arm_client import API_VERSIONS, ArmClient, ArmError
from hushh_mcp.services.azure_setup_plan import (
    AZURE_JOB_STAGES,
    ArmStep,
    PlanInputs,
    SetupPlan,
    without_model,
)

logger = logging.getLogger(__name__)

_PLACEHOLDER = re.compile(r"\$\{([A-Za-z]+)\}")
_PRINCIPAL_SETTLE_DELAYS: tuple[float, ...] = (3.0, 6.0, 10.0, 15.0, 20.0, 30.0)
_PROVIDER_POLL_SECONDS = 5.0
_PROVIDER_POLL_LIMIT = 60


class AzureSetupRefused(RuntimeError):
    """A typed refusal for the setup record; ``code`` is stable for the frontend."""

    def __init__(self, message: str, *, code: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass
class ApplyResult:
    values: dict[str, str] = field(default_factory=dict)
    model_outcome: str = "created"
    model_error_code: str = ""
    plan: Optional[SetupPlan] = None

    @property
    def model_available(self) -> bool:
        return self.model_outcome == "created"


def resolve(value: Any, values: dict[str, str]) -> Any:
    """Substitute ``${name}`` everywhere; refuse when any placeholder is unresolved."""
    if isinstance(value, dict):
        return {key: resolve(item, values) for key, item in value.items()}
    if isinstance(value, list):
        return [resolve(item, values) for item in value]
    if not isinstance(value, str):
        return value

    def _swap(match: re.Match[str]) -> str:
        name = match.group(1)
        if not values.get(name):
            raise AzureSetupRefused(f"setup value {name} is not known yet", code="PLAN_UNRESOLVED")
        return values[name]

    return _PLACEHOLDER.sub(_swap, value)


def _capture(step: ArmStep, body: dict[str, Any], values: dict[str, str]) -> None:
    properties = body.get("properties") or {}
    if "/userAssignedIdentities/" in step.path:
        values["podPrincipalId"] = str(properties.get("principalId") or "")
        values["podClientId"] = str(properties.get("clientId") or "")
    elif "/keys/" in step.path and "/vaults/" in step.path:
        values["keyUriWithVersion"] = str(properties.get("keyUriWithVersion") or "")


def _model_outcome(exc: ArmError) -> str:
    return "quota_refused" if "quota" in exc.code.lower() else "unavailable"


class SetupApplier:
    """Runs one plan. Synchronous: callers run it off the event loop."""

    def __init__(
        self,
        arm: ArmClient,
        *,
        advance: Callable[[str], None],
        sleep: Callable[[float], None] = time.sleep,
        image_source_credentials: Optional[Callable[[], dict[str, str]]] = None,
    ) -> None:
        self._arm = arm
        self._advance = advance
        self._sleep = sleep
        self._image_credentials = image_source_credentials

    def apply(
        self,
        plan: SetupPlan,
        *,
        values: dict[str, str],
        plan_for: Callable[[PlanInputs], SetupPlan],
        until: str = "proving",
    ) -> ApplyResult:
        """Run every stage before ``until``. ``plan_for`` rebuilds after a model refusal."""
        result = ApplyResult(values=dict(values), plan=plan)
        result.values.setdefault("signingSecretValue", secrets.token_urlsafe(48))
        for stage in AZURE_JOB_STAGES[: AZURE_JOB_STAGES.index(until)]:
            self._advance(stage)
            for step in result.plan.stage_steps(stage):  # type: ignore[union-attr]
                if not self._apply_step(step, result):
                    result.plan = plan_for(without_model(result.plan.inputs))  # type: ignore[union-attr]
                    break
        result.values.pop("signingSecretValue", None)
        return result

    def _apply_step(self, step: ArmStep, result: ApplyResult) -> bool:
        """Apply one step. False means an optional step was refused (typed outcome)."""
        try:
            if step.kind == "role_assignment":
                self._assign(step, result.values)
            elif step.kind == "action":
                self._act(step, result.values)
            else:
                self._put(step, result.values)
        except ArmError as exc:
            if not step.optional or exc.kind in ("unauthorized", "throttled", "server", "timeout"):
                raise
            result.model_outcome, result.model_error_code = _model_outcome(exc), exc.code
            logger.info("azure_setup.model_unavailable code=%s", exc.code)
            return False
        return True

    def _put(self, step: ArmStep, values: dict[str, str]) -> None:
        api = API_VERSIONS[step.api]
        if step.create_only:
            existing = self._arm.get_or_none(step.path, api_version=api, op=step.stage)
            if existing is not None:
                _capture(step, existing, values)
                return
        body = self._arm.put(
            step.path, api_version=api, body=resolve(step.body, values), op=step.stage
        )
        _capture(step, body, values)

    def _act(self, step: ArmStep, values: dict[str, str]) -> None:
        api = API_VERSIONS[step.api]
        body = resolve(step.body, values)
        if step.path.endswith("/importImage") and self._image_credentials is not None:
            body["source"]["credentials"] = self._image_credentials()
        self._arm.post(step.path, api_version=api, body=body, op=step.stage)
        if step.path.endswith("/register"):
            self._await_registration(step.path.removesuffix("/register"), api)

    def _await_registration(self, provider_path: str, api: str) -> None:
        for _ in range(_PROVIDER_POLL_LIMIT):
            state = self._arm.get(provider_path, api_version=api, op="registering_providers")
            if str(state.get("registrationState") or "") == "Registered":
                return
            self._sleep(_PROVIDER_POLL_SECONDS)
        raise AzureSetupRefused(
            f"Azure is still enabling {provider_path.rsplit('/', 1)[-1]}; try again shortly",
            code="PROVIDER_REGISTRATION_PENDING",
        )

    def _assign(self, step: ArmStep, values: dict[str, str]) -> None:
        api = API_VERSIONS[step.api]
        body = resolve(step.body, values)
        path = resolve(step.path, values)
        for delay in (*_PRINCIPAL_SETTLE_DELAYS, None):
            try:
                self._arm.put(path, api_version=api, body=body, op=step.stage)
                return
            except ArmError as exc:
                if exc.code == "RoleAssignmentExists":
                    return
                if exc.code != "PrincipalNotFound" or delay is None:
                    raise
                self._sleep(delay)


__all__ = ["ApplyResult", "AzureSetupRefused", "SetupApplier", "resolve"]
