#!/usr/bin/env python3
from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass


DEFAULT_LIMIT = 1900
HARD_LIMIT = 2000


@dataclass(frozen=True)
class Chunk:
    index: int
    total: int
    text: str

    @property
    def length(self) -> int:
        return len(self.text)


def _split_long_line(line: str, limit: int) -> list[str]:
    pieces: list[str] = []
    remaining = line
    while len(remaining) > limit:
        cut = remaining.rfind(" ", 0, limit + 1)
        if cut <= 0:
            cut = limit
        pieces.append(remaining[:cut].rstrip())
        remaining = remaining[cut:].lstrip()
    if remaining:
        pieces.append(remaining)
    return pieces


def _paragraph_units(text: str, limit: int) -> list[str]:
    normalized = text.strip()
    if not normalized:
        return []
    units: list[str] = []
    for paragraph in normalized.split("\n\n"):
        paragraph = paragraph.strip()
        if not paragraph:
            continue
        if len(paragraph) <= limit:
            units.append(paragraph)
            continue
        lines = paragraph.splitlines()
        for line in lines:
            line = line.rstrip()
            if len(line) <= limit:
                units.append(line)
            else:
                units.extend(_split_long_line(line, limit))
    return units


def chunk_text(text: str, limit: int = DEFAULT_LIMIT) -> list[Chunk]:
    if limit <= 0 or limit > HARD_LIMIT:
        raise ValueError(f"limit must be between 1 and {HARD_LIMIT}")
    units = _paragraph_units(text, limit)
    chunks: list[str] = []
    current = ""
    for unit in units:
        candidate = unit if not current else f"{current}\n\n{unit}"
        if len(candidate) <= limit:
            current = candidate
            continue
        if current:
            chunks.append(current)
        current = unit
    if current:
        chunks.append(current)
    total = len(chunks)
    return [Chunk(index=i + 1, total=total, text=value) for i, value in enumerate(chunks)]


def render_copy_blocks(chunks: list[Chunk]) -> str:
    if not chunks:
        return ""
    rendered: list[str] = []
    for chunk in chunks:
        backtick_runs = [len(match.group(0)) for match in re.finditer(r"`+", chunk.text)]
        fence = "`" * max(3, (max(backtick_runs) + 1) if backtick_runs else 3)
        rendered.append(
            "\n".join(
                [
                    f"Discord copy batch {chunk.index}/{chunk.total} ({chunk.length} chars)",
                    "",
                    f"{fence}text",
                    chunk.text,
                    fence,
                ]
            )
        )
    return "\n\n".join(rendered)


def _self_test() -> None:
    assert len(chunk_text("short", 1900)) == 1
    long = "a" * 2001
    chunks = chunk_text(long, 1900)
    assert len(chunks) == 2
    assert all(chunk.length <= 1900 for chunk in chunks)
    paragraph = "one\n\ntwo"
    assert chunk_text(paragraph, 1900)[0].text == paragraph
    rendered = render_copy_blocks(chunk_text("```bash\necho ok\n```", 1900))
    assert "````text" in rendered


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Split Discord copy into message-sized copy blocks."
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=DEFAULT_LIMIT,
        help=f"safe character budget per Discord message, max {HARD_LIMIT}",
    )
    parser.add_argument("--file", help="read content from this file instead of stdin")
    parser.add_argument("--count-only", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()

    if args.self_test:
        _self_test()
        print("discord chunk self-test passed")
        return 0

    text = (
        open(args.file, encoding="utf-8").read()
        if args.file
        else sys.stdin.read()
    )
    chunks = chunk_text(text, args.limit)
    if args.count_only:
        print(
            f"chars={len(text.strip())} chunks={len(chunks)} limit={args.limit} "
            f"hard_limit={HARD_LIMIT}"
        )
        return 0
    print(render_copy_blocks(chunks))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
