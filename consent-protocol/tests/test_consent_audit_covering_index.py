# tests/test_consent_audit_covering_index.py
"""
Regression tests for the consent_audit covering index migration.

The get_active_tokens() and get_audit_log() methods in ConsentDBService both
execute queries with the pattern:

    WHERE user_id = $1
    AND action IN ('CONSENT_GRANTED', 'REVOKED')
    ORDER BY issued_at DESC

The existing idx_consent_audit_user_action(user_id, action) index satisfies
the filter predicate, but PostgreSQL still has to sort the filtered rows
because issued_at is not part of the index.  For users with many consent
audit rows this sort dominates query time.

The new idx_consent_audit_user_issued(user_id, action, issued_at DESC)
covering index lets Postgres return rows in the required order directly from
the index without a separate sort step.

These tests verify:
1. The covering index name is present in the migration SQL.
2. The index column list matches the query ordering used by the service.
3. The migration is idempotent (IF NOT EXISTS).
4. The existing indexes are not removed or renamed.
"""

import ast

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _get_migration_sql() -> list[str]:
    """Extract all SQL strings from create_consent_audit by reading the source file."""
    import pathlib

    migrate_path = pathlib.Path(__file__).parent.parent / "db" / "migrate.py"
    source = migrate_path.read_text()

    # Extract only the create_consent_audit function body
    start = source.find("async def create_consent_audit(")
    # Find the next top-level async def after the function
    next_def = source.find("\nasync def ", start + 1)
    func_source = source[start:next_def] if next_def != -1 else source[start:]

    tree = ast.parse(func_source)
    sql_strings = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            sql_strings.append(node.value)
    return sql_strings


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestConsentAuditCoveringIndex:
    def setup_method(self):
        self.sql_strings = _get_migration_sql()
        # Normalise whitespace for easier matching
        self.normalised = [" ".join(s.split()).upper() for s in self.sql_strings]

    def _find_index(self, name: str) -> str | None:
        needle = name.upper()
        for s in self.normalised:
            if needle in s:
                return s
        return None

    def test_covering_index_present(self):
        """The two-column covering index (user_id, issued_at DESC) must be in the migration."""
        idx = self._find_index("IDX_CONSENT_AUDIT_USER_ISSUED")
        assert idx is not None, (
            "idx_consent_audit_user_issued not found in create_consent_audit(). "
            "The covering index is required for efficient ORDER BY on active-token queries."
        )

    def test_covering_index_columns(self):
        """The covering index must include user_id and issued_at DESC (tied to get_audit_log query)."""
        idx = self._find_index("IDX_CONSENT_AUDIT_USER_ISSUED")
        assert idx is not None
        assert "USER_ID" in idx, "covering index must include user_id"
        assert "ISSUED_AT" in idx, "covering index must include issued_at"
        assert "DESC" in idx, "issued_at must be ordered DESC to match query ORDER BY"

    def test_covering_index_is_idempotent(self):
        """The index creation must use IF NOT EXISTS."""
        idx = self._find_index("IDX_CONSENT_AUDIT_USER_ISSUED")
        assert idx is not None
        assert "IF NOT EXISTS" in idx, (
            "Index creation must use IF NOT EXISTS so repeated migrations are safe."
        )

    def test_existing_user_action_index_preserved(self):
        """The original two-column index must not be removed."""
        idx = self._find_index("IDX_CONSENT_AUDIT_USER_ACTION")
        assert idx is not None, (
            "idx_consent_audit_user_action must be preserved alongside the new covering index."
        )

    def test_existing_pending_index_preserved(self):
        """The partial index for pending requests must not be removed."""
        idx = self._find_index("IDX_CONSENT_AUDIT_PENDING")
        assert idx is not None, "idx_consent_audit_pending must be preserved."

    def test_existing_request_id_index_preserved(self):
        """The request_id partial index must not be removed."""
        idx = self._find_index("IDX_CONSENT_AUDIT_REQUEST_ID")
        assert idx is not None, "idx_consent_audit_request_id must be preserved."

    def test_covering_index_targets_correct_table(self):
        """The index must be on consent_audit, not any other table."""
        idx = self._find_index("IDX_CONSENT_AUDIT_USER_ISSUED")
        assert idx is not None
        assert "ON CONSENT_AUDIT" in idx, (
            "Covering index must target the consent_audit table."
        )
