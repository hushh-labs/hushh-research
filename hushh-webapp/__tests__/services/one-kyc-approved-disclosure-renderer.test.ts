import { describe, expect, it } from "vitest";

import {
  APPROVED_DISCLOSURE_FORMATTER_CONTRACT_ID,
  buildApprovedDisclosureHtml,
  buildApprovedDisclosurePlainText,
  redraftTransformFromInstructions,
  renderLlmRedraftHtml,
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

  it("matches the captured golden HTML for a plain draft (shell-extraction guard)", () => {
    // Locks the EXACT outward-facing sent-email HTML so the shell extraction
    // refactor (sharing the chrome with the LLM-redraft path) is byte-identical.
    expect(buildApprovedDisclosureHtml(makeModel({}))).toMatchSnapshot();
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

// ---------------------------------------------------------------------------
// Root cause (b): the LLM-redraft path rendered markdown LITERALLY (escaped) and
// dropped the shared email theme shell. renderLlmRedraftHtml is a sanitized,
// escape-first markdown -> themed HTML string renderer wrapped in the SAME shell
// as buildApprovedDisclosureHtml. This output is also the actual sent email.
// ---------------------------------------------------------------------------
describe("renderLlmRedraftHtml — sanitized markdown in the shared shell", () => {
  it("renders markdown bullets as a real <ul><li> list", () => {
    const html = renderLlmRedraftHtml("Intro paragraph.\n\n- first point\n- second point");
    expect(html).toContain("<ul");
    const liCount = (html.match(/<li\b/g) || []).length;
    expect(liCount).toBe(2);
    expect(html).toContain("first point");
    expect(html).toContain("second point");
    expect(html).toContain("Intro paragraph.");
  });

  it("renders markdown headings as themed heading tags", () => {
    const html = renderLlmRedraftHtml("# Account summary\n\nBody text.");
    expect(html).toMatch(/<h1[^>]*>Account summary<\/h1>/);
    expect(html).toContain("Body text.");
  });

  it("renders **bold** as <strong>", () => {
    const html = renderLlmRedraftHtml("This is **important** information.");
    expect(html).toContain("<strong>important</strong>");
  });

  it("splits blank-line-separated text into multiple paragraphs", () => {
    const html = renderLlmRedraftHtml("Paragraph one.\n\nParagraph two.");
    const pCount = (html.match(/<p\b/g) || []).length;
    expect(pCount).toBeGreaterThanOrEqual(2);
  });

  it("escapes HTML in LLM output (no live markup injected)", () => {
    const html = renderLlmRedraftHtml("Hello <script>alert(1)</script> & <b>x</b>");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>x</b>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp;");
  });

  it("wraps the content in the SAME email shell as the approved-disclosure renderer", () => {
    const html = renderLlmRedraftHtml("Just a line.");
    // identical shell chrome (header chip + outer container) as buildApprovedDisclosureHtml
    expect(html).toContain(">hussh One</div>");
    expect(html).toContain(">approved reply</div>");
    expect(html).toContain('<div style="padding:20px;">');
    expect(html).toContain(`background:#18181b`);
  });
});

// ---------------------------------------------------------------------------
// Golden snapshot: consolidated multi-account portfolio rendering
// Locks the exact sent-email HTML for a consolidated portfolio across changes.
// ---------------------------------------------------------------------------
it("renders a consolidated multi-account portfolio to stable themed HTML", () => {
  const html = buildApprovedDisclosureHtml({
    contractId: APPROVED_DISCLOSURE_FORMATTER_CONTRACT_ID,
    contractVersion: "1.0.0",
    accountHolder: "Kushal Trivedi",
    style: {
      compact: false,
      formal: false,
      bulletList: false,
      structured: false,
      table: false,
      fullDetail: false,
      human: false,
      cleanHeaders: false,
    },
    sections: [
      {
        scope: "attr.financial.portfolio.*",
        title: "Portfolio",
        entries: [
          {
            field: "portfolio",
            label: "portfolio",
            scope: "attr.financial.portfolio.*",
            value:
              "Portfolio summary\n- Accounts: 2\n- Total value: $150,000.00\n- Fidelity Individual: $100,000.00\n- Schwab IRA: $50,000.00\n- Cash balance: $1,500.00\n\nHoldings\n- AAPL: 300 shares; $45,000.00 value",
          },
        ],
        missingFields: [],
      },
    ],
    missingFields: [],
  });
  expect(html).toContain("<table");
  expect(html).toContain("Portfolio summary");
  expect(html).toContain("AAPL");
  expect(html).toMatchSnapshot();
});
