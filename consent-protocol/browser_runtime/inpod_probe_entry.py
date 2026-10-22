#!/opt/browser/venv/bin/python
"""Synthetic entry for the disposable image only; never production gunicorn."""

import asyncio
import json

from hushh_mcp.services.pod_browser.namespace_public_probe import PREFIX, run_inpod_probe

try:
    result = asyncio.run(run_inpod_probe())
except Exception as exc:
    result = {"code": "BROWSER_INPOD_PROBE_REFUSED", "failure_type": type(exc).__name__}
    if isinstance(exc, OSError):
        result["errno"] = exc.errno
print(PREFIX + json.dumps(result), flush=True)
