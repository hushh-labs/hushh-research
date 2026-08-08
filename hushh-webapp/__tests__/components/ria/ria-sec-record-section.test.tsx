import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  RiaSecRecordSection,
  type RiaSecAdvisorRecord,
  type RiaSecFirmRecord,
} from "@/components/ria/profile/ria-sec-record-section";
import type { RiaClaimProfileFacts } from "@/lib/services/ria-service";

const fullAdvisor: RiaSecAdvisorRecord = {
  crd: 1234567,
  registered_since: "2004-01-12",
  exams: [
    { code: "Series 65", name: "Uniform Investment Adviser Law", date: "2004-01-05" },
    { code: "Series 7", name: "General Securities Representative", date: "2001-06-02" },
  ],
  registered_states: [
    { state: "CA", status: "APPROVED", date: "2004-01-12" },
    { state: "NY", status: "APPROVED", date: "2006-03-01" },
  ],
  previous_firms: [{ firm_name: "OLD CAPITAL LLC", firm_crd: 99, from: "2001", to: "2004" }],
  branch: { city: "SAN FRANCISCO", state: "CA", street1: "1 Market St", zip: "94105" },
  has_disclosures: true,
  disclosure_count: 2,
  report_url: "https://adviserinfo.sec.gov/individual/summary/1234567",
};

const fullFirm: RiaSecFirmRecord = {
  crd: 800001,
  name: "EXAMPLE ADVISORS LLC",
  registration_status: "Active",
  registration_type: "sec",
  aum: 2_500_000_000,
  num_accounts: 1400,
  total_employees: 52,
  registrations: [{ jurisdiction: "SEC", status: "APPROVED", effective_date: "1998-04-20" }],
  notice_filed_states: ["CA", "NY", "TX", "WA"],
  form_adv_pdf_url: "https://reports.adviserinfo.sec.gov/reports/ADV/800001/adv.pdf",
  form_crs_url: "https://reports.adviserinfo.sec.gov/crs/crs_800001.pdf",
  brochures: [{ name: "WRAP FEE BROCHURE", date_submitted: "2025-03-01", url: "https://example.com/brochure.pdf" }],
  website: "https://exampleadvisors.com",
  report_url: "https://adviserinfo.sec.gov/firm/summary/800001",
};

describe("RiaSecRecordSection", () => {
  it("renders the full record from persisted firm and adviser snapshots", () => {
    render(<RiaSecRecordSection advisorRecord={fullAdvisor} firmRecord={fullFirm} />);

    expect(screen.getByText("From your SEC record.")).toBeInTheDocument();
    // Adviser rows.
    expect(screen.getByText("CRD")).toBeInTheDocument();
    expect(screen.getByText("1234567")).toBeInTheDocument();
    expect(screen.getByText("Registered since")).toBeInTheDocument();
    expect(screen.getByText("2004-01-12")).toBeInTheDocument();
    expect(screen.getByText("Office")).toBeInTheDocument();
    expect(screen.getByText("San Francisco, CA")).toBeInTheDocument();
    expect(screen.getByText("Exams")).toBeInTheDocument();
    expect(screen.getByText("Series 65, Series 7")).toBeInTheDocument();
    expect(screen.getByText("Registered in 2")).toBeInTheDocument();
    expect(screen.getByText("CA, NY · Approved")).toBeInTheDocument();
    expect(screen.getByText("Previously")).toBeInTheDocument();
    expect(screen.getByText("Old Capital LLC · 2001–2004")).toBeInTheDocument();
    expect(screen.getByText("Disclosures")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    // Firm rows.
    expect(screen.getByText("Regulator")).toBeInTheDocument();
    expect(screen.getByText("SEC · Active")).toBeInTheDocument();
    expect(screen.getByText("Firm assets")).toBeInTheDocument();
    expect(screen.getByText("$2.5B")).toBeInTheDocument();
    expect(screen.getByText("Accounts")).toBeInTheDocument();
    expect(screen.getByText("1,400")).toBeInTheDocument();
    expect(screen.getByText("Employees")).toBeInTheDocument();
    expect(screen.getByText("52")).toBeInTheDocument();
    expect(screen.getByText("Notice filed in 4")).toBeInTheDocument();
    expect(screen.getByText("CA, NY, TX…")).toBeInTheDocument();
    expect(screen.getByText("SEC")).toBeInTheDocument();
    expect(screen.getByText("Approved · 1998-04-20")).toBeInTheDocument();
    // Links.
    expect(
      screen.getByRole("link", { name: /View on adviserinfo\.sec\.gov/ }),
    ).toHaveAttribute("href", fullAdvisor.report_url);
    expect(screen.getByRole("link", { name: /Form ADV/ })).toHaveAttribute(
      "href",
      fullFirm.form_adv_pdf_url,
    );
    expect(screen.getByRole("link", { name: /Form CRS/ })).toHaveAttribute(
      "href",
      fullFirm.form_crs_url,
    );
    expect(screen.getByRole("link", { name: /Wrap Fee Brochure/ })).toHaveAttribute(
      "href",
      "https://example.com/brochure.pdf",
    );
    expect(screen.getByRole("link", { name: /Website/ })).toHaveAttribute(
      "href",
      fullFirm.website,
    );
  });

  it("renders from the claim-page facts shape", () => {
    const facts: RiaClaimProfileFacts = {
      crd_number: "7654321",
      regulator: "SEC",
      regulator_status: "Active",
      registered_since: "2010-05-01",
      branch_city: "AUSTIN",
      branch_state: "TX",
      exams: [{ code: "Series 66" }],
      registered_states: [{ state: "TX", status: "APPROVED" }],
      previous_firms: [{ firm_name: "PRIOR LLC" }],
      notice_filed_states: ["TX"],
      aum: 120_000_000,
      num_accounts: 300,
      firm_website: "https://factsfirm.com",
      report_url: "https://adviserinfo.sec.gov/individual/summary/7654321",
      has_disclosures: false,
    };
    render(<RiaSecRecordSection facts={facts} />);

    expect(screen.getByText("7654321")).toBeInTheDocument();
    expect(screen.getByText("SEC · Active")).toBeInTheDocument();
    expect(screen.getByText("Austin, TX")).toBeInTheDocument();
    expect(screen.getByText("$120M")).toBeInTheDocument();
    expect(screen.getByText("Registered in")).toBeInTheDocument();
    expect(screen.getByText("TX · Approved")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Website/ })).toHaveAttribute(
      "href",
      "https://factsfirm.com",
    );
    // No disclosures flag → no row.
    expect(screen.queryByText("Disclosures")).not.toBeInTheDocument();
  });

  it("prefers the fuller snapshot over facts where both exist", () => {
    const facts: RiaClaimProfileFacts = { crd_number: "1", aum: 1_000_000 };
    render(
      <RiaSecRecordSection
        facts={facts}
        advisorRecord={{ crd: 999 }}
        firmRecord={{ aum: 2_000_000_000 }}
      />,
    );
    expect(screen.getByText("999")).toBeInTheDocument();
    expect(screen.queryByText("1")).not.toBeInTheDocument();
    expect(screen.getByText("$2.0B")).toBeInTheDocument();
  });

  it("omits absent rows entirely instead of rendering placeholders", () => {
    render(<RiaSecRecordSection advisorRecord={{ crd: 42 }} firmRecord={{}} />);
    expect(screen.getByText("CRD")).toBeInTheDocument();
    expect(screen.queryByText(/N\/A/)).not.toBeInTheDocument();
    expect(screen.queryByText("Office")).not.toBeInTheDocument();
    expect(screen.queryByText("Exams")).not.toBeInTheDocument();
    expect(screen.queryByText("Regulator")).not.toBeInTheDocument();
    expect(screen.queryByText("Employees")).not.toBeInTheDocument();
  });

  it("renders nothing when no record exists", () => {
    const { container } = render(<RiaSecRecordSection />);
    expect(container).toBeEmptyDOMElement();
  });

  it("never renders phone digits from the raw metadata snapshot", () => {
    // The persisted firm_record carries the claimant's phone; the section must
    // render selected keys only and drop it even when present at runtime.
    const leakyFirm = { ...fullFirm, phone: "2125550123" } as RiaSecFirmRecord;
    const { container } = render(
      <RiaSecRecordSection advisorRecord={fullAdvisor} firmRecord={leakyFirm} />,
    );
    expect(container.textContent).not.toContain("2125550123");
    expect(container.textContent).not.toContain("(212) 555-0123");
  });

  it("mounts the header accessory beside the caption", () => {
    render(
      <RiaSecRecordSection
        advisorRecord={{ crd: 42 }}
        headerAccessory={<span data-testid="chip">Verified</span>}
      />,
    );
    expect(screen.getByTestId("chip")).toBeInTheDocument();
  });
});
