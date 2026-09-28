"""Gunicorn hooks for the consent-protocol container.

gunicorn also loads this file by default from the working directory, so the
Drive worker service (same image, its own command line) gets the same hook.
"""

from __future__ import annotations

import faulthandler
from typing import Any


def post_worker_init(worker: Any) -> None:
    """Log where a worker was stuck when gunicorn aborts it for WORKER TIMEOUT.

    gunicorn sends SIGABRT to a worker whose event loop missed its heartbeat for
    ``--timeout`` seconds, which drops every open chat stream on that worker.
    UvicornWorker resets SIGABRT to the default action while it starts, so the
    handler is installed here, after that reset. The dump lists file, line and
    function names only: no arguments, locals or request content.
    """
    faulthandler.enable(all_threads=True)
