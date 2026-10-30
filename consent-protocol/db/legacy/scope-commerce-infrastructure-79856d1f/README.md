# Frozen infrastructure migration lineage

This canonical archive preserves the exact manifest and six forward/rollback SQL bodies from `79856d1f1b803ccc01d2d3a08d149230dd850a3b` before integration of main `4277558db778554c9cd94c2dc89a9505363bd442`. Main owns 315–321. The branch's unrecorded release tail moves to 322–327 with unchanged SQL bytes. Do not execute this archive as an active manifest.

Read-only observations on 2026-10-12 at 13:44:03Z (Dev),13:44:06Z (UAT), and13:44:09Z (production) find no accepted 315–327 receipts or release baseline. Dev's 59 historical 900–958 private receipts are a distinct lane. Absence of replay receipts does not prove absence of applied schema; existing funding, journals and other application rows remain untouched. No receipt is fabricated or rewritten. Deployment still requires canonical replay/preservation and schema checks; refresh evidence before a later environment rollout.

| Frozen filename | Active filename | SQL SHA-256 | Rollback SHA-256 |
|---|---|---|---|
| `315_vault_environment_enrollment.sql` | `322_vault_environment_enrollment.sql` | `9f1fe45a135fe21b591288e6101bd8731d853a51f856d9bc96c4267d617785aa` | `2cf4895d3c3562e7e52f9741bbc5c0c968fd61fb832695f29398118becdd2130` |
| `316_consumer_scope_commerce.sql` | `323_consumer_scope_commerce.sql` | `153b30ae338b61fac9e9db361dd2eb5b6c5e73bef53a11c7ede3e917e980cb05` | `69961cc7573cdb22bac6258335e5aae05ae4df75c3448e9243947d4fd20dead6` |
| `317_one_shared_hosting_choice.sql` | `324_one_shared_hosting_choice.sql` | `1c92b4957ba8b8684e09c5e0d36fca1c6635f94a7e51184024c5e21bbac8e1d6` | `6f5bee22d11d452ce5dc607cb2a01c219977a54e8729bde92f8a61c94b3ed115` |
| `318_public_profile_bridge.sql` | `325_public_profile_bridge.sql` | `495609d6e515da292a5ec52915ceb7ec090b474a9b28edfcfa6a3c4230120db4` | `0e61c43e175ed02765491f7bd0c4350b49ca644fd5359b5ba860b8652b6a76fd` |
| `319_one_placement_reader_foundation.sql` | `326_one_placement_reader_foundation.sql` | `aad7ce3d059077339eaa5630bf7a916f7fb4460336142c31aac967a00e6f3d6b` | `74d0bb3284087d333d46f9d6436634ad665d270d8986d8764228d60b78675ecf` |
| `320_one_legacy_shared_continuity.sql` | `327_one_legacy_shared_continuity.sql` | `5ef3f5d680e8c9ed07ca96d967be09eea2b6d33410cb0162574ee00d0f26f5f8` | `74d0bb3284087d333d46f9d6436634ad665d270d8986d8764228d60b78675ecf` |
