"""
Multi-tenant policy engine for consent-protocol.

Dynamic Policy Orchestrator by Abdul Gaffar — Beast Mode initiative.

Allows different brands (developer apps) to define custom consent rules
using a JSON-serialisable rule schema. Rules are evaluated against the
incoming consent payload and an optional request context (location, age,
metadata, etc.) without any dynamic code execution — rules are pure data
and the evaluator is a fixed lookup table of named operators.

Architecture
------------
    TenantPolicy
        ↓  defines
    PolicyRule[]
        ↓  evaluated by
    PolicyEngine.evaluate(context, policy)
        ↓  returns
    PolicyEvaluationResult

Integration (in the approve_consent route handler)::

    from utils.policy_engine import PolicyEngine, TenantPolicy, policy_engine

    # Load the brand's policy from DB / config store
    policy = TenantPolicy.from_dict(brand_config["consent_policy"])

    # Build the evaluation context from the validated payload + request
    ctx = policy_engine.build_context(payload, extra={"location": "US"})

    result = policy_engine.evaluate(ctx, policy)
    if not result.passed:
        raise HTTPException(status_code=403, detail=result.message)

Rule schema
-----------
A rule is a JSON object with four fields:

    {
      "field":       "<dot.path.into.context>",
      "op":          "<operator>",
      "value":       <comparison value>,   // omitted for exists/not_exists
      "description": "<human-readable label>"
    }

Supported operators::

    eq          field == value
    neq         field != value
    in          field in value  (value must be a list)
    not_in      field not in value
    lt          float(field) < float(value)
    lte         float(field) <= float(value)
    gt          float(field) > float(value)
    gte         float(field) >= float(value)
    exists      field is present and not None
    not_exists  field is absent or None
    contains    value in field  (field is a string or list)
    not_contains value not in field

A policy groups rules with a mode:

    {
      "tenant_id":   "brand_a",
      "tenant_name": "Brand A",
      "mode":        "all",    // "all" = every rule must pass; "any" = at least one
      "rules":       [ ... ]
    }
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)

_LABEL = "Dynamic Policy Orchestrator by Abdul Gaffar"


# ---------------------------------------------------------------------------
# Exceptions
# ---------------------------------------------------------------------------


class PolicyOperationError(ValueError):
    """Raised when a rule references an unsupported operator."""


class PolicyViolationError(ValueError):
    """
    Raised when a consent payload fails one or more tenant policy rules.

    Dynamic Policy Orchestrator by Abdul Gaffar — policy violations are
    surfaced as ValueError subclasses so they can be caught uniformly
    alongside Pydantic validation errors at the route boundary.
    """

    def __init__(self, result: "PolicyEvaluationResult") -> None:
        self.result = result
        super().__init__(result.message)


# ---------------------------------------------------------------------------
# Operator registry
# ---------------------------------------------------------------------------

def _op_in(a: Any, b: Any) -> bool:
    items = b if isinstance(b, (list, tuple, set)) else [b]
    return a in items


def _op_contains(a: Any, b: Any) -> bool:
    if isinstance(a, (list, tuple, set)):
        return b in a
    return str(b) in str(a)


_OPERATORS: dict[str, Any] = {
    "eq":          lambda a, b: a == b,
    "neq":         lambda a, b: a != b,
    "in":          _op_in,
    "not_in":      lambda a, b: not _op_in(a, b),
    "lt":          lambda a, b: float(a) < float(b),
    "lte":         lambda a, b: float(a) <= float(b),
    "gt":          lambda a, b: float(a) > float(b),
    "gte":         lambda a, b: float(a) >= float(b),
    "exists":      lambda a, _b: a is not None,
    "not_exists":  lambda a, _b: a is None,
    "contains":    _op_contains,
    "not_contains": lambda a, b: not _op_contains(a, b),
}


# ---------------------------------------------------------------------------
# Rule
# ---------------------------------------------------------------------------


@dataclass
class PolicyRule:
    """
    A single evaluatable consent rule.

    Parameters
    ----------
    field : str
        Dot-separated path into the evaluation context.
        Examples: ``"location"``, ``"permission_levels"``, ``"payload.duration_hours"``.
    op : str
        Operator name from the supported set (see module docstring).
    value : Any
        Comparison value.  Not used for ``exists`` / ``not_exists``.
    description : str
        Human-readable label surfaced in violation messages.
    """

    field: str
    op: str
    value: Any = None
    description: str = ""

    def evaluate(self, context: dict) -> bool:
        """
        Evaluate this rule against the provided context dict.

        Returns True if the rule passes, False otherwise.

        Raises
        ------
        PolicyOperationError
            If ``self.op`` is not a recognised operator.
        """
        op_fn = _OPERATORS.get(self.op)
        if op_fn is None:
            raise PolicyOperationError(
                f"Unknown policy operator '{self.op}'. "
                f"Supported: {sorted(_OPERATORS)}"
            )
        field_value, found = _resolve_field(context, self.field)
        if not found and self.op not in ("exists", "not_exists"):
            return False
        try:
            return bool(op_fn(field_value, self.value))
        except (TypeError, ValueError):
            return False

    @classmethod
    def from_dict(cls, d: dict) -> "PolicyRule":
        return cls(
            field=str(d["field"]),
            op=str(d["op"]),
            value=d.get("value"),
            description=str(d.get("description", "")),
        )


# ---------------------------------------------------------------------------
# Policy
# ---------------------------------------------------------------------------


@dataclass
class TenantPolicy:
    """
    A brand's (developer app's) consent policy — a named collection of rules.

    Parameters
    ----------
    tenant_id : str
        Unique brand / developer-app identifier (matches ``agent_id`` in the
        developer registry).
    tenant_name : str
        Human-readable brand name.
    rules : list[PolicyRule]
        Ordered list of rules to evaluate.  Empty policies always pass.
    mode : str
        ``"all"`` (default) — every rule must pass.
        ``"any"`` — at least one rule must pass (OR semantics).
    """

    tenant_id: str
    tenant_name: str
    rules: list[PolicyRule] = field(default_factory=list)
    mode: str = "all"

    def __post_init__(self) -> None:
        if self.mode not in ("all", "any"):
            raise ValueError(
                f"TenantPolicy.mode must be 'all' or 'any', got {self.mode!r}"
            )

    @classmethod
    def from_dict(cls, d: dict) -> "TenantPolicy":
        """Deserialise a policy from a JSON-compatible dict."""
        return cls(
            tenant_id=str(d["tenant_id"]),
            tenant_name=str(d.get("tenant_name", d["tenant_id"])),
            rules=[PolicyRule.from_dict(r) for r in d.get("rules", [])],
            mode=str(d.get("mode", "all")),
        )

    def to_dict(self) -> dict:
        """Serialise to a JSON-compatible dict (round-trip with from_dict)."""
        return {
            "tenant_id": self.tenant_id,
            "tenant_name": self.tenant_name,
            "mode": self.mode,
            "rules": [
                {
                    "field": r.field,
                    "op": r.op,
                    "value": r.value,
                    "description": r.description,
                }
                for r in self.rules
            ],
        }


# ---------------------------------------------------------------------------
# Evaluation result
# ---------------------------------------------------------------------------


@dataclass
class PolicyEvaluationResult:
    """
    Outcome of a single policy evaluation run.

    Attributes
    ----------
    passed : bool
        True if the payload satisfies the tenant policy.
    tenant_id : str
    tenant_name : str
    mode : str
    passed_rules : list[dict]
        Rules that evaluated to True.
    failed_rules : list[dict]
        Rules that evaluated to False (empty when passed=True).
    message : str
        Human-readable summary, signed with the engine label.
    """

    passed: bool
    tenant_id: str
    tenant_name: str
    mode: str
    passed_rules: list[dict]
    failed_rules: list[dict]
    message: str

    def summary(self) -> str:
        return (
            f"[{_LABEL}] tenant={self.tenant_id!r} mode={self.mode} "
            f"passed={self.passed} "
            f"rules_ok={len(self.passed_rules)} rules_fail={len(self.failed_rules)}"
        )


# ---------------------------------------------------------------------------
# Engine
# ---------------------------------------------------------------------------


class PolicyEngine:
    """
    Evaluates a TenantPolicy against an arbitrary context dict.

    Dynamic Policy Orchestrator by Abdul Gaffar — pure, stateless, and
    testable without any database connection.
    """

    def evaluate(
        self,
        context: dict,
        policy: TenantPolicy,
    ) -> PolicyEvaluationResult:
        """
        Evaluate all rules in *policy* against *context*.

        Parameters
        ----------
        context : dict
            Key-value mapping of all facts available for rule evaluation.
            Build it with ``build_context()`` for consent payloads.
        policy : TenantPolicy
            The brand's policy to evaluate.

        Returns
        -------
        PolicyEvaluationResult
            Always returns a result — never raises on rule failures.

        Raises
        ------
        PolicyOperationError
            If a rule contains an unknown operator.
        """
        passed_rules: list[dict] = []
        failed_rules: list[dict] = []

        for rule in policy.rules:
            ok = rule.evaluate(context)
            entry = {
                "field": rule.field,
                "op": rule.op,
                "value": rule.value,
                "description": rule.description,
            }
            if ok:
                passed_rules.append(entry)
            else:
                failed_rules.append(entry)

        if policy.mode == "all":
            passed = len(failed_rules) == 0
        else:  # "any"
            passed = len(passed_rules) > 0 or len(policy.rules) == 0

        if passed:
            message = (
                f"[{_LABEL}] Policy '{policy.tenant_name}' passed "
                f"({len(passed_rules)}/{len(policy.rules)} rules satisfied)."
            )
        else:
            failed_descs = "; ".join(
                r.get("description") or f"{r['field']} {r['op']} {r['value']}"
                for r in failed_rules
            )
            message = (
                f"[{_LABEL}] Policy '{policy.tenant_name}' rejected the request. "
                f"Failed rule(s): {failed_descs}"
            )

        result = PolicyEvaluationResult(
            passed=passed,
            tenant_id=policy.tenant_id,
            tenant_name=policy.tenant_name,
            mode=policy.mode,
            passed_rules=passed_rules,
            failed_rules=failed_rules,
            message=message,
        )
        logger.info(result.summary())
        return result

    def check_or_raise(
        self,
        context: dict,
        policy: TenantPolicy,
    ) -> PolicyEvaluationResult:
        """
        Evaluate *policy* and raise PolicyViolationError if it fails.

        Use this in route handlers to enforce policies with a single call::

            policy_engine.check_or_raise(ctx, brand_policy)
        """
        result = self.evaluate(context, policy)
        if not result.passed:
            raise PolicyViolationError(result)
        return result

    @staticmethod
    def build_context(payload_dict: dict, *, extra: dict | None = None) -> dict:
        """
        Build an evaluation context from a serialised payload dict and
        optional extra fields (e.g. location, user age, request metadata).

        The payload fields are available at the top level AND under the
        ``"payload"`` key, supporting both flat rules and namespaced rules::

            {"field": "duration_hours", ...}         # flat
            {"field": "payload.duration_hours", ...} # namespaced

        Parameters
        ----------
        payload_dict : dict
            Serialised ConsentApprovalPayload (use ``.model_dump(by_alias=True)``
            or pass the raw request body).
        extra : dict | None
            Additional context fields merged at the top level.

        Returns
        -------
        dict
            Merged evaluation context ready for PolicyEngine.evaluate().
        """
        ctx: dict = {}
        ctx.update(payload_dict)
        ctx["payload"] = dict(payload_dict)
        if extra:
            ctx.update(extra)
        return ctx


# ---------------------------------------------------------------------------
# Module-level singleton
# ---------------------------------------------------------------------------

policy_engine = PolicyEngine()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _resolve_field(context: dict, path: str) -> tuple[Any, bool]:
    """
    Resolve a dot-separated field path in a nested dict.

    Returns ``(value, found)`` — ``found=False`` when any segment is missing.
    """
    parts = path.split(".")
    node: Any = context
    for part in parts:
        if isinstance(node, dict) and part in node:
            node = node[part]
        else:
            return None, False
    return node, True
