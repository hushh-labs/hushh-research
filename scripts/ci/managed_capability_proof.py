"""Closed capability-proof validation shared by pinned release tooling.

This module validates synthetic evidence only; it grants no runtime authority.
"""

from __future__ import annotations

import re
from typing import Any

CLASSIFICATIONS = frozenset(
    {
        "dependency_ok",
        "provider_unavailable",
        "candidate_misconfigured",
        "application_broken",
    }
)
ERROR_TYPES = frozenset(
    {
        "ClientError",
        "ServerError",
        "APIError",
        "ResourceExhausted",
        "ResourceExhaustedError",
        "TimeoutError",
        "ConnectionError",
        "RuntimeError",
        "ValueError",
        "TypeError",
        "PermissionError",
        "KeyError",
        "LookupError",
        "AttributeError",
        "PermissionDenied",
        "Unauthenticated",
        "NotFound",
        "InvalidArgument",
        "GoogleAPICallError",
        "ServiceUnavailable",
        "DeadlineExceeded",
        "APITimeoutError",
        "APIConnectionError",
        "AuthenticationError",
        "RateLimitError",
        "InternalServerError",
        "BadRequestError",
        "NotFoundError",
        "PermissionDeniedError",
        "APIStatusError",
        "ReadinessConfigurationError",
        "ReadinessResponseError",
        "JSONDecodeError",
        "UnknownException",
        "LocationBrainEmbeddingUnavailable",
        "SpecialistAdkTurnError",
    }
)
PROBE_NAME = re.compile(
    r"(?:text|adk|one_chat|one_voice_live):gemini-[a-z0-9][a-z0-9._-]{0,95}"
    r"@[a-z][a-z0-9-]{0,39}(?:,[a-z][a-z0-9-]{0,39}){0,7}\Z"
)
FIXED_PROBES = frozenset({"embedding", "location_command:audio", "location_command:semantics"})
CAPABILITY_PROBES = frozenset(
    "capability:" + name
    for name in (
        "structured_text",
        "image_input",
        "pdf_input",
        "public_search",
        "public_source",
        "narration",
        "location_transcription",
        "location_semantics",
        "embeddings",
        "live_audio",
        "compact_public_search",
        "one_text_root",
    )
)


def _decision_fields(value: dict[str, Any]) -> dict[str, Any]:
    if type(value.get("ok")) is not bool or value.get("classification") not in CLASSIFICATIONS:
        raise ValueError("Invalid decision fields")
    return {"ok": value["ok"], "classification": value["classification"]}


def _attempt_receipts(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list) or not 1 <= len(value) <= 2:
        raise ValueError("Invalid probe attempts")
    result = []
    for attempt in value:
        if not isinstance(attempt, dict):
            raise ValueError("Invalid probe attempt")
        elapsed = attempt.get("elapsed_ms")
        if type(elapsed) is not int or not 0 <= elapsed <= 420000:
            raise ValueError("Invalid probe duration")
        clean = {**_decision_fields(attempt), "elapsed_ms": elapsed}
        if "dispatched" in attempt:
            if type(attempt["dispatched"]) is not bool:
                raise ValueError("Invalid dispatch flag")
            clean["dispatched"] = attempt["dispatched"]
        if "resource_exhausted" in attempt:
            if type(attempt["resource_exhausted"]) is not bool:
                raise ValueError("Invalid attempt exhaustion flag")
            clean["resource_exhausted"] = attempt["resource_exhausted"]
        if "error_type" in attempt:
            error_type = attempt["error_type"]
            clean["error_type"] = (
                error_type
                if isinstance(error_type, str) and error_type in ERROR_TYPES
                else "OtherError"
            )
        if "failure_stage" in attempt:
            stage = attempt["failure_stage"]
            if stage not in {
                "configuration",
                "federation",
                "primary_http",
                "response_validation",
            }:
                raise ValueError("Invalid failure stage")
            clean["failure_stage"] = stage
        result.append(clean)
    return result


def sanitize_probe_history(value: Any, *, provider: str) -> list[dict]:
    """Retain actual bounded attempts, with recovery derived from their outcomes."""
    if not isinstance(value, list) or len(value) > 128:
        raise ValueError("Invalid probe history")
    result, seen = [], set()
    for row in value:
        if not isinstance(row, dict):
            raise ValueError("Invalid probe history row")
        name = row.get("probe")
        if (
            not isinstance(name, str)
            or name in seen
            or name not in FIXED_PROBES | CAPABILITY_PROBES | {"primary_http"}
            and not PROBE_NAME.fullmatch(name)
        ):
            raise ValueError("Invalid probe history name")
        seen.add(name)
        attempts = _attempt_receipts(row.get("attempts"))
        if provider == "azure_openai" and (
            name not in CAPABILITY_PROBES | {"primary_http"} or len(attempts) != 1
        ):
            raise ValueError("Azure readiness has no retry")
        if provider == "vertex" and name in CAPABILITY_PROBES | {"primary_http"}:
            raise ValueError("Probe history provider mismatch")
        if name in CAPABILITY_PROBES and attempts[0]["ok"]:
            raise ValueError("Capability failure history cannot assert success")
        if any(a["ok"] != (a["classification"] == "dependency_ok") for a in attempts):
            raise ValueError("Inconsistent probe history outcome")
        if len(attempts) == 2 and (
            attempts[0]["ok"] or attempts[0]["classification"] != "provider_unavailable"
        ):
            raise ValueError("Invalid probe retry lineage")
        recovered = len(attempts) == 2 and attempts[-1]["ok"]
        if "recovered_after_retry" in row and row["recovered_after_retry"] is not recovered:
            raise ValueError("Unproven probe recovery")
        clean = {"probe": name, "attempts": attempts}
        if recovered:
            clean["recovered_after_retry"] = True
        result.append(clean)
    return result


def _azure_capability_failures(values: list[dict]) -> list[dict]:
    terminals = [value for value in values if "capability_failures" in value]
    if not terminals:
        return []
    if (
        len(terminals) != 1
        or terminals[0].get("azure_pwm_runtime_probe_result") != "failed"
        or type(terminals[0].get("attempt")) is not int
        or terminals[0]["attempt"] != 1
    ):
        raise ValueError("Ambiguous Azure capability failure history")
    failures = terminals[0]["capability_failures"]
    if not isinstance(failures, list) or not 1 <= len(failures) <= len(CAPABILITY_PROBES):
        raise ValueError("Invalid Azure capability failures")
    history = []
    for failure in failures:
        if not isinstance(failure, dict):
            raise ValueError("Invalid Azure capability failure")
        name = failure.get("capability")
        if not isinstance(name, str) or "capability:" + name not in CAPABILITY_PROBES:
            raise ValueError("Invalid Azure failure capability")
        history.append(
            {
                "probe": "capability:" + name,
                "attempts": [
                    {
                        "ok": False,
                        **{
                            key: failure.get(key)
                            for key in ("classification", "error_type", "elapsed_ms")
                        },
                    }
                ],
            }
        )
    return history


def execution_diagnostics(provider: str, values: list[dict]) -> dict:
    """Called only after the collector binds the exact candidate job execution."""
    history, result = [], {}
    if provider == "vertex":
        verdicts = [v for v in values if v.get("check") == "managed_vertex_runtime"]
        if len(verdicts) != 1:
            return result
        probes = [p for p in verdicts[0].get("probes", []) if isinstance(p, dict)]
        result["capability_classifications"] = {
            p["probe"]: p.get("classification", "unverified")
            for p in probes
            if isinstance(p.get("probe"), str)
        }
        result["capabilities"] = {
            p["probe"]: p.get("ok") is True for p in probes if isinstance(p.get("probe"), str)
        }
        for p in probes:
            if "attempts" in p:
                attempts = _attempt_receipts(p["attempts"])
                if _decision_fields(p) != _decision_fields(attempts[-1]):
                    raise ValueError("Probe terminal outcome differs from its last attempt")
                history.append({"probe": p["probe"], "attempts": attempts})
    else:
        stages = [v for v in values if v.get("azure_pwm_runtime_probe_stage") == "primary_http"]
        if len(stages) > 1:
            raise ValueError("Ambiguous Azure readiness history")
        if len(stages) == 1 and "elapsed_ms" in stages[0]:
            stage = stages[0]
            attempt = {
                "ok": stage.get("result") == "ok",
                "classification": stage.get("classification", "dependency_ok"),
                "elapsed_ms": stage["elapsed_ms"],
            }
            for key in ("error_type", "failure_stage"):
                if key in stage:
                    attempt[key] = stage[key]
            history.append({"probe": "primary_http", "attempts": [attempt]})
        history.extend(_azure_capability_failures(values))
    if history:
        result["probe_history"] = sanitize_probe_history(history, provider=provider)
    return result


def verified_diagnostics(value: dict, *, provider: str) -> dict:
    if "probe_history" not in value:
        return {}
    return {"probe_history": sanitize_probe_history(value["probe_history"], provider=provider)}


def readiness_diagnostics(value: dict, *, provider: str, valid: bool, ready: bool) -> dict:
    return {
        "ready": ready,
        "reason": value.get("reason", "unverified") if valid else "missing_or_misbound",
        "capabilities": value.get("capabilities", {}) if valid else {},
        "classifications": value.get("capability_classifications", {}) if valid else {},
        **(
            verified_diagnostics(value, provider=provider)
            if valid and value.get("verified") is True
            else {}
        ),
    }


def _valid_result(value: object) -> bool:
    return (
        isinstance(value, dict)
        and value.get("ready") is True
        and type(value.get("elapsed_ms")) is int
        and 0 <= value["elapsed_ms"] <= 65_000
        and set(value)
        <= {
            "ready",
            "elapsed_ms",
            "cited_sources",
            "fresh_page_retrieval_claimed",
            "http_receipts",
            "audio_bytes",
            "sample_rate",
            "chunks",
            "synthetic_phrase_verified",
            "dimensions",
            "function_round_trip",
            "input_sample_rate",
            "input_transcription_verified",
            "synthetic_content_verified",
            "streaming_observed",
            "steps",
            "tools_sent",
        }
        and all(
            type(item) is bool
            if key
            in {
                "ready",
                "fresh_page_retrieval_claimed",
                "synthetic_phrase_verified",
                "function_round_trip",
                "input_transcription_verified",
                "synthetic_content_verified",
                "streaming_observed",
            }
            else type(item) is int and 0 <= item <= 10_000_000
            for key, item in value.items()
        )
    )


def _valid_compact_search(value: dict) -> bool:
    return (
        value.get("cited_sources", 0) > 0
        and value.get("fresh_page_retrieval_claimed") is False
        and value.get("synthetic_content_verified") is True
    )


def valid_capabilities(
    proof: object, provider: str, expected: dict, document: dict, *, generation: str
) -> bool:
    if not isinstance(proof, dict) or set(proof) != {
        "schema",
        "provider",
        "config_fingerprint",
        "policy_generation",
        "synthetic_only",
        "capabilities",
        "ready",
        "elapsed_ms",
    }:
        return False
    policy = document["managed_runtime_uat"]
    capabilities = proof["capabilities"]
    return (
        proof["schema"] == "managed_capabilities_probe.v1"
        and proof["provider"] == provider
        and proof["synthetic_only"] is True
        and proof["ready"] is True
        and proof["config_fingerprint"] == expected["config_fingerprint"]
        and proof["policy_generation"] == generation
        and type(proof["elapsed_ms"]) is int
        and 0 <= proof["elapsed_ms"] <= 600_000
        and isinstance(capabilities, dict)
        and set(capabilities) == set(policy["required_capabilities"])
        and all(_valid_result(value) for value in capabilities.values())
        and all(
            capabilities[name].get("synthetic_content_verified") is True
            for name in ("structured_text", "image_input", "pdf_input")
        )
        and capabilities["structured_text"].get("streaming_observed") is True
        and capabilities["public_search"].get("cited_sources", 0) > 0
        and capabilities["public_search"].get("fresh_page_retrieval_claimed") is False
        and (
            "compact_public_search" not in policy["required_capabilities"]
            or _valid_compact_search(capabilities["compact_public_search"])
        )
        and (
            "one_text_root" not in policy["required_capabilities"]
            or (
                capabilities["one_text_root"].get("synthetic_content_verified") is True
                and capabilities["one_text_root"].get("streaming_observed") is True
                and capabilities["one_text_root"].get("function_round_trip") is True
                and capabilities["one_text_root"].get("steps") == 2
                and capabilities["one_text_root"].get("tools_sent", 0) >= 60
            )
        )
        and capabilities["public_source"].get("http_receipts") == 1
        and capabilities["location_transcription"].get("synthetic_phrase_verified") is True
        and capabilities["location_semantics"].get("steps") == 1
        and capabilities["narration"].get("audio_bytes", 0) > 0
        and capabilities["narration"].get("chunks", 0) > 0
        and capabilities["narration"].get("sample_rate") == 24000
        and capabilities["live_audio"].get("audio_bytes", 0) > 0
        and capabilities["live_audio"].get("sample_rate") == 24000
        and capabilities["live_audio"].get("input_sample_rate") == 16000
        and capabilities["live_audio"].get("function_round_trip") is True
        and capabilities["live_audio"].get("input_transcription_verified") is True
        and capabilities["embeddings"].get("dimensions") == 768
    )
