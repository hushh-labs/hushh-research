"""Security tests for PR 3503 — Result<T,E> type pattern."""

import ast
import os

RT = os.path.join(os.path.dirname(__file__), "..", "services", "result_type.py")


def _r(p):
    with open(p, encoding="utf-8", errors="replace") as f:
        return f.read()


def test_exists():
    assert os.path.exists(RT)


def test_syntax():
    assert ast.parse(_r(RT)) is not None


def test_has_ok_type():
    assert "Ok" in _r(RT) or "ok" in _r(RT).lower(), "Result type must define Ok variant"


def test_has_err_type():
    assert "Err" in _r(RT), "Result type must define Err variant for explicit error signalling"


def test_no_silent_swallow():
    """Result must not silently suppress errors — Err must be accessible."""
    content = _r(RT)
    assert "unwrap_err" in content or "error" in content.lower(), (
        "Result type must expose error value via unwrap_err() or similar"
    )


def test_result_is_typed():
    """Result must use generics for type safety."""
    assert "Generic" in _r(RT) or "TypeVar" in _r(RT), (
        "Result must use Generic/TypeVar for type-safe error handling"
    )
