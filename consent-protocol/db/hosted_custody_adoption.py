"""Preserve the reviewed installed custody family without installing pilot authority."""

from __future__ import annotations

import hashlib
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from db.migration_authority import MigrationManifestEntryV2

QUALIFIED = {
    "erasure_authorization_history(jsonb,jsonb)": "229ae3dadf31ae73f9c84e55ad4be9c57da79e8dece62838fc6b663c07ab2bad",
    "erasure_managed_model_grants_complete(jsonb)": "ab7ad9ac87b2a2acd524de7d8f794b1a9ba3c0bffa39996c2c9fa21333a6fcba",
    "erasure_private_coordinates(jsonb)": "1390d7709aef509377b352995a8354ce9d25c60f871e3f7b9d05ad72ebb5ffe5",
    "expected_erasure_bootstrap_release(text,jsonb,text)": "5f147b9ea109568a120653b39373d1f607986b0cbd1f9b3133c851ad73d99eb5",
    "guard_personal_agent_erasure_registry()": "1e2357c1d4d76fd6e78b16137734bf59cfa18f4229200c653cce9bc3315db0d1",
    "guard_project_grant_registry_admission()": "38822c10a774c8c8602cf8b2788436a83958167b7bcfb302d37eef3bcb9e3d54",
    "hosted_pod_cleanup_admitted(text,text,jsonb)": "8c9507d2151caede029d26b1784c3772bc7c4e959b3bf3e8a8766f8865e51735",
    "hosted_pod_execution_admitted(text,text,jsonb,jsonb,text)": "8361affe67f04eb6269e2bbec93d43b2893c8fbfb9681e5db0f69907cccdd166",
    "hosted_pod_retained_admitted(text,jsonb)": "7886341ac8363c3ef491746978e5d4863c24a74b84531ebd2ce29a7d7c7ba954",
    "hosted_pod_upgrade_admitted(text,text,jsonb,boolean)": "a3b2321d76a773ae76378fe640eca1f65a70445c25feb64a37b0c90e70e47455",
    "hosted_prefix_abort_admitted(text,text,jsonb)": "4d3662ef87909557b354c6e86f5a147f9f84768e35f98aa52222e330fdbb4f74",
    "hosted_preparation_cleanup_admitted(text,text,jsonb)": "087392d6dd4740ecbe1cc43e19e8da6a01d578570c7bd4257881e97d10ae8777",
    "managed_prefix_abort_complete(jsonb)": "9e56151f811ac3a2a988936a300cb8821831a7e0ac0bb74292f7b29848bdb7c6",
    "managed_prefix_abort_context(jsonb)": "8b3db943f9f15243b8b4ebfff0ce2df885d2f8b7e3232de25c49d1038ae5666b",
    "managed_prefix_base(jsonb)": "e1a538e3f5b421ec335d5cedf31a5dd4f2eb3b900bd0f71ca94f85c90b90ba80",
    "managed_prefix_binding_contract(jsonb,text,text)": "659d1a4a44cf64fc8aae0b884c651cb4e6a9cfb47cdb2d51a79cefed6e32d4e6",
    "managed_prefix_bindings(jsonb)": "9524a16f3de16d3c348f72b609704b85a8ba4ce3b3dfe26de8d6c11c2446fb1b",
    "managed_prefix_failed_binding_checks(jsonb)": "2a0a91ae45c72d8f7e4cdf364ab712f3fd276e59ea85d7bb363b87e6d691f110",
    "managed_prefix_item_admission(jsonb,text,text,jsonb)": "e053b4c85a535a858bb44b04608645dbc14ac2b4e2e104ff5f824a45c9714a88",
    "managed_prefix_items_complete(jsonb,text)": "f9045b96b23494155262ba6a8e65e0f144858815b5f76ba05dea0f438c380c1d",
    "managed_prefix_nonkey_complete(jsonb)": "8946501ad98378562c5c1f494a429755c4b4d4442853da4d8d56dc0e84a434d5",
    "managed_prefix_resource_name(jsonb,jsonb)": "deb6064753f49150ff1203696ff389df7bee108a0df903577f8965f040139de6",
    "managed_prefix_resource_step(text)": "b2e0027531cc18ada63b213fc5150272c5b6f1590b24b1c1730709bfb43e2184",
    "managed_prefix_terminal_failure(jsonb)": "b7eaaec9175bcd93b2bc813f1d28a65511ec0ad90556528ba96874f423913cbc",
    "managed_preparation_cleanup_coordinates(jsonb)": "b579eb521662df03cdfc108ca92bab129fbfa24a6c71bb689f811c70c69fc54c",
    "personal_agent_erasure_archive(jsonb,jsonb)": "9a7a7b1bb39aa33c5f397eb0e42848aeeaceb16931e043fc9ccc7f8f20ddbee8",
    "personal_agent_erasure_archived(text,jsonb,jsonb)": "842f2a6bfa25429a970a2508c9ef84e525175c7e69e91875f18fcb7253b4d7f8",
    "personal_agent_erasure_complete(text)": "7f28101ba074765abb5699bf8dd42668e8449e77229ec43033d511fc3a217467",
    "private_gcp_coordinates(jsonb)": "1276132589bc5b003fb031bb84e5f8a5b7e4b9c5b2ab707c1f3576823e86e03c",
    "project_grant_release_is_exclusive(text,text)": "600d73daf4d90be870860e24fc5e7ee8130acf2a46afac5ae1a72def433e6a1e",
    "reserve_erasure_grant_release(text,text,jsonb)": "6a2e27053b8c0d2e3abef78c446a1fd653bf93d1ad2d3edb800f6f3a5b400855",
    "reserve_personal_agent_erasure(text,text)": "08490d2bfdf17c5cbd6163216f924548a17192ff0139a0997266624d6974f420",
    "retain_erasure_managed_model_grant_receipt(text,text,jsonb,text,text,jsonb)": "ba959ceb4ac55f3b3b93ada3fac883faf2fd697cb5dbe083b3160a9e202d4912",
    "retain_erasure_managed_project_retirement(text,text,jsonb,text,jsonb)": "1c83c62a23b3f8e050c3d15ec76153c9ffc5a7b0f874b515443645585f54a50b",
    "retain_hosted_pod_project_authorization(text,text)": "69a3a70f7793e2a2936d14143defde00cf01534eb8abb08f75210519ac1da862",
    "retain_managed_prefix_abort(text,text,jsonb,text,text,text,jsonb)": "992cc805c1b0190176213c2432043d9af2f938cdb10a585e0ffe8eadb69c21a3",
    "retain_managed_preparation_cleanup(text,text,jsonb,text,jsonb)": "4ca371403a38e1e05da0478862fc5d8c2560ed1b1be0f0c01f45db67a874467d",
    "valid_erasure_files_receipt(jsonb,text,text,jsonb)": "e253b257558adc05bd7c5170f5da9f67dca039800aba75234180a03ea27f964a",
    "valid_erasure_gcp_files_upgrade_observation(jsonb,jsonb)": "96d97d4f2f66d3bcd2555805b21bd712f1b973daae20657053f17652856d0742",
    "valid_erasure_grant_release(jsonb,jsonb)": "4100815e7449e23a730dbb3bedd45c9e8fd736363ef725e956e881183fdb5b6f",
    "valid_erasure_kms_receipt(jsonb,text,jsonb)": "cf50b8fabc20ded749e2094183f484d2e9ab0f710fe9f331999756d6a8e783af",
    "valid_erasure_mail_receipt(jsonb,text,text,jsonb)": "4d4b33ec24b3fff696c7bcc52aa17a8479e0ec4100bff80a58bb226883656ed8",
    "valid_erasure_managed_model_grant_append(jsonb,jsonb)": "c6806e3be69d9420f6a57044cadd68ff698be50d5ed2c3c2f5ed50295ad9e0ff",
    "valid_erasure_managed_model_grant_receipt(jsonb,text,text,jsonb)": "072534ad1f221b060b490dc330e0bf2db061502b5d3186f257c78ae85226a749",
    "valid_erasure_managed_project_retirement(jsonb,text,jsonb)": "6a0728cbf7cd714089199427d2d85d16017c6e95a8d5dd4ef02a6fdd59da0349",
    "valid_erasure_managed_retirement_append(jsonb,jsonb)": "69320963e61384d21aceb1840d22b825da549c9d7c16e72ad4da6705a7565c11",
    "valid_erasure_repository_grant_receipt(jsonb,text,jsonb)": "8ad9954e5381703965b6700056acebf77d4f07624fe778fcec87192245de5799",
    "valid_erasure_repository_inventory(jsonb,jsonb)": "ce792c145b70c2f5515221a2e3cc93add5e2c0ae0182800bce30aafa9ec2ffe4",
    "valid_erasure_secret_receipt(jsonb,text,jsonb)": "40f47265300102f0b7d1f8420820948406b1748b61cba2ca2543aa2a763e0ae3",
    "valid_erasure_writer_receipt(jsonb,text,jsonb)": "b1f78ff6cc79b6a8cb1ca2a2c8f5be2f7bf1699ab5b1d9df585f42e6490bdd81",
    "valid_managed_prefix_abort_append(jsonb,jsonb)": "26c6b0e4b17c15c383d2a00e6af7f872fe16eea8c24f65f0c93b249739cc9ab4",
    "valid_managed_prefix_abort_receipt(jsonb,text,text,text,jsonb)": "1e07021aa73ce4174e6ce6e260fd92037eb585daebcfe999f9cbdc5b88c62be6",
    "valid_managed_prefix_created_identity(jsonb,jsonb,jsonb)": "c9e08edf80dbabb0c3a332d75750d24b00e9a128e4f499d65ee0c6a6374f3eb7",
    "valid_managed_prefix_inventory(jsonb,jsonb)": "9c4d219b79341445768debe3e749c89f539fca7754b84b7c7ed292ed2f18426c",
    "valid_managed_prefix_inventory_admission(jsonb,jsonb)": "2d08b62c03499f51b8a17c4c9a5e4b539ddbea1f1de965ae27181301ac564e11",
    "valid_managed_prefix_item_result(jsonb,text,text,jsonb)": "aacbe09dae8ae55a75a67e406fac2c703441be54169c6ea536e40287d5f59ffa",
    "valid_managed_prefix_memory_absence(jsonb,jsonb)": "14f7ee9eafa2c6cff37e089e58e1bd2f0f0f28426fd9344bf2a036e18d03b3c7",
    "valid_managed_prefix_resource_result(jsonb,jsonb,jsonb,jsonb)": "4f0cdf06677eba2a3167fa3244c45333f754ddcc195114779432c482299e00cd",
    "valid_managed_preparation_cleanup(jsonb,text,jsonb)": "45bc615c0be9c136d49c6e30c8df53990424020ec561facdc122c5f9c3049184",
    "valid_managed_preparation_cleanup_append(jsonb,jsonb)": "7fb22e756f1ca75aa7b475d8cb80a690646a1520487afa3da771cddf71eb8cb5",
}

REFINED = {
    "expected_erasure_bootstrap_release": (
        "'9c7df549d997f7e00af73bdc28816ca337452ff340ea232b0acf27a486b04897'",
        "5f147b9ea109568a120653b39373d1f607986b0cbd1f9b3133c851ad73d99eb5",
    ),
    "guard_personal_agent_erasure_registry": (
        "'28050839ef93e010d92cd5289dda40b6adb020aaf3717f4b23c513aa4503f30a','c7f509dc6824e9a0ab66ae6e30b98e2afdd48483d72754a00c36cb15d0d3f521'",
        "1e2357c1d4d76fd6e78b16137734bf59cfa18f4229200c653cce9bc3315db0d1",
    ),
    "guard_project_grant_registry_admission": (
        "'1912f59585796ac340a29f56fa7875726e742531b716fa9b98612a555cc3a6ca'",
        "38822c10a774c8c8602cf8b2788436a83958167b7bcfb302d37eef3bcb9e3d54",
    ),
    "personal_agent_erasure_archive": (
        "'e43bad73e40984d01c4ea5a01872dc76ce3ba77fce05c48eaffd95118d398685'",
        "9a7a7b1bb39aa33c5f397eb0e42848aeeaceb16931e043fc9ccc7f8f20ddbee8",
    ),
    "personal_agent_erasure_archived": (
        "'869752af19ff5735ad84cfefcb7cdfdc3036646bf137d64e16e04ce57f984bab'",
        "842f2a6bfa25429a970a2508c9ef84e525175c7e69e91875f18fcb7253b4d7f8",
    ),
    "personal_agent_erasure_complete": (
        "'d1e653a9c5323c12e558ed2b2d5483487e50d745424f5d512b91c687cd94dd2d'",
        "7f28101ba074765abb5699bf8dd42668e8449e77229ec43033d511fc3a217467",
    ),
    "project_grant_release_is_exclusive": (
        "'2443acc5b64dd4866dba2f0814a1abad38f031dee12f1f4e2f69e78fb4a8a9f9'",
        "600d73daf4d90be870860e24fc5e7ee8130acf2a46afac5ae1a72def433e6a1e",
    ),
    "reserve_erasure_grant_release": (
        "'31773f73b7057b12261573a9a42f0c3838046723a49598fad1f3c2dfe92506fc'",
        "6a2e27053b8c0d2e3abef78c446a1fd653bf93d1ad2d3edb800f6f3a5b400855",
    ),
    "reserve_personal_agent_erasure": (
        "'cd9672f048b220109cb23cd12e97921f11afddf1616d3bea7fcec10f0eb26195'",
        "08490d2bfdf17c5cbd6163216f924548a17192ff0139a0997266624d6974f420",
    ),
    "valid_erasure_files_receipt": (
        "'dc0122b80000b4c4698f132b11377676b6cb18a31efd5c7e49fd8137428f9ab5'",
        "e253b257558adc05bd7c5170f5da9f67dca039800aba75234180a03ea27f964a",
    ),
    "valid_erasure_gcp_files_upgrade_observation": (
        "'38a8ec11f7099b60c25ed7380f74144d5a14e0f8c42fca42e56ca58689eefa46'",
        "96d97d4f2f66d3bcd2555805b21bd712f1b973daae20657053f17652856d0742",
    ),
    "valid_erasure_grant_release": (
        "'11b5843638035e5e4ac935d43e74b143f4e653a27ed8b19332570307afe4a9a9'",
        "4100815e7449e23a730dbb3bedd45c9e8fd736363ef725e956e881183fdb5b6f",
    ),
    "valid_erasure_kms_receipt": (
        "'d0aa90c25eee793106f325983887305a032202012fe02ca74a55b4bb11b2eac2'",
        "cf50b8fabc20ded749e2094183f484d2e9ab0f710fe9f331999756d6a8e783af",
    ),
    "valid_erasure_mail_receipt": (
        "'e11aa98f323fb42d4b5724f23e20e5b86f26dc77a4f5d2506266e31cdfd84fc2'",
        "4d4b33ec24b3fff696c7bcc52aa17a8479e0ec4100bff80a58bb226883656ed8",
    ),
    "valid_erasure_repository_grant_receipt": (
        "'6d57969cb359757416e6918f061ff95c08b15d1cc39499e1fe571d9a97a30715'",
        "8ad9954e5381703965b6700056acebf77d4f07624fe778fcec87192245de5799",
    ),
    "valid_erasure_repository_inventory": (
        "'6c2d5f82d86f8a97001f252860d3d770744e43bedd07c5b04eef8cfa99f69d3e'",
        "ce792c145b70c2f5515221a2e3cc93add5e2c0ae0182800bce30aafa9ec2ffe4",
    ),
    "valid_erasure_secret_receipt": (
        "'9fd18377bf2d060aac9d7236c708dacefe2b674b19a381b0778ddac15be0672c'",
        "40f47265300102f0b7d1f8420820948406b1748b61cba2ca2543aa2a763e0ae3",
    ),
    "valid_erasure_writer_receipt": (
        "'c25e11f3a85b63082a3adcbd08bf93cd6c9f7f439c0db262df42ac49575cd041'",
        "b1f78ff6cc79b6a8cb1ca2a2c8f5be2f7bf1699ab5b1d9df585f42e6490bdd81",
    ),
}


def hosted_custody_adoption(sql: str) -> str:
    from db.migration_authority import MigrationAuthorityError

    qualification = _successor_qualification()
    for name, (predecessors, successor) in REFINED.items():
        anchor = (
            f"NOT IN ({predecessors}) THEN\n  RAISE EXCEPTION 'Unqualified schema drift: {name}'"
        )
        if sql.count(anchor) != 1:
            raise MigrationAuthorityError(f"Managed custody adoption inventory changed: {name}")
        sql = sql.replace(
            anchor,
            anchor.replace(f"NOT IN ({predecessors})", f"NOT IN ({predecessors},'{successor}')"),
            1,
        )
    return _qualified_transaction(sql, qualification)


RECOVERY_SOURCE_SHA256 = "f637ba12f5eb6fc0b79ad3a1244b65cd972a33fd589c8ffa2425157d6ddcc4f6"


def hosted_custody_recovery_replay(entry: MigrationManifestEntryV2, sql: str) -> str:
    """421 must retain a complete qualified974 guard rather than downgrade it."""
    from db.migration_authority import MigrationAuthorityError

    checksum = hashlib.sha256(entry.sql.encode()).hexdigest()
    if (
        entry.migration_id != "421"
        or entry.filename != "421_cloud_removal_recovery.sql"
        or checksum != RECOVERY_SOURCE_SHA256
        or entry.checksum_sha256 != checksum
    ):
        raise MigrationAuthorityError("Managed custody recovery source checksum changed")
    anchor = "CREATE OR REPLACE FUNCTION public.guard_personal_agent_erasure_registry()"
    if sql.count(anchor) != 1:
        raise MigrationAuthorityError("Managed custody recovery guard shape changed")
    start = sql.index(anchor)
    terminator = sql.find("$$;", start)
    if terminator < 0:
        raise MigrationAuthorityError("Managed custody recovery guard terminator changed")
    end = terminator + 3
    body = sql[start:end]
    if sql.count(body) != 1:
        raise MigrationAuthorityError("Managed custody recovery guard shape changed")
    digest = QUALIFIED["guard_personal_agent_erasure_registry()"]
    wrapped = f"""DO $retain_managed_custody$
DECLARE actual text;
BEGIN
 IF to_regprocedure('public.private_gcp_coordinates(jsonb)') IS NOT NULL THEN
  SELECT pg_get_functiondef(to_regprocedure('public.guard_personal_agent_erasure_registry()')) INTO actual;
  IF actual IS NULL OR encode(sha256(convert_to(actual,'UTF8')),'hex')<>'{digest}' THEN
   RAISE EXCEPTION 'Unqualified managed custody recovery guard';
  END IF;
  RETURN;
 END IF;
 EXECUTE $reviewed_recovery_guard${body}$reviewed_recovery_guard$;
END;
$retain_managed_custody$;
"""
    adapted = sql[:start] + wrapped + sql[end:]
    # Reuse the same complete-vector check as immutable420, without its hash-list adaptation.
    qualification = _successor_qualification()
    return _qualified_transaction(adapted, qualification)


def _qualified_transaction(sql: str, qualification: str) -> str:
    from db.migration_authority import MigrationAuthorityError

    if sql.count("BEGIN;") != 1 or not sql.rstrip().endswith("COMMIT;"):
        raise MigrationAuthorityError("Managed custody adoption transaction shape changed")
    sql = sql.replace("BEGIN;", "BEGIN;\n" + qualification, 1)
    before_commit, trailing = sql.rsplit("COMMIT;", 1)
    return before_commit + qualification + "COMMIT;" + trailing


def _successor_qualification() -> str:
    values = ",".join(
        f"('{signature}','{digest}',{'true' if signature.partition('(')[0] in REFINED else 'false'})"
        for signature, digest in QUALIFIED.items()
    )
    qualification = f"""DO $hosted_custody_successor$
DECLARE spec record; definition text; client_role text; footprint boolean := false;
BEGIN
 -- Any new helper or refined successor is a footprint. A missing sentinel
 -- must not make a partial successor look like the legacy family.
 SELECT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname IN
   (SELECT split_part(signature,'(',1) FROM (VALUES {values}) AS expected(signature,digest,refined)
    WHERE NOT refined)) INTO footprint;
 FOR spec IN SELECT * FROM (VALUES {values}) AS expected(signature,digest,refined) LOOP
  SELECT pg_get_functiondef(to_regprocedure('public.'||spec.signature)) INTO definition;
  IF definition IS NOT NULL AND (NOT spec.refined OR encode(sha256(convert_to(definition,'UTF8')),'hex')=spec.digest) THEN
   footprint := true;
   EXIT;
  END IF;
 END LOOP;
 IF NOT footprint THEN RETURN; END IF;
 IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname IN
   (SELECT split_part(signature,'(',1) FROM (VALUES {values}) AS expected(signature,digest,refined))
  AND NOT EXISTS(SELECT 1 FROM (VALUES {values}) AS expected(signature,digest,refined)
   WHERE to_regprocedure('public.'||expected.signature)=p.oid)) THEN
  RAISE EXCEPTION 'Unqualified managed custody function overload';
 END IF;
 FOR spec IN SELECT * FROM (VALUES {values}) AS expected(signature,digest,refined) LOOP
  SELECT pg_get_functiondef(to_regprocedure('public.'||spec.signature)) INTO definition;
  IF definition IS NULL OR encode(sha256(convert_to(definition,'UTF8')),'hex')<>spec.digest THEN
   RAISE EXCEPTION 'Unqualified managed custody successor: %',spec.signature;
  END IF;
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',to_regprocedure('public.'||spec.signature));
  FOREACH client_role IN ARRAY ARRAY['anon','authenticated'] LOOP
   IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=client_role) THEN
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',to_regprocedure('public.'||spec.signature),client_role);
   END IF;
  END LOOP;
 END LOOP;
END;
$hosted_custody_successor$;
"""
    return qualification
