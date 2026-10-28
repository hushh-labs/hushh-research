"""The fixed legacy table seam missing from exact S's canonical initializer.

Only three hash-pinned CREATE TABLE statements are admitted. The complete
legacy/local scripts are never executed. No reads or writes happen on import.
"""

from __future__ import annotations

import hashlib

import release_source
from qualification_target import SOURCE, require

PATH = "consent-protocol/db/legacy/init_legacy_schema.sql"
SHA256 = "7d3c0adbaf24ce0fa5496adc95ca68e176f896b0d4e7131cd717300b198ea531"
FRAGMENTS = (
    ("kai_gmail_connections", "6b1b9180330bce0744d0970b41ee2a95aacc3fc71907c363b0c17bd5a5baa5d7"),
    ("kai_gmail_sync_runs", "7bde55d687b5e750cd5ec1984e120879d7c017b70d843dfaba1fd28307e96c25"),
    ("kai_gmail_receipts", "49da84d2f80b3a601363221e725e55795fa31e5ec45a72ff27642baa91db0f7a"),
)


def binding() -> dict:
    return {
        "sourcePath": PATH,
        "sourceSha256": SHA256,
        "sourceSha": SOURCE,
        "precedingCanonicalArguments": [
            "--table",
            "vault_keys",
            "--release-environment",
            "production",
        ],
        "fragments": [{"table": name, "sha256": digest} for name, digest in FRAGMENTS],
        "includesLegacyIndexes": False,
        "includesLegacyRows": False,
    }


def fragments() -> tuple[tuple[str, bytes], ...]:
    """Extract only the reviewed statements from the immutable Git object."""
    content = release_source._git("show", SOURCE + ":" + PATH)
    require(hashlib.sha256(content).hexdigest() == SHA256, "qualification_base_source_changed")
    result, previous_end = [], -1
    for name, digest in FRAGMENTS:
        start_marker = b"CREATE TABLE IF NOT EXISTS " + name.encode() + b" ("
        require(content.count(start_marker) == 1, "qualification_base_fragment_ambiguous")
        start = content.index(start_marker)
        end = content.find(b"\n);", start)
        require(start > previous_end and end >= start, "qualification_base_fragment_order_changed")
        end += len(b"\n);")
        statement = content[start:end] + b"\n"
        require(
            hashlib.sha256(statement).hexdigest() == digest, "qualification_base_fragment_changed"
        )
        result.append((name, statement))
        previous_end = end
    return tuple(result)


def arguments(initializer: bool, vault: bool) -> list[str]:
    """Select finite canonical arguments, never a caller-supplied SQL/CLI path."""
    require(
        type(initializer) is bool and type(vault) is bool and (initializer or not vault),
        "qualification_source_phase_invalid",
    )
    if not initializer:
        return []
    return ["--table", "vault_keys"] if vault else ["--init"]


def install(connection, source) -> None:
    """Called only after the parent schema's locked fresh/identity admission."""
    require(connection.autocommit, "qualification_schema_autocommit_required")
    statements = fragments()  # Verify every statement before the first write.
    source(vault=True)
    for _name, statement in statements:
        with connection.cursor() as cursor:
            cursor.execute(statement.decode())
    source(vault=False)
