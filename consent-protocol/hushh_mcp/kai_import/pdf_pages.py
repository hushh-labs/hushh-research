"""One-page PDFs through the app's existing PDFium, in an owned isolated process."""

from __future__ import annotations

import asyncio
import io
import os
import re
import struct
import subprocess
import sys
from pathlib import Path
from typing import Any, BinaryIO

_MAX_BYTES = 25 * 1024 * 1024
_FRAME = struct.Struct("!I")
_RESPONSE_SECONDS = 10


class PdfPageSplitUnsupported(ValueError):
    pass


async def _settle_owned(awaitable):
    # Starting/stopping a child must settle even if its caller is cancelled.
    task = asyncio.create_task(awaitable)
    cancellation = None
    while True:
        try:
            result = await asyncio.shield(task)
            break
        except asyncio.CancelledError as exc:
            if task.cancelled():
                raise
            cancellation = exc
        except Exception:
            if cancellation is not None:
                raise cancellation from None
            raise
    if cancellation is not None:
        raise cancellation
    return result


class PdfPages:
    def __init__(self) -> None:
        self.process: asyncio.subprocess.Process | None = None
        self.count = 0
        self.closed = False

    @classmethod
    async def open(cls, content: bytes) -> PdfPages:
        source = cls()
        try:
            async with asyncio.timeout(_RESPONSE_SECONDS):
                await _settle_owned(source._start())
                await source._write(content)
                count = await source._read(16)
            if not count.isdigit() or int(count) <= 0:
                raise PdfPageSplitUnsupported("pdf_page_split_unavailable")
            source.count = int(count)
            return source
        except BaseException as exc:
            await source.close()
            if isinstance(exc, (asyncio.CancelledError, KeyboardInterrupt, SystemExit)):
                raise
            raise PdfPageSplitUnsupported("pdf_page_split_unavailable") from None

    async def _start(self) -> None:
        # No owner identifiers, tokens or service credentials enter the child.
        environment = {
            "PATH": os.defpath,
            "LANG": "C.UTF-8",
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHON_DOTENV_DISABLED": "1",
        }
        if sys.platform == "win32" and os.environ.get("SystemRoot"):
            environment["SystemRoot"] = os.environ["SystemRoot"]
        creationflags = 0
        if sys.platform == "win32":
            creationflags = subprocess.CREATE_NO_WINDOW
        self.process = await asyncio.create_subprocess_exec(
            sys.executable,
            str(Path(__file__).resolve()),
            "--worker",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            env=environment,
            creationflags=creationflags,
            start_new_session=sys.platform != "win32",
        )

    async def _write(self, value: bytes) -> None:
        if self.process is None or self.process.stdin is None or len(value) > _MAX_BYTES:
            raise PdfPageSplitUnsupported("pdf_page_split_unavailable")
        self.process.stdin.write(_FRAME.pack(len(value)))
        self.process.stdin.write(value)
        await self.process.stdin.drain()

    async def _read(self, limit: int) -> bytes:
        if self.process is None or self.process.stdout is None:
            raise PdfPageSplitUnsupported("pdf_page_split_unavailable")
        size = _FRAME.unpack(await self.process.stdout.readexactly(_FRAME.size))[0]
        if not 0 < size <= limit:
            raise PdfPageSplitUnsupported("pdf_page_split_unavailable")
        return await self.process.stdout.readexactly(size)

    async def page_bytes(self, index: int) -> bytes:
        if self.closed or type(index) is not int or not 0 <= index < self.count:
            raise PdfPageSplitUnsupported("pdf_page_split_unavailable")
        try:
            async with asyncio.timeout(_RESPONSE_SECONDS):
                await self._write(str(index).encode("ascii"))
                result = await self._read(_MAX_BYTES)
            if not result.startswith(b"%PDF-"):
                raise PdfPageSplitUnsupported("pdf_page_split_unavailable")
            return result
        except (OSError, ValueError, asyncio.IncompleteReadError, TimeoutError):
            raise PdfPageSplitUnsupported("pdf_page_split_unavailable") from None

    async def page_text(self, index: int, *, layout: bool = False) -> str:
        """Read embedded text through the same isolated PDF worker."""
        if self.closed or not 0 <= index < self.count:
            raise PdfPageSplitUnsupported("pdf_page_text_unavailable")
        try:
            async with asyncio.timeout(_RESPONSE_SECONDS):
                command = "layout" if layout else "text"
                await self._write(f"{command}:{index}".encode("ascii"))
                response = await self._read(128 * 1024)
                if not response.startswith(b"t"):
                    raise ValueError("page_text_frame")
                return response[1:].decode("utf-8")
        except (OSError, ValueError, asyncio.IncompleteReadError, TimeoutError):
            raise PdfPageSplitUnsupported("pdf_page_text_unavailable") from None

    async def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        await _settle_owned(self._stop())

    async def _stop(self) -> None:
        process = self.process
        if process is None:
            return

        async def discard_output() -> None:
            if process.stdout is not None:
                while await process.stdout.read(64 * 1024):
                    pass

        # Draining keeps Process.wait from hanging on a full output pipe after
        # cancellation while a page is being written. Nothing is retained.
        drain = asyncio.create_task(discard_output())
        try:
            if process.returncode is None and process.stdin is not None:
                try:
                    async with asyncio.timeout(1):
                        await self._write(b"close")
                except (OSError, ValueError, TimeoutError):
                    pass
                process.stdin.close()
            try:
                await asyncio.wait_for(process.wait(), 1)
            except TimeoutError:
                try:
                    process.terminate()
                except ProcessLookupError:
                    pass
                try:
                    await asyncio.wait_for(process.wait(), 1)
                except TimeoutError:
                    try:
                        process.kill()
                    except ProcessLookupError:
                        pass
                    await process.wait()
        finally:
            if not drain.done():
                drain.cancel()
            await asyncio.gather(drain, return_exceptions=True)


def _read_frame(stream: BinaryIO, limit: int) -> bytes:
    header = stream.read(_FRAME.size)
    if len(header) != _FRAME.size:
        raise EOFError
    size = _FRAME.unpack(header)[0]
    if not 0 < size <= limit:
        raise ValueError("frame_size")
    value = stream.read(size)
    if len(value) != size:
        raise EOFError
    return value


def _write_frame(stream: BinaryIO, value: bytes) -> None:
    if len(value) > _MAX_BYTES:
        raise ValueError("frame_size")
    stream.write(_FRAME.pack(len(value)))
    stream.write(value)
    stream.flush()


def _column_text(text_page: Any, text: str) -> str:
    """Separate visual cells using gaps between glyphs on the same text line."""
    if len(text) > 16_384 or len(text) != text_page.count_chars():
        raise ValueError("pdf_text_geometry_unavailable")
    lines: list[str] = []
    for line in re.finditer(r"[^\r\n]+", text):
        cells: list[str] = []
        right: float | None = None
        for word in re.finditer(r"\S+", line[0]):
            left = text_page.get_charbox(line.start() + word.start())[0]
            edge = text_page.get_charbox(line.start() + word.end() - 1)[2]
            if right is None or left - right >= 8:
                cells.append(word[0])
            else:
                cells[-1] += " " + word[0]
            right = edge
        lines.append("\t".join(cells))
    return "\n".join(lines)


def _worker() -> None:
    import pypdfium2

    source = None
    try:
        source = pypdfium2.PdfDocument(_read_frame(sys.stdin.buffer, _MAX_BYTES))
        if pypdfium2.raw.FPDF_GetSecurityHandlerRevision(source) != -1:
            raise ValueError("encrypted_pdf")
        _write_frame(sys.stdout.buffer, str(len(source)).encode("ascii"))
        while True:
            command = _read_frame(sys.stdin.buffer, 32)
            if command == b"close":
                break
            prefix, separator, argument = command.partition(b":")
            index = int(argument if separator else command)
            if not 0 <= index < len(source):
                raise ValueError("page_index")
            if prefix in (b"text", b"layout") and separator:
                input_page = source[index]
                text_page = input_page.get_textpage()
                try:
                    text = text_page.get_text_range()
                    if prefix == b"layout":
                        try:
                            text = _column_text(text_page, text)
                        except (ValueError, IndexError, pypdfium2.PdfiumError):
                            _write_frame(sys.stdout.buffer, b"u")
                            continue
                    encoded = text.encode("utf-8")
                    _write_frame(
                        sys.stdout.buffer, b"t" + (encoded if len(encoded) < 128 * 1024 else b"")
                    )
                finally:
                    text_page.close()
                    input_page.close()
                continue
            with pypdfium2.PdfDocument.new() as page, io.BytesIO() as output:
                page.import_pages(source, pages=[index])
                page.save(output)
                _write_frame(sys.stdout.buffer, output.getvalue())
    except Exception:
        # Native/parser errors and source contents never enter telemetry.
        try:
            _write_frame(sys.stdout.buffer, b"")
        except (OSError, ValueError):
            pass
    finally:
        if source is not None:
            source.close()


if __name__ == "__main__" and sys.argv[1:] == ["--worker"]:
    _worker()
