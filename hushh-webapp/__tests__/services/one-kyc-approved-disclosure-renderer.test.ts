import { describe, expect, it } from "vitest";

import {
  APPROVED_DISCLOSURE_FORMATTER_CONTRACT_ID,
  buildApprovedDisclosureHtml,
  buildApprovedDisclosurePlainText,
  redraftTransformFromInstructions,
  type ApprovedDisclosureRenderModel,
  type RedraftTransform,
  type RenderSection,
} from "@/lib/services/one-kyc-approved-disclosure-renderer";

const NO_STYLE: RedraftTransform = {
  compact: false,
  formal: false,
  bulletList: false,
  structured: false,
  table: false,
  fullDetail: false,
  human: false,
  cleanHeaders: false,
};

function makeModel(params: {
  style?: Partial<RedraftTransform>;
  sections?: RenderSection[];
  missingFields?: string[];
}): ApprovedDisclosureRenderModel {
  return {
    contractId: APPROVED_DISCLOSURE_FORMATTER_CONTRACT_ID,
    contractVersion: "1.0.0",
    accountHolder: "Jane Doe",
    style: { ...NO_STYLE, ...(params.style || {}) },
    sections:
      params.sections ?? [
        {
          scope: "identity",
          title: "Identity",
          entries: [
            { field: "full_name", label: "Full name", value: "Jane Doe", scope: "identity" },
            { field: "dob", label: "Date of birth", value: "1990-01-01", scope: "identity" },
          ],
          missingFields: [],
        },
        {
          scope: "contact",
          title: "Contact",
          entries: [
            { field: "email", label: "Email", value: "jane@example.com", scope: "contact" },
          ],
          missingFields: [],
        },
      ],
    missingFields: params.missingFields ?? [],
  };
}

const holdingsSection: RenderSection = {
  scope: "agent.kyc.financial.portfolio",
  title: "Portfolio",
  entries: [
    {
      field: "portfolio",
      label: "Portfolio",
      value: "Holdings\n- AAPL: 10 shares; $1,000 value\n- Cash: $500",
      scope: "agent.kyc.financial.portfolio",
    },
  ],
  missingFields: [],
};

// ---------------------------------------------------------------------------
// Characterization: the regression surface that MUST stay stable through the
// shell-extraction refactor (plain / table / human / structured drafts).
// ---------------------------------------------------------------------------
describe("buildApprovedDisclosureHtml — regression surface", () => {
  it("renders the email shell, opening, every value, and signature for a plain draft", () => {
    const html = buildApprovedDisclosureHtml(makeModel({}));
    // shared email shell chrome. NB: the HTML renderer uses the "hussh One" brand
    // string in BOTH the header chip and the footer signature; only the PLAINTEXT
    // signature uses "hushh One". Mirrored verbatim from the renderer.
    expect(html).toContain(">hussh One</div>");
    expect(html).toContain(">approved reply</div>");
    expect(html).toContain("I am replying on behalf of Jane Doe.");
    expect(html).toContain("Jane Doe");
    expect(html).toContain("1990-01-01");
    expect(html).toContain("jane@example.com");
    expect(html).toContain("Best,<br/>hussh One");
  });

  it("still renders a holdings table when style.table is set", () => {
    const html = buildApprovedDisclosureHtml(
      makeModel({ style: { table: true, bulletList: true }, sections: [holdingsSection] }),
    );
    expect(html).toContain("<table");
    expect(html).toContain("Asset");
    expect(html).toContain("AAPL");
  });

  it("renders a natural sentence when style.human is set (single entry)", () => {
    const html = buildApprovedDisclosureHtml(
      makeModel({
        style: { human: true },
        sections: [
          {
            scope: "identity",
            title: "Identity",
            entries: [
              { field: "full_name", label: "Full name", value: "Jane Doe", scope: "identity" },
            ],
            missingFields: [],
          },
        ],
      }),
    );
    expect(html).toContain("Jane Doe");
    expect(html).not.toContain("<li");
  });
});

// ---------------------------------------------------------------------------
// Root cause (a): the "use bullet points" keyword must render EVERY entry as a
// uniform bullet — both in plaintext and HTML — not just whichever entry happens
// to take the dash branch.
// ---------------------------------------------------------------------------
describe("bullet-points keyword renders every entry uniformly", () => {
  const bulletStyle = redraftTransformFromInstructions("use bullet points");

  it("derives bulletList without structured/table from a pure bullet instruction", () => {
    expect(bulletStyle.bulletList).toBe(true);
    expect(bulletStyle.structured).toBe(false);
    expect(bulletStyle.table).toBe(false);
  });

  it("plaintext: every entry becomes a '- label: value' line", () => {
    const text = buildApprovedDisclosurePlainText(makeModel({ style: bulletStyle }));
    expect(text).toContain("- Full name: Jane Doe");
    expect(text).toContain("- Date of birth: 1990-01-01");
    expect(text).toContain("- Email: jane@example.com");
    const bulletLines = text.split("\n").filter((line) => line.startsWith("- "));
    expect(bulletLines).toHaveLength(3);
  });

  it("html: every entry becomes its own <li> (no entry left as a card or paragraph)", () => {
    const html = buildApprovedDisclosureHtml(makeModel({ style: bulletStyle }));
    const liCount = (html.match(/<li\b/g) || []).length;
    expect(liCount).toBe(3);
    expect(html).toContain("Full name: Jane Doe");
    expect(html).toContain("Date of birth: 1990-01-01");
    expect(html).toContain("Email: jane@example.com");
    // entries must NOT fall back to the key-value card-cell layout
    // (width:50%;padding:6px is the htmlList key-value <td> card marker; the
    // <table>/<td> in the header chip logo is part of the shell and is expected).
    expect(html).not.toContain("width:50%;padding:6px");
  });
});
