"""Qualify the complete reviewed managed-custody successor without rewriting420."""

from __future__ import annotations

QUALIFIED = {
    "erasure_authorization_history(jsonb,jsonb)": "229ae3dadf31ae73f9c84e55ad4be9c57da79e8dece62838fc6b663c07ab2bad",
    "erasure_managed_model_grants_complete(jsonb)": "ab7ad9ac87b2a2acd524de7d8f794b1a9ba3c0bffa39996c2c9fa21333a6fcba",
    "erasure_private_coordinates(jsonb)": "1390d7709aef509377b352995a8354ce9d25c60f871e3f7b9d05ad72ebb5ffe5",
    "expected_erasure_bootstrap_release(text,jsonb,text)": "5f147b9ea109568a120653b39373d1f607986b0cbd1f9b3133c851ad73d99eb5",
    "guard_personal_agent_erasure_registry()": "ad1098a0ec4bef6691a40bb4b9a34bf98a2bfcbdb4cec71100113f1b7948618b",
    "guard_project_grant_registry_admission()": "38822c10a774c8c8602cf8b2788436a83958167b7bcfb302d37eef3bcb9e3d54",
    "hosted_pod_cleanup_admitted(text,text,jsonb)": "8c9507d2151caede029d26b1784c3772bc7c4e959b3bf3e8a8766f8865e51735",
    "hosted_pod_execution_admitted(text,text,jsonb,jsonb,text)": "8361affe67f04eb6269e2bbec93d43b2893c8fbfb9681e5db0f69907cccdd166",
    "hosted_pod_retained_admitted(text,jsonb)": "7886341ac8363c3ef491746978e5d4863c24a74b84531ebd2ce29a7d7c7ba954",
    "hosted_pod_upgrade_admitted(text,text,jsonb,boolean)": "a3b2321d76a773ae76378fe640eca1f65a70445c25feb64a37b0c90e70e47455",
    "hosted_preparation_cleanup_admitted(text,text,jsonb)": "087392d6dd4740ecbe1cc43e19e8da6a01d578570c7bd4257881e97d10ae8777",
    "managed_preparation_cleanup_coordinates(jsonb)": "4876286e5b7e1d3f69d534b55aec8961dd8c5d38c58af1a6514da1333f9693d1",
    "personal_agent_erasure_archive(jsonb,jsonb)": "1139e56bb652ecfcab21e859685bcbabaa1fb77b6600fb644ab1b0f579aeb812",
    "personal_agent_erasure_archived(text,jsonb,jsonb)": "842f2a6bfa25429a970a2508c9ef84e525175c7e69e91875f18fcb7253b4d7f8",
    "personal_agent_erasure_complete(text)": "6783be49623801f45983a4eed88ba4473ab1e853fd20bec6bd82020cb613eb9e",
    "private_gcp_coordinates(jsonb)": "1276132589bc5b003fb031bb84e5f8a5b7e4b9c5b2ab707c1f3576823e86e03c",
    "project_grant_release_is_exclusive(text,text)": "600d73daf4d90be870860e24fc5e7ee8130acf2a46afac5ae1a72def433e6a1e",
    "reserve_erasure_grant_release(text,text,jsonb)": "6a2e27053b8c0d2e3abef78c446a1fd653bf93d1ad2d3edb800f6f3a5b400855",
    "reserve_personal_agent_erasure(text,text)": "adb9e04bbda14bdd2d0d0373d014efc288760f7d3eacb227551de7677b682498",
    "retain_erasure_managed_model_grant_receipt(text,text,jsonb,text,text,jsonb)": "ba959ceb4ac55f3b3b93ada3fac883faf2fd697cb5dbe083b3160a9e202d4912",
    "retain_erasure_managed_project_retirement(text,text,jsonb,text,jsonb)": "1c83c62a23b3f8e050c3d15ec76153c9ffc5a7b0f874b515443645585f54a50b",
    "retain_hosted_pod_project_authorization(text,text)": "69a3a70f7793e2a2936d14143defde00cf01534eb8abb08f75210519ac1da862",
    "retain_managed_preparation_cleanup(text,text,jsonb,text,jsonb)": "4ca371403a38e1e05da0478862fc5d8c2560ed1b1be0f0c01f45db67a874467d",
    "valid_erasure_files_receipt(jsonb,text,text,jsonb)": "e253b257558adc05bd7c5170f5da9f67dca039800aba75234180a03ea27f964a",
    "valid_erasure_gcp_files_upgrade_observation(jsonb,jsonb)": "96d97d4f2f66d3bcd2555805b21bd712f1b973daae20657053f17652856d0742",
    "valid_erasure_grant_release(jsonb,jsonb)": "4100815e7449e23a730dbb3bedd45c9e8fd736363ef725e956e881183fdb5b6f",
    "valid_erasure_kms_receipt(jsonb,text,jsonb)": "0de93e902fcf50d4464a7c764808dd32912d35b37a1077615616aa4ee55e5234",
    "valid_erasure_mail_receipt(jsonb,text,text,jsonb)": "4d4b33ec24b3fff696c7bcc52aa17a8479e0ec4100bff80a58bb226883656ed8",
    "valid_erasure_managed_model_grant_append(jsonb,jsonb)": "c6806e3be69d9420f6a57044cadd68ff698be50d5ed2c3c2f5ed50295ad9e0ff",
    "valid_erasure_managed_model_grant_receipt(jsonb,text,text,jsonb)": "072534ad1f221b060b490dc330e0bf2db061502b5d3186f257c78ae85226a749",
    "valid_erasure_managed_project_retirement(jsonb,text,jsonb)": "6a0728cbf7cd714089199427d2d85d16017c6e95a8d5dd4ef02a6fdd59da0349",
    "valid_erasure_managed_retirement_append(jsonb,jsonb)": "69320963e61384d21aceb1840d22b825da549c9d7c16e72ad4da6705a7565c11",
    "valid_erasure_repository_grant_receipt(jsonb,text,jsonb)": "8ad9954e5381703965b6700056acebf77d4f07624fe778fcec87192245de5799",
    "valid_erasure_repository_inventory(jsonb,jsonb)": "ce792c145b70c2f5515221a2e3cc93add5e2c0ae0182800bce30aafa9ec2ffe4",
    "valid_erasure_secret_receipt(jsonb,text,jsonb)": "40f47265300102f0b7d1f8420820948406b1748b61cba2ca2543aa2a763e0ae3",
    "valid_erasure_writer_receipt(jsonb,text,jsonb)": "b1f78ff6cc79b6a8cb1ca2a2c8f5be2f7bf1699ab5b1d9df585f42e6490bdd81",
    "valid_managed_preparation_cleanup(jsonb,text,jsonb)": "2a6e52470a9c63d38d1b3565e3216d86e1a51359ed506da73b5db331f41b7ef6",
    "valid_managed_preparation_cleanup_append(jsonb,jsonb)": "7fb22e756f1ca75aa7b475d8cb80a690646a1520487afa3da771cddf71eb8cb5",
}

REFINED = {
    "expected_erasure_bootstrap_release": (
        "'9c7df549d997f7e00af73bdc28816ca337452ff340ea232b0acf27a486b04897'",
        "5f147b9ea109568a120653b39373d1f607986b0cbd1f9b3133c851ad73d99eb5",
    ),
    "guard_personal_agent_erasure_registry": (
        "'28050839ef93e010d92cd5289dda40b6adb020aaf3717f4b23c513aa4503f30a','c7f509dc6824e9a0ab66ae6e30b98e2afdd48483d72754a00c36cb15d0d3f521'",
        "ad1098a0ec4bef6691a40bb4b9a34bf98a2bfcbdb4cec71100113f1b7948618b",
    ),
    "guard_project_grant_registry_admission": (
        "'1912f59585796ac340a29f56fa7875726e742531b716fa9b98612a555cc3a6ca'",
        "38822c10a774c8c8602cf8b2788436a83958167b7bcfb302d37eef3bcb9e3d54",
    ),
    "personal_agent_erasure_archive": (
        "'e43bad73e40984d01c4ea5a01872dc76ce3ba77fce05c48eaffd95118d398685'",
        "1139e56bb652ecfcab21e859685bcbabaa1fb77b6600fb644ab1b0f579aeb812",
    ),
    "personal_agent_erasure_archived": (
        "'869752af19ff5735ad84cfefcb7cdfdc3036646bf137d64e16e04ce57f984bab'",
        "842f2a6bfa25429a970a2508c9ef84e525175c7e69e91875f18fcb7253b4d7f8",
    ),
    "personal_agent_erasure_complete": (
        "'d1e653a9c5323c12e558ed2b2d5483487e50d745424f5d512b91c687cd94dd2d'",
        "6783be49623801f45983a4eed88ba4473ab1e853fd20bec6bd82020cb613eb9e",
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
        "adb9e04bbda14bdd2d0d0373d014efc288760f7d3eacb227551de7677b682498",
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
        "0de93e902fcf50d4464a7c764808dd32912d35b37a1077615616aa4ee55e5234",
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
    return sql.replace("BEGIN;", "BEGIN;\n" + qualification, 1)


RECOVERY_SOURCE_SHA256 = "f637ba12f5eb6fc0b79ad3a1244b65cd972a33fd589c8ffa2425157d6ddcc4f6"


def hosted_custody_recovery_replay(entry, sql: str) -> str:
    """421 must retain a complete qualified974 guard rather than downgrade it."""
    import hashlib

    from db.migration_authority import MigrationAuthorityError

    checksum = hashlib.sha256(entry.sql.encode()).hexdigest()
    if (
        entry.filename != "421_cloud_removal_recovery.sql"
        or checksum != RECOVERY_SOURCE_SHA256
        or entry.checksum_sha256 != checksum
    ):
        raise MigrationAuthorityError("Managed custody recovery source checksum changed")
    anchor = "CREATE OR REPLACE FUNCTION public.guard_personal_agent_erasure_registry()"
    start = sql.index(anchor)
    end = sql.index("$$;", start) + 3
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
    return adapted.replace("BEGIN;", "BEGIN;\n" + qualification, 1)


def _successor_qualification() -> str:
    values = ",".join(f"('{signature}','{digest}')" for signature, digest in QUALIFIED.items())
    qualification = f"""DO $hosted_custody_successor$
DECLARE spec record; definition text; client_role text;
BEGIN
 IF to_regprocedure('public.private_gcp_coordinates(jsonb)') IS NULL THEN RETURN; END IF;
 FOR spec IN SELECT * FROM (VALUES {values}) AS expected(signature,digest) LOOP
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
