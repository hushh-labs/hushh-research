# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""PostgreSQL top-level statement lexer and atomic ledger envelope unwrapper.

Historical SQL migrations frequently wrap their body in ``BEGIN; ... COMMIT;``.
When ``MigrationMode.LEDGER`` runs a transactional entry inside
``async with conn.transaction():``, an inner top-level ``COMMIT;`` prematurely
commits the outer PostgreSQL transaction before ``schema_migrations`` records
the applied receipt (R33). This module lexes PostgreSQL comments, string
literals, quoted identifiers, and ``$tag$...$tag$`` dollar-quoted blocks so
only a symmetric outer ``BEGIN; ... COMMIT;`` envelope is stripped in memory
after replay/adoption SQL resolution, preserving on-disk bytes and SHA-256
checksums untouched.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

_DOLLAR_TAG_RE = re.compile(r"^\$(?:[A-Za-z_\x80-\xff][A-Za-z0-9_\x80-\xff]*)?\$")
_WORD_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_$]*")
_BEGIN_ENVELOPES: frozenset[tuple[str, ...]] = frozenset(
    {
        ("BEGIN",),
        ("BEGIN", "WORK"),
        ("BEGIN", "TRANSACTION"),
    }
)
_COMMIT_ENVELOPES: frozenset[tuple[str, ...]] = frozenset(
    {
        ("COMMIT",),
        ("COMMIT", "WORK"),
        ("COMMIT", "TRANSACTION"),
    }
)


@dataclass(frozen=True, slots=True)
class TopLevelSqlStatement:
    """One top-level semicolon-delimited (or trailing) PostgreSQL statement."""

    start: int
    end: int
    semicolon_end: int
    keywords: tuple[str, ...]


def _extract_top_level_keywords(code_tokens: list[str]) -> tuple[str, ...]:
    joined = "".join(code_tokens)
    return tuple(match.group(0).upper() for match in _WORD_RE.finditer(joined[:256]))


def is_outer_transaction_control(keywords: tuple[str, ...]) -> bool:
    """True when ``keywords`` control the outer PostgreSQL transaction block.

    ``SAVEPOINT``, ``RELEASE [SAVEPOINT]``, and ``ROLLBACK [WORK|TRANSACTION] TO``
    operate on subtransaction savepoints and remain valid inside ``conn.transaction()``.
    """

    if not keywords:
        return False
    first = keywords[0]
    if first in {"BEGIN", "COMMIT", "END", "ABORT"}:
        return True
    if first == "START" and len(keywords) >= 2 and keywords[1] == "TRANSACTION":
        return True
    if first == "ROLLBACK":
        return "TO" not in keywords[:4]
    return False


def _skip_quoted_literal(sql: str, index: int, *, quote: str, escaped: bool) -> int:
    length = len(sql)
    cursor = index + 1
    while cursor < length:
        ch = sql[cursor]
        if escaped and ch == "\\":
            cursor += 2
            continue
        if ch == quote:
            if cursor + 1 < length and sql[cursor + 1] == quote:
                cursor += 2
                continue
            return cursor + 1
        cursor += 1
    return -1


def _skip_block_comment(sql: str, index: int) -> int:
    length = len(sql)
    cursor = index + 2
    depth = 1
    while cursor < length and depth > 0:
        if sql.startswith("/*", cursor):
            depth += 1
            cursor += 2
        elif sql.startswith("*/", cursor):
            depth -= 1
            cursor += 2
        else:
            cursor += 1
    return cursor if depth == 0 else -1


def _consume_quoted_or_dollar(
    sql: str,
    index: int,
    *,
    filename: str,
    error_cls: type[Exception],
) -> tuple[int, str] | None:
    ch = sql[index]
    if ch in {"'", '"'}:
        escaped = (
            ch == "'"
            and index > 0
            and sql[index - 1] in {"e", "E"}
            and (index == 1 or not (sql[index - 2].isalnum() or sql[index - 2] == "_"))
        )
        next_i = _skip_quoted_literal(sql, index, quote=ch, escaped=escaped)
        if next_i == -1:
            raise error_cls(f"Unterminated SQL quoted literal in {filename}")
        return next_i, " '' "
    if ch == "$":
        tag_match = _DOLLAR_TAG_RE.match(sql[index:])
        if tag_match is not None:
            tag = tag_match.group(0)
            close_at = sql.find(tag, index + len(tag))
            if close_at == -1:
                raise error_cls(f"Unterminated dollar-quoted block {tag} in {filename}")
            return close_at + len(tag), " $$ "
    return None


def scan_top_level_sql_statements(
    sql: str,
    *,
    filename: str = "<sql>",
    error_cls: type[Exception] = RuntimeError,
) -> tuple[TopLevelSqlStatement, ...]:
    """Lex top-level SQL statements without splitting comments or ``$$`` blocks."""

    statements: list[TopLevelSqlStatement] = []
    length = len(sql)
    i = 0
    stmt_start: int | None = None
    stmt_end = 0
    code_chunks: list[str] = []

    while i < length:
        ch = sql[i]
        if ch.isspace() or sql.startswith("--", i) or sql.startswith("/*", i):
            if ch.isspace():
                i += 1
            elif sql.startswith("--", i):
                nl = sql.find("\n", i + 2)
                i = length if nl == -1 else nl + 1
            else:
                next_i = _skip_block_comment(sql, i)
                if next_i == -1:
                    raise error_cls(f"Unterminated SQL block comment in {filename}")
                i = next_i
            if stmt_start is not None:
                code_chunks.append(" ")
            continue
        if ch == ";":
            if stmt_start is not None:
                keywords = _extract_top_level_keywords(code_chunks)
                if keywords:
                    statements.append(TopLevelSqlStatement(stmt_start, stmt_end, i + 1, keywords))
                stmt_start, code_chunks = None, []
            i += 1
            continue

        if stmt_start is None:
            stmt_start = i
        special = _consume_quoted_or_dollar(sql, i, filename=filename, error_cls=error_cls)
        if special is not None:
            i, placeholder = special
            code_chunks.append(placeholder)
            stmt_end = i
            continue
        code_chunks.append(ch)
        i += 1
        stmt_end = i

    if stmt_start is not None:
        keywords = _extract_top_level_keywords(code_chunks)
        if keywords:
            statements.append(TopLevelSqlStatement(stmt_start, stmt_end, stmt_end, keywords))
    return tuple(statements)


def strip_sql_comments_and_literals(sql: str) -> str:
    """Return top-level SQL with comments, string literals, and ``$$`` bodies blanked."""

    out: list[str] = []
    i = 0
    length = len(sql)
    while i < length:
        if sql.startswith("--", i):
            nl = sql.find("\n", i + 2)
            i = length if nl == -1 else nl
            continue
        if sql.startswith("/*", i):
            next_i = _skip_block_comment(sql, i)
            i = length if next_i == -1 else next_i
            out.append(" ")
            continue
        special = _consume_quoted_or_dollar(sql, i, filename="<sql>", error_cls=RuntimeError)
        if special is not None:
            i, placeholder = special
            out.append(placeholder)
            continue
        out.append(sql[i])
        i += 1
    return "".join(out)


def prepare_execution_sql(
    entry: Any,
    sql: str,
    *,
    mode_value: str,
    error_cls: type[Exception] = RuntimeError,
) -> str:
    """Return mode-appropriate SQL while preserving ``entry.sql`` and checksums."""

    if mode_value != "ledger":
        return sql

    statements = scan_top_level_sql_statements(
        sql,
        filename=entry.filename,
        error_cls=error_cls,
    )
    tx_indices = [
        idx for idx, stmt in enumerate(statements) if is_outer_transaction_control(stmt.keywords)
    ]

    if not entry.transactional:
        if tx_indices:
            raise error_cls(
                f"Non-transactional migration must not contain transaction control: {entry.filename}"
            )
        return sql

    if not tx_indices:
        return sql

    if (
        len(statements) >= 2
        and tx_indices == [0, len(statements) - 1]
        and statements[0].keywords in _BEGIN_ENVELOPES
        and statements[-1].keywords in _COMMIT_ENVELOPES
    ):
        first = statements[0]
        last = statements[-1]
        return (
            sql[: first.start] + sql[first.semicolon_end : last.start] + sql[last.semicolon_end :]
        )

    raise error_cls(
        f"Transactional ledger migration has an unbalanced or unsupported transaction envelope: {entry.filename}"
    )
