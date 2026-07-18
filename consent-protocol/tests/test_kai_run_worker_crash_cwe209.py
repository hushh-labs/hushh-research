"""Minimal proof: run worker crash SSE events use opaque messages (CWE-209).

Canonical attach points:
  api/routes/kai/run_manager.py::KaiAnalyzeRunManager
    -- ANALYZE_RUN_WORKER_FAILED event
  api/routes/kai/import_run_manager.py::KaiPortfolioImportRunManager
    -- IMPORT_RUN_WORKER_FAILED event
"""

from __future__ import annotations

from pathlib import Path

_ROUTES_DIR = Path(__file__).resolve().parents[1] / "api" / "routes" / "kai"


def test_analyze_run_worker_failed_message_is_static():
    """ANALYZE_RUN_WORKER_FAILED event must carry a static message, not str(exc)."""
    source = (_ROUTES_DIR / "run_manager.py").read_text(encoding="utf-8")

    assert '"Analysis run worker failed."' in source

    idx = source.find('"ANALYZE_RUN_WORKER_FAILED"')
    assert idx != -1, "ANALYZE_RUN_WORKER_FAILED event not found in run_manager.py"
    snippet = source[idx : idx + 200]
    assert '"message": str(exc)' not in snippet, (
        "ANALYZE_RUN_WORKER_FAILED event still forwards str(exc) as message"
    )


def test_import_run_worker_failed_message_is_static():
    """IMPORT_RUN_WORKER_FAILED event must carry a static message, not str(exc)."""
    source = (_ROUTES_DIR / "import_run_manager.py").read_text(encoding="utf-8")

    assert '"Import run worker failed."' in source

    idx = source.find('"IMPORT_RUN_WORKER_FAILED"')
    assert idx != -1, "IMPORT_RUN_WORKER_FAILED event not found in import_run_manager.py"
    snippet = source[idx : idx + 200]
    assert '"message": str(exc)' not in snippet, (
        "IMPORT_RUN_WORKER_FAILED event still forwards str(exc) as message"
    )
