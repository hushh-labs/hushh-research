"""Pinned embedding behavior and the public startup admission privacy boundary."""

import io
import json
import logging
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from hushh_mcp.services.drive_document_parser import MAX_TEXT_BYTES, ParsedText
from hushh_mcp.services.drive_document_processor import (
    IsolatedDocumentEmbedding,
    PrivateDocumentEmbedding,
)
from hushh_mcp.services.google_drive_adapter import DriveReadError
from mcp_modules.log_redaction import SensitiveLogFilter


@pytest.fixture
def runtime_redacted_logs(caplog):
    redactor = SensitiveLogFilter()
    caplog.handler.addFilter(redactor)
    try:
        yield caplog
    finally:
        caplog.handler.removeFilter(redactor)


@pytest.mark.parametrize("baked", [True, False])
def test_embedding_client_prefers_the_baked_model_and_never_the_hub(monkeypatch, tmp_path, baked):
    # UAT 2026-09-27: the default client loaded the hub name, so a new backend
    # instance called Hugging Face on its first turn; a 429 aborted the process.
    import sys

    from hushh_mcp.services import embedding_client_leaf as leaf

    calls = []
    fake = SimpleNamespace(SentenceTransformer=lambda source, **kw: calls.append((source, kw)))
    monkeypatch.setitem(sys.modules, "sentence_transformers", fake)
    monkeypatch.setattr(leaf, "BAKED_MODEL_DIR", str(tmp_path))
    monkeypatch.setenv(leaf.BAKED_MODEL_DIR_ENV, str(tmp_path if baked else tmp_path / "missing"))

    leaf.EmbeddingClient()._load()

    source, kwargs = calls[0]
    if baked:
        assert (source, kwargs["local_files_only"]) == (str(tmp_path), True)
    else:  # no baked copy (local development): the pinned hub revision, as before
        assert (source, kwargs["local_files_only"]) == (leaf.MODEL_ID, False)
    assert kwargs["revision"] == leaf.MODEL_REVISION


def test_embedding_chunks_never_silently_drop_unicode_or_exceed_token_budget(monkeypatch):
    embedder = PrivateDocumentEmbedding()
    model = SimpleNamespace(
        tokenizer=SimpleNamespace(encode=lambda value, **kwargs: list(range(len(value) * 3)))
    )
    monkeypatch.setattr(embedder, "_load", lambda: model)
    captured = []

    def vectors(passages):
        captured.extend(passages)
        return [[1.0] + [0.0] * 383 for _ in passages]

    monkeypatch.setattr(embedder, "embed_passages", vectors)
    text = "₹abc" * 600
    prepared = embedder.prepare(ParsedText((text,)))
    assert "".join(captured) == text
    assert all(len("passage: " + part) * 3 <= 480 for part in captured)
    assert not prepared.truncated
    for chunk in prepared.chunks:
        assert text[chunk.start : chunk.end] == chunk.text
    assert embedder.local_files_only


def test_embedding_chunk_cap_reports_truncation(monkeypatch):
    embedder = PrivateDocumentEmbedding()
    monkeypatch.setattr(
        embedder,
        "_load",
        lambda: SimpleNamespace(
            tokenizer=SimpleNamespace(encode=lambda value, **kwargs: list(value))
        ),
    )
    monkeypatch.setattr(
        embedder, "embed_passages", lambda values: [[1.0] + [0.0] * 383 for _ in values]
    )
    result = embedder.prepare(ParsedText(("x" * MAX_TEXT_BYTES,)))
    assert len(result.chunks) == 128
    assert result.truncated


@pytest.mark.parametrize(
    ("operation", "payload", "accepted"),
    [
        ("query", {"query": "synthetic private query"}, True),
        ("query", {"query": "synthetic statement"}, True),
        ("admit", {"query": "synthetic statement"}, True),
        ("admit", {"query": "synthetic private query"}, False),
        ("admit", {"query": "synthetic statement", "extra": "private"}, False),
    ],
)
def test_embedding_child_only_profiles_the_exact_public_admission(
    monkeypatch, tmp_path, capsys, operation, payload, accepted
):
    from hushh_mcp.services import drive_document_embedding as child
    from hushh_mcp.services import embedding_client_leaf as leaf

    encode = Mock(return_value=SimpleNamespace(tolist=lambda: [1.0] + [0.0] * 383))
    model = SimpleNamespace(tokenizer=SimpleNamespace(encode=lambda *_a, **_k: [1]), encode=encode)
    monkeypatch.setitem(
        sys.modules,
        "sentence_transformers",
        SimpleNamespace(SentenceTransformer=lambda *_a, **_k: model),
    )
    monkeypatch.setitem(
        sys.modules,
        "torch",
        SimpleNamespace(set_num_threads=Mock(), set_num_interop_threads=Mock()),
    )
    monkeypatch.setattr(
        child,
        "resource",
        SimpleNamespace(setrlimit=Mock(), RLIMIT_CORE=0, RLIMIT_CPU=1, RLIMIT_AS=2),
    )
    monkeypatch.setattr(leaf, "BAKED_MODEL_DIR", str(tmp_path))
    monkeypatch.setenv(leaf.BAKED_MODEL_DIR_ENV, str(tmp_path))
    monkeypatch.setattr(sys, "argv", ["drive_document_embedding.py", operation])
    monkeypatch.setattr(
        sys, "stdin", SimpleNamespace(buffer=io.BytesIO(json.dumps(payload).encode()))
    )

    child.main()

    result = json.loads(capsys.readouterr().out)
    if not accepted:
        assert result == {"error": "invalid_argument"}
        encode.assert_not_called()
        return
    assert result["profile"] == child.PROFILE
    assert result["embedding"] == [1.0] + [0.0] * 383
    encode.assert_called_once_with("query: " + payload["query"], normalize_embeddings=True)
    if operation == "query":
        assert set(result) == {"profile", "embedding"}
    else:
        assert set(result["admission_timings"]) == set(leaf.ADMISSION_TIMING_PHASES)
        assert all(
            type(value) is int and value >= 0
            for metrics in result["admission_timings"].values()
            for value in metrics.values()
        )


@pytest.mark.asyncio
@pytest.mark.feature_drive_packets
@pytest.mark.trace_loop
@pytest.mark.parametrize(
    "mode",
    ["private_query", "public_query", "admit", "startup_admit", "malformed", "invalid_vector"],
)
async def test_embedding_admission_logs_only_bounded_metrics_after_vector_validation(
    monkeypatch, runtime_redacted_logs, mode
):
    from hushh_mcp.services import drive_document_processor as processor
    from hushh_mcp.services.embedding_client_leaf import ADMISSION_TIMING_PHASES

    metrics = {phase: {"wall_ms": 10, "cpu_ms": 5} for phase in ADMISSION_TIMING_PHASES}
    if mode == "startup_admit":
        metrics["model_load"]["wall_ms"] = 120_000
    result = {
        "profile": processor.PROFILE,
        "embedding": [1.0] + [0.0] * 383,
        "admission_timings": metrics,
    }
    if mode == "malformed":
        result["admission_timings"] = {"synthetic private field": {"wall_ms": True}}
    if mode == "invalid_vector":
        result["embedding"] = [0.0] * 384
    process = AsyncMock(return_value=result)
    monkeypatch.setattr(processor, "_private_process", process)
    caplog = runtime_redacted_logs
    caplog.set_level(logging.INFO, logger=processor.__name__)
    embedding = IsolatedDocumentEmbedding()

    if mode == "invalid_vector":
        with pytest.raises(DriveReadError, match="^processor_unavailable$"):
            await embedding.admit()
    elif mode.endswith("query"):
        query = "synthetic private query" if mode == "private_query" else "synthetic statement"
        assert await embedding.query(query) == tuple(result["embedding"])
    elif mode == "startup_admit":
        assert await embedding.admit(timeout=170) is None
    else:
        assert await embedding.admit() is None
    messages = [record.message for record in caplog.records if record.name == processor.__name__]
    if mode in {"admit", "startup_admit"}:
        assert messages == [
            f"drive_worker_embedding_admission phase={phase} "
            f"wall_ms={metrics[phase]['wall_ms']} cpu_ms={metrics[phase]['cpu_ms']}"
            for phase in ADMISSION_TIMING_PHASES
        ]
    elif mode == "malformed":
        assert messages == ["drive_worker_embedding_admission timings=unavailable"]
    else:
        assert messages == []
    operation = "query" if mode.endswith("query") else "admit"
    assert process.await_args.args[1] == operation
    assert process.await_args.kwargs == {
        "timeout": 170 if mode == "startup_admit" else 100,
        "limit": 16384,
    }


@pytest.mark.asyncio
async def test_admission_observer_failure_cannot_change_model_or_readiness(monkeypatch):
    from hushh_mcp.services import drive_document_processor as processor
    from hushh_mcp.services import embedding_client_leaf as leaf

    monkeypatch.setattr(
        leaf, "monotonic_ns", Mock(side_effect=RuntimeError("synthetic clock failure"))
    )
    timings = leaf.EmbeddingAdmissionTimings()
    with timings.measure("encode"):
        pass
    with pytest.raises(ValueError, match="synthetic model failure"):
        with timings.measure("encode"):
            raise ValueError("synthetic model failure")
    monkeypatch.setattr(
        processor,
        "_private_process",
        AsyncMock(return_value={"profile": processor.PROFILE, "embedding": [1.0] + [0.0] * 383}),
    )
    monkeypatch.setattr(
        processor.logger, "info", Mock(side_effect=RuntimeError("synthetic log failure"))
    )
    assert await IsolatedDocumentEmbedding().admit() is None
