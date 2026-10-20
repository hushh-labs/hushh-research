"""One worker owns one bootstrap generation; never reuse its browser channel."""

import os
import socket


def child_exit(server, _worker) -> None:
    if os.environ.get("HUSSH_BROWSER_LAUNCH_FD") != "3":
        return
    # Gunicorn normally replaces a crashed worker while retaining inherited
    # master FDs. A browser-capable pod instead closes its generation and lets
    # the platform restart the whole bootstrap. No new worker can consume an
    # old acknowledgement or attach to the previous worker's browser.
    try:
        with socket.socket(fileno=3) as channel:
            channel.shutdown(socket.SHUT_RDWR)
    except OSError:
        pass
    if server.alive:
        server.halt(reason="Private browser worker generation ended", exit_status=1)
