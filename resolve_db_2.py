import re

files = [
    "consent-protocol/db/contracts/dev_minimum_schema.json",
    "consent-protocol/db/contracts/prod_core_schema.json",
    "consent-protocol/db/contracts/uat_integrated_schema.json"
]

for file in files:
    with open(file, "r") as f:
        text = f.read()
    
    text = re.sub(r"<<<<<<<.*?\n(.*?)=======\n.*?\n>>>>>>>.*?\n", r'"expected_migration_version": 202,\n', text, flags=re.DOTALL)
    with open(file, "w") as f:
        f.write(text)

with open("consent-protocol/db/release_migration_manifest.json", "r") as f:
    manifest = f.read()

manifest_replacement = """    "198_actor_identity_verified_phone_uniqueness.sql",
    "199_one_location_auto_approve_multi_circle_scope.sql",
    "200_contact_sync_directory_policy_lock.sql",
    "201_account_deletion_tombstones.sql",
    "202_gmail_authorized_send_enablement_backfill.sql"\n"""

manifest = re.sub(r"<<<<<<<.*?\n.*?=======\n.*?\n>>>>>>>.*?\n", manifest_replacement, manifest, flags=re.DOTALL)

with open("consent-protocol/db/release_migration_manifest.json", "w") as f:
    f.write(manifest)
