"""Persisted X25519 connector keypair for the local stdio MCP server.

The local stdio MCP process (spawned by `npx @hushh/mcp` or a direct
`python mcp_server.py` invocation) runs as the developer's own trusted
software on their own machine. Before this module existed, an LLM host
would have to generate a fresh X25519 keypair on every session and pass its
public half into `request_consent`, with no way to remember which key a
prior wrapped-key bundle targeted (`connector_key_id`) once the session
ended. That produced two problems: the LLM sometimes forgot/mismatched keys
across turns, and every large scoped export had to travel to the LLM as raw
ciphertext because the LLM's own sandbox (not this local trusted process)
held the only private key.

This module gives the local stdio MCP server ITS OWN long-lived identity: a
single X25519 keypair generated once per installation and persisted to
disk, so `request_consent` never needs the LLM to supply
`connector_public_key`/`connector_key_id`/`connector_wrapping_alg`, and
`get_encrypted_scoped_export` can decrypt scoped exports locally using the
same key that was used to request consent.

Storage location: `${HUSHH_MCP_STATE_DIR:-~/.hushh/mcp}/connector_keypair.json`,
directory permissions `0700`, file permissions `0600`. This is intentionally
the FIRST local per-installation state convention in this codebase (no prior
`~/.hushh/` directory exists); scope is deliberately narrow (just this one
keypair file).

This module is ONLY ever used by the local stdio transport
(`mcp_modules.transport_context.is_local_stdio_transport()` gates all
call sites). The remote/hosted MCP transport never touches this module and
continues to require connectors to supply their own keys.
"""

from __future__ import annotations

import json
import os
import stat
import tempfile
from dataclasses import dataclass
from pathlib import Path
from uuid import uuid4

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey

_WRAPPING_ALG = "X25519-AES256-GCM"
_KEYPAIR_FILENAME = "connector_keypair.json"


@dataclass(frozen=True)
class LocalConnectorKeyPair:
    private_key: X25519PrivateKey
    public_key_b64: str
    key_id: str
    wrapping_alg: str = _WRAPPING_ALG


def _state_dir() -> Path:
    override = str(os.environ.get("HUSHH_MCP_STATE_DIR", "")).strip()
    if override:
        return Path(override).expanduser()
    return Path.home() / ".hushh" / "mcp"


def _keypair_path() -> Path:
    return _state_dir() / _KEYPAIR_FILENAME


def _b64encode(value: bytes) -> str:
    import base64

    return base64.b64encode(value).decode("utf-8")


def _b64decode(value: str) -> bytes:
    import base64

    return base64.b64decode(value)


def _generate_keypair() -> LocalConnectorKeyPair:
    private_key = X25519PrivateKey.generate()
    public_bytes = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    return LocalConnectorKeyPair(
        private_key=private_key,
        public_key_b64=_b64encode(public_bytes),
        key_id=f"local-mcp-{uuid4().hex[:12]}",
    )


def _load_keypair(path: Path) -> LocalConnectorKeyPair | None:
    try:
        raw = path.read_text(encoding="utf-8")
        record = json.loads(raw)
        private_key = X25519PrivateKey.from_private_bytes(
            _b64decode(str(record["private_key_b64"]))
        )
        return LocalConnectorKeyPair(
            private_key=private_key,
            public_key_b64=str(record["public_key_b64"]),
            key_id=str(record["key_id"]),
            wrapping_alg=str(record.get("wrapping_alg") or _WRAPPING_ALG),
        )
    except (OSError, json.JSONDecodeError, KeyError, ValueError, TypeError):
        return None


def _write_keypair(path: Path, keypair: LocalConnectorKeyPair) -> None:
    directory = path.parent
    directory.mkdir(parents=True, exist_ok=True)
    os.chmod(directory, stat.S_IRWXU)  # 0700: owner rwx only

    private_bytes = keypair.private_key.private_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PrivateFormat.Raw,
        encryption_algorithm=serialization.NoEncryption(),
    )
    record = {
        "private_key_b64": _b64encode(private_bytes),
        "public_key_b64": keypair.public_key_b64,
        "key_id": keypair.key_id,
        "wrapping_alg": keypair.wrapping_alg,
    }

    # Atomic write: write to a temp file in the same directory, then replace,
    # so a crash mid-write never leaves a corrupt/partial keypair file.
    fd, tmp_path_str = tempfile.mkstemp(
        dir=str(directory), prefix=".connector_keypair-", suffix=".tmp"
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as tmp_file:
            json.dump(record, tmp_file)
        os.chmod(tmp_path_str, stat.S_IRUSR | stat.S_IWUSR)  # 0600: owner rw only
        os.replace(tmp_path_str, path)
    except BaseException:
        Path(tmp_path_str).unlink(missing_ok=True)
        raise


def get_or_create_local_connector_keypair() -> LocalConnectorKeyPair:
    """Load the persisted local connector keypair, generating it on first use.

    Idempotent: repeated calls within the same installation return the same
    key_id/public key. A missing or corrupt keypair file is treated as
    first-run and silently regenerated (grants encrypted to the discarded
    key become undecryptable locally; `request_consent` self-heals this by
    always targeting the current persisted key going forward).
    """
    path = _keypair_path()
    existing = _load_keypair(path)
    if existing is not None:
        return existing

    keypair = _generate_keypair()
    _write_keypair(path, keypair)
    return keypair
