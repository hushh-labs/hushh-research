#!/usr/bin/env python3
"""
Add onboarding_completed column to existing vault_keys table.

This is a one-time migration to add the onboarding tracking column.
Run with: python db/repair/add_onboarding_column.py
"""

import asyncio
import sys

from dotenv import load_dotenv

load_dotenv()

import asyncpg  # noqa: E402

from db.connection import get_database_ssl, get_database_url  # noqa: E402


async def main():
    try:
        database_url = get_database_url()
        ssl_config = get_database_ssl()
    except EnvironmentError as e:
        print(f"❌ ERROR: {e}")
        sys.exit(1)

    print("Connecting to database...")
    print(f"   SSL: {'enabled' if ssl_config else 'disabled'}")

    pool = await asyncpg.create_pool(
        database_url,
        min_size=1,
        max_size=2,
        ssl=ssl_config,
    )

    try:
        print("Connected successfully!")

        # Check if column already exists
        result = await pool.fetchval("""
            SELECT COUNT(*)
            FROM information_schema.columns
            WHERE table_name = 'vault_keys'
            AND column_name = 'onboarding_completed'
        """)

        if result > 0:
            print("✅ Column 'onboarding_completed' already exists!")
        else:
            print("📦 Adding 'onboarding_completed' column to vault_keys...")

            await pool.execute("""
                ALTER TABLE vault_keys
                ADD COLUMN onboarding_completed BOOLEAN DEFAULT FALSE
            """)

            print("✅ Column added successfully!")

        # Verify
        count = await pool.fetchval("SELECT COUNT(*) FROM vault_keys")
        print(f"\n📊 vault_keys table: {count} rows")

        # Show sample
        sample = await pool.fetch("""
            SELECT user_id, onboarding_completed
            FROM vault_keys
            LIMIT 3
        """)

        print("\nSample rows:")
        for row in sample:
            print(
                f"   {row['user_id'][:8]}... → onboarding_completed: {row['onboarding_completed']}"
            )

        print("\n✅ Migration complete!")

    finally:
        await pool.close()


if __name__ == "__main__":
    asyncio.run(main())
