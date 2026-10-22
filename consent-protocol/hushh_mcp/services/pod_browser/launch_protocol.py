"""Private launcher protocol: fixed operations and one connected descriptor.

The bootstrap creates this channel before loading pod credentials. It has no
listener or pathname. No caller-selected command, environment or file is accepted.
"""

from __future__ import annotations

import array
import json
import os
import re
import socket

MAX_PACKET = 4096
CONTROL_FD = 3
WORKER_ID = 10002
AGENT_ID = 10001


class LaunchRefused(RuntimeError):
    def __init__(self) -> None:
        super().__init__("BROWSER_LAUNCH_REFUSED")


def connected_socket(connection: socket.socket, kind: int) -> None:
    if (
        connection.family != socket.AF_UNIX
        or connection.getsockopt(socket.SOL_SOCKET, socket.SO_TYPE) != kind
    ):
        raise LaunchRefused()
    connection.getpeername()
    connection.set_inheritable(False)


def encode(operation: str, request_id: str) -> bytes:
    if operation not in {"launch", "stop", "started", "stopped", "refused"} or not re.fullmatch(
        r"[a-f0-9]{32}", request_id
    ):
        raise LaunchRefused()
    return json.dumps({"operation": operation, "id": request_id}, separators=(",", ":")).encode()


def _unique(pairs: list[tuple[str, object]]) -> dict:
    result: dict = {}
    for key, value in pairs:
        if key in result:
            raise LaunchRefused()
        result[key] = value
    return result


def receive(connection: socket.socket) -> tuple[str, str, socket.socket | None]:
    """Takes ownership of received FDs, including on malformed/truncated input."""
    descriptors = array.array("i")
    child = None
    try:
        raw, ancillary, flags, _ = connection.recvmsg(
            MAX_PACKET,
            socket.CMSG_SPACE(8 * descriptors.itemsize),
            getattr(socket, "MSG_CMSG_CLOEXEC", 0),
        )
        invalid = False
        for level, kind, value in ancillary:
            if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                descriptors.frombytes(value[: len(value) - len(value) % descriptors.itemsize])
            else:
                invalid = True
        if invalid or not raw or flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC):
            raise LaunchRefused()
        value = json.loads(raw, object_pairs_hook=_unique)
        if not isinstance(value, dict) or set(value) != {"operation", "id"}:
            raise LaunchRefused()
        operation, request_id = value["operation"], value["id"]
        if not isinstance(operation, str) or not isinstance(request_id, str):
            raise LaunchRefused()
        encode(operation, request_id)
        expected = 1 if operation == "launch" else 0
        if len(descriptors) != expected:
            raise LaunchRefused()
        if expected:
            child = socket.socket(fileno=descriptors[0])
            descriptors.pop()  # ownership transfers only after socket validation
            connected_socket(child, socket.SOCK_STREAM)
        return operation, request_id, child
    except (OSError, ValueError, TypeError, RecursionError, LaunchRefused):
        if child is not None:
            child.close()
        raise LaunchRefused() from None
    finally:
        for descriptor in descriptors:
            os.close(descriptor)


def send(
    connection: socket.socket, operation: str, request_id: str, child: socket.socket | None = None
) -> None:
    payload = encode(operation, request_id)
    ancillary = []
    if (operation == "launch") != (child is not None):
        raise LaunchRefused()
    if child is not None:
        connected_socket(child, socket.SOCK_STREAM)
        ancillary = [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array("i", [child.fileno()]))]
    if connection.sendmsg([payload], ancillary) != len(payload):
        raise LaunchRefused()
