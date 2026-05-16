"""
Automated Data Redaction & Privacy Guardrails.

Privacy Guardrail Engine by Abdul Gaffar — Beast Mode initiative.

Takes a data payload and a list of policy-violated fields and scrubs each
field according to a deterministic, no-eval lookup table.  The caller
controls how aggressively data is withheld via ClearanceLevel.

Four redaction actions (in order of severity)
----------------------------------------------
MASK     — Partially obscure (show first/last two chars, replace middle with
           ``***``).  Used for quasi-identifiers (email, phone, user_id).
NULLIFY  — Replace the value with ``None``.  Keeps the field present in the
           payload so downstream consumers know the key exists.
REDACT   — Replace with the sentinel string ``"[REDACTED]"``.  Used for
           sensitive personal data where even ``null`` is informative.
OMIT     — Remove the key entirely from the payload.  Used for location and
           device data where even the field's presence reveals information.

Four clearance levels
---------------------
FULL     — No redaction applied; brand receives the complete payload.
PARTIAL  — Only fields that violated a policy rule are redacted (Partial
           Success mode — brand gets most data, sensitive fields scrubbed).
MINIMAL  — Only fields that explicitly passed a policy rule are returned;
           everything else is redacted.  Strictest selective mode.
NONE     — All payload fields are redacted regardless of policy results.

Deterministic lookup table
--------------------------
``_REDACTION_TABLE`` is a plain dict mapping field name → RedactionAction.
No dynamic code evaluation; no regex; no runtime policy re-evaluation.
Unknown fields fall back to ``_DEFAULT_ACTION`` (REDACT).

Integration with PolicyEngine
------------------------------
``RedactionEngine.apply_from_evaluation()`` accepts any object whose
``failed_rules`` and ``passed_rules`` attributes contain rule objects with a
``field`` string attribute — structurally compatible with
``PolicyEvaluationResult`` from ``utils.policy_engine`` without a hard import.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional

logger = logging.getLogger(__name__)

_LABEL = "Privacy Guardrail Engine by Abdul Gaffar"

_SENTINEL = "[REDACTED]"


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------


class RedactionAction(str, Enum):
    """The masking operation applied to a single field."""

    MASK = "MASK"       # Partial obscure — e.g. "al***ce"
    NULLIFY = "NULLIFY" # Set to None — key kept, value removed
    REDACT = "REDACT"   # Replace with "[REDACTED]"
    OMIT = "OMIT"       # Remove the key entirely


class ClearanceLevel(str, Enum):
    """Controls how aggressively the engine redacts the payload."""

    FULL = "full"       # No redaction; brand receives complete payload
    PARTIAL = "partial" # Redact only policy-violating fields (Partial Success)
    MINIMAL = "minimal" # Expose only explicitly policy-approved fields
    NONE = "none"       # Redact all fields regardless of policy results


# ---------------------------------------------------------------------------
# Deterministic lookup table — no eval, no regex, no dynamic dispatch
# ---------------------------------------------------------------------------

_REDACTION_TABLE: dict[str, RedactionAction] = {
    # Quasi-identifiers — masked (partially visible for debugging)
    "email": RedactionAction.MASK,
    "phone": RedactionAction.MASK,
    "user_id": RedactionAction.MASK,
    "userId": RedactionAction.MASK,
    "consent_id": RedactionAction.MASK,
    "request_id": RedactionAction.MASK,
    "requestId": RedactionAction.MASK,
    # Sensitive personal data — fully redacted
    "age": RedactionAction.REDACT,
    "date_of_birth": RedactionAction.REDACT,
    "health_data": RedactionAction.REDACT,
    "financial_data": RedactionAction.REDACT,
    "income": RedactionAction.REDACT,
    "permission_levels": RedactionAction.REDACT,
    "permissionLevels": RedactionAction.REDACT,
    "zk_encrypted_data": RedactionAction.REDACT,
    # Temporal / structural metadata — nullified (key kept)
    "timestamp": RedactionAction.NULLIFY,
    "expires_at": RedactionAction.NULLIFY,
    "expiresAt": RedactionAction.NULLIFY,
    "updated_at": RedactionAction.NULLIFY,
    # Location and device — omitted entirely (field presence is informative)
    "location": RedactionAction.OMIT,
    "ip_address": RedactionAction.OMIT,
    "device_id": RedactionAction.OMIT,
    "device_model": RedactionAction.OMIT,
    "coordinates": RedactionAction.OMIT,
}

_DEFAULT_ACTION: RedactionAction = RedactionAction.REDACT


# ---------------------------------------------------------------------------
# Domain types
# ---------------------------------------------------------------------------


@dataclass
class RedactedField:
    """Record of a single field that was redacted."""

    field: str
    action: RedactionAction
    original_type: str  # type name of the value before redaction


@dataclass
class RedactionResult:
    """Output of a redaction pass."""

    payload: dict[str, Any]
    redacted_fields: list[RedactedField] = field(default_factory=list)
    redaction_count: int = 0
    clearance_level: ClearanceLevel = ClearanceLevel.PARTIAL
    engine: str = _LABEL

    def summary(self) -> str:
        names = [r.field for r in self.redacted_fields]
        return (
            f"[{self.engine}] clearance={self.clearance_level.value} "
            f"redacted={self.redaction_count} fields={names}"
        )


# ---------------------------------------------------------------------------
# Masking helpers
# ---------------------------------------------------------------------------


def _mask_value(value: Any) -> str:
    """Partially obscure a value — show first/last 2 chars, replace middle."""
    s = str(value)
    if len(s) <= 4:
        return "***"
    return s[:2] + "***" + s[-2:]


def _apply_action_to_dict(
    payload: dict[str, Any],
    key: str,
    action: RedactionAction,
) -> tuple[dict[str, Any], Optional[RedactedField]]:
    """
    Apply ``action`` to ``key`` in a copy of ``payload``.

    Returns (new_payload, RedactedField) if the key existed, or
    (original_payload, None) if the key was absent.
    """
    if key not in payload:
        return payload, None

    original_type = type(payload[key]).__name__
    new_payload = dict(payload)

    if action == RedactionAction.OMIT:
        del new_payload[key]
    elif action == RedactionAction.NULLIFY:
        new_payload[key] = None
    elif action == RedactionAction.MASK:
        new_payload[key] = _mask_value(payload[key])
    else:  # REDACT (default)
        new_payload[key] = _SENTINEL

    return new_payload, RedactedField(field=key, action=action, original_type=original_type)


# ---------------------------------------------------------------------------
# Engine
# ---------------------------------------------------------------------------


class RedactionEngine:
    """
    Deterministic, no-eval privacy guardrail engine.

    Privacy Guardrail Engine by Abdul Gaffar — stateless; all configuration
    is expressed in ``_REDACTION_TABLE`` (a plain dict) and the caller-supplied
    ``ClearanceLevel``.
    """

    def _lookup_action(self, field_name: str) -> RedactionAction:
        """Return the RedactionAction for ``field_name``, defaulting to REDACT."""
        top_key = field_name.split(".")[0]  # strip dot-path prefix
        return _REDACTION_TABLE.get(top_key, _DEFAULT_ACTION)

    def _fields_to_redact(
        self,
        payload: dict[str, Any],
        failed_fields: list[str],
        passed_fields: Optional[list[str]],
        clearance_level: ClearanceLevel,
    ) -> list[str]:
        """Compute the set of top-level keys to redact for this clearance level."""
        if clearance_level == ClearanceLevel.FULL:
            return []
        if clearance_level == ClearanceLevel.NONE:
            return list(payload.keys())
        if clearance_level == ClearanceLevel.MINIMAL:
            approved = set(passed_fields) if passed_fields else set()
            return [k for k in payload if k not in approved]
        # PARTIAL: only redact the fields that explicitly failed
        return [f.split(".")[0] for f in failed_fields]

    def apply(
        self,
        payload: dict[str, Any],
        *,
        failed_fields: list[str],
        passed_fields: Optional[list[str]] = None,
        clearance_level: ClearanceLevel = ClearanceLevel.PARTIAL,
    ) -> RedactionResult:
        """
        Apply the redaction table to ``payload`` based on ``clearance_level``.

        Parameters
        ----------
        payload : dict
            The outgoing data payload to scrub.
        failed_fields : list[str]
            Field names (optionally dot-path) from failed policy rules.
        passed_fields : list[str] | None
            Field names from passed policy rules; required for MINIMAL level.
        clearance_level : ClearanceLevel
            Controls which fields are redacted (default: PARTIAL).

        Returns
        -------
        RedactionResult
            Scrubbed payload and a log of what was redacted and why.
        """
        keys_to_redact = self._fields_to_redact(
            payload, failed_fields, passed_fields, clearance_level
        )

        result_payload = dict(payload)
        redacted: list[RedactedField] = []

        for key in keys_to_redact:
            action = self._lookup_action(key)
            result_payload, entry = _apply_action_to_dict(result_payload, key, action)
            if entry is not None:
                redacted.append(entry)

        result = RedactionResult(
            payload=result_payload,
            redacted_fields=redacted,
            redaction_count=len(redacted),
            clearance_level=clearance_level,
        )
        logger.info(
            "[%s] %s",
            _LABEL,
            result.summary(),
        )
        return result

    def apply_from_evaluation(
        self,
        payload: dict[str, Any],
        *,
        evaluation: Any,
        clearance_level: ClearanceLevel = ClearanceLevel.PARTIAL,
    ) -> RedactionResult:
        """
        Apply redactions driven by a PolicyEngine evaluation result.

        ``evaluation`` is duck-typed: it must have ``failed_rules`` and
        ``passed_rules`` attributes, each a list of objects with a ``field``
        string attribute.  This is structurally compatible with
        ``PolicyEvaluationResult`` from ``utils.policy_engine``.

        Parameters
        ----------
        payload : dict
            The outgoing data payload to scrub.
        evaluation : Any
            Object with ``.failed_rules`` and ``.passed_rules`` (each item
            has a ``.field`` str attribute).
        clearance_level : ClearanceLevel
            Controls how aggressively the payload is scrubbed.
        """
        failed_fields = [r.field for r in evaluation.failed_rules]
        passed_fields = [r.field for r in evaluation.passed_rules]
        return self.apply(
            payload,
            failed_fields=failed_fields,
            passed_fields=passed_fields,
            clearance_level=clearance_level,
        )


# ---------------------------------------------------------------------------
# Module-level singleton
# ---------------------------------------------------------------------------

redaction_engine = RedactionEngine()
