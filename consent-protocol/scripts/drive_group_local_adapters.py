"""Local evaluation adapters, never imported by production runtime entrypoints."""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path


async def windows_parser_process(leaf, argument, payload, *, timeout, limit):
    from hushh_mcp.services.google_drive_adapter import DriveReadError

    if leaf != "parser" or len(payload) > 10 * 1024 * 1024:
        raise DriveReadError("processor_unavailable")
    environment = {
        "PATH": os.defpath,
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHON_DOTENV_DISABLED": "1",
        **{name: os.environ[name] for name in ("SystemRoot", "WINDIR") if name in os.environ},
    }
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        str(Path(__file__).with_name("drive_group_local_parse.py")),
        argument,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
        env=environment,
    )

    async def write():
        process.stdin.write(payload)
        await process.stdin.drain()
        process.stdin.close()

    writer = asyncio.create_task(write())
    try:
        async with asyncio.timeout(timeout):
            output = bytearray()
            while len(output) <= limit:
                part = await process.stdout.read(min(65536, limit + 1 - len(output)))
                if not part:
                    break
                output.extend(part)
            if len(output) > limit:
                raise DriveReadError("processor_unavailable")
            await writer
            await process.wait()
            if process.returncode:
                raise DriveReadError("processor_unavailable")
            result = json.loads(output)
            if not isinstance(result, dict):
                raise ValueError("invalid result")
            return result
    except TimeoutError:
        raise DriveReadError("processing_timeout") from None
    except (ValueError, BrokenPipeError, ConnectionResetError):
        raise DriveReadError("processor_unavailable") from None
    finally:
        if process.returncode is None:
            process.kill()
        await process.wait()
        if not writer.done():
            writer.cancel()
        await asyncio.gather(writer, return_exceptions=True)


class LocalHeadEmbedder:
    """Same pinned model as the developer lab; offline, one thread, batches of 32."""

    def __init__(self):
        self._client = None

    async def embed(self, heads):
        def run():
            if self._client is None:
                import torch

                from hushh_mcp.services.embedding_client_leaf import EmbeddingClient

                torch.set_num_threads(1)
                torch.set_num_interop_threads(1)
                self._client = EmbeddingClient(local_files_only=True)
            result = []
            for start in range(0, len(heads), 32):
                vectors = self._client.embed_passages(list(heads[start : start + 32]))
                result.extend(tuple(vector) for vector in vectors)
            return result

        return await asyncio.to_thread(run)
