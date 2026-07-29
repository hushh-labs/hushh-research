import { describe, expect, it } from "vitest";

import {
  DATA_TOKEN_BUNDLE_ARRAY_ERROR,
  extractDataTokenBundle,
} from "@/lib/personal-knowledge-model/manifest";

describe("extractDataTokenBundle", () => {
  it("accepts native array data-token bundles", () => {
    const result = extractDataTokenBundle([
      { tokenId: "tok_extraction_01", source: "vault_sync" },
      { tokenId: "tok_extraction_02", source: "pkm_service" },
    ]);

    expect(result).toEqual({
      isExtractedSuccessfully: true,
      processedRecordCount: 2,
      errorLabel: null,
    });
  });

  it("rejects object-wrapped payloads without iterating undefined item fields", () => {
    const result = extractDataTokenBundle({
      data: "stub_item",
      total: 1,
    });

    expect(result).toEqual({
      isExtractedSuccessfully: false,
      processedRecordCount: 0,
      errorLabel: DATA_TOKEN_BUNDLE_ARRAY_ERROR,
    });
  });
});
