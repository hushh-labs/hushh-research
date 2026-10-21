"""Write the synthetic labelled fixtures for the Drive four-group organizing aid.

Every name, person, number and layout here is invented. The train and eval
sets use disjoint template families (different layouts, issuers and phrasing),
so an eval row is never a re-skin of a train row. Hard negatives copy the
words that fooled the earlier hand-weighted rules: coursework with a lab or
enrollment number, a statement of purpose, a bank holiday circular, accounting
lecture notes. These fixtures are a regression gate for the aid. They are not
a measure of accuracy on a real Drive; for that, run ``eval_drive_groups.py``
on a private file of authorized labels.

    python scripts/build_drive_group_fixtures.py
"""

# ruff: noqa: S311 -- seeded synthetic fixtures, never secrets or tokens

from __future__ import annotations

import json
import random
import sys
from collections.abc import Callable
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from hushh_mcp.services.drive_groups.text_head import HEAD_CHARS, capture_head  # noqa: E402

OUT = (
    Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "drive_groups" / "synthetic.jsonl"
)
SEED = 20261021
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
BANKS = [
    "Northwind Bank",
    "Contoso Bank",
    "Fabrikam Savings",
    "Tailspin Credit Union",
    "Litware Finance",
]
CARDS = ["Northwind Platinum Card", "Contoso Rewards Card", "Fabrikam Everyday Card"]
BROKERS = ["Woodgrove Securities", "Proseware Capital", "Lucerne Wealth"]
INSURERS = ["Wingtip Insurance", "Alpine General Insurance", "Proseware Life", "Coho Health Cover"]
PEOPLE = [
    "Alex Morgan",
    "Priya Rao",
    "Jordan Ellis",
    "Sana Khan",
    "Marco Ruiz",
    "Mei Tan",
    "Omar Haddad",
]
UNIVERSITIES = ["Woodgrove University", "Tailwind Institute of Technology", "Blue Yonder College"]
PDF, DOC, DOCX, SHEET, TXT = (
    "application/pdf",
    "application/vnd.google-apps.document",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.google-apps.spreadsheet",
    "text/plain",
)


class Maker:
    def __init__(self, rng: random.Random) -> None:
        self.rng = rng

    def date(self) -> str:
        return f"{self.rng.randint(1, 28):02d} {self.rng.choice(MONTHS)} {self.rng.randint(2024, 2026)}"

    def period(self) -> str:
        return f"{self.date()} to {self.date()}"

    def amount(self, high: int = 900000) -> str:
        return f"{self.rng.randint(120, high):,}.{self.rng.randint(0, 99):02d}"

    def digits(self, n: int) -> str:
        return "".join(str(self.rng.randint(0, 9)) for _ in range(n))

    def pick(self, pool: list[str]) -> str:
        return self.rng.choice(pool)

    def noisy(self, text: str) -> str:
        """Scan-like damage: case, spacing and character slips, on some rows only."""
        roll = self.rng.random()
        if roll < 0.12:
            return text.upper()
        if roll < 0.22:
            return text.replace(" ", "  ", 6).replace("O", "0", 2)
        if roll < 0.28:
            return text.replace(":", "").replace(".", "", 4)
        return text


# Each family returns (text start, name stems). Stems are filled with {tag}.
Family = Callable[[Maker], tuple[str, list[str]]]


def bank_statement(m: Maker):
    bank = m.pick(BANKS)
    return (
        f"{bank} Statement of Account Account Number XXXXXX{m.digits(4)} Customer {m.pick(PEOPLE)} "
        f"Statement Period {m.period()} Opening Balance {m.amount()} Closing Balance {m.amount()} "
        f"Date Narration Withdrawals Deposits Balance {m.date()} UPI Transfer {m.amount(5000)} "
        f"{m.date()} Salary Credit {m.amount()}",
        [
            f"{bank.split()[0]}_Statement_{{tag}}",
            "Account statement {tag}",
            "acct_{tag}",
            "{tag} bank statement",
        ],
    )


def card_statement(m: Maker):
    card = m.pick(CARDS)
    return (
        f"{card} Credit Card Statement Statement Date {m.date()} Payment Due Date {m.date()} "
        f"Total Amount Due {m.amount(80000)} Minimum Amount Due {m.amount(8000)} Credit Limit "
        f"{m.amount()} Available Credit {m.amount()} Card Number XXXX XXXX XXXX {m.digits(4)} "
        f"Reward Points Balance {m.rng.randint(100, 9000)} Transactions",
        [f"{card.split()[0]}_card_{{tag}}", "CC statement {tag}", "Card bill {tag}"],
    )


def demat_holding(m: Maker):
    broker = m.pick(BROKERS)
    return (
        f"{broker} Holding Statement as on {m.date()} Client ID {m.digits(8)} DP ID IN{m.digits(6)} "
        f"ISIN Security Name Quantity Closing Price Market Value INE{m.digits(3)}A01012 "
        f"Contoso Industries Ltd {m.rng.randint(5, 900)} {m.amount(4000)} {m.amount()} Total Portfolio Value {m.amount()}",
        [f"{broker.split()[0]}_holdings_{{tag}}", "Demat statement {tag}", "portfolio {tag}"],
    )


def loan_statement(m: Maker):
    bank = m.pick(BANKS)
    return (
        f"{bank} Loan Account Statement Loan Account No {m.digits(10)} Borrower {m.pick(PEOPLE)} "
        f"Sanctioned Amount {m.amount()} Rate of Interest {m.rng.randint(7, 13)}.{m.rng.randint(0, 99):02d}% "
        f"EMI Amount {m.amount(60000)} Principal Outstanding {m.amount()} Next EMI Due {m.date()} "
        f"Installments Paid {m.rng.randint(1, 60)} of {m.rng.randint(61, 240)}",
        ["{tag} loan statement", f"{bank.split()[0]}_loan_{{tag}}", "EMI schedule {tag}"],
    )


def mutual_fund_cas(m: Maker):
    return (
        f"Consolidated Account Statement for the period {m.period()} PAN XXXXX{m.digits(4)}X "
        f"Folio No {m.digits(9)} Scheme Woodgrove Flexi Cap Fund Direct Growth Opening Unit Balance "
        f"{m.rng.randint(10, 900)}.{m.digits(3)} NAV on {m.date()} {m.amount(300)} Closing Unit Balance "
        f"Valuation {m.amount()} Transaction Type Purchase SIP Amount {m.amount(20000)}",
        ["CAS_{tag}", "Mutual fund statement {tag}", "consolidated account statement {tag}"],
    )


def tax_statement(m: Maker):
    return (
        f"Annual Tax Statement Form 26AS Assessment Year {m.rng.randint(2024, 2027)}-{m.rng.randint(25, 28)} "
        f"Permanent Account Number XXXXX{m.digits(4)}X Part A Details of Tax Deducted at Source "
        f"Name of Deductor Fabrikam Services TAN BLRF{m.digits(5)}A Amount Paid {m.amount()} "
        f"Tax Deducted {m.amount(90000)} Tax Deposited {m.amount(90000)}",
        ["26AS {tag}", "tax statement {tag}", "AIS_{tag}"],
    )


def checking_summary(m: Maker):
    bank = m.pick(BANKS)
    return (
        f"{bank} Your checking account summary Account ending in {m.digits(4)} Statement closing date "
        f"{m.date()} Beginning balance ${m.amount()} Deposits and other credits ${m.amount()} "
        f"Withdrawals and other debits ${m.amount()} Ending balance ${m.amount()} Daily balance summary "
        f"Overdraft protection Member FDIC",
        ["eStmt_{tag}", f"{bank.split()[0]} checking {{tag}}", "statement_{tag}"],
    )


def hindi_bank(m: Maker):
    bank = m.pick(BANKS)
    return (
        f"{bank} खाता विवरण Account Statement खाता संख्या XXXXXX{m.digits(4)} अवधि {m.period()} "
        f"प्रारंभिक शेष {m.amount()} अंतिम शेष {m.amount()} दिनांक विवरण जमा निकासी शेष राशि "
        f"UPI भुगतान {m.amount(4000)}",
        ["खाता विवरण {tag}", "bank stmt {tag}", "{tag} passbook"],
    )


def electricity_usage(m: Maker):
    return (
        f"Lucerne Power Distribution Electricity Usage Statement Consumer No {m.digits(10)} Billing "
        f"Period {m.period()} Meter Number {m.digits(7)} Previous Reading {m.rng.randint(1000, 9000)} "
        f"Current Reading {m.rng.randint(9001, 12000)} Units Consumed kWh {m.rng.randint(90, 700)} "
        f"Sanctioned Load {m.rng.randint(2, 9)} kW Tariff Domestic",
        ["electricity bill {tag}", "Power usage {tag}", "LPD_{tag}"],
    )


def mobile_usage(m: Maker):
    return (
        f"Adventure Works Telecom Itemised Usage Statement Mobile Number +91 {m.digits(5)} {m.digits(5)} "
        f"Plan Unlimited 5G Bill Period {m.period()} Data Used {m.rng.randint(5, 400)} GB Voice Minutes "
        f"{m.rng.randint(20, 900)} SMS {m.rng.randint(0, 200)} Roaming None Call Details Date Time Called Number Duration",
        ["mobile bill {tag}", "AWT_usage_{tag}", "phone statement {tag}"],
    )


def lab_report(m: Maker):
    return (
        f"Blue Yonder Diagnostics Laboratory Report Patient Name {m.pick(PEOPLE)} Age {m.rng.randint(18, 80)} "
        f"Sex F Sample Collected {m.date()} Referred By Dr Rivera Test Name Result Unit Reference Range "
        f"Hemoglobin {m.rng.randint(9, 17)}.{m.rng.randint(0, 9)} g/dL 12.0 - 15.5 Total Cholesterol "
        f"{m.rng.randint(120, 260)} mg/dL",
        ["lab report {tag}", "blood test {tag}", "BYD_report_{tag}"],
    )


def transcript(m: Maker):
    uni = m.pick(UNIVERSITIES)
    return (
        f"{uni} Official Academic Transcript Student Name {m.pick(PEOPLE)} Program B.Tech Computer Science "
        f"Semester {m.rng.randint(1, 8)} Course Code Course Title Credits Grade CS{m.digits(3)} Data "
        f"Structures 4 A MA{m.digits(3)} Linear Algebra 3 B+ Semester Grade Point Average {m.rng.randint(6, 9)}.{m.rng.randint(0, 99):02d} "
        f"Cumulative GPA",
        ["transcript {tag}", "marksheet sem {tag}", "grade report {tag}"],
    )


def broadband_usage(m: Maker):
    return (
        f"Tailwind Fibre Broadband Usage Statement Account ID {m.digits(9)} Billing Cycle {m.period()} "
        f"Plan 300 Mbps Data Download {m.rng.randint(80, 900)} GB Upload {m.rng.randint(5, 90)} GB "
        f"Average Speed {m.rng.randint(180, 310)} Mbps Outage Hours {m.rng.randint(0, 6)} Fair Usage Policy",
        ["internet usage {tag}", "fibre statement {tag}", "TFB_{tag}"],
    )


def discharge_summary(m: Maker):
    return (
        f"Margie Care Hospital Discharge Summary Patient {m.pick(PEOPLE)} UHID {m.digits(8)} Date of "
        f"Admission {m.date()} Date of Discharge {m.date()} Diagnosis Acute appendicitis Procedure "
        f"Laparoscopic appendectomy Condition at Discharge Stable Medications Advised Follow up after 7 days",
        ["discharge summary {tag}", "hospital papers {tag}", "MCH_{tag}"],
    )


def gas_water_usage(m: Maker):
    return (
        f"Northwind Utilities Water and Gas Consumption Statement Service Address Block {m.rng.randint(1, 40)} "
        f"Customer Reference {m.digits(9)} Reading Date {m.date()} Water Consumed kL {m.rng.randint(8, 60)} "
        f"Gas Consumed SCM {m.rng.randint(5, 80)} Previous Reading Current Reading Usage Trend Compared "
        f"with Last Quarter",
        ["utility usage {tag}", "water gas {tag}", "NWU_{tag}"],
    )


def grade_report(m: Maker):
    uni = m.pick(UNIVERSITIES)
    return (
        f"{uni} Statement of Marks Roll Number {m.digits(8)} Examination Held {m.date()} Candidate "
        f"{m.pick(PEOPLE)} Paper Marks Obtained Maximum Marks Result Physics {m.rng.randint(40, 98)} 100 "
        f"Pass Mathematics {m.rng.randint(40, 98)} 100 Pass Aggregate {m.rng.randint(55, 95)}% Division First",
        ["statement of marks {tag}", "result {tag}", "exam marks {tag}"],
    )


def health_policy(m: Maker):
    insurer = m.pick(INSURERS)
    return (
        f"{insurer} Health Insurance Policy Schedule Policy Number {m.digits(4)}/{m.digits(8)} Policyholder "
        f"{m.pick(PEOPLE)} Period of Insurance {m.period()} Sum Insured {m.amount()} Premium Payable "
        f"{m.amount(60000)} Insured Members 3 Room Rent Limit Co-payment 10% Pre-existing disease waiting period",
        [f"{insurer.split()[0]}_policy_{{tag}}", "health policy {tag}", "policy schedule {tag}"],
    )


def premium_notice(m: Maker):
    insurer = m.pick(INSURERS)
    return (
        f"{insurer} Premium Due Notice Dear Policyholder your life insurance premium is due Policy Number "
        f"{m.digits(10)} Plan Term Assurance Sum Assured {m.amount()} Premium Amount {m.amount(80000)} "
        f"Due Date {m.date()} Mode Annual Grace period of 30 days Kindly pay to keep your policy in force",
        ["premium notice {tag}", f"{insurer.split()[0]}_premium_{{tag}}", "LIC style notice {tag}"],
    )


def motor_certificate(m: Maker):
    insurer = m.pick(INSURERS)
    return (
        f"{insurer} Certificate of Insurance cum Policy Schedule Private Car Package Policy Registration "
        f"No KA{m.digits(2)}XY{m.digits(4)} Make Model Hatchback Engine No {m.digits(9)} IDV {m.amount()} "
        f"No Claim Bonus 25% Period {m.period()} Own Damage Premium {m.amount(30000)} Third Party Premium",
        ["car insurance {tag}", "motor policy {tag}", "vehicle cover note {tag}"],
    )


def claim_letter(m: Maker):
    insurer = m.pick(INSURERS)
    return (
        f"{insurer} Claim Settlement Letter Claim Number CL{m.digits(9)} Policy Number {m.digits(10)} "
        f"Insured {m.pick(PEOPLE)} Date of Loss {m.date()} Amount Claimed {m.amount(200000)} Amount Approved "
        f"{m.amount(200000)} Deductions Non-payable items Settlement by NEFT within 7 working days",
        ["claim settlement {tag}", "claim letter {tag}", "insurance claim {tag}"],
    )


def term_life_statement(m: Maker):
    return (
        f"Proseware Life Annual Policy Statement for the year ended {m.date()} Policy {m.digits(9)} Life "
        f"Assured {m.pick(PEOPLE)} Sum Assured {m.amount()} Premiums Paid to date {m.amount(500000)} "
        f"Policy Status In Force Nominee Registered Rider Accidental Death Benefit Surrender Value Not applicable",
        ["life policy statement {tag}", "term plan {tag}", "PL_annual_{tag}"],
    )


def home_travel_policy(m: Maker):
    insurer = m.pick(INSURERS)
    return (
        f"{insurer} Home Shield Policy Schedule Insured Location Flat {m.rng.randint(100, 900)} Building "
        f"Sum Insured Structure {m.amount()} Contents {m.amount(900000)} Perils Covered Fire Flood Burglary "
        f"Policy Period {m.period()} Premium {m.amount(40000)} GST Total Premium Paid",
        ["home insurance {tag}", "property policy {tag}", "{tag} cover schedule"],
    )


def renewal_notice(m: Maker):
    insurer = m.pick(INSURERS)
    return (
        f"{insurer} Health Insurance Renewal Notice Your policy {m.digits(10)} expires on {m.date()} "
        f"Renew before the expiry date to retain continuity benefits and no claim bonus Renewal Premium "
        f"{m.amount(70000)} Sum Insured {m.amount()} Pay online or contact your advisor",
        ["renewal notice {tag}", "policy renewal {tag}", "{tag} renew"],
    )


def claim_status(m: Maker):
    insurer = m.pick(INSURERS)
    return (
        f"{insurer} Claim Status Statement Reference CL{m.digits(9)} Claim Type Cashless Hospitalisation "
        f"Status Under Review Documents Received {m.date()} Pending Requirements Discharge summary Final "
        f"bill Policy {m.digits(10)} Insured {m.pick(PEOPLE)}",
        ["claim status {tag}", "cashless claim {tag}", "claim update {tag}"],
    )


def passport(m: Maker):
    return (
        f"Republic of Northwind Passport Type P Code NWD Passport No {m.rng.choice('ABCDEFGH')}{m.digits(7)} "
        f"Surname {m.pick(PEOPLE).split()[1]} Given Names {m.pick(PEOPLE).split()[0]} Nationality Northwindian "
        f"Date of Birth {m.date()} Place of Birth Springfield Date of Issue {m.date()} Date of Expiry {m.date()} "
        f"Authority Passport Office",
        ["passport", "passport scan {tag}", "my passport copy"],
    )


def national_id(m: Maker):
    return (
        f"Government of Northwind National Identity Card ID No {m.digits(4)} {m.digits(4)} {m.digits(4)} "
        f"Name {m.pick(PEOPLE)} Date of Birth {m.date()} Gender Address House {m.rng.randint(1, 99)} Elm Street "
        f"Springfield Issued {m.date()} Valid proof of identity and address",
        ["national id", "ID card front back", "identity card {tag}"],
    )


def resume(m: Maker):
    return (
        f"{m.pick(PEOPLE)} Resume Objective Motivated software engineer seeking a role in backend "
        f"development Education B.Tech Computer Science {m.pick(UNIVERSITIES)} {m.rng.randint(2016, 2024)} "
        f"Experience Software Engineer Contoso Ltd {m.rng.randint(2018, 2022)} - Present Skills Python SQL "
        f"Docker References available on request",
        ["resume", "CV {tag}", "{tag} resume final"],
    )


def certificate(m: Maker):
    return (
        f"This is to certify that {m.pick(PEOPLE)} was born on {m.date()} at Springfield General Hospital "
        f"Certificate of Birth Registration No {m.digits(8)} Date of Registration {m.date()} Issued by the "
        f"Registrar of Births and Deaths Seal and signature of the issuing authority",
        ["birth certificate", "certificate scan {tag}", "degree certificate {tag}"],
    )


def driving_licence(m: Maker):
    return (
        f"Northwind State Transport Department Driving Licence DL No NW{m.digits(2)} {m.digits(11)} Name "
        f"{m.pick(PEOPLE)} S/D/W of Date of Birth {m.date()} Blood Group O+ Class of Vehicle LMV MCWG "
        f"Valid Till {m.date()} Issuing Authority RTO",
        ["driving licence", "DL copy {tag}", "licence front"],
    )


def employment_letter(m: Maker):
    return (
        f"Contoso Ltd Employment Letter Date {m.date()} To {m.pick(PEOPLE)} Dear sir or madam we are pleased "
        f"to offer you the position of Analyst at our Bengaluru office effective {m.date()} Your annual "
        f"compensation will be communicated separately Please sign and return a copy of this letter",
        ["offer letter {tag}", "employment letter {tag}", "joining letter"],
    )


def resume_alt(m: Maker):
    return (
        f"CURRICULUM VITAE Name: {m.pick(PEOPLE)} Date of Birth: {m.date()} Address: Springfield Mobile: "
        f"{m.digits(10)} Career Summary Product designer with {m.rng.randint(2, 12)} years of experience "
        f"Academic Qualifications Master of Design {m.pick(UNIVERSITIES)} Languages English Hindi",
        ["CV_{tag}", "curriculum vitae", "profile {tag}"],
    )


def domicile_form(m: Maker):
    return (
        f"Application Form for Domicile Certificate Name of Applicant {m.pick(PEOPLE)} Father's Name "
        f"Permanent Address Years of residence {m.rng.randint(5, 40)} Declaration I hereby declare that the "
        f"information furnished above is true Signature of Applicant Date {m.date()} Photograph Attestation",
        ["domicile form {tag}", "application form {tag}", "marriage certificate {tag}"],
    )


# Files that fit none of the four groups, including the words that fooled the
# earlier rules.
def coursework(m: Maker):
    uni = m.pick(UNIVERSITIES)
    return (
        f"{uni} Department of Computer Science Lab Assignment {m.rng.randint(1, 9)} Computer Vision CV "
        f"Enrollment No {m.digits(9)} Name {m.pick(PEOPLE)} Submitted {m.date()} Aim implement edge "
        f"detection using OpenCV Procedure load the image convert to grayscale apply the Sobel operator",
        ["CV lab {tag}", "assignment {tag}", "lab report final {tag}"],
    )


def meeting_notes(m: Maker):
    return (
        f"Weekly sync {m.date()} Attendees {m.pick(PEOPLE)}, {m.pick(PEOPLE)}, {m.pick(PEOPLE)} Agenda "
        f"1 roadmap review 2 hiring plan 3 launch checklist Notes The team agreed to move the beta to next "
        f"sprint Action items follow up with design on onboarding copy",
        ["meeting notes {tag}", "standup {tag}", "Notes by Gemini {tag}"],
    )


def project_plan(m: Maker):
    return (
        f"Project Plan Mobile Onboarding Revamp Goals reduce drop off in the first session Milestones "
        f"design review {m.date()} prototype test {m.date()} release candidate Risks vendor delay Owner "
        f"{m.pick(PEOPLE)} Budget approved by finance Dependencies analytics SDK upgrade",
        ["project plan {tag}", "roadmap {tag}", "spec draft {tag}"],
    )


def itinerary(m: Maker):
    return (
        f"Trip itinerary Lisbon and Porto Day 1 arrive {m.date()} check in at the guesthouse walk the old "
        f"town Day 2 tram to Belem pastries Day 3 train to Porto riverside dinner Packing list adapter "
        f"sunscreen comfortable shoes Restaurant ideas",
        ["trip plan {tag}", "itinerary", "holiday ideas {tag}"],
    )


def statement_of_purpose(m: Maker):
    uni = m.pick(UNIVERSITIES)
    return (
        f"Statement of Purpose I am applying to the Master of Science program at {uni} because my work in "
        f"machine learning has shown me how much I still want to learn My undergraduate research on "
        f"recommendation systems taught me to ask careful questions and to measure the answer",
        ["statement of purpose {tag}", "SOP final", "essay draft {tag}"],
    )


def research_notes(m: Maker):
    return (
        "Reading notes Attention is all you need Summary the transformer replaces recurrence with "
        "self attention Key ideas multi head attention positional encoding Questions how does scaling "
        "change with context length Related work memory networks, convolutional sequence models",
        ["paper notes {tag}", "reading list {tag}", "research {tag}"],
    )


def marketing_copy(m: Maker):
    return (
        "Spring campaign copy Headline Fresh starts for every kitchen Subhead Cook something new this "
        "season Body Our best selling pans are now in three colours Call to action Shop the collection "
        "Tone warm and playful Channels email, social, in store posters",
        ["campaign copy {tag}", "ad text {tag}", "newsletter {tag}"],
    )


def bank_holiday_circular(m: Maker):
    bank = m.pick(BANKS)
    return (
        f"{bank} Circular Bank holidays for the coming quarter All branches will remain closed on the "
        f"following dates {m.date()} {m.date()} {m.date()} Customers are requested to plan their branch "
        f"visits accordingly Internet banking and ATMs will remain available",
        ["bank holiday list {tag}", "branch circular {tag}", "holiday notice"],
    )


def insurance_comparison(m: Maker):
    return (
        "Notes comparing health insurance options to think about for next year Wingtip has a lower "
        "premium but Alpine covers more hospitals Things to ask the agent about waiting periods and "
        "room rent limits Not decided yet will talk to family over the weekend",
        ["insurance thoughts {tag}", "which plan {tag}", "compare plans"],
    )


def accounting_lecture(m: Maker):
    uni = m.pick(UNIVERSITIES)
    return (
        f"{uni} Financial Accounting Lecture {m.rng.randint(1, 12)} Financial statements analysis The "
        f"income statement, the balance sheet and the cash flow statement Learning objectives define "
        f"assets, liabilities and equity Example Contoso Ltd reports revenue and operating expenses",
        ["accounting lecture {tag}", "FA slides {tag}", "financial statements notes"],
    )


def recipe(m: Maker):
    return (
        "Weeknight lentil soup Serves four Ingredients one cup red lentils, an onion, two carrots, "
        "garlic, cumin, lemon Method soften the onion, add spices, then lentils and stock, simmer "
        "twenty minutes, blend half, finish with lemon Tip freezes well",
        ["recipe {tag}", "soup", "dinner ideas {tag}"],
    )


TRAIN: dict[str, list[Family]] = {
    "financial_statements": [bank_statement, card_statement, demat_holding, loan_statement],
    "non_financial_statements": [electricity_usage, mobile_usage, lab_report, transcript],
    "insurance_statements": [health_policy, premium_notice, motor_certificate, claim_letter],
    "personal_documents": [passport, national_id, resume, certificate],
    "none": [coursework, meeting_notes, project_plan, itinerary, statement_of_purpose, recipe],
}
EVAL: dict[str, list[Family]] = {
    "financial_statements": [mutual_fund_cas, tax_statement, checking_summary, hindi_bank],
    "non_financial_statements": [broadband_usage, discharge_summary, gas_water_usage, grade_report],
    "insurance_statements": [term_life_statement, home_travel_policy, renewal_notice, claim_status],
    "personal_documents": [driving_licence, employment_letter, resume_alt, domicile_form],
    "none": [
        research_notes,
        marketing_copy,
        bank_holiday_circular,
        insurance_comparison,
        accounting_lecture,
    ],
}
PER_FAMILY = {"train": 12, "eval": 6}
PER_NONE_FAMILY = {"train": 14, "eval": 10}
UNINFORMATIVE = [
    "scan_{n:04d}",
    "IMG_{n:04d}",
    "Document ({n})",
    "Untitled document",
    "file{n}",
    "New doc {n}",
]


def tag(m: Maker) -> str:
    return m.rng.choice(
        [
            f"{m.rng.choice(MONTHS)}{m.rng.randint(2024, 2026)}",
            f"{m.rng.randint(2024, 2026)}-{m.rng.randint(1, 12):02d}",
            f"{m.rng.choice(MONTHS)} {m.rng.randint(2024, 2026)}",
            f"Q{m.rng.randint(1, 4)} FY{m.rng.randint(24, 27)}",
            f"({m.rng.randint(1, 9)})",
        ]
    )


def build_row(m: Maker, split: str, label: str, family: Family, serial: int) -> dict:
    head_text, stems = family(m)
    mime = m.rng.choices([PDF, DOC, DOCX, SHEET, TXT], weights=[60, 14, 12, 9, 5])[0]
    scanned = m.rng.random() < 0.12
    informative = m.rng.random() > 0.25
    stem = (
        m.pick(stems).replace("{tag}", tag(m))
        if informative
        else m.pick(UNINFORMATIVE).format(n=serial)
    )
    extension = {PDF: ".pdf", DOCX: ".docx", TXT: ".txt"}.get(mime, "")
    if scanned:
        mime, extension = PDF, ".pdf"
    head = None if scanned else capture_head((m.noisy(head_text),), HEAD_CHARS)
    return {
        "id": f"{split[0]}{serial:04d}",
        "split": split,
        "family": family.__name__,
        "label": label,
        "name": f"{stem}{extension}",
        "mime": mime,
        "shared_with_me": m.rng.random() < (0.08 if label != "none" else 0.3),
        "owned_by_me": m.rng.random() < (0.92 if label != "none" else 0.7),
        "head": head,
    }


def build() -> list[dict]:
    rng = random.Random(SEED)
    maker = Maker(rng)
    rows, serial = [], 0
    for split, families in (("train", TRAIN), ("eval", EVAL)):
        for label, members in families.items():
            count = (PER_NONE_FAMILY if label == "none" else PER_FAMILY)[split]
            for family in members:
                for _ in range(count):
                    serial += 1
                    rows.append(build_row(maker, split, label, family, serial))
    return rows


def main() -> None:
    rows = build()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    lines = "\n".join(json.dumps(row, ensure_ascii=False) for row in rows) + "\n"
    OUT.write_bytes(lines.encode("utf-8"))  # bytes: identical on every platform
    by = {}
    for row in rows:
        by.setdefault((row["split"], row["label"]), 0)
        by[(row["split"], row["label"])] += 1
    print(f"wrote {len(rows)} rows to {OUT.name}")
    for key in sorted(by):
        print(f"  {key[0]:5s} {key[1]:26s} {by[key]}")


if __name__ == "__main__":
    main()
