"""Tests that CrdScrapeJobRequest.crdNumber has a max_length bound (CWE-400).

A missing max_length allows arbitrarily long strings to reach normalize_crd_number()
and any downstream services, enabling resource exhaustion.

Uses source-level assertions to avoid import-time side effects from rate-limit
middleware that requires environment variables.
"""

import pathlib
import re

_SRC = pathlib.Path(__file__).parent.parent / "api" / "routes" / "crd_scraper.py"


def test_crd_number_field_has_max_length():
    src = _SRC.read_text()
    assert re.search(r"max_length\s*=\s*\d+", src), (
        "CrdScrapeJobRequest.crdNumber must declare max_length to prevent CWE-400"
    )


def test_crd_number_max_length_is_reasonable():
    src = _SRC.read_text()
    # Extract the crdNumber Field(...) block and check its max_length
    field_block = re.search(r"crdNumber:\s*str\s*=\s*Field\s*\(.*?\)", src, re.DOTALL)
    assert field_block, "crdNumber Field definition not found"
    match = re.search(r"max_length\s*=\s*(\d+)", field_block.group(0))
    assert match, "max_length not found in crdNumber Field"
    value = int(match.group(1))
    assert value <= 64, (
        "CrdScrapeJobRequest.crdNumber max_length=%d is unreasonably large (> 64)" % value
    )


def test_crd_number_field_has_min_length():
    src = _SRC.read_text()
    assert re.search(r"min_length\s*=\s*1", src), (
        "CrdScrapeJobRequest.crdNumber must retain min_length=1"
    )
