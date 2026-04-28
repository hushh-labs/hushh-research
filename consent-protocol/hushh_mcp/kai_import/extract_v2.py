"""Streaming extraction helpers for Kai portfolio import V2."""

from __future__ import annotations

import asyncio
import json
import math
import re
import time
from typing import Any, AsyncGenerator


class ImportStrictParseError(ValueError):
    """Raised when strict JSON parsing/schema checks fail for import extraction."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def is_retryable_extract_error(exc: Exception) -> bool:
    raw = str(exc or "").lower()
    if not raw:
        return False
    retryable_markers = (
        "429",
        "too many requests",
        "resource exhausted",
        "timeout",
        "timed out",
        "connection",
        "temporarily unavailable",
    )
    return any(marker in raw for marker in retryable_markers)


def _to_object(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    raise ImportStrictParseError("IMPORT_JSON_INVALID", "Model response is not a JSON object.")


def parse_json_strict_v2(
    raw_text: str,
    *,
    required_keys: set[str] | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    candidate = str(raw_text or "").strip()
    if not candidate:
        raise ImportStrictParseError("IMPORT_JSON_INVALID", "Empty model response.")

    try:
        parsed = _to_object(json.loads(candidate))
    except json.JSONDecodeError as exc:
        raise ImportStrictParseError(
            "IMPORT_JSON_INVALID",
            f"Model returned invalid JSON: {exc.msg}",
        ) from exc

    if required_keys:
        missing = sorted(k for k in required_keys if k not in parsed)
        extra = sorted(k for k in parsed if k not in required_keys)
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
        "mode": "strict_json_only",
        "raw_length": len(candidate),
        "repair_attempted": False,
        "repair_applied": False,
        "repair_actions": [],
    }
    return parsed, diagnostics


def _phase_progress_bounds_v2(phase: str) -> tuple[float, float]:
    ranges: dict[str, tuple[float, float]] = {
        "extract_full": (3.0, 78.0),
        "normalizing": (78.0, 92.0),
        "validating": (92.0, 99.0),
    }
    return ranges.get(phase, (0.0, 100.0))


def _phase_progress_from_chunks_v2(phase: str, chunk_count: int) -> float:
    start, end = _phase_progress_bounds_v2(phase)
    if chunk_count <= 0:
        return start
    span = max(1.0, end - start)
    return min(end, start + min(span, math.log1p(max(chunk_count, 1)) * (span / 2.4)))


def _parse_live_number(raw: Any) -> float | None:
    if raw is None:
        return None
    if isinstance(raw, bool):
        return None
    if isinstance(raw, (int, float)):
        value = float(raw)
        return value if math.isfinite(value) else None
    text = str(raw).strip()
    if not text:
        return None
    negative = text.startswith("(") and text.endswith(")")
    cleaned = (
        text.replace(",", "")
        .replace("$", "")
        .replace("%", "")
        .replace("(", "")
        .replace(")", "")
        .strip()
    )
    if not cleaned:
        return None
    try:
        value = float(cleaned)
    except Exception:
        return None
    if not math.isfinite(value):
        return None
    return -value if negative else value


def _normalize_symbol(value: Any) -> str:
    return re.sub(r"[^A-Z0-9.\-]", "", str(value or "").upper()).strip()


def _normalize_text(value: Any) -> str:
    return str(value or "").strip()


def _extract_confirmed_holding_objects_from_stream(
    full_response: str,
    *,
    max_items: int = 80,
) -> list[dict[str, Any]]:
    """Extract fully-closed holding JSON objects from detailed_holdings stream text."""
    if max_items <= 0:
        return []

    lower = full_response.lower()
    key_idx = lower.find('"detailed_holdings"')
    if key_idx < 0:
        return []

    array_start = full_response.find("[", key_idx)
    if array_start < 0:
        return []

    out: list[dict[str, Any]] = []
    in_string = False
    escape = False
    object_depth = 0
    object_start: int | None = None

    for idx in range(array_start + 1, len(full_response)):
        ch = full_response[idx]

        if escape:
            escape = False
            continue
        if ch == "\\" and in_string:
            escape = True
            continue
        if ch == '"':
            in_string = not in_string
            continue
        if in_string:
            continue

        if object_start is None:
            if ch == "]":
                break
            if ch == "{":
                object_start = idx
                object_depth = 1
            continue

        if ch == "{":
            object_depth += 1
            continue
        if ch == "}":
            object_depth -= 1
            if object_depth == 0 and object_start is not None:
                snippet = full_response[object_start : idx + 1]
                object_start = None
                try:
                    parsed = json.loads(snippet)
                except Exception:
                    continue
                if isinstance(parsed, dict):
                    out.append(parsed)
                    if len(out) >= max_items:
                        break

    return out


def _build_holdings_preview_from_objects(
    objects: list[dict[str, Any]],
    *,
    max_items: int = 40,
) -> list[dict[str, Any]]:
    if max_items <= 0:
        return []
    preview: list[dict[str, Any]] = []
    seen: set[str] = set()

    for row in objects:
        symbol = _normalize_symbol(
            row.get("symbol")
            or row.get("ticker")
            or row.get("symbol_cusip")
            or row.get("cusip")
            or row.get("security_id")
            or row.get("security")
        )
        name = _normalize_text(
            row.get("name")
            or row.get("description")
            or row.get("security_name")
            or row.get("holding_name")
            or row.get("security_description")
        )
        quantity = _parse_live_number(
            row.get("quantity") or row.get("shares") or row.get("units") or row.get("qty")
        )
        market_value = _parse_live_number(
            row.get("market_value")
            or row.get("current_value")
            or row.get("marketValue")
            or row.get("value")
            or row.get("position_value")
        )
        asset_type = _normalize_text(
            row.get("asset_type")
            or row.get("asset_class")
            or row.get("security_type")
            or row.get("type")
        )

        if not symbol and not name:
            continue
        fingerprint = f"{symbol}|{name.lower()}|{quantity}|{market_value}|{asset_type.lower()}"
        if fingerprint in seen:
            continue
        seen.add(fingerprint)

        preview.append(
            {
                "symbol": symbol,
                "name": name or None,
                "quantity": quantity,
                "market_value": market_value,
                "asset_type": asset_type or None,
            }
        )
        if len(preview) >= max_items:
            break

    return preview


def _build_pass_contents_v2(
    *,
    types_module: Any,
    prompt: str,
    content: bytes,
    is_csv_upload: bool,
    context_excerpt: str,
    excerpt_confidence: float,
) -> tuple[list[Any], str]:
    upload_mime_type = "text/csv" if is_csv_upload else "application/pdf"
    parts: list[Any] = [types_module.Part.from_text(text=prompt)]

    use_excerpt = bool(context_excerpt.strip())
    if use_excerpt:
        parts.append(
            types_module.Part.from_text(
                text=("Statement excerpt (deterministic page filter):\n" + context_excerpt.strip())
            )
        )

    include_full_document = is_csv_upload or (not use_excerpt) or excerpt_confidence < 0.35
    if include_full_document:
        parts.append(types_module.Part.from_bytes(data=content, mime_type=upload_mime_type))
        source = "full_document"
    else:
        source = "excerpt_only"

    return parts, source


async def run_stream_pass_v2(
    *,
    request: Any,
    stream: Any,
    client: Any,
    types_module: Any,
    model_name: str,
    prompt: str,
    context_excerpt: str,
    context_confidence: float,
    stage_message: str,
    progress_message: str,
    include_holdings_preview: bool,
    result_store: dict[str, Any],
    content: bytes,
    is_csv_upload: bool,
    temperature: float,
    max_output_tokens: int,
    thinking_enabled: bool,
    thinking_level_raw: str,
    heartbeat_interval_seconds: float,
    phase: str = "extract_full",
    required_keys: set[str] | None = None,
) -> AsyncGenerator[dict[str, str], None]:
    contents, content_source = _build_pass_contents_v2(
        types_module=types_module,
        prompt=prompt,
        content=content,
        is_csv_upload=is_csv_upload,
        context_excerpt=context_excerpt,
        excerpt_confidence=context_confidence,
    )

    config_kwargs: dict[str, Any] = {
        "temperature": temperature,
        "max_output_tokens": max_output_tokens,
        "response_mime_type": "application/json",
        "automatic_function_calling": types_module.AutomaticFunctionCallingConfig(disable=True),
    }
    if thinking_enabled:
        thinking_level = getattr(
            types_module.ThinkingLevel,
            str(thinking_level_raw or "LOW").upper(),
            types_module.ThinkingLevel.LOW,
        )
        config_kwargs["thinking_config"] = types_module.ThinkingConfig(
            include_thoughts=False,
            thinking_level=thinking_level,
        )

    config = types_module.GenerateContentConfig(**config_kwargs)

    yield stream.event(
        "stage",
        {
            "stage": "extracting",
            "phase": phase,
            "message": stage_message,
            "progress_pct": _phase_progress_bounds_v2(phase)[0],
        },
    )

    pass_started = time.perf_counter()
    response_text = ""
    chunk_count = 0
    latest_holdings_preview: list[dict[str, Any]] = []
    streamed_holdings_confirmed = 0
    loop_started_at = asyncio.get_running_loop().time()
    last_progress_emit_at = loop_started_at

    gen_stream = await client.aio.models.generate_content_stream(
        model=model_name,
        contents=contents,
        config=config,
    )
    stream_iter = gen_stream.__aiter__()
    next_chunk_task: asyncio.Task | None = None

    while True:
        if await request.is_disconnected():
            if next_chunk_task and not next_chunk_task.done():
                next_chunk_task.cancel()
            result_store["client_disconnected"] = True
            return

        try:
            if next_chunk_task is None:
                next_chunk_task = asyncio.create_task(stream_iter.__anext__())
            chunk = await asyncio.wait_for(
                asyncio.shield(next_chunk_task),
                timeout=heartbeat_interval_seconds,
            )
            next_chunk_task = None
        except asyncio.TimeoutError:
            elapsed_seconds = int(asyncio.get_running_loop().time() - loop_started_at)
            heartbeat_message = "Still reviewing your statement..."
            yield stream.event(
                "stage",
                {
                    "stage": "extracting",
                    "phase": phase,
                    "message": heartbeat_message,
                    "heartbeat": True,
                    "elapsed_seconds": elapsed_seconds,
                    "chunk_count": chunk_count,
                    "total_chars": len(response_text),
                    "progress_pct": _phase_progress_from_chunks_v2(phase, chunk_count),
                },
            )
            continue
        except StopAsyncIteration:
            next_chunk_task = None
            break

        appended_response_text = False
        if hasattr(chunk, "candidates") and chunk.candidates:
            candidate = chunk.candidates[0]
            if hasattr(candidate, "content") and candidate.content:
                parts = getattr(candidate.content, "parts", None) or []
                for part in parts:
                    part_text = str(getattr(part, "text", "") or "")
                    if not part_text:
                        continue
                    # Import stream is investor-facing; never emit thought chunks.
                    if bool(getattr(part, "thought", False)):
                        continue
                    response_text += part_text
                    chunk_count += 1
                    appended_response_text = True

                    if include_holdings_preview:
                        confirmed_objects = _extract_confirmed_holding_objects_from_stream(
                            response_text,
                            max_items=80,
                        )
                        streamed_holdings_confirmed = len(confirmed_objects)
                        latest_holdings_preview = _build_holdings_preview_from_objects(
                            confirmed_objects,
                            max_items=40,
                        )

                    yield stream.event(
                        "chunk",
                        {
                            "phase": phase,
                            "text": part_text,
                            "total_chars": len(response_text),
                            "chunk_count": chunk_count,
                            "token_source": "response",
                            "holdings_detected": streamed_holdings_confirmed,
                            "holdings_preview": latest_holdings_preview,
                            "progress_pct": _phase_progress_from_chunks_v2(phase, chunk_count),
                        },
                    )

        if not appended_response_text and getattr(chunk, "text", None):
            text_chunk = str(chunk.text)
            response_text += text_chunk
            chunk_count += 1
            if include_holdings_preview:
                confirmed_objects = _extract_confirmed_holding_objects_from_stream(
                    response_text,
                    max_items=80,
                )
                streamed_holdings_confirmed = len(confirmed_objects)
                latest_holdings_preview = _build_holdings_preview_from_objects(
                    confirmed_objects,
                    max_items=40,
                )
            yield stream.event(
                "chunk",
                {
                    "phase": phase,
                    "text": text_chunk,
                    "total_chars": len(response_text),
                    "chunk_count": chunk_count,
                    "token_source": "response",
                    "holdings_detected": streamed_holdings_confirmed,
                    "holdings_preview": latest_holdings_preview,
                    "progress_pct": _phase_progress_from_chunks_v2(phase, chunk_count),
                },
            )

        now = asyncio.get_running_loop().time()
        if chunk_count > 1 and (now - last_progress_emit_at) >= heartbeat_interval_seconds:
            last_progress_emit_at = now
            yield stream.event(
                "progress",
                {
                    "phase": phase,
                    "message": "Still reviewing your statement...",
                    "chunk_count": chunk_count,
                    "total_chars": len(response_text),
                    "holdings_detected": streamed_holdings_confirmed,
                    "holdings_preview": latest_holdings_preview,
                    "progress_pct": _phase_progress_from_chunks_v2(phase, chunk_count),
                },
            )

    if not response_text.strip():
        raise ImportStrictParseError("IMPORT_JSON_INVALID", "Empty model response from extractor.")

    parsed_payload, pass_parse_diagnostics = parse_json_strict_v2(
        response_text,
        required_keys=required_keys,
    )

    pass_elapsed_ms = int((time.perf_counter() - pass_started) * 1000)
    result_store.update(
        {
            "phase": phase,
            "source": content_source,
            "parsed": parsed_payload,
            "text": response_text,
            "chunk_count": chunk_count,
            "thought_count": 0,
            "elapsed_ms": pass_elapsed_ms,
            "holdings_detected": streamed_holdings_confirmed,
            "holdings_preview": latest_holdings_preview,
            "parse_diagnostics": pass_parse_diagnostics,
        }
    )

    yield stream.event(
        "stage",
        {
            "stage": "extracting",
            "phase": phase,
            "message": f"{phase.replace('_', ' ').title()} pass complete ({chunk_count} chunks)",
            "chunk_count": chunk_count,
            "thought_count": 0,
            "total_chars": len(response_text),
            "holdings_detected": streamed_holdings_confirmed,
            "holdings_preview": latest_holdings_preview,
            "content_source": content_source,
            "duration_ms": pass_elapsed_ms,
            "progress_pct": _phase_progress_bounds_v2(phase)[1],
        },
    )
