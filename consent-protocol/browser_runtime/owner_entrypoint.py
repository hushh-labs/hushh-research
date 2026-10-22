"""Fixed ordinary Browser child entrypoint; contains no application authority."""

import sys

sys.path.insert(0, "/opt/browser/source")

if __name__ == "__main__":
    from hushh_mcp.services.pod_browser.container_worker import main

    try:
        main()
    except Exception:
        raise SystemExit("BROWSER_PROCESS_REFUSED") from None
