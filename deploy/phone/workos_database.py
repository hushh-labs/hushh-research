# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Read-only WorkOS authority inventory on an already-owned database connection."""

def _database_empty(connection) -> dict:
    connection.set_session(
        isolation_level="REPEATABLE READ", readonly=True, autocommit=False
    )
    with connection.cursor() as cursor:
        cursor.execute("SET LOCAL statement_timeout='5000ms'")
        cursor.execute("SET LOCAL lock_timeout='3000ms'")
        cursor.execute(
            "SELECT to_regclass('public.account_workos_memberships') IS NOT NULL"
        )
        installed = cursor.fetchone()[0]
        if type(installed) is not bool:
            raise ValueError("workos_membership_inventory_unavailable")
        if installed:
            cursor.execute(
                "SELECT EXISTS(SELECT 1 FROM public.account_workos_memberships)"
            )
            if cursor.fetchone()[0] is not False:
                raise ValueError("workos_membership_authority_already_exists")
        cursor.execute(
            "SELECT to_regclass('public.account_firebase_mutations') IS NOT NULL"
        )
        receipts_installed = cursor.fetchone()[0]
        if type(receipts_installed) is not bool:
            raise ValueError("workos_receipt_inventory_unavailable")
        if receipts_installed:
            cursor.execute(
                "SELECT EXISTS(SELECT 1 FROM public.account_firebase_mutations WHERE purpose IN ('sso_claims','sso_create','sso_offboarding'))"
            )
            if cursor.fetchone()[0] is not False:
                raise ValueError("workos_mutation_authority_already_exists")
    return {
        "membership_table_exists": installed,
        "memberships_empty": True,
        "sso_receipts_empty": True,
        "receipt_table_exists": receipts_installed,
    }
