import asyncio
import os
import sys

# Ensure consent-protocol is in path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from db.connection import get_pool


async def run():
    pool = await get_pool()
    async with pool.acquire() as conn:
        count = await conn.fetchval("SELECT COUNT(*) FROM actor_profiles")
        print(f"Total rows in actor_profiles: {count}")

        rows = await conn.fetch("SELECT * FROM actor_profiles LIMIT 20")
        print("First 20 rows of actor_profiles:")
        for r in rows:
            print(dict(r))


if __name__ == "__main__":
    asyncio.run(run())
