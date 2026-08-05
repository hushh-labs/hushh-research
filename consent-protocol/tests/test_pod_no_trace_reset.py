"""S7: the control plane keeps no private intelligence after a reset.

The founder's decision for the developer phase is **reset, not migrate**: a pod
starts clean, and the hub-side copy of the user's private intelligence is
cleared rather than re-encrypted and moved. That makes "no trace with Hushh" a
property the code can be held to, so this asserts it on the real cascade rather
than trusting a table list read by eye.

What counts as private intelligence on the control plane (all verified to exist
and to be keyed by ``user_id``):

* ``pkm_index`` -- holds ``domain_summaries``, natural-language prose about the
  owner, in plaintext;
* ``pkm_manifest_paths`` -- holds ``json_path``, the semantic shape of a life;
* ``pkm_blobs`` / ``pkm_manifests`` -- the record bodies;
* ``pwm_documents`` -- the preference world model (migration 118);
* ``kai_receipt_memory_artifacts`` -- receipt-derived memory;
* ``agent_chat_messages`` / ``agent_chat_conversations`` -- forfeited, not moved.

The tests drive ``_clear_user_data_tables`` -- the method ``reset_account``
actually calls -- against a recording connection, so a table dropped from the
cascade fails here instead of quietly surviving in production.
"""

from __future__ import annotations

from typing import Any, Optional

from hushh_mcp.services.account_service import AccountService

# Every hub-side surface that must not survive a reset.
PRIVATE_INTELLIGENCE_TABLES = (
    "pkm_index",
    "pkm_manifest_paths",
    "pkm_manifests",
    "pkm_blobs",
    "pkm_events",
    "pwm_documents",
    "kai_receipt_memory_artifacts",
    "agent_chat_messages",
    "agent_chat_conversations",
)

# The identity spine a reset deliberately KEEPS, so the owner and their vault
# survive and the pod can re-bind. Deleting these would be a different operation.
IDENTITY_SPINE_TABLES = (
    "vault_keys",
    "vault_key_wrappers",
    "actor_profiles",
    "actor_identity_cache",
    "actor_verified_email_aliases",
)


class _Result:
    def __init__(self, value: Any) -> None:
        self._value = value

    def scalar(self) -> Any:
        return self._value


class _RecordingConn:
    """Records every statement the cascade issues; every table 'exists'."""

    def __init__(self) -> None:
        self.statements: list[str] = []

    def execute(self, query: Any, params: Optional[dict] = None) -> _Result:
        sql = " ".join(str(query).split())
        if "to_regclass" in sql:
            return _Result(True)  # every table exists, so nothing is skipped
        self.statements.append(sql)
        return _Result(None)


def _run_reset_cascade() -> _RecordingConn:
    conn = _RecordingConn()
    AccountService()._clear_user_data_tables(conn, "firebase-uid-reset-me", {})
    return conn


def _deletes_from(conn: _RecordingConn, table: str) -> bool:
    return any(f"DELETE FROM {table} " in f"{sql} " for sql in conn.statements)


def test_the_reset_clears_every_private_intelligence_surface():
    conn = _run_reset_cascade()
    missing = [t for t in PRIVATE_INTELLIGENCE_TABLES if not _deletes_from(conn, t)]
    assert not missing, f"private intelligence would survive a reset: {missing}"


def test_the_reset_keeps_the_identity_spine():
    """A reset is not a deletion: the owner, their vault, and their identity stay."""
    conn = _run_reset_cascade()
    kept = [t for t in IDENTITY_SPINE_TABLES if _deletes_from(conn, t)]
    assert not kept, f"a reset must not clear the identity spine: {kept}"


def test_every_cascade_table_is_registered_so_cleanup_cannot_raise():
    """``_delete_user_rows_if_table_exists`` raises for an unregistered table.

    A table added to a cleanup list but not to ``_delete_by_user_queries`` turns
    account deletion into a ValueError the first time it runs somewhere the table
    actually exists. Driving the real cascade proves every name it passes is
    registered -- the reset above would raise rather than fail an assertion.
    """
    conn = _run_reset_cascade()
    assert conn.statements, "the cascade issued no statements at all"


def test_the_preference_world_model_has_a_user_scoped_cleanup_statement():
    """pwm_documents is private intelligence; its cleanup must be user-scoped."""
    statement = " ".join(str(AccountService()._delete_by_user_queries["pwm_documents"]).split())
    assert statement == "DELETE FROM pwm_documents WHERE user_id = :user_id"
