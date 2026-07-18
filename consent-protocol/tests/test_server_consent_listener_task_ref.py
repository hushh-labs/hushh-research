"""Proof that the consent-listener startup task retains a strong reference.

asyncio.create_task() only stores a weak reference to the returned task on
the event loop; without an external strong reference, the task object can
be garbage collected before it completes, silently killing the background
consent listener.

This test reads the source directly rather than importing server.py,
because importing server.py runs module-level logging.basicConfig() and
install_sensitive_log_filter() calls that mutate global logging state and
collide with other tests' caplog assertions when run in the same session.

Canonical attach point: server.py::startup_consent_listener
"""

from __future__ import annotations

from pathlib import Path

_SERVER_PY = Path(__file__).resolve().parents[1] / "server.py"


def test_consent_listener_task_has_strong_reference():
    """startup_consent_listener must retain the task in a module-level set."""
    source = _SERVER_PY.read_text(encoding="utf-8")

    assert "_background_startup_tasks: set[asyncio.Task] = set()" in source, (
        "Module-level strong-reference set for background startup tasks is missing"
    )

    idx = source.find("async def startup_consent_listener")
    assert idx != -1, "startup_consent_listener not found in server.py"
    snippet = source[idx : idx + 600]

    assert "asyncio.create_task(run_consent_listener()" in snippet
    assert "_background_startup_tasks.add(task)" in snippet, (
        "consent listener task is not retained in the strong-reference set"
    )
    assert "_background_startup_tasks.discard" in snippet, (
        "consent listener task has no done-callback to clean up the strong reference"
    )
