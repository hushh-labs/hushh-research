"""Strict JSON parse contract tests for Kai import extraction V2."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from hushh_mcp.kai_import.extract_v2 import (
    ImportStrictParseError,
    parse_json_strict_v2,
    run_stream_pass_v2,
)


def test_parse_json_strict_v2_rejects_invalid_json() -> None:
    with pytest.raises(ImportStrictParseError) as exc:
        parse_json_strict_v2('{"a": 1', required_keys={"a"})
    assert exc.value.code == "IMPORT_JSON_INVALID"


def test_parse_json_strict_v2_rejects_schema_mismatch() -> None:
    with pytest.raises(ImportStrictParseError) as exc:
        parse_json_strict_v2('{"a": 1, "extra": 2}', required_keys={"a"})
    assert exc.value.code == "IMPORT_SCHEMA_INVALID"


def test_parse_json_strict_v2_accepts_exact_required_shape() -> None:
    parsed, diagnostics = parse_json_strict_v2('{"a": 1, "b": []}', required_keys={"a", "b"})
    assert parsed == {"a": 1, "b": []}
    assert diagnostics["mode"] == "strict_json_only"


def test_parse_json_strict_v2_accepts_first_object_when_model_appends_extra_data() -> None:
    parsed, diagnostics = parse_json_strict_v2(
        '{"a": 1, "b": []}\n{"a": 2, "b": []}',
        required_keys={"a", "b"},
    )
    assert parsed == {"a": 1, "b": []}
    assert diagnostics["mode"] == "strict_json_with_extra_data_repair"
    assert diagnostics["repair_applied"] is True
    assert diagnostics["repair_actions"] == [
        "accepted_first_json_object",
        "discarded_trailing_content",
    ]


def test_run_stream_pass_v2_emits_thinking_without_polluting_json_response() -> None:
    async def run_case() -> tuple[list[dict[str, object]], dict[str, object], object]:
        events: list[dict[str, object]] = []
        result_store: dict[str, object] = {}

        class FakeRequest:
            async def is_disconnected(self) -> bool:
                return False

        class FakeStream:
            def event(
                self,
                event: str,
                payload: dict[str, object],
                *,
                terminal: bool = False,
            ) -> dict[str, object]:
                events.append({"event": event, "payload": payload, "terminal": terminal})
                return events[-1]

        class FakePart:
            @staticmethod
            def from_text(*, text: str) -> dict[str, str]:
                return {"text": text}

            @staticmethod
            def from_bytes(*, data: bytes, mime_type: str) -> dict[str, object]:
                return {"data": data, "mime_type": mime_type}

        class FakeThinkingConfig:
            def __init__(self, **kwargs: object) -> None:
                self.kwargs = kwargs

        class FakeGenerateContentConfig:
            def __init__(self, **kwargs: object) -> None:
                self.kwargs = kwargs

        fake_types = SimpleNamespace(
            AutomaticFunctionCallingConfig=lambda **kwargs: kwargs,
            GenerateContentConfig=FakeGenerateContentConfig,
            Part=FakePart,
            ThinkingConfig=FakeThinkingConfig,
            ThinkingLevel=SimpleNamespace(LOW="LOW"),
        )

        chunks = [
            SimpleNamespace(
                candidates=[
                    SimpleNamespace(
                        content=SimpleNamespace(
                            parts=[
                                SimpleNamespace(
                                    text="Found the quantity column before the value column.",
                                    thought=True,
                                )
                            ]
                        )
                    )
                ]
            ),
            SimpleNamespace(
                candidates=[
                    SimpleNamespace(
                        content=SimpleNamespace(
                            parts=[
                                SimpleNamespace(text='{"a": 1}', thought=False),
                            ]
                        )
                    )
                ]
            ),
        ]

        class FakeAsyncStream:
            def __init__(self) -> None:
                self._index = 0

            def __aiter__(self) -> "FakeAsyncStream":
                return self

            async def __anext__(self) -> object:
                if self._index >= len(chunks):
                    raise StopAsyncIteration
                chunk = chunks[self._index]
                self._index += 1
                return chunk

        class FakeModels:
            def __init__(self) -> None:
                self.config: object | None = None

            async def generate_content_stream(self, **kwargs: object) -> FakeAsyncStream:
                self.config = kwargs["config"]
                return FakeAsyncStream()

        fake_models = FakeModels()
        fake_client = SimpleNamespace(aio=SimpleNamespace(models=fake_models))

        async for _ in run_stream_pass_v2(
            request=FakeRequest(),
            stream=FakeStream(),
            client=fake_client,
            types_module=fake_types,
            model_name="gemini-3.5-flash",
            prompt="extract",
            context_excerpt="",
            context_confidence=0.0,
            stage_message="Extracting...",
            progress_message="Streaming",
            include_holdings_preview=False,
            result_store=result_store,
            content=b"symbol,qty",
            is_csv_upload=True,
            temperature=0.0,
            max_output_tokens=128,
            thinking_enabled=True,
            thinking_level_raw="LOW",
            heartbeat_interval_seconds=30.0,
            required_keys={"a"},
        ):
            pass

        assert fake_models.config is not None
        return events, result_store, fake_models.config

    events, result_store, config = asyncio.run(run_case())
    thinking_events = [event for event in events if event["event"] == "thinking"]
    chunk_events = [event for event in events if event["event"] == "chunk"]

    assert len(thinking_events) == 1
    assert thinking_events[0]["payload"]["token_source"] == "thought"  # noqa: S105
    assert len(chunk_events) == 1
    assert chunk_events[0]["payload"]["text"] == '{"a": 1}'
    assert result_store["text"] == '{"a": 1}'
    assert result_store["thought_count"] == 1

    thinking_config = config.kwargs["thinking_config"]
    assert thinking_config.kwargs["include_thoughts"] is True
