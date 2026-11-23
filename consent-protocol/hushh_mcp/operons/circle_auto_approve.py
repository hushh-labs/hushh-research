"""Stage 2b Dual-Lock Circle Auto-Approve operon.

Pure, deterministic decision logic that evaluates whether an inbound Circle
Information Exchange request may be fulfilled automatically inside a woken
Personal Sandbox or BYOC pod without touching the owner's Master Vault Key.

Architectural invariants:
1. Lock 1 (Cryptographic Scope Ceiling):
   Every rule pins an explicit list of allowed parent/sub-scope patterns and a
   domain-scoped delegation subkey reference sealed on-device to the pod public
   key. Sovereign Vault capital, credentials, identity documents, contacts, and
   root wildcards (``*``) are unconditionally forbidden.
2. Lock 2 (Quarantined Natural-Language Policy Filter):
   Evaluates the owner's natural-language predicate strictly against the owner's
   own candidate slice metadata (never the untrusted requester's prompt text).
   Explicit negative clauses (``never share ...``, ``except ...``, ``exclude ...``)
   veto immediately. Any uncertainty below the 0.85 confidence floor degrades
   cleanly to ``stage_for_owner_review``.
3. Zero-PII Notifications & Master Vault Key Isolation:
   ``master_vault_key_touched`` is structurally ``False``. Notifications reuse
   ``build_muse_background_push`` so zero names, subjects, or amounts ever reach
   Apple or Google push relays.
"""

from __future__ import annotations

import re
import uuid
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal

from hushh_mcp.services.feed_attention_push import build_muse_background_push

DecisionKind = Literal["auto_approve", "stage_for_owner_review"]

MIN_CONFIDENCE_FLOOR = 0.85
MAX_RULES_PER_OWNER = 32
MAX_SCOPE_PATTERNS_PER_RULE = 12
MAX_DAILY_CAP = 50
MAX_NL_POLICY_CHARS = 500
MAX_LABEL_CHARS = 80

# Sovereign Vault capital, secrets, identity documents, payment credentials,
# and BYOC-only contacts may NEVER be delegated to offline Circle auto-approve.
FORBIDDEN_AUTO_APPROVE_SCOPE_PREFIXES: frozenset[str] = frozenset(
    {
        "vault.secrets",
        "vault.master",
        "identity.ssn",
        "identity.passport",
        "identity.tax",
        "wallet.pan",
        "wallet.cvv",
        "finance.account_credentials",
        "finance.holdings",
        "finance.net_worth",
        "finance.brokerage",
        "contacts",
    }
)

# Parent roots that contain sovereign forbidden sub-scopes: wildcarding the
# whole parent (e.g. "vault.*", "identity.*", "wallet.*", "finance.*") is also
# refused so a broad rule can never sweep sovereign capital offline.
_FORBIDDEN_WILDCARD_ROOTS: frozenset[str] = frozenset(
    {prefix.split(".", 1)[0] for prefix in FORBIDDEN_AUTO_APPROVE_SCOPE_PREFIXES}
)

_RULE_ID_RE = re.compile(r"^rule_[a-z0-9][a-z0-9_-]{7,63}$")
_CIRCLE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
_SCOPE_PATTERN_RE = re.compile(r"^[a-z0-9][a-z0-9_.-]{1,95}(?:\.\*)?$")
_CONCRETE_SCOPE_RE = re.compile(r"^[a-z0-9][a-z0-9_.-]{1,95}$")
_SUBKEY_REF_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{5,127}$")
_TOKEN_RE = re.compile(r"[a-z0-9]{3,}")

_NEGATION_CLAUSE_RE = re.compile(
    r"(?:never\s+share|do\s+not\s+share|don't\s+share|never\s+include|"
    r"do\s+not\s+include|except|excluding|exclude|without)\s+([^;.\n]+)",
    re.IGNORECASE,
)

_STOPWORDS: frozenset[str] = frozenset(
    {
        "the",
        "and",
        "for",
        "with",
        "from",
        "that",
        "this",
        "auto",
        "share",
        "approve",
        "only",
        "when",
        "asked",
        "trusted",
        "family",
        "work",
        "circle",
        "members",
        "member",
        "always",
        "allow",
        "send",
        "provide",
        "give",
        "any",
        "all",
        "upcoming",
        "recent",
        "current",
        "my",
        "our",
    }
)


class CircleRuleValidationError(ValueError):
    """Typed validation failure for Circle Auto-Approve rules."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _normalize_scope(raw: str) -> str:
    return str(raw or "").strip().lower()


def is_forbidden_sovereign_scope(scope_or_pattern: str) -> bool:
    """True when a scope or wildcard pattern touches a forbidden sovereign domain."""
    clean = _normalize_scope(scope_or_pattern)
    if not clean or clean == "*" or clean.startswith("*") or ".." in clean:
        return True
    is_wildcard = clean.endswith(".*")
    base = clean[:-2] if is_wildcard else clean
    if not base or "*" in base:
        return True

    if is_wildcard and base in _FORBIDDEN_WILDCARD_ROOTS:
        return True

    for forbidden in FORBIDDEN_AUTO_APPROVE_SCOPE_PREFIXES:
        if base == forbidden or base.startswith(f"{forbidden}."):
            return True
        if is_wildcard and forbidden.startswith(f"{base}."):
            return True
    return False


def validate_scope_pattern(pattern: str) -> str:
    """Normalize and validate one parent/sub-scope pattern for Lock 1."""
    clean = _normalize_scope(pattern)
    if not clean or clean == "*" or "*" in clean[:-2]:
        raise CircleRuleValidationError(
            "FORBIDDEN_WILDCARD_SCOPE",
            "Root or mid-segment wildcards are forbidden in Circle auto-approve rules.",
        )
    if is_forbidden_sovereign_scope(clean):
        raise CircleRuleValidationError(
            "FORBIDDEN_SOVEREIGN_SCOPE",
            f"Scope '{clean}' belongs to sovereign Vault or BYOC-only data and cannot auto-approve offline.",
        )
    if not _SCOPE_PATTERN_RE.fullmatch(clean):
        raise CircleRuleValidationError(
            "INVALID_SCOPE_PATTERN",
            f"Scope pattern '{clean}' must use lowercase dot-separated segments (optional trailing '.*').",
        )
    if clean.endswith(".") or clean.startswith(".") or ".." in clean:
        raise CircleRuleValidationError(
            "INVALID_SCOPE_PATTERN",
            f"Scope pattern '{clean}' contains empty segments.",
        )
    return clean


def validate_rule_id(rule_id: str) -> str:
    clean = str(rule_id or "").strip().lower()
    if not _RULE_ID_RE.fullmatch(clean):
        raise CircleRuleValidationError(
            "INVALID_RULE_ID",
            "Rule identifier must start with 'rule_' followed by 8-64 lowercase characters.",
        )
    return clean


def generate_rule_id() -> str:
    return f"rule_{uuid.uuid4().hex[:16]}"


@dataclass(frozen=True)
class CircleAutoApproveRule:
    """One owner-authored Dual-Lock Circle Auto-Approve rule."""

    rule_id: str
    circle_id: str
    label: str
    scope_patterns: tuple[str, ...]
    nl_policy_filter: str = ""
    delegation_subkey_ref: str = ""
    enabled: bool = True
    daily_cap: int = 10
    require_confidence: float = MIN_CONFIDENCE_FLOOR
    created_at_ms: int = 0
    updated_at_ms: int = 0

    def as_dict(self) -> dict[str, Any]:
        return {
            "rule_id": self.rule_id,
            "circle_id": self.circle_id,
            "label": self.label,
            "scope_patterns": list(self.scope_patterns),
            "nl_policy_filter": self.nl_policy_filter,
            "delegation_subkey_ref": self.delegation_subkey_ref,
            "enabled": self.enabled,
            "daily_cap": self.daily_cap,
            "require_confidence": self.require_confidence,
            "created_at_ms": self.created_at_ms,
            "updated_at_ms": self.updated_at_ms,
        }


def validate_circle_rule(
    raw: Mapping[str, Any],
    *,
    existing_rule_id: str | None = None,
    now_ms: int = 0,
    existing_created_at_ms: int | None = None,
) -> CircleAutoApproveRule:
    """Validate and construct an immutable ``CircleAutoApproveRule``."""
    raw_id = str(raw.get("rule_id") or raw.get("ruleId") or existing_rule_id or "").strip().lower()
    rule_id = validate_rule_id(raw_id) if raw_id else generate_rule_id()

    circle_id = str(raw.get("circle_id") or raw.get("circleId") or "").strip().lower()
    if not _CIRCLE_ID_RE.fullmatch(circle_id):
        raise CircleRuleValidationError(
            "INVALID_CIRCLE_ID",
            "Circle identifier must be 1-64 lowercase letters, digits, hyphens, or underscores.",
        )

    label = str(raw.get("label") or "").strip()
    if not label or len(label) > MAX_LABEL_CHARS:
        raise CircleRuleValidationError(
            "INVALID_LABEL",
            f"Rule label must be between 1 and {MAX_LABEL_CHARS} characters.",
        )

    raw_patterns = raw.get("scope_patterns")
    if raw_patterns is None:
        raw_patterns = raw.get("scopePatterns")
    if not isinstance(raw_patterns, Sequence) or isinstance(raw_patterns, (str, bytes)):
        raise CircleRuleValidationError(
            "INVALID_SCOPE_PATTERNS",
            "At least one scope pattern is required.",
        )
    deduped_patterns: list[str] = []
    for item in raw_patterns:
        validated = validate_scope_pattern(str(item))
        if validated not in deduped_patterns:
            deduped_patterns.append(validated)
    if not deduped_patterns or len(deduped_patterns) > MAX_SCOPE_PATTERNS_PER_RULE:
        raise CircleRuleValidationError(
            "INVALID_SCOPE_PATTERNS",
            f"Provide between 1 and {MAX_SCOPE_PATTERNS_PER_RULE} scope patterns.",
        )

    nl_policy_filter = str(
        raw.get("nl_policy_filter")
        if raw.get("nl_policy_filter") is not None
        else raw.get("nlPolicyFilter") or ""
    ).strip()
    if len(nl_policy_filter) > MAX_NL_POLICY_CHARS:
        raise CircleRuleValidationError(
            "NL_POLICY_TOO_LONG",
            f"Natural-language filter must be at most {MAX_NL_POLICY_CHARS} characters.",
        )

    delegation_subkey_ref = str(
        raw.get("delegation_subkey_ref")
        if raw.get("delegation_subkey_ref") is not None
        else raw.get("delegationSubkeyRef") or ""
    ).strip()
    if delegation_subkey_ref and not _SUBKEY_REF_RE.fullmatch(delegation_subkey_ref):
        raise CircleRuleValidationError(
            "INVALID_SUBKEY_REF",
            "Delegation subkey reference is malformed.",
        )

    enabled_raw = raw.get("enabled", True)
    if not isinstance(enabled_raw, bool):
        raise CircleRuleValidationError("INVALID_ENABLED", "enabled must be a boolean.")

    cap_raw = raw.get("daily_cap") if raw.get("daily_cap") is not None else raw.get("dailyCap", 10)
    if (
        isinstance(cap_raw, bool)
        or not isinstance(cap_raw, int)
        or not (1 <= cap_raw <= MAX_DAILY_CAP)
    ):
        raise CircleRuleValidationError(
            "INVALID_DAILY_CAP",
            f"daily_cap must be an integer between 1 and {MAX_DAILY_CAP}.",
        )

    conf_raw = (
        raw.get("require_confidence")
        if raw.get("require_confidence") is not None
        else raw.get("requireConfidence", MIN_CONFIDENCE_FLOOR)
    )
    if (
        isinstance(conf_raw, bool)
        or not isinstance(conf_raw, (int, float))
        or not (MIN_CONFIDENCE_FLOOR <= float(conf_raw) <= 1.0)
    ):
        raise CircleRuleValidationError(
            "INVALID_CONFIDENCE_FLOOR",
            f"require_confidence must be between {MIN_CONFIDENCE_FLOOR} and 1.0.",
        )

    created_at = (
        existing_created_at_ms
        if existing_created_at_ms is not None and existing_created_at_ms > 0
        else int(raw.get("created_at_ms") or now_ms)
    )
    updated_at = int(now_ms or raw.get("updated_at_ms") or created_at)

    return CircleAutoApproveRule(
        rule_id=rule_id,
        circle_id=circle_id,
        label=label,
        scope_patterns=tuple(deduped_patterns),
        nl_policy_filter=nl_policy_filter,
        delegation_subkey_ref=delegation_subkey_ref,
        enabled=enabled_raw,
        daily_cap=cap_raw,
        require_confidence=round(float(conf_raw), 4),
        created_at_ms=created_at,
        updated_at_ms=updated_at,
    )


def scope_matches_ceiling(requested_scope: str, scope_patterns: Sequence[str]) -> bool:
    """Lock 1: strict segment-bounded scope ceiling match, rejecting sovereign scopes."""
    clean_scope = _normalize_scope(requested_scope)
    if not clean_scope or "*" in clean_scope or not _CONCRETE_SCOPE_RE.fullmatch(clean_scope):
        return False
    if is_forbidden_sovereign_scope(clean_scope):
        return False

    for raw_pattern in scope_patterns:
        pattern = _normalize_scope(raw_pattern)
        if not pattern or is_forbidden_sovereign_scope(pattern):
            continue
        if pattern.endswith(".*"):
            prefix = pattern[:-2]
            if clean_scope == prefix or clean_scope.startswith(f"{prefix}."):
                return True
        elif clean_scope == pattern:
            return True
    return False


SemanticMatcher = Callable[[str, str, str, tuple[str, ...]], tuple[bool, float, str]]


@dataclass(frozen=True)
class NlPolicyEvaluation:
    """Result of Lock 2 quarantined semantic evaluation."""

    matched: bool
    confidence: float
    reason: str
    excluded_term: str | None = None


def _extract_exclusion_phrases(nl_policy_filter: str) -> tuple[str, ...]:
    phrases: list[str] = []
    for match in _NEGATION_CLAUSE_RE.finditer(nl_policy_filter):
        chunk = match.group(1).strip().lower()
        if not chunk:
            continue
        for part in re.split(r"\s*(?:,|/|\bor\b|\band\b)\s*", chunk):
            cleaned = re.sub(r"[^a-z0-9\s_-]+", "", part).strip()
            if len(cleaned) >= 3:
                phrases.append(cleaned)
    return tuple(dict.fromkeys(phrases))


def _positive_policy_tokens(nl_policy_filter: str) -> tuple[str, ...]:
    positive_only = _NEGATION_CLAUSE_RE.sub(" ", nl_policy_filter).lower()
    tokens = [tok for tok in _TOKEN_RE.findall(positive_only) if tok not in _STOPWORDS]
    return tuple(dict.fromkeys(tokens))


def evaluate_nl_policy_filter(
    *,
    nl_policy_filter: str,
    candidate_scope: str,
    candidate_summary: str,
    candidate_tags: Iterable[str] = (),
    min_confidence: float = MIN_CONFIDENCE_FLOOR,
    semantic_matcher: SemanticMatcher | None = None,
) -> NlPolicyEvaluation:
    """Lock 2: quarantined evaluation over owner's candidate slice ONLY.

    Security boundary: untrusted requester prompt text is deliberately NOT an
    input to this function so prompt injection from an inbound request can never
    manipulate the owner's natural-language policy filter.
    """
    policy = str(nl_policy_filter or "").strip()
    if not policy:
        return NlPolicyEvaluation(matched=True, confidence=1.0, reason="scope_ceiling_only")

    tags = tuple(str(t or "").strip().lower() for t in candidate_tags if str(t or "").strip())
    scope_norm = _normalize_scope(candidate_scope)
    summary_norm = str(candidate_summary or "").strip().lower()
    haystack = " ".join(
        part for part in (scope_norm.replace(".", " "), summary_norm, " ".join(tags)) if part
    )

    # Hard negative exclusion check runs BEFORE any semantic scorer.
    for phrase in _extract_exclusion_phrases(policy):
        phrase_tokens = [tok for tok in _TOKEN_RE.findall(phrase) if tok not in _STOPWORDS]
        if phrase in haystack:
            return NlPolicyEvaluation(
                matched=False,
                confidence=0.0,
                reason="nl_policy_excluded",
                excluded_term=phrase,
            )
        if phrase_tokens and all(tok in haystack for tok in phrase_tokens):
            return NlPolicyEvaluation(
                matched=False,
                confidence=0.0,
                reason="nl_policy_excluded",
                excluded_term=phrase,
            )

    effective_floor = max(MIN_CONFIDENCE_FLOOR, float(min_confidence))

    if semantic_matcher is not None:
        try:
            matched, raw_conf, raw_reason = semantic_matcher(
                policy,
                scope_norm,
                summary_norm,
                tags,
            )
            conf = max(0.0, min(1.0, float(raw_conf)))
        except Exception:  # noqa: BLE001 - fail safe to owner review on matcher error
            return NlPolicyEvaluation(
                matched=False,
                confidence=0.0,
                reason="nl_policy_matcher_error",
            )
        if matched and conf >= effective_floor:
            return NlPolicyEvaluation(
                matched=True,
                confidence=round(conf, 4),
                reason=str(raw_reason or "nl_policy_matched"),
            )
        return NlPolicyEvaluation(
            matched=False,
            confidence=round(conf, 4),
            reason="nl_policy_uncertain",
        )

    # Deterministic lexical evaluator when no LLM semantic matcher is injected:
    # requires explicit positive topic match against the owner's candidate slice.
    positive_tokens = _positive_policy_tokens(policy)
    if not positive_tokens:
        # Policy had only exclusions and none triggered -> safe within Lock 1 ceiling.
        return NlPolicyEvaluation(matched=True, confidence=0.92, reason="nl_exclusions_cleared")

    haystack_tokens = set(_TOKEN_RE.findall(haystack))
    matched_tokens = [
        tok
        for tok in positive_tokens
        if tok in haystack_tokens
        or any(ht.startswith(tok) or tok.startswith(ht) for ht in haystack_tokens if len(ht) >= 4)
    ]
    if not matched_tokens:
        return NlPolicyEvaluation(matched=False, confidence=0.0, reason="nl_policy_uncertain")

    # Single-domain positive policies (e.g. "flight and hotel confirmations")
    # match cleanly when the candidate aligns strongly with one or more named
    # subject tokens. Require at least 1 strong hit and boost with multi-token alignment.
    ratio = len(matched_tokens) / max(1, min(len(positive_tokens), 3))
    confidence = min(0.98, 0.80 + 0.16 * min(1.0, ratio))
    if confidence >= effective_floor:
        return NlPolicyEvaluation(
            matched=True,
            confidence=round(confidence, 4),
            reason="nl_policy_matched",
        )
    return NlPolicyEvaluation(
        matched=False,
        confidence=round(confidence, 4),
        reason="nl_policy_uncertain",
    )


@dataclass(frozen=True)
class AutoApproveDecision:
    """Typed Dual-Lock decision with privacy-safe receipt & lockscreen push."""

    decision: DecisionKind
    reason: str
    matched_rule_id: str | None
    confidence: float
    delegation_subkey_ref: str | None
    master_vault_key_touched: bool
    receipt_summary: dict[str, Any]
    notification_payload: dict[str, Any]

    def as_dict(self) -> dict[str, Any]:
        return {
            "decision": self.decision,
            "reason": self.reason,
            "matchedRuleId": self.matched_rule_id,
            "confidence": self.confidence,
            "delegationSubkeyRef": self.delegation_subkey_ref,
            "masterVaultKeyTouched": self.master_vault_key_touched,
            "receiptSummary": dict(self.receipt_summary),
            "notificationPayload": dict(self.notification_payload),
        }


def _stage_decision(
    *,
    circle_id: str,
    requested_scope: str,
    reason: str,
    request_ref: str,
    matched_rule_id: str | None = None,
    confidence: float = 0.0,
) -> AutoApproveDecision:
    safe_ref = (
        re.sub(r"[^A-Za-z0-9_:-]+", "", str(request_ref or ""))[:48]
        or f"req_{uuid.uuid4().hex[:12]}"
    )
    receipt = {
        "decision": "stage_for_owner_review",
        "reason": reason,
        "circle_id": _normalize_scope(circle_id),
        "scope": _normalize_scope(requested_scope),
        "matched_rule_id": matched_rule_id,
        "confidence": round(float(confidence), 4),
        "master_vault_key_touched": False,
    }
    notification = build_muse_background_push(
        "information_request_ready",
        ref_id=safe_ref,
        count=1,
    )
    return AutoApproveDecision(
        decision="stage_for_owner_review",
        reason=reason,
        matched_rule_id=matched_rule_id,
        confidence=round(float(confidence), 4),
        delegation_subkey_ref=None,
        master_vault_key_touched=False,
        receipt_summary=receipt,
        notification_payload=notification,
    )


def evaluate_circle_auto_approve(
    *,
    rules: Sequence[CircleAutoApproveRule],
    circle_id: str,
    requester_in_circle: bool,
    requested_scope: str,
    candidate_summary: str,
    candidate_tags: Iterable[str] = (),
    session_only_lockdown: bool = False,
    fulfilled_today_by_rule: Mapping[str, int] | None = None,
    available_subkey_refs: Iterable[str] | None = None,
    requester_prompt_text: str = "",
    request_ref: str = "",
    semantic_matcher: SemanticMatcher | None = None,
) -> AutoApproveDecision:
    """Run both cryptographic ceiling (Lock 1) and quarantined NL filter (Lock 2).

    Note: ``requester_prompt_text`` is accepted ONLY to prove quarantine at the
    interface boundary and is NEVER forwarded to Lock 1 or Lock 2.
    """
    _ = requester_prompt_text  # Intentionally quarantined from policy evaluation.

    norm_circle = str(circle_id or "").strip().lower()
    norm_scope = _normalize_scope(requested_scope)

    if session_only_lockdown:
        return _stage_decision(
            circle_id=norm_circle,
            requested_scope=norm_scope,
            reason="session_only_lockdown",
            request_ref=request_ref,
        )

    if not requester_in_circle:
        return _stage_decision(
            circle_id=norm_circle,
            requested_scope=norm_scope,
            reason="requester_not_in_circle",
            request_ref=request_ref,
        )

    if is_forbidden_sovereign_scope(norm_scope):
        return _stage_decision(
            circle_id=norm_circle,
            requested_scope=norm_scope,
            reason="forbidden_sovereign_scope",
            request_ref=request_ref,
        )

    circle_rules = [r for r in rules if r.enabled and r.circle_id == norm_circle]
    if not circle_rules:
        return _stage_decision(
            circle_id=norm_circle,
            requested_scope=norm_scope,
            reason="no_active_circle_rule",
            request_ref=request_ref,
        )

    ceiling_matches = [
        r for r in circle_rules if scope_matches_ceiling(norm_scope, r.scope_patterns)
    ]
    if not ceiling_matches:
        return _stage_decision(
            circle_id=norm_circle,
            requested_scope=norm_scope,
            reason="outside_scope_ceiling",
            request_ref=request_ref,
        )

    available_set = set(available_subkey_refs) if available_subkey_refs is not None else None
    counts = dict(fulfilled_today_by_rule or {})

    last_failure_reason = "outside_scope_ceiling"
    last_failure_rule_id: str | None = None
    last_confidence = 0.0

    for rule in ceiling_matches:
        if not rule.delegation_subkey_ref:
            last_failure_reason = "delegation_subkey_missing"
            last_failure_rule_id = rule.rule_id
            continue
        if available_set is not None and rule.delegation_subkey_ref not in available_set:
            last_failure_reason = "delegation_subkey_unavailable"
            last_failure_rule_id = rule.rule_id
            continue
        if int(counts.get(rule.rule_id, 0)) >= rule.daily_cap:
            last_failure_reason = "daily_cap_reached"
            last_failure_rule_id = rule.rule_id
            continue

        nl_eval = evaluate_nl_policy_filter(
            nl_policy_filter=rule.nl_policy_filter,
            candidate_scope=norm_scope,
            candidate_summary=candidate_summary,
            candidate_tags=candidate_tags,
            min_confidence=rule.require_confidence,
            semantic_matcher=semantic_matcher,
        )
        if not nl_eval.matched:
            last_failure_reason = nl_eval.reason
            last_failure_rule_id = rule.rule_id
            last_confidence = nl_eval.confidence
            continue

        safe_ref = re.sub(r"[^A-Za-z0-9_:-]+", "", str(request_ref or ""))[:48] or rule.rule_id
        receipt = {
            "decision": "auto_approve",
            "reason": nl_eval.reason,
            "circle_id": norm_circle,
            "scope": norm_scope,
            "matched_rule_id": rule.rule_id,
            "confidence": nl_eval.confidence,
            "master_vault_key_touched": False,
        }
        notification = build_muse_background_push(
            "circle_rule_fulfilled",
            ref_id=safe_ref,
            count=1,
        )
        return AutoApproveDecision(
            decision="auto_approve",
            reason=nl_eval.reason,
            matched_rule_id=rule.rule_id,
            confidence=nl_eval.confidence,
            delegation_subkey_ref=rule.delegation_subkey_ref,
            master_vault_key_touched=False,
            receipt_summary=receipt,
            notification_payload=notification,
        )

    return _stage_decision(
        circle_id=norm_circle,
        requested_scope=norm_scope,
        reason=last_failure_reason,
        request_ref=request_ref,
        matched_rule_id=last_failure_rule_id,
        confidence=last_confidence,
    )


__all__ = [
    "FORBIDDEN_AUTO_APPROVE_SCOPE_PREFIXES",
    "MAX_DAILY_CAP",
    "MAX_LABEL_CHARS",
    "MAX_NL_POLICY_CHARS",
    "MAX_RULES_PER_OWNER",
    "MAX_SCOPE_PATTERNS_PER_RULE",
    "MIN_CONFIDENCE_FLOOR",
    "AutoApproveDecision",
    "CircleAutoApproveRule",
    "CircleRuleValidationError",
    "DecisionKind",
    "NlPolicyEvaluation",
    "SemanticMatcher",
    "evaluate_circle_auto_approve",
    "evaluate_nl_policy_filter",
    "generate_rule_id",
    "is_forbidden_sovereign_scope",
    "scope_matches_ceiling",
    "validate_circle_rule",
    "validate_rule_id",
    "validate_scope_pattern",
]
