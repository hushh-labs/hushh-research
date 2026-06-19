"""Tests that portfolio services use UTC-aware datetimes instead of deprecated utcnow().

These tests use source-level assertions to avoid import-time side effects.
"""

import pathlib
import re

_SERVICES_DIR = pathlib.Path(__file__).parent.parent / "hushh_mcp" / "services"
_IMPORT_SERVICE = _SERVICES_DIR / "portfolio_import_service.py"
_PARSER = _SERVICES_DIR / "portfolio_parser.py"


def test_import_service_utc_import():
    src = _IMPORT_SERVICE.read_text()
    assert re.search(r"from datetime import.*\bUTC\b", src), (
        "portfolio_import_service must import UTC from datetime"
    )


def test_import_service_no_utcnow():
    src = _IMPORT_SERVICE.read_text()
    assert "datetime.utcnow()" not in src, (
        "portfolio_import_service must not call deprecated datetime.utcnow()"
    )


def test_import_service_imported_at_uses_utc():
    src = _IMPORT_SERVICE.read_text()
    assert re.search(r"datetime\.now\(UTC\)\.isoformat\(\)", src), (
        "imported_at must use datetime.now(UTC).isoformat()"
    )


def test_parser_utc_import():
    src = _PARSER.read_text()
    assert re.search(r"from datetime import.*\bUTC\b", src), (
        "portfolio_parser must import UTC from datetime"
    )


def test_parser_no_utcnow():
    src = _PARSER.read_text()
    assert "datetime.utcnow()" not in src, (
        "portfolio_parser must not call deprecated datetime.utcnow()"
    )


def test_parser_parsed_at_uses_utc():
    src = _PARSER.read_text()
    assert re.search(r"datetime\.now\(UTC\)", src), (
        "parsed_at must use datetime.now(UTC)"
    )
