"""WorkOS boundary in the existing real PostgreSQL erase/enroll rehearsal."""

import asyncio
from unittest.mock import patch

import asyncpg
import pytest

from hushh_mcp.services import account_firebase_mutations as mutations
from hushh_mcp.services.enterprise_sso import membership
from hushh_mcp.services.enterprise_sso.errors import EnterpriseSsoError
from hushh_mcp.services.enterprise_sso.workos_adapter import DirectoryMembership, SsoProfile


class GenerationMembershipRehearsal:
    def __init__(self, engine, identity):
        self.engine = engine
        self.identity = identity
        self.store = membership.SqlMembershipStore()
        self.profile = SsoProfile(
            "prof_original",
            "org_original",
            "person@example.com",
            connection_id="conn_original",
            idp_id="idp_original",
        )
        self.directory = DirectoryMembership("directory_original", "directory_user_original")

    def capture(self, owner):
        with patch.object(membership, "get_db_connection", self.engine.begin):
            assert self.store.capture(owner, self.profile, None, "linked") is None
            profile_key = membership.membership_hash("org_original", self.profile.id)
            assert self.store.admit_profile(profile_key, owner)
            key = self.store.capture(owner, self.profile, self.directory, "linked")
            assert self.store.admit(key, owner)
            assert (
                self.store.offboard(
                    "org_original", self.directory.directory_id, self.directory.user_id
                ).owner_id
                == owner
            )

    def mutation_callbacks(self, owner):
        def begin(captured_owner=owner):
            with patch.object(mutations, "get_db_connection", self.engine.begin):
                return mutations.begin(
                    captured_owner,
                    purpose="sso_offboarding"
                    if captured_owner == self.identity
                    else "display_name",
                    authority_project="synthetic-project",
                )

        def settle(permit, outcome):
            with patch.object(mutations, "get_db_connection", self.engine.begin):
                return mutations.settle(permit, outcome)

        return begin, settle

    async def assert_retired(self, conn):
        with patch.object(membership, "get_db_connection", self.engine.begin):
            captured = await asyncio.to_thread(
                self.store.offboard,
                "org_original",
                self.directory.directory_id,
                self.directory.user_id,
            )
            assert captured.owner_id is None
            with pytest.raises(EnterpriseSsoError):
                await asyncio.to_thread(
                    self.store.capture, self.identity, self.profile, self.directory, "linked"
                )
            with pytest.raises(asyncpg.InsufficientPrivilegeError):
                await conn.execute("DELETE FROM account_workos_memberships")
