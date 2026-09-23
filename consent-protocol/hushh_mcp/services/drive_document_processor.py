"""Self-hosted private processing: local ClamAV, isolated parser, pinned E5.

No provider IDs, credentials or owner identifiers enter this interface. Models
must be baked into the worker image: runtime downloads and remote code are off.
"""

from __future__ import annotations

import asyncio
import json
import math
import os
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
from hushh_mcp.services.drive_document_embedding import PROFILE, prepare_payload
from hushh_mcp.services.drive_document_parser import MAX_TEXT_BYTES, ParsedText
from hushh_mcp.services.embedding_client_leaf import (
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
    scripts = {"parser": "drive_document_parser.py", "embedding": "drive_document_embedding.py"}
    if leaf not in scripts:
        raise DriveReadError("processor_unavailable")
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        str(Path(__file__).resolve().parent / scripts[leaf]),
        argument,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
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
            process.kill()
        await process.wait()
        if not writer.done():
            writer.cancel()
        await asyncio.gather(writer, return_exceptions=True)


class Scanner(Protocol):
    async def scan(self, content: bytes) -> None: ...


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
                raise ValueError("stale scanner signatures")
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
        except DriveReadError as error:
            if str(error) == "unsafe_document":
                return
            raise
        raise DriveReadError("scanner_unavailable", retryable=True)

    async def scan(self, content: bytes) -> None:
        if not content or len(content) > CONTENT_LIMIT:
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
    async def parse(self, *, content: bytes, mime_type: str) -> ParsedText:
        try:
            result = await _private_process(
                "parser",
                mime_type,
                content,
                timeout=25,
                limit=MAX_TEXT_BYTES * 6 + 4096,
            )
            if "error" in result:
                code = result["error"]
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
            return ParsedText(tuple(pages), result["truncated"])
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
        if not query.strip() or len(query.encode()) > 2048:
            raise DriveReadError("invalid_argument")
        # The pinned E5 model was measured at ~71s from a cold start on the
        # UAT worker's 2-CPU/4-GiB allocation. Admission and child execution
        # remain bounded independently; downstream jobs own larger leases.
        async with asyncio.timeout(105), _embedding_admission():
            result = await _private_process(
                "embedding",
                "query",
                json.dumps({"query": query}).encode(),
                timeout=100,
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
        # One document per worker; no unbounded CPU/model fan-out.
        self._lock = asyncio.Lock()

    async def prepare(self, *, content: bytes, mime_type: str) -> PreparedIndex:
        if not content or len(content) > CONTENT_LIMIT:
            raise DriveReadError("file_too_large")
        async with self._lock:
            await self.scanner.scan(content)
            parsed = await self.parser.parse(content=content, mime_type=mime_type)
            return await self.embedder.prepare(parsed)
