"""Declared account-deletion outcome for tables the erasure path does not remove.

Every table with an account identity column (the migration-201 write-guard
pattern: ``user_id``, ``firebase_uid``, ``user_<x>_id``, ``*_user_id``,
``*_firebase_uid``) must end a full account deletion in exactly one state:

* DELETED  -- a ``DELETE`` in the full-deletion path targets it, or a foreign key
  on its identity column to a DELETED table removes (CASCADE) or blocks
  (RESTRICT / NO ACTION) its rows. Both are derived from the migrations and
  the code by ``tests/services/test_account_erasure_coverage.py``.
* one of the declarations below, each with the reason it is not a plain delete.

The coverage test currently reports advisory findings unless enforcement is enabled.
Its executing inventory companion separately verifies the known erasure paths;
advisory coverage alone must not be described as a release gate.

Retention here is a current-state record, not a legal determination. Changing
any RETAINED or ANONYMIZED entry is a privacy/legal policy decision.
"""

from __future__ import annotations

from collections.abc import Mapping
from types import MappingProxyType

# Kept with the raw account UID after deletion.
RETAINED_ON_ACCOUNT_DELETION: Mapping[str, str] = MappingProxyType(
    {
        "fabric_receipts": (
            "Append-only, signed, hash-chained subscription receipt ledger. The schema "
            "has no chain-safe subject-redaction primitive, so rows (user_id, scopes, "
            "fields, purpose) are retained until a legal redaction policy is approved."
        ),
        "hushh_tech_link_events": (
            "Append-only audit provenance for the synthetic UAT legacy-account link "
            "migration, intentionally not foreign-keyed; removed only by the approved "
            "UAT audit-retention process."
        ),
    }
)

# Kept only in a form that no longer carries the raw account UID.
ANONYMIZED_ON_ACCOUNT_DELETION: Mapping[str, str] = MappingProxyType(
    {
        "account_deletion_tombstones": (
            "Created by deletion. Keeps a SHA-256 UID digest indefinitely to stop the "
            "account being recreated; the raw firebase_uid exists only until Firebase "
            "cleanup completes (CHECK: completed implies firebase_uid IS NULL)."
        ),
    }
)

# Removed by a scoped delete of the owning parent rather than by its own id.
DELETED_WITH_OWNED_PARENT: Mapping[str, str] = MappingProxyType(
    {
        "drive_share_events": (
            "Rows are written for either participant of a share request. "
            "erase_drive_account_in_transaction deletes every event of each request the "
            "account owns or receives, before deleting the request itself."
        ),
    }
)

# Parked-migration tables with no writer in this shared runtime.
PARKED_OUTSIDE_SHARED_RUNTIME: Mapping[str, str] = MappingProxyType(
    {
        "consent_audit_receipts": (
            "Private-pod runtime only; append-only receipt chain keyed by subject_id. "
            "Retained if present, like fabric_receipts."
        ),
    }
)

ACCOUNT_ERASURE_DECLARATIONS: Mapping[str, Mapping[str, str]] = MappingProxyType(
    {
        "retained": RETAINED_ON_ACCOUNT_DELETION,
        "anonymized": ANONYMIZED_ON_ACCOUNT_DELETION,
        "deleted_with_owned_parent": DELETED_WITH_OWNED_PARENT,
        "parked_outside_shared_runtime": PARKED_OUTSIDE_SHARED_RUNTIME,
    }
)
