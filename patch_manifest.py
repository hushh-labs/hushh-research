import json
with open("consent-protocol/db/release_migration_manifest.json", "r") as f:
    text = f.read()

import re
text = re.sub(r"<<<<<<< HEAD\n(.*?)=======\n(.*?)\n>>>>>>> origin/main", r"\1,\n\2", text, flags=re.DOTALL)
# But wait, 198 is duplicated. Let's just manually replace the conflict block with:
# "198_actor_identity_verified_phone_uniqueness.sql",
# "199_one_location_auto_approve_multi_circle_scope.sql",
# "200_contact_sync_directory_policy_lock.sql",
# "201_account_deletion_tombstones.sql",
# "202_gmail_authorized_send_enablement_backfill.sql"

