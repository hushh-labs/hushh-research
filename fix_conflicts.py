import re

def fix_schemas():
    for file in ["consent-protocol/db/contracts/dev_minimum_schema.json", "consent-protocol/db/contracts/prod_core_schema.json", "consent-protocol/db/contracts/uat_integrated_schema.json"]:
        with open(file, "r") as f:
            text = f.read()
        
        text = re.sub(r"<<<<<<< HEAD\n.*?=======\n(.*?)\n>>>>>>> origin/main", r'"expected_migration_version": 202,', text, flags=re.DOTALL)
        with open(file, "w") as f:
            f.write(text)

def fix_manifest():
    with open("consent-protocol/db/release_migration_manifest.json", "r") as f:
        manifest = f.read()

    manifest_replacement = """    "198_actor_identity_verified_phone_uniqueness.sql",
    "199_one_location_auto_approve_multi_circle_scope.sql",
    "200_contact_sync_directory_policy_lock.sql",
    "201_account_deletion_tombstones.sql",
    "202_gmail_authorized_send_enablement_backfill.sql\""""

    manifest = re.sub(r"<<<<<<< HEAD\n.*?=======\n.*?\n>>>>>>> origin/main", manifest_replacement, manifest, flags=re.DOTALL)
    with open("consent-protocol/db/release_migration_manifest.json", "w") as f:
        f.write(manifest)

def fix_action_tools():
    with open("consent-protocol/hushh_mcp/one_adk/action_tools.py", "r") as f:
        content = f.read()

    content = re.sub(
        r"<<<<<<< HEAD\n(.*?)=======\n(.*?)\n>>>>>>> origin/main",
        r"\1\n\2",
        content,
        flags=re.DOTALL
    )

    with open("consent-protocol/hushh_mcp/one_adk/action_tools.py", "w") as f:
        f.write(content)

fix_schemas()
fix_manifest()
fix_action_tools()
