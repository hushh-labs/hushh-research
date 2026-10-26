# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Preserve the exact WorkOS mutation-purpose successor during phone replay."""

from __future__ import annotations

import hashlib
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from db.migration_authority import MigrationManifestEntryV2

SOURCE = ("425", "425_account_phone_transfers.sql")
_CHECKSUM = "7b7d40e23677ff8ffe13fbd27e1f6fc17e4ce070d335ac2f7ed351c2f915f871"
_LEGACY = """ALTER TABLE public.account_firebase_mutations DROP CONSTRAINT IF EXISTS account_firebase_mutations_purpose_check;
ALTER TABLE public.account_firebase_mutations ADD CONSTRAINT account_firebase_mutations_purpose_check
 CHECK(purpose IN ('display_name','welcome_marker','phone_unlink'));"""
_SUCCESSOR = (
    "CHECK ((purpose = ANY (ARRAY['display_name'::text, 'welcome_marker'::text, "
    "'phone_unlink'::text, 'sso_claims'::text, 'sso_create'::text, 'sso_offboarding'::text])))"
)


def phone_mutation_replay_sql(entry: MigrationManifestEntryV2) -> str:
    """Adapt one immutable CHECK replacement, retaining all other phone DDL."""
    checksum = hashlib.sha256(entry.sql.encode("utf-8")).hexdigest()
    if (
        (entry.migration_id, entry.filename) != SOURCE
        or checksum != _CHECKSUM
        or entry.checksum_sha256 != checksum
        or entry.sql.count(_LEGACY) != 1
    ):
        raise ValueError("Phone mutation replay source checksum changed")
    expected = _SUCCESSOR.replace("'", "''")
    guard = f"""DO $phone_mutation_replay$
BEGIN
 LOCK TABLE public.account_firebase_mutations IN ACCESS EXCLUSIVE MODE;
 IF to_regclass('public.account_workos_memberships') IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint c
    WHERE c.conrelid='public.account_firebase_mutations'::regclass
     AND c.conname='account_firebase_mutations_purpose_check'
     AND c.contype='c' AND c.convalidated
     AND pg_get_constraintdef(c.oid)='{expected}') THEN
   RAISE EXCEPTION 'WorkOS mutation purpose successor changed; refusing phone replay';
  END IF;
 ELSE
  {_LEGACY}
 END IF;
END $phone_mutation_replay$;"""
    return entry.sql.replace(_LEGACY, guard, 1)
