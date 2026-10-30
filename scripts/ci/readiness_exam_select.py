"""Pure case selection and splicing for the pre-merge readiness exam (no I/O, no PR code).

A YAML anchor names a subagent: when the graded commit changes that subagent's
mapping, the whole mapping is graded as data, so instruction, reasoning and
output-budget edits all count while unrelated subagents keep Main's text. A
Python anchor is code, so only its string literal is taken, never the module.
"""

from __future__ import annotations

import ast
from collections.abc import Callable
from typing import Any

MAX_ANCHOR_FILE_CHARS = 1_000_000
UNRESOLVED = "anchor_unresolvable"


class SpliceRefused(ValueError):
    """The graded text cannot be applied to Main's file exactly; nothing is run."""


def _resolve(anchor_text: Callable, anchor: dict, source: str | None) -> str | None:
    if source is None:
        return None
    try:
        return anchor_text(anchor, source)
    except (KeyError, ValueError, SyntaxError, AttributeError, TypeError, ImportError):
        return None
    except Exception as error:  # noqa: BLE001 - YAML parser errors stay data errors
        if type(error).__module__.startswith("yaml"):
            return None
        raise


def _case_overlays(case: dict, anchor_text: Callable, main_file, graded_file) -> tuple[list, str]:
    overlays, reason = [], "anchor_unchanged"
    for anchor in case["anchors"]:
        graded, main = graded_file(anchor["file"]), main_file(anchor["file"])
        value = _resolve(anchor_text, anchor, graded)
        if value is None:
            return [], UNRESOLVED
        if graded == main:
            continue
        if anchor["type"] == "python_constant":
            if value != anchor_text(anchor, main):
                overlays.append(("literal", anchor, value))
            continue
        mapping = subagent(graded, anchor["subagent"])
        if mapping is None:
            return [], UNRESOLVED
        if mapping != subagent(main, anchor["subagent"]):
            overlays.append(("subagent", anchor, mapping))
    return overlays, "anchor_changed" if overlays else reason


def subagent(source: str | None, subagent_id: str) -> dict | None:
    """One subagent mapping from a YAML manifest, read as data."""
    import yaml  # type: ignore[import-untyped]  # noqa: PLC0415 - runtime dependency only

    try:
        document = yaml.safe_load(source or "")
    except yaml.YAMLError:
        return None
    rows = document.get("subagents") if isinstance(document, dict) else None
    match = [row for row in rows or [] if isinstance(row, dict) and row.get("id") == subagent_id]
    return match[0] if len(match) == 1 else None


def select_cases(
    manifest: dict, anchor_text: Callable, main_file, graded_file, requested: list | None
) -> list[dict]:
    """Live cases whose anchors the graded commit changes; controls name their cases."""
    rows = []
    for case in (c for c in manifest["cases"] if c["pre_merge"] == "live"):
        overlays, reason = _case_overlays(case, anchor_text, main_file, graded_file)
        if requested is None:
            selected = reason != "anchor_unchanged"
        else:
            selected = not requested or case["id"] in requested
            reason = "requested" if selected and reason == "anchor_unchanged" else reason
        rows.append(
            {"case": case["id"], "selected": selected, "reason": reason, "_overlays": overlays}
        )
    return rows


def splice_subagent(anchor: dict, source: str, mapping: dict) -> str:
    """Main's manifest with only the anchored subagent replaced, proven by re-parsing."""
    import yaml  # type: ignore[import-untyped]  # noqa: PLC0415 - runtime dependency only

    if len(source) > MAX_ANCHOR_FILE_CHARS or len(repr(mapping)) > MAX_ANCHOR_FILE_CHARS:
        raise SpliceRefused("anchor file exceeds the bounded size")
    document = yaml.safe_load(source)
    rows = document.get("subagents") if isinstance(document, dict) else None
    if not isinstance(rows, list) or sum(r.get("id") == anchor["subagent"] for r in rows) != 1:
        raise SpliceRefused(f"{anchor['subagent']} is not exactly one subagent in Main")
    document["subagents"] = [mapping if r.get("id") == anchor["subagent"] else r for r in rows]
    spliced = yaml.safe_dump(document, sort_keys=False, allow_unicode=True, width=1_000_000_000)
    reloaded = yaml.safe_load(spliced)
    if reloaded != document or subagent(spliced, anchor["subagent"]) != mapping:
        raise SpliceRefused(f"{anchor['subagent']} could not be spliced exactly")
    return spliced


def splice_literal(anchor: dict, source: str, value: str, anchor_text: Callable) -> str:
    """Main's module with only the anchored string literal replaced, proven by re-parsing."""
    symbol = anchor["symbol"]
    node = next((n for n in ast.parse(source).body if _assigns(n, symbol)), None)
    if node is None or node.value is None:
        raise SpliceRefused(f"{symbol} is missing from Main")
    lines = source.splitlines(keepends=True)
    start, end = node.value, node.value
    # ast offsets count UTF-8 bytes; convert them to characters before slicing.
    head = _char_offset(lines[start.lineno - 1], start.col_offset)
    tail = _char_offset(lines[end.end_lineno - 1], end.end_col_offset)  # type: ignore[index,arg-type]
    spliced = (
        "".join(lines[: start.lineno - 1])
        + lines[start.lineno - 1][:head]
        + repr(value)
        + lines[end.end_lineno - 1][tail:]  # type: ignore[index]
        + "".join(lines[end.end_lineno :])  # type: ignore[misc]
    )
    try:
        unchanged = _module_without(source, symbol) == _module_without(spliced, symbol)
    except SyntaxError as error:
        raise SpliceRefused(f"{symbol} could not be spliced exactly") from error
    if not unchanged or anchor_text(anchor, spliced) != value:
        raise SpliceRefused(f"{symbol} could not be spliced exactly")
    return spliced


def _assigns(node: ast.stmt, symbol: str) -> bool:
    if isinstance(node, ast.Assign):
        return any(isinstance(t, ast.Name) and t.id == symbol for t in node.targets)
    return (
        isinstance(node, ast.AnnAssign)
        and isinstance(node.target, ast.Name)
        and node.target.id == symbol
    )


def _char_offset(line: str, byte_offset: int) -> int:
    return len(line.encode("utf-8")[:byte_offset].decode("utf-8"))


def _module_without(source: str, symbol: str) -> str:
    tree = ast.parse(source)
    for node in tree.body:
        if _assigns(node, symbol):
            node.value = ast.Constant(value=None)
    return ast.dump(tree)


def overlay_texts(selection: list[dict], main_file, anchor_text: Callable) -> dict[str, str]:
    """File contents to write into Main's checkout, one per anchor file."""
    texts: dict[str, str] = {}
    for row in (r for r in selection if r["selected"]):
        for kind, anchor, payload in row["_overlays"]:
            path = anchor["file"]
            if kind == "subagent":
                texts[path] = splice_subagent(anchor, texts.get(path, main_file(path)), payload)
            else:
                texts[path] = splice_literal(
                    anchor, texts.get(path, main_file(path)), payload, anchor_text
                )
    return texts


def public_rows(selection: list[dict]) -> list[dict[str, Any]]:
    return [{k: v for k, v in row.items() if k != "_overlays"} for row in selection]
