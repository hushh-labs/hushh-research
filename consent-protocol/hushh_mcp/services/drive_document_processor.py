"""Self-hosted private processing: local ClamAV, isolated parser, pinned E5.

No provider IDs, credentials or owner identifiers enter this interface. Models
must be baked into the worker image: runtime downloads and remote code are off.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import signal
import struct
import sys
from dataclasses import asdict
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Protocol
from weakref import WeakKeyDictionary

from hushh_mcp.services.document_index_service import (
    IndexedChunk,
    PreparedIndex,
)
from hushh_mcp.services.drive_document_embedding import (
    PROFILE,
    PUBLIC_ADMISSION_QUERY,
    prepare_payload,
)
from hushh_mcp.services.drive_document_pages import (
    MAX_BATCH_PAGES,
    MAX_SOURCE_BYTES,
    ExtractedPages,
)
from hushh_mcp.services.drive_document_parser import MAX_TEXT_BYTES, ParsedText
from hushh_mcp.services.drive_worker_limits import page_extraction_slots
from hushh_mcp.services.embedding_client_leaf import (
    ADMISSION_TIMING_PHASES,
    BAKED_MODEL_DIR,
    BAKED_MODEL_DIR_ENV,
    EmbeddingClient,
)
from hushh_mcp.services.google_drive_adapter import CONTENT_LIMIT, DriveReadError

PARSE_CODES = frozenset(
    {
        "file_too_large",
        "no_extractable_text",
        "invalid_document",
        "unsupported_format",
        "encrypted_document",
    }
)
_EMBEDDING_ADMISSION: WeakKeyDictionary = WeakKeyDictionary()
logger = logging.getLogger(__name__)


def _log_admission_timings(values: object, *, max_elapsed_ms: int) -> None:
    # The child response is untrusted. Only closed phase names and bounded
    # integers may enter logs, after the public probe's vector passed validation.
    if (
        not isinstance(values, dict)
        or set(values) != set(ADMISSION_TIMING_PHASES)
        or any(
            not isinstance(metrics, dict)
            or set(metrics) != {"wall_ms", "cpu_ms"}
            or any(
                type(value) is not int or not 0 <= value <= max_elapsed_ms
                for value in metrics.values()
            )
            for metrics in values.values()
        )
    ):
        # Diagnostics are not a new readiness gate.
        logger.info("drive_worker_embedding_admission timings=unavailable")
        return
    for phase in ADMISSION_TIMING_PHASES:
        logger.info(
            "drive_worker_embedding_admission phase=%s wall_ms=%d cpu_ms=%d",
            phase,
            values[phase]["wall_ms"],
            values[phase]["cpu_ms"],
        )


def _embedding_admission() -> asyncio.Semaphore:
    loop = asyncio.get_running_loop()
    if loop not in _EMBEDDING_ADMISSION:
        _EMBEDDING_ADMISSION[loop] = asyncio.Semaphore(1)
    return _EMBEDDING_ADMISSION[loop]


async def _private_process(
    leaf: str, argument: str, payload: bytes, *, timeout: int, limit: int
) -> dict:
    # Children do not inherit database credentials, Google tokens or cloud SDK
    # environment. Their only input is this bounded private byte stream.
    scripts = {
        "parser": "drive_document_parser.py",
        "embedding": "drive_document_embedding.py",
        "pages": "drive_document_pages.py",
    }
    if leaf not in scripts:
        raise DriveReadError("processor_unavailable")
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        str(Path(__file__).resolve().parent / scripts[leaf]),
        argument,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
        start_new_session=True,
        env={
            "PATH": os.defpath,
            "LANG": "C.UTF-8",
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHON_DOTENV_DISABLED": "1",
            "HF_HUB_OFFLINE": "1",
            "TRANSFORMERS_OFFLINE": "1",
            "HF_HUB_DISABLE_TELEMETRY": "1",
            BAKED_MODEL_DIR_ENV: BAKED_MODEL_DIR,
            "TOKENIZERS_PARALLELISM": "false",
            # Do not let native math libraries infer more threads than this
            # deliberately small, CPU-limited private child can sustain.
            "OMP_NUM_THREADS": "1",
            "MKL_NUM_THREADS": "1",
            "OPENBLAS_NUM_THREADS": "1",
            "NUMEXPR_NUM_THREADS": "1",
        },
    )

    async def write_input():
        if process.stdin is None:
            raise DriveReadError("processor_unavailable")
        process.stdin.write(payload)
        await process.stdin.drain()
        process.stdin.close()

    writer = asyncio.create_task(write_input())
    try:
        async with asyncio.timeout(timeout):
            if process.stdout is None:
                raise DriveReadError("processor_unavailable")
            output = await process.stdout.read(limit + 1)
            # StreamReader.read(n) may return early, so accumulate with a hard cap.
            while len(output) <= limit:
                part = await process.stdout.read(min(65536, limit + 1 - len(output)))
                if not part:
                    break
                output += part
            if len(output) > limit:
                raise DriveReadError("processor_unavailable")
            await writer
            await process.wait()
            if process.returncode:
                raise DriveReadError("processor_unavailable")
            result = json.loads(output)
            if not isinstance(result, dict):
                raise ValueError("invalid response")
            return result
    except (ValueError, BrokenPipeError, ConnectionResetError):
        raise DriveReadError("processor_unavailable") from None
    except TimeoutError:
        raise DriveReadError("processing_timeout", retryable=True) from None
    finally:
        if process.returncode is None:
            # Reap OCR descendants as well as the Python leaf on cancellation.
            if type(getattr(process, "pid", None)) is int and os.name == "posix":
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            else:
                process.kill()
        await process.wait()
        if not writer.done():
            writer.cancel()
        await asyncio.gather(writer, return_exceptions=True)


class Scanner(Protocol):
    async def scan(self, content: bytes, *, max_bytes: int = CONTENT_LIMIT) -> None: ...


class _StaleSignatures(DriveReadError):
    """Signatures outside the freshness window; reported as scanner_unavailable."""


class ClamAvScanner:
    """Fixed same-instance scanner, in-memory INSTREAM; unavailable fails closed."""

    MAX_SIGNATURE_AGE = timedelta(days=7)
    EICAR = b"X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"

    async def _require_fresh_signatures(self) -> None:
        writer = None
        try:
            async with asyncio.timeout(3):
                reader, writer = await asyncio.open_connection("127.0.0.1", 3310, limit=1024)
                writer.write(b"zVERSION\x00")
                await writer.drain()
                response = (await reader.readuntil(b"\x00")).decode("ascii").strip("\x00\r\n ")
            engine, revision, database_time = response.split("/", 2)
            if not engine.startswith("ClamAV ") or not revision.isdecimal():
                raise ValueError("invalid scanner version")
            built_at = datetime.strptime(database_time, "%a %b %d %H:%M:%S %Y").replace(tzinfo=UTC)
            age = datetime.now(UTC) - built_at
            if not -timedelta(days=1) <= age <= self.MAX_SIGNATURE_AGE:
                raise _StaleSignatures("scanner_unavailable", retryable=True)
        except _StaleSignatures:
            raise
        except Exception:
            raise DriveReadError("scanner_unavailable", retryable=True) from None
        finally:
            if writer is not None:
                writer.close()
                try:
                    await writer.wait_closed()
                except OSError:
                    pass

    async def check_ready(self) -> None:
        """Prove both recent signatures and real EICAR detection at startup."""
        try:
            await self.scan(self.EICAR)
        except _StaleSignatures:
            # clamd starts reading the image's baked database while freshclam is
            # still writing today's, and freshclam cannot notify a clamd whose
            # socket is not up yet. Once the baked set ages past the window every
            # new instance fails here, so ask clamd to reload what is on disk;
            # the caller's startup loop re-checks freshness afterwards.
            await self._request_reload()
            raise
        except DriveReadError as error:
            if str(error) == "unsafe_document":
                return
            raise
        raise DriveReadError("scanner_unavailable", retryable=True)

    async def _request_reload(self) -> None:
        """Best effort: freshness is re-proven by the next check, never assumed."""
        writer = None
        try:
            async with asyncio.timeout(3):
                reader, writer = await asyncio.open_connection("127.0.0.1", 3310, limit=1024)
                writer.write(b"zRELOAD\x00")
                await writer.drain()
                await reader.readuntil(b"\x00")
        except Exception:
            return
        finally:
            if writer is not None:
                writer.close()
                try:
                    await writer.wait_closed()
                except OSError:
                    pass

    async def scan(self, content: bytes, *, max_bytes: int = CONTENT_LIMIT) -> None:
        if (
            max_bytes not in {CONTENT_LIMIT, MAX_SOURCE_BYTES}
            or not content
            or len(content) > max_bytes
        ):
            raise DriveReadError("file_too_large")
        await self._require_fresh_signatures()
        writer = None
        try:
            async with asyncio.timeout(10):
                reader, writer = await asyncio.open_connection("127.0.0.1", 3310, limit=1024)
                writer.write(b"zINSTREAM\x00")
                for start in range(0, len(content), 65536):
                    chunk = content[start : start + 65536]
                    writer.write(struct.pack("!I", len(chunk)) + chunk)
                    await writer.drain()
                writer.write(b"\x00\x00\x00\x00")
                await writer.drain()
                response = await reader.readuntil(b"\x00")
                if response.endswith(b" FOUND\x00"):
                    raise DriveReadError("unsafe_document")
                if response != b"stream: OK\x00":
                    raise DriveReadError("scanner_unavailable", retryable=True)
        except DriveReadError:
            raise
        except Exception:
            raise DriveReadError("scanner_unavailable", retryable=True) from None
        finally:
            if writer is not None:
                writer.close()
                try:
                    await writer.wait_closed()
                except OSError:
                    pass


class IsolatedDocumentParser:
    def __init__(self, *, process=None):
        self._process = process or _private_process
        # Downloads may overlap more widely than memory-heavy parser children.
        self._parse_slots = asyncio.Semaphore(2)

    async def parse(
        self, *, content: bytes, mime_type: str, live: bool = False, raw_prefix: bool = False
    ) -> ParsedText:
        try:
            async with self._parse_slots:
                result = await self._process(
                    "parser",
                    ("prefix:" if raw_prefix else "live:" if live else "") + mime_type,
                    content,
                    timeout=25,
                    limit=MAX_TEXT_BYTES * 6 + 4096,
                )
            if "error" in result:
                code = result["error"]
                if code == "processor_unavailable":
                    raise DriveReadError(code)
                raise DriveReadError(code if code in PARSE_CODES else "invalid_document")
            pages = result["pages"]
            if (
                not isinstance(pages, list)
                or not 1 <= len(pages) <= 100
                or any(not isinstance(page, str) for page in pages)
                or sum(len(page.encode()) for page in pages) > MAX_TEXT_BYTES
                or type(result["truncated"]) is not bool
            ):
                raise DriveReadError("invalid_document")
            method = result.get("method")
            if raw_prefix:
                from hushh_mcp.services.drive_document_prefix import PREFIX_METHODS

                if method not in PREFIX_METHODS:
                    raise DriveReadError("invalid_document")
            return ParsedText(tuple(pages), result["truncated"], method if raw_prefix else None)
        except (ValueError, KeyError, TypeError):
            raise DriveReadError("invalid_document") from None


def _prepared(result: dict) -> PreparedIndex:
    try:
        prepared = PreparedIndex(
            result["profile"],
            tuple(
                IndexedChunk(
                    item["text"], tuple(item["embedding"]), item["start"], item["end"], item["page"]
                )
                for item in result["chunks"]
            ),
            result["truncated"],
        )
        prepared.validate()
        if prepared.profile != PROFILE:
            raise ValueError("wrong model profile")
        return prepared
    except (ValueError, KeyError, TypeError):
        raise DriveReadError("processor_unavailable") from None


class PrivateDocumentEmbedding(EmbeddingClient):
    def __init__(self):
        super().__init__(local_files_only=True)

    def prepare(self, parsed: ParsedText) -> PreparedIndex:
        return _prepared(prepare_payload(self, parsed))


class IsolatedDocumentEmbedding:
    profile = PROFILE

    async def query(self, query: str) -> tuple[float, ...]:
        return await self._query(query, admission=False)

    async def admit(self, *, timeout: int = 100) -> None:
        """Public startup proof with its caller's bound; private queries stay at 100s."""
        await self._query(PUBLIC_ADMISSION_QUERY, admission=True, timeout=timeout)

    async def _query(self, query: str, *, admission: bool, timeout: int = 100) -> tuple[float, ...]:
        if not query.strip() or len(query.encode()) > 2048:
            raise DriveReadError("invalid_argument")
        # Private queries retain their 100s child / 105s admission bounds.
        # Startup's public probe may use more of its existing overall budget
        # without discarding an in-progress cold load and repeating its imports.
        async with asyncio.timeout(timeout + 5), _embedding_admission():
            result = await _private_process(
                "embedding",
                "admit" if admission else "query",
                json.dumps({"query": query}).encode(),
                timeout=timeout,
                limit=16384,
            )
        if result.get("error") == "invalid_argument":
            raise DriveReadError("invalid_argument")
        values = result.get("embedding")
        if (
            result.get("profile") != PROFILE
            or not isinstance(values, list)
            or len(values) != 384
            or any(
                type(value) not in {int, float} or not math.isfinite(value) or abs(value) > 1
                for value in values
            )
            or not 0.9 <= sum(value * value for value in values) <= 1.1
        ):
            raise DriveReadError("processor_unavailable")
        if admission:
            try:
                _log_admission_timings(
                    result.get("admission_timings"), max_elapsed_ms=(timeout + 5) * 1000
                )
            except Exception:
                # Logging cannot turn a valid public probe into a readiness
                # failure. Model/transport/vector failures remain outside this.
                pass
        return tuple(values)

    async def prepare(self, parsed: ParsedText) -> PreparedIndex:
        result = await _private_process(
            "embedding",
            "embed",
            json.dumps(asdict(parsed)).encode(),
            timeout=100,
            limit=4 * 1024 * 1024,
        )
        return _prepared(result)


class LocalDocumentProcessor:
    profile = PROFILE

    def __init__(self, *, scanner=None, parser=None, embedder=None):
        self.scanner = scanner or ClamAvScanner()
        self.parser = parser or IsolatedDocumentParser()
        self.embedder = embedder or IsolatedDocumentEmbedding()
        # One embedding document per worker: the local model is memory heavy.
        self._lock = asyncio.Lock()
        # Page extraction children are single-threaded and bounded per vCPU,
        # so concurrent owner jobs overlap downloads without CPU fan-out.
        self._pages = asyncio.Semaphore(page_extraction_slots())

    async def prepare(self, *, content: bytes, mime_type: str) -> PreparedIndex:
        if not content or len(content) > CONTENT_LIMIT:
            raise DriveReadError("file_too_large")
        # The parse and embedding children also take a per-vCPU slot, so CPU
        # and memory heavy children never exceed page_extraction_slots() in
        # this process. Lock order is always _lock, then _pages.
        async with self._lock, self._pages:
            await self.scanner.scan(content)
            parsed = await self.parser.parse(content=content, mime_type=mime_type)
            return await self.embedder.prepare(parsed)

    async def extract_pages(
        self,
        *,
        content: bytes,
        mime_type: str,
        start_page: int = 1,
        page_limit: int = MAX_BATCH_PAGES,
    ) -> ExtractedPages:
        """Full evidence lane; safe bounded batches are persisted by ingestion."""
        if not content or len(content) > MAX_SOURCE_BYTES:
            raise DriveReadError("file_too_large")
        async with self._pages:
            await self.scanner.scan(content, max_bytes=MAX_SOURCE_BYTES)
            result = await _private_process(
                "pages",
                json.dumps(
                    {"mime_type": mime_type, "start_page": start_page, "page_limit": page_limit}
                ),
                content,
                timeout=75,
                limit=2 * 1024 * 1024,
            )
            if "error" in result:
                code = result["error"]
                raise DriveReadError(code if code in PARSE_CODES else "processor_unavailable")
            try:
                return ExtractedPages.from_dict(result)
            except (ValueError, KeyError, TypeError):
                raise DriveReadError("index_response_invalid") from None
