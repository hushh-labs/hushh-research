import { resumeToText, splitName, type Resume } from "@/lib/career/resume";
import { CareerPkmService, type CareerApplicationReceipt } from "@/lib/services/career-pkm-service";
import { CareerService, type CareerApplicationResult, type CareerRole } from "@/lib/services/career-service";

type WriteParams = { userId: string; vaultKey: string; vaultOwnerToken: string };

/**
 * Apply to one hussh role with the resume saved in the owner's PKM.
 *
 * Shared by the Career screen and Agent One's careers.apply chat action, so
 * both send exactly the same fields and both leave a receipt in PKM. The
 * receipt write is best effort: a failed write never turns a sent application
 * into a reported failure (receiptSaved says which happened).
 */
export async function applyWithSavedResume(params: {
  role: Pick<CareerRole, "slug" | "family" | "title">;
  resume: Resume;
  write: WriteParams;
}): Promise<{ result: CareerApplicationResult; receipt: CareerApplicationReceipt; receiptSaved: boolean }> {
  const { role, resume, write } = params;
  const receiptId = crypto.randomUUID();
  const { first, last } = splitName(resume.name);
  const link = (needle: string) => resume.links.find((l) => l.url.toLowerCase().includes(needle))?.url;
  const resumeText = resumeToText(resume);
  const result = await CareerService.applyToRole({
    role,
    firstName: first,
    lastName: last,
    location: resume.location,
    resumeText,
    links: { linkedin: link("linkedin.com"), github: link("github.com") },
    consentReceiptId: receiptId,
  });
  const receipt: CareerApplicationReceipt = {
    receipt_id: receiptId,
    role_slug: role.slug,
    role_title: role.title,
    sent_at: new Date().toISOString(),
    reference: result.reference,
    status_link: result.statusLink,
    shared: { name: resume.name, location: resume.location, resume_chars: resumeText.length },
  };
  const receiptSaved = await CareerPkmService.recordApplication({ ...write, receipt }).then(
    () => true,
    () => false,
  );
  return { result, receipt, receiptSaved };
}
