import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/pkm/pkm-domain-resource", () => ({
  PkmDomainResourceService: {
    getStaleFirst: vi.fn(),
  },
}));

vi.mock("@/lib/services/pkm-write-coordinator", () => ({
  PkmWriteCoordinator: {
    saveMergedDomain: vi.fn(),
  },
}));

vi.mock("@/lib/services/one-kyc-service", () => ({
  OneKycService: {
    getClientConnector: vi.fn(),
    registerClientConnector: vi.fn(),
  },
}));

import {
  APPROVED_DISCLOSURE_FORMATTER_CONTRACT_ID,
  effectiveOneKycRequiredFields,
  KYC_CONNECTOR_WRAPPING_ALG,
  OneKycClientZkService,
  type KycClientConnectorPrivateRecord,
} from "@/lib/services/one-kyc-client-zk-service";
import type { OneKycWorkflow } from "@/lib/services/one-kyc-service";

const baseWorkflow: OneKycWorkflow = {
  workflow_id: "kyc_wf_1",
  user_id: "user_1",
  status: "waiting_on_user",
  sender_email: "broker@example.com",
  participant_emails: ["broker@example.com"],
  subject: "KYC request",
  counterparty_label: "Acme Brokerage",
  required_fields: ["full_name", "date_of_birth", "address"],
  draft_status: "ready",
};

const connector: KycClientConnectorPrivateRecord = {
  connector_key_id: "one-kyc-test",
  connector_public_key: "public-key",
  connector_private_key: "private-key",
  connector_private_key_format: "pkcs8",
  connector_wrapping_alg: KYC_CONNECTOR_WRAPPING_ALG,
  public_key_fingerprint: "fingerprint",
  created_at: "2026-05-04T00:00:00.000Z",
};

describe("OneKycClientZkService", () => {
  it("builds a deterministic local draft from decrypted scoped export values", async () => {
    const first = await OneKycClientZkService.buildDraft({
      workflow: baseWorkflow,
      exportPayload: {
        identity: {
          full_name: "Ada Lovelace",
          date_of_birth: "1815-12-10",
          address: {
            line1: "1 St James Square",
            city: "London",
          },
        },
      },
    });
    const second = await OneKycClientZkService.buildDraft({
      workflow: baseWorkflow,
      exportPayload: {
        identity: {
          full_name: "Ada Lovelace",
          date_of_birth: "1815-12-10",
          address: {
            line1: "1 St James Square",
            city: "London",
          },
        },
      },
    });

    expect(first).toEqual(second);
    expect(first.subject).toBe("Re: KYC request");
    expect(first.renderModel.contractId).toBe(APPROVED_DISCLOSURE_FORMATTER_CONTRACT_ID);
    expect(first.renderModel.contractVersion).toBe("1.0.0");
    expect(first.body).toContain("full name: Ada Lovelace");
    expect(first.body).toContain("date of birth: 1815-12-10");
    expect(first.missingFields).toEqual([]);
    expect(first.draftHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("tracks missing fields without inventing values", async () => {
    const draft = await OneKycClientZkService.buildDraft({
      workflow: baseWorkflow,
      exportPayload: {
        identity: {
          full_name: "Ada Lovelace",
        },
      },
    });

    expect(draft.approvedValues).toEqual({ full_name: "Ada Lovelace" });
    expect(draft.missingFields).toEqual(["date_of_birth", "address"]);
    expect(draft.body).not.toContain("date of birth:");
    expect(draft.body).not.toContain("address:");
  });

  it("builds multi-scope drafts without appending redraft instructions as outgoing text", async () => {
    const workflow: OneKycWorkflow = {
      ...baseWorkflow,
      required_fields: ["full_name", "portfolio", "financial_profile"],
      requested_scopes: ["attr.identity.*", "attr.financial.*"],
    };

    const draft = await OneKycClientZkService.buildDraft({
      workflow,
      instructions: "add financial information",
      exportPayloads: [
        {
          scope: "attr.identity.*",
          payload: {
            identity: {
              full_name: "Ada Lovelace",
            },
          },
        },
        {
          scope: "attr.financial.*",
          payload: {
            financial: {
              portfolio: [{ ticker: "UAT", value: "test only" }],
            },
          },
        },
      ],
    });

    expect(draft.body).toContain("full name: Ada Lovelace");
    expect(draft.body).toContain("Portfolio summary");
    expect(draft.body).toContain("Holdings");
    expect(draft.body).toContain("- UAT");
    expect(draft.body).not.toContain("Not found in the approved data");
    expect(draft.body).not.toContain("financial profile");
    expect(draft.body).not.toContain("User requested adjustment");
    expect(draft.scopeSummaries).toHaveLength(2);
    expect(draft.renderModel.sections.map((section) => section.title)).toEqual([
      "Identity information",
      "Financial information",
    ]);
  });

  it("applies supported redraft style without sending the instruction text", async () => {
    const draft = await OneKycClientZkService.buildDraft({
      workflow: {
        ...baseWorkflow,
        required_fields: ["full_name", "portfolio"],
        requested_scopes: ["attr.identity.*", "attr.financial.portfolio.*"],
        metadata: { account_holder_name: "Kushal Trivedi" },
      },
      instructions: "Make this more formal and concise. Also mention my private chat context.",
      exportPayloads: [
        {
          scope: "attr.identity.*",
          payload: {
            identity: {
              full_name: "Kushal Trivedi",
            },
          },
        },
        {
          scope: "attr.financial.portfolio.*",
          payload: {
            financial: {
              portfolio: [{ ticker: "HUSHH", value: "approved test value" }],
            },
          },
        },
      ],
    });

    expect(draft.body).toContain(
      "I am replying on behalf of Kushal Trivedi with the approved information below.",
    );
    expect(draft.body).toContain("Identity information");
    expect(draft.body).toContain("Portfolio");
    expect(draft.body).toContain("Portfolio summary");
    expect(draft.body).toContain("- HUSHH");
    expect(draft.body).not.toContain("private chat context");
    expect(draft.body).not.toContain("Make this more formal");
    expect(draft.body).toContain("Best,\nhussh One");
  });

  it("rebuilds plaintext and HTML when redraft instructions change style", async () => {
    const workflow: OneKycWorkflow = {
      ...baseWorkflow,
      required_fields: ["portfolio"],
      requested_scope: "attr.financial.portfolio.*",
      metadata: { account_holder_name: "Kushal Trivedi" },
    };
    const exportPayload = {
      financial: {
        portfolio: {
          account_summary: {
            ending_value: 1656064.53,
            cash_balance: 900226.92,
          },
          holdings: [{ quantity: 30, symbol: "AMZN", market_value: 92822.4 }],
        },
      },
    };

    const original = await OneKycClientZkService.buildDraft({
      workflow,
      exportPayload,
    });
    const redrafted = await OneKycClientZkService.buildDraft({
      workflow,
      exportPayload,
      instructions: "Make this sectioned as a table with full detail.",
    });

    expect(redrafted.body).not.toEqual(original.body);
    expect(redrafted.htmlBody).not.toEqual(original.htmlBody);
    expect(redrafted.body).toContain("Portfolio");
    expect(redrafted.htmlBody).toContain("<table");
    expect(redrafted.renderModel.style.table).toBe(true);
    expect(redrafted.renderModel.style.fullDetail).toBe(true);
  });

  it("renders portfolio exports as structured human email text instead of raw PKM metadata", async () => {
    const workflow: OneKycWorkflow = {
      ...baseWorkflow,
      required_fields: ["portfolio"],
      requested_scope: "attr.financial.portfolio.*",
      subject: "Portfolio information",
      metadata: { account_holder_name: "Kushal Trivedi" },
    };

    const draft = await OneKycClientZkService.buildDraft({
      workflow,
      exportPayload: {
        financial: {
          portfolio: {
            account_info: {
              holder_name: "MANISH SAINANI DESIGNATED BENE PLAN/TOD",
              account_number: "4566-0512",
            },
            account_summary: {
              beginning_value: 6820789.52,
              ending_value: 6951964.54,
              cash_balance: -2569053.37,
              change_in_value: 145734.69,
              investment_gain_loss: 145734.69,
              total_fees: -14559.67,
            },
            holdings: [
              {
                quantity: 1879.4037,
                instrument_kind: "equity",
                symbol: "AAPL",
                symbol_trust_reason: "statement_import",
                metadata_confidence: 0,
                analyze_eligible: true,
                optimize_eligible: true,
                is_short_position: false,
                tradable: true,
                unrealized_gain_loss: -379342.45,
                asset_type: "Equities",
                price_per_unit: 234.775,
                market_value: 441258.37,
                confidence: 0.85,
              },
              {
                quantity: 30,
                symbol: "AMZN",
                asset_type: "Equities",
                price_per_unit: 3094.08,
                market_value: 92822.4,
              },
              {
                quantity: 10000,
                symbol: "ABEV",
                asset_type: "Equities",
                market_value: 27400,
              },
              {
                quantity: 900226.92,
                symbol: "CASH",
                market_value: 900226.92,
              },
            ],
            cash_balance: -2569053.37,
            total_value: 6951964.54,
            parse_fallback: false,
            domain_intent: { primary: "financial", secondary: "portfolio" },
          },
        },
      },
    });

    expect(draft.body).toContain("I am replying on behalf of Kushal Trivedi.");
    expect(draft.body).toContain("Portfolio summary");
    expect(draft.body).not.toContain("Portfolio\n\nPortfolio summary");
    expect(draft.body).toContain("- Total value: $6,951,964.54");
    expect(draft.body).toContain("- Cash balance: -$2,569,053.37");
    expect(draft.body).toContain("- Investment gain/loss: $145,734.69");
    expect(draft.body).toContain("- Holdings: 4");
    expect(draft.body).toContain("Holdings");
    expect(draft.body).toContain("- AAPL: 1,879.4037 shares; $441,258.37 value");
    expect(draft.body).toContain("- AMZN: 30 shares; $92,822.40 value; $3,094.08 per share");
    expect(draft.body).toContain("- ABEV: 10,000 shares; $27,400.00 value");
    expect(draft.body).toContain("- Cash: $900,226.92");
    expect(draft.body).toContain("Best,\nhussh One");
    expect(draft.htmlBody).toContain("<table");
    expect(draft.htmlBody).toContain("overflow-x:auto");
    expect(draft.htmlBody).toContain("min-width:720px");
    expect(draft.htmlBody).toContain("Portfolio summary");
    expect(draft.htmlBody).toContain("AAPL");
    expect(draft.htmlBody).toContain("Cash");
    expect(draft.body).not.toContain("and 1 more");
    expect(draft.body).not.toContain("and 17 more");
    expect(draft.htmlBody).not.toContain("and 1 more");
    expect(draft.htmlBody).not.toContain("and 17 more");
    expect(draft.body).not.toContain("account number");
    expect(draft.body).not.toContain("4566-0512");
    expect(draft.htmlBody).not.toContain("account number");
    expect(draft.htmlBody).not.toContain("4566-0512");
    expect(draft.body).not.toContain("symbol trust reason");
    expect(draft.body).not.toContain("metadata confidence");
    expect(draft.body).not.toContain("analyze eligible");
    expect(draft.body).not.toContain("domain intent");
    expect(draft.body).not.toContain("parse fallback");
  });

  it("formats broad financial exports through portfolio-aware sections", async () => {
    const workflow: OneKycWorkflow = {
      ...baseWorkflow,
      required_fields: ["financial_profile"],
      requested_scope: "attr.financial.*",
      subject: "Financial information",
      metadata: { account_holder_name: "Kushal Trivedi" },
    };

    const draft = await OneKycClientZkService.buildDraft({
      workflow,
      instructions: "Format the financial data as a clean table with headings.",
      exportPayload: {
        financial: {
          portfolio: {
            account_summary: {
              ending_value: 1656064.53,
              cash_balance: 900226.92,
              investment_gain_loss: 16126.09,
            },
            holdings: [
              {
                quantity: 30,
                symbol: "AMZN",
                asset_type: "Equities",
                price_per_unit: 3094.08,
                market_value: 92822.4,
              },
              {
                quantity: 10000,
                symbol: "ABEV",
                asset_type: "Equities",
                market_value: 27400,
              },
            ],
            domain_intent: { primary: "financial", secondary: "portfolio" },
          },
        },
      },
    });

    expect(draft.approvedValues.financial_information).toContain("Portfolio summary");
    expect(draft.body).toContain("Portfolio summary");
    expect(draft.body).toContain("- Total value: $1,656,064.53");
    expect(draft.body).toContain("Holdings");
    expect(draft.body).toContain("- AMZN: 30 shares; $92,822.40 value; $3,094.08 per share");
    expect(draft.body).not.toContain("domain intent");
    expect(draft.body).not.toContain("financial profile\nPortfolio summary");
    expect(draft.htmlBody).toContain("hussh One");
    expect(draft.htmlBody).toContain("🤫");
    expect(draft.htmlBody).toContain("#D4A847");
    expect(draft.htmlBody).toContain("#18181b");
    expect(draft.htmlBody).toContain("<table");
    expect(draft.htmlBody).toContain("AMZN");
  });

  it("honors financial path scopes before stale required fields", async () => {
    const workflow: OneKycWorkflow = {
      ...baseWorkflow,
      required_fields: ["financial_profile"],
      requested_scope: "attr.financial.portfolio.*",
      subject: "Portfolio information",
      metadata: { account_holder_name: "Kushal Trivedi" },
    };

    const draft = await OneKycClientZkService.buildDraft({
      workflow,
      exportPayload: {
        financial: {
          portfolio: {
            account_summary: {
              ending_value: 1656064.53,
            },
            holdings: [{ quantity: 30, symbol: "AMZN", market_value: 92822.4 }],
          },
        },
      },
    });

    expect(draft.approvedValues.portfolio).toContain("Portfolio summary");
    expect(draft.missingFields).toEqual([]);
    expect(draft.body).toContain("Portfolio");
    expect(draft.body).toContain("Holdings");
    expect(draft.body).toContain("AMZN");
    expect(draft.body).not.toContain("financial profile:");
  });

  it("renders all selected financial scopes without letting the broad scope hide portfolio data", async () => {
    const workflow: OneKycWorkflow = {
      ...baseWorkflow,
      required_fields: ["financial_profile"],
      requested_scopes: ["attr.financial.profile.*", "attr.financial.*"],
      subject: "Financial information",
      metadata: { account_holder_name: "Kushal Trivedi" },
    };

    const draft = await OneKycClientZkService.buildDraft({
      workflow,
      instructions: "Make this sectioned and human.",
      exportPayloads: [
        {
          scope: "attr.financial.profile.*",
          payload: {
            financial: {
              profile: {
                preferences: {
                  risk_profile: "balanced",
                  investment_horizon: "medium_term",
                  updated_at: "2026-03-01T18:49:42.147Z",
                },
              },
            },
          },
        },
        {
          scope: "attr.financial.*",
          payload: {
            financial: {
              profile: {
                preferences: {
                  risk_profile: "balanced",
                  investment_horizon: "medium_term",
                  updated_at: "2026-03-01T18:49:42.147Z",
                },
              },
              portfolio: {
                account_summary: {
                  ending_value: 1656064.53,
                  cash_balance: 900226.92,
                },
                holdings: [
                  { quantity: 30, symbol: "AMZN", market_value: 92822.4 },
                  { quantity: 10000, symbol: "ABEV", market_value: 27400 },
                ],
              },
            },
          },
        },
      ],
    });

    expect(draft.renderModel.sections.map((section) => section.title)).toEqual([
      "Financial profile",
      "Financial information",
    ]);
    expect(draft.body).toContain("Financial profile");
    expect(draft.body).toContain("Risk profile: Balanced");
    expect(draft.body).toContain("Financial information");
    expect(draft.body).toContain("Portfolio summary");
    expect(draft.body).toContain("Holdings");
    expect(draft.body).toContain("AMZN");
    expect(draft.body).toContain("ABEV");
    expect(draft.body).not.toContain("2026-03-01T18:49:42.147Z");
    expect(draft.body).not.toContain("financial profile: onboarding");
    expect(draft.body).not.toContain("Portfolio\n\nfinancial profile");
  });

  it("escapes approved values before producing HTML email content", async () => {
    const draft = await OneKycClientZkService.buildDraft({
      workflow: {
        ...baseWorkflow,
        required_fields: ["preferences"],
        requested_scope: "attr.travel.seat_preferences.*",
        metadata: { account_holder_name: "Kushal Trivedi" },
      },
      exportPayload: {
        travel: {
          seat_preferences: {
            summary: '<script>alert("bad")</script>Window seats',
          },
        },
      },
    });

    expect(draft.body).toContain('<script>alert("bad")</script>Window seats');
    expect(draft.htmlBody).toContain("&lt;script&gt;");
    expect(draft.htmlBody).not.toContain("<script>");
  });

  it("builds drafts from dynamic non-identity scopes without forcing identity fields", async () => {
    const workflow: OneKycWorkflow = {
      ...baseWorkflow,
      required_fields: ["favorite_locations"],
      requested_scope: "attr.travel.*",
      subject: "Favorite locations",
    };

    const draft = await OneKycClientZkService.buildDraft({
      workflow,
      exportPayload: {
        travel: {
          favorite_locations: ["Seattle", "Tokyo"],
          travel_style: "quiet cafes and walkable neighborhoods",
        },
      },
    });

    expect(draft.subject).toBe("Re: Favorite locations");
    expect(draft.approvedValues).toEqual({
      travel_information:
        "favorite locations: Seattle, Tokyo; travel style: quiet cafes and walkable neighborhoods",
    });
    expect(draft.missingFields).toEqual([]);
    expect(draft.body).toContain("favorite locations");
    expect(draft.body).toContain("Seattle, Tokyo");
    expect(draft.body).toContain("quiet cafes and walkable neighborhoods");
    expect(draft.body).not.toContain("identity profile");
  });

  it("renders multiple dynamic scopes as clean sections without PKM structure keys", async () => {
    const workflow: OneKycWorkflow = {
      ...baseWorkflow,
      required_fields: ["preferences"],
      requested_scopes: ["attr.location.*", "attr.travel.*"],
      subject: "Approved details",
      metadata: { account_holder_name: "Kushal Trivedi" },
    };

    const draft = await OneKycClientZkService.buildDraft({
      workflow,
      instructions: "Make this human and sectioned.",
      exportPayloads: [
        {
          scope: "attr.location.*",
          payload: {
            location: {
              changes: {
                entities: {
                  sf_residence_001: { summary: "I live in New York City now." },
                },
              },
              preferences: {
                entities: {
                  nyc_preference_001: { summary: "I love New York City." },
                },
              },
              profile: {
                entities: {
                  sf_residence_001: { summary: "I live in San Francisco." },
                },
              },
            },
          },
        },
        {
          scope: "attr.travel.*",
          payload: {
            travel: {
              changes: {
                entities: {
                  travel_preference_seat_001: {
                    summary: "Actually window seats work better now.",
                  },
                },
              },
              seat_preferences: {
                entities: {
                  travel_preference_seat_001: {
                    summary: "I prefer aisle seats for work trips.",
                  },
                },
              },
            },
          },
        },
      ],
    });

    expect(draft.body).toContain("Location information");
    expect(draft.body).toContain("Travel information");
    expect(draft.body).toContain("I love New York City.");
    expect(draft.body).toContain("I prefer aisle seats for work trips.");
    expect(draft.body).not.toContain("changes");
    expect(draft.body).not.toContain("entities");
    expect(draft.body).not.toContain("sf residence 001");
    expect(draft.body).not.toContain("travel preference seat 001");
    expect(draft.htmlBody).not.toContain("changes");
    expect(draft.htmlBody).not.toContain("entities");
  });

  it("formats financial profile dates and enums for human email", async () => {
    const workflow: OneKycWorkflow = {
      ...baseWorkflow,
      required_fields: ["financial_profile"],
      requested_scope: "attr.financial.profile.*",
      subject: "Financial profile",
      metadata: { account_holder_name: "Kushal Trivedi" },
    };

    const draft = await OneKycClientZkService.buildDraft({
      workflow,
      instructions: "Make it more human.",
      exportPayload: {
        financial: {
          profile: {
            onboarding: {
              completed: true,
              completed_at: "2026-03-01T17:21:46.644Z",
            },
            preferences: {
              investment_horizon: "medium_term",
              drawdown_response: "buy_more",
              volatility_preference: "moderate",
              risk_score: 4,
              risk_profile: "balanced",
              updated_at: "2026-03-01T18:49:42.147Z",
            },
          },
        },
      },
    });

    expect(draft.body).toContain("Risk profile: Balanced");
    expect(draft.body).toContain("Investment horizon: Medium term");
    expect(draft.body).toContain("Drawdown response: Buy more");
    expect(draft.body).toContain("Last updated: Mar 1, 2026");
    expect(draft.body).not.toContain("Financial profile\n\nFinancial profile");
    expect(draft.body).not.toContain("2026-03-01T18:49:42.147Z");
    expect(draft.body).not.toContain("onboarding");
    expect(draft.body).not.toContain("completed at");
  });

  it("recognizes redraft requests that ask to remove duplicate headings", async () => {
    const workflow: OneKycWorkflow = {
      ...baseWorkflow,
      required_fields: ["portfolio"],
      requested_scope: "attr.financial.portfolio.*",
      subject: "Portfolio information",
      metadata: { account_holder_name: "Kushal Trivedi" },
    };

    const draft = await OneKycClientZkService.buildDraft({
      workflow,
      instructions: "can you remove the double headers",
      exportPayload: {
        financial: {
          portfolio: {
            account_summary: {
              ending_value: 1656064.53,
            },
            holdings: [{ quantity: 30, symbol: "AMZN", market_value: 92822.4 }],
          },
        },
      },
    });

    expect(draft.renderModel.style.cleanHeaders).toBe(true);
    expect(draft.body).toContain("Portfolio summary");
    expect(draft.body).not.toContain("Portfolio\n\nPortfolio summary");
    expect(draft.htmlBody).toContain("Portfolio summary");
    expect(draft.htmlBody).toContain("AMZN");
  });

  it("maps generic travel preference asks to approved travel data without leaking email false positives", async () => {
    const workflow: OneKycWorkflow = {
      ...baseWorkflow,
      required_fields: ["email", "preferences"],
      requested_scope: "attr.travel.seat_preferences.*",
      subject: "Test Email",
      sender_email: "kushal@example.com",
      sender_name: "Kushal Trivedi",
      counterparty_label: "Kushal Trivedi",
      metadata: {
        classification: "dynamic_disclosure",
        reply_thread: { matched_user_emails: ["kushal@example.com"] },
      },
    };

    const draft = await OneKycClientZkService.buildDraft({
      workflow,
      exportPayload: {
        travel: {
          seat_preferences: {
            summary: "Actually window seats work better now.",
            observations: ["Avoid middle seats when possible."],
          },
        },
      },
    });

    expect(draft.approvedValues).toEqual({
      seat_preferences: "Actually window seats work better now.",
    });
    expect(draft.missingFields).toEqual([]);
    expect(draft.body.startsWith("I am replying on behalf of Kushal Trivedi.")).toBe(true);
    expect(draft.body).toContain("Kushal prefers window seats.");
    expect(draft.body).toContain("Best,\nhussh One");
    expect(draft.body).not.toContain("No requested values were present");
    expect(draft.body).not.toContain("Hi Kushal Trivedi");
    expect(draft.body).not.toContain("email");
    expect(draft.body).not.toContain("anything else");
    expect(draft.body).not.toContain("KYC review");
  });

  it("filters stale identity fields from effective non-identity requirements", () => {
    expect(
      effectiveOneKycRequiredFields({
        requiredFields: ["email", "preferences"],
        scopes: ["attr.travel.seat_preferences.*"],
        fallbackScope: "attr.travel.seat_preferences.*",
      })
    ).toEqual(["seat_preferences"]);
  });

  it("builds dynamic drafts from scope path metadata without hardcoded field aliases", async () => {
    const workflow: OneKycWorkflow = {
      ...baseWorkflow,
      required_fields: ["preferences"],
      requested_scope: "attr.mobility.cabin_comfort.*",
      subject: "Booking request",
      metadata: { classification: "dynamic_disclosure" },
    };

    const draft = await OneKycClientZkService.buildDraft({
      workflow,
      exportPayload: {
        mobility: {
          cabin_comfort: {
            summary: "Prefers quiet cabins and extra legroom.",
          },
        },
      },
    });

    expect(draft.approvedValues).toEqual({
      cabin_comfort: "Prefers quiet cabins and extra legroom.",
    });
    expect(draft.missingFields).toEqual([]);
    expect(draft.body).toContain("cabin comfort");
    expect(draft.body).toContain("Prefers quiet cabins and extra legroom.");
    expect(draft.body).not.toContain("No requested values were present");
    expect(draft.renderModel.sections[0]?.presentationSource).toBe("generic_projection");
    expect(draft.renderModel.missingPresentationMetadata).toEqual([
      "attr.mobility.cabin_comfort.*",
    ]);
  });

  it("rejects consent exports wrapped to a different connector before decrypting", async () => {
    await expect(
      OneKycClientZkService.decryptScopedExport({
        connector,
        exportPackage: {
          encrypted_data: "",
          iv: "",
          tag: "",
          wrapped_key_bundle: {
            wrapped_export_key: "",
            wrapped_key_iv: "",
            wrapped_key_tag: "",
            sender_public_key: "",
            wrapping_alg: KYC_CONNECTOR_WRAPPING_ALG,
            connector_key_id: "one-kyc-other",
          },
        },
      })
    ).rejects.toThrow("different client connector");
  });

  it("rejects unsupported export wrapping algorithms before decrypting", async () => {
    await expect(
      OneKycClientZkService.decryptScopedExport({
        connector,
        exportPackage: {
          encrypted_data: "",
          iv: "",
          tag: "",
          wrapped_key_bundle: {
            wrapped_export_key: "",
            wrapped_key_iv: "",
            wrapped_key_tag: "",
            sender_public_key: "",
            wrapping_alg: "RSA-OAEP",
            connector_key_id: connector.connector_key_id,
          },
        },
      })
    ).rejects.toThrow("Unsupported KYC export wrapping algorithm");
  });
});

// ── ZK preflight — structurally invalid payload rejection ──────────────────────

describe("ZK preflight — non-compliant and structurally empty payload rejection", () => {

  // ── Algorithm check takes priority ───────────────────────────────────────

  it("algorithm check fires before connector-key check when both are wrong", async () => {
    // Ensures the preflight order is deterministic: algorithm is checked first.
    await expect(
      OneKycClientZkService.decryptScopedExport({
        connector,
        exportPackage: {
          encrypted_data: "",
          iv: "",
          tag: "",
          wrapped_key_bundle: {
            wrapped_export_key: "",
            wrapped_key_iv: "",
            wrapped_key_tag: "",
            sender_public_key: "",
            wrapping_alg: "RSA-OAEP",            // wrong algorithm
            connector_key_id: "one-kyc-other",    // also wrong connector
          },
        },
      })
    ).rejects.toThrow("Unsupported KYC export wrapping algorithm");
    // NOT "different client connector" — algorithm gate fires first.
  });

  // ── Structurally empty crypto payload ─────────────────────────────────────

  it("rejects a package with empty crypto fields — preflight passes but crypto fails", async () => {
    // wrapping_alg matches and connector_key_id matches, so both preflight guards clear.
    // The subsequent WebCrypto operations receive empty-string fields and must throw.
    await expect(
      OneKycClientZkService.decryptScopedExport({
        connector,
        exportPackage: {
          encrypted_data: "",
          iv: "",
          tag: "",
          wrapped_key_bundle: {
            wrapped_export_key: "",
            wrapped_key_iv: "",
            wrapped_key_tag: "",
            sender_public_key: "",
            wrapping_alg: KYC_CONNECTOR_WRAPPING_ALG,
            connector_key_id: connector.connector_key_id,
          },
        },
      })
    ).rejects.toThrow(); // WebCrypto rejects empty key material
  });

  it("rejects a package whose connector_key_id is present but empty — passthrough checked next", async () => {
    // connector_key_id: "" is falsy — the connector check is skipped.
    // wrapping_alg: "EC-DH" is truthy and wrong → algorithm check fires.
    await expect(
      OneKycClientZkService.decryptScopedExport({
        connector,
        exportPackage: {
          encrypted_data: "",
          iv: "",
          tag: "",
          wrapped_key_bundle: {
            wrapped_export_key: "",
            wrapped_key_iv: "",
            wrapped_key_tag: "",
            sender_public_key: "",
            wrapping_alg: "EC-DH",
            connector_key_id: "",
          },
        },
      })
    ).rejects.toThrow("Unsupported KYC export wrapping algorithm");
  });

  // ── buildDraft — empty and null-valued export payloads ────────────────────

  it("reports all required fields as missing when export payload is an empty object", async () => {
    const draft = await OneKycClientZkService.buildDraft({
      workflow: baseWorkflow,
      exportPayload: {},
    });

    expect(draft.approvedValues).toEqual({});
    expect(draft.missingFields).toEqual(["full_name", "date_of_birth", "address"]);
    expect(draft.body).not.toContain("full name:");
    expect(draft.body).not.toContain("date of birth:");
    expect(draft.body).not.toContain("address:");
  });

  it("treats null field values as absent — no invented values, no crash", async () => {
    const draft = await OneKycClientZkService.buildDraft({
      workflow: baseWorkflow,
      exportPayload: {
        identity: {
          full_name: null,
          date_of_birth: null,
          address: null,
        },
      },
    });

    expect(draft.missingFields).toContain("full_name");
    expect(draft.missingFields).toContain("date_of_birth");
    expect(draft.missingFields).toContain("address");
    expect(draft.approvedValues).toEqual({});
    // Null values must never surface as literal "null" in the output.
    expect(draft.body).not.toMatch(/\bnull\b/);
  });

  it("produces a coherent empty draft when neither exportPayload nor exportPayloads is supplied", async () => {
    const draft = await OneKycClientZkService.buildDraft({
      workflow: baseWorkflow,
    });

    // No payload → no scope-payload pair → no field extraction at all.
    expect(draft.approvedValues).toEqual({});
    expect(draft.missingFields).toEqual([]);
    expect(typeof draft.body).toBe("string");
    expect(draft.draftHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("returns all required fields as missing when export payload contains only internal keys", async () => {
    // Internal keys (e.g. schema_version, updated_at) are stripped by the
    // INTERNAL_APPROVED_VALUE_KEYS filter — they must never fill required fields.
    const draft = await OneKycClientZkService.buildDraft({
      workflow: baseWorkflow,
      exportPayload: {
        identity: {
          schema_version: 1,
          updated_at: "2026-01-01T00:00:00.000Z",
          analyze_eligible: true,
          metadata: { source: "import" },
        },
      },
    });

    expect(draft.missingFields).toContain("full_name");
    expect(draft.missingFields).toContain("date_of_birth");
    expect(draft.missingFields).toContain("address");
    // Internal PKM keys must not surface as approved values.
    expect(Object.keys(draft.approvedValues)).not.toContain("schema_version");
    expect(Object.keys(draft.approvedValues)).not.toContain("updated_at");
    expect(Object.keys(draft.approvedValues)).not.toContain("analyze_eligible");
  });

  // ── effectiveOneKycRequiredFields — null and empty input edge cases ────────

  it("returns identity defaults when all scope entries are null or undefined", () => {
    const fields = effectiveOneKycRequiredFields({
      requiredFields: [],
      scopes: [null, undefined, null],
      fallbackScope: null,
    });
    // All null → filtered to [] → uses fallback identity defaults.
    expect(fields).toEqual(["identity_profile"]);
  });

  it("filters null entries from a mixed scope list and processes the valid scope", () => {
    const fields = effectiveOneKycRequiredFields({
      requiredFields: [],
      scopes: [null, "attr.identity.*", undefined],
    });
    expect(fields).toContain("identity_profile");
  });

  it("does not throw when requiredFields is null", () => {
    expect(() =>
      effectiveOneKycRequiredFields({
        requiredFields: null,
        scopes: ["attr.identity.*"],
      })
    ).not.toThrow();
  });

  it("does not throw when scopes is null", () => {
    expect(() =>
      effectiveOneKycRequiredFields({
        requiredFields: ["full_name"],
        scopes: null,
        fallbackScope: "attr.identity.*",
      })
    ).not.toThrow();
  });
});
// ── End ZK preflight invalid-payload coverage ──────────────────────────────────
