"""Strict statement JSON validation; compatibility exports stay in extract_v2."""

import json
from typing import Any

from .schema_v2 import FINANCIAL_STATEMENT_EXTRACT_V2_REQUIRED_KEYS


class ImportStrictParseError(ValueError):
    """Raised when strict JSON parsing/schema checks fail for import extraction."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _to_object(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    raise ImportStrictParseError("IMPORT_JSON_INVALID", "Model response is not a JSON object.")


def parse_json_strict_v2(
    raw_text: str,
    *,
    required_keys: set[str] | None = None,
    optional_keys: set[str] | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    candidate = str(raw_text or "").strip()
    if not candidate:
        raise ImportStrictParseError("IMPORT_JSON_INVALID", "Empty model response.")

    repair_actions: list[str] = []
    repair_applied = False
    try:
        parsed = _to_object(json.loads(candidate))
    except json.JSONDecodeError as exc:
        if exc.msg != "Extra data":
            raise ImportStrictParseError(
                "IMPORT_JSON_INVALID",
                f"Model returned invalid JSON: {exc.msg}",
            ) from exc

        try:
            parsed_value, parsed_end = json.JSONDecoder().raw_decode(candidate)
            parsed = _to_object(parsed_value)
        except json.JSONDecodeError as repair_exc:
            raise ImportStrictParseError(
                "IMPORT_JSON_INVALID",
                f"Model returned invalid JSON: {repair_exc.msg}",
            ) from repair_exc
        except ImportStrictParseError as repair_exc:
            raise repair_exc from exc

        trailing = candidate[parsed_end:].strip()
        if trailing:
            repair_applied = True
            repair_actions.extend(
                [
                    "accepted_first_json_object",
                    "discarded_trailing_content",
                ]
            )

    if required_keys:
        missing = sorted(k for k in required_keys if k not in parsed)
        extra = sorted(k for k in parsed if k not in required_keys | (optional_keys or set()))
        if missing or extra:
            fragments: list[str] = []
            if missing:
                fragments.append("missing keys: " + ", ".join(missing))
            if extra:
                fragments.append("unexpected keys: " + ", ".join(extra))
            raise ImportStrictParseError(
                "IMPORT_SCHEMA_INVALID",
                "Top-level schema mismatch (" + "; ".join(fragments) + ").",
            )

    diagnostics = {
        "mode": "strict_json_with_extra_data_repair" if repair_applied else "strict_json_only",
        "raw_length": len(candidate),
        "repair_attempted": repair_applied,
        "repair_applied": repair_applied,
        "repair_actions": repair_actions,
    }
    return parsed, diagnostics


def parse_statement_extraction(payload: dict[str, Any]) -> dict[str, Any]:
    parsed, _ = parse_json_strict_v2(
        json.dumps(payload, separators=(",", ":")),
        required_keys=FINANCIAL_STATEMENT_EXTRACT_V2_REQUIRED_KEYS,
        optional_keys={"historical_values"},
    )
    return parsed
