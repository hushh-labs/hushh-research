"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Briefcase } from "lucide-react";
import { toast } from "sonner";

import { AppPageContentRegion, AppPageHeaderRegion, AppPageShell } from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { useAuth } from "@/hooks/use-auth";
import { isEmptyResume, normalizeResume, resumeToText, splitName, type Resume } from "@/lib/career/resume";
import { Button } from "@/lib/morphy-ux/morphy";
import { ROUTES } from "@/lib/navigation/routes";
import { CareerPkmService, type CareerApplicationReceipt } from "@/lib/services/career-pkm-service";
import { CareerService, type CareerRole } from "@/lib/services/career-service";
import { useVault } from "@/lib/vault/vault-context";

const CARD = "rounded-[24px] border border-border/45 bg-card/88 p-5 shadow-[var(--app-card-shadow-standard)]";
const FIELD = "mt-1 w-full rounded-xl border bg-background px-3 py-2 text-sm";

export default function CareerPage() {
  const { user } = useAuth();
  const { isVaultUnlocked, vaultKey, vaultOwnerToken } = useVault();
  const ready = Boolean(user?.uid && isVaultUnlocked && vaultKey && vaultOwnerToken);
  const write = ready ? { userId: user!.uid, vaultKey: vaultKey!, vaultOwnerToken: vaultOwnerToken! } : null;

  const [saved, setSaved] = useState<Resume | null>(null);
  const [draft, setDraft] = useState<Resume | null>(null);
  const [applications, setApplications] = useState<CareerApplicationReceipt[]>([]);
  const [roles, setRoles] = useState<CareerRole[] | null>(null);
  const [applying, setApplying] = useState<CareerRole | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!write) return;
    let cancelled = false;
    CareerPkmService.load(write)
      .then((state) => {
        if (cancelled) return;
        setSaved(state.resume);
        setApplications(state.applications);
      })
      .finally(() => !cancelled && setLoaded(true));
    CareerService.listRoles()
      .then((next) => !cancelled && setRoles(next))
      .catch(() => !cancelled && setRoles([]));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  const onFile = useCallback(
    async (file: File | undefined) => {
      if (!file || !vaultOwnerToken) return;
      setBusy("parse");
      try {
        const { resume, truncated } = await CareerService.parseResume(file, vaultOwnerToken);
        setDraft(resume);
        if (truncated) toast.message("Your resume was long, so we read the first part. Check everything below.");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "We couldn't read that resume.");
      } finally {
        setBusy(null);
        if (fileInput.current) fileInput.current.value = "";
      }
    },
    [vaultOwnerToken],
  );

  const saveDraft = async () => {
    if (!draft || !write) return;
    setBusy("save");
    try {
      await CareerPkmService.saveResume({ ...write, resume: draft });
      setSaved(normalizeResume(draft));
      setDraft(null);
      toast.success("Saved to your knowledge model");
    } catch {
      toast.error("Couldn't save your resume. Try again.");
    } finally {
      setBusy(null);
    }
  };

  const apply = async () => {
    if (!applying || !saved || !write) return;
    setBusy("apply");
    const receiptId = crypto.randomUUID();
    const { first, last } = splitName(saved.name);
    const link = (needle: string) => saved.links.find((l) => l.url.toLowerCase().includes(needle))?.url;
    const resumeText = resumeToText(saved);
    try {
      const result = await CareerService.applyToRole({
        role: applying,
        firstName: first,
        lastName: last,
        location: saved.location,
        resumeText,
        links: { linkedin: link("linkedin.com"), github: link("github.com") },
        consentReceiptId: receiptId,
      });
      const receipt: CareerApplicationReceipt = {
        receipt_id: receiptId,
        role_slug: applying.slug,
        role_title: applying.title,
        sent_at: new Date().toISOString(),
        reference: result.reference,
        status_link: result.statusLink,
        shared: { name: saved.name, location: saved.location, resume_chars: resumeText.length },
      };
      setApplications((current) => [receipt, ...current]);
      await CareerPkmService.recordApplication({ ...write, receipt }).catch(() =>
        toast.message("Applied. We couldn't save the receipt to your knowledge model."),
      );
      toast.success(`Applied to ${applying.title}${result.reference ? ` · ${result.reference}` : ""}`);
      setApplying(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The application didn't go through.");
    } finally {
      setBusy(null);
    }
  };

  const applied = new Set(applications.map((a) => a.role_slug));

  return (
    <AppPageShell
      as="main"
      width="reading"
      className="pb-8"
      nativeTest={{
        routeId: ROUTES.ONE_CAREER,
        marker: "native-route-one-career",
        authState: user ? "authenticated" : "pending",
        dataState: !ready ? "loading" : loaded ? "loaded" : "loading",
      }}
    >
      <AppPageHeaderRegion>
        <PageHeader
          eyebrow="One"
          title="Career"
          description="Your resume, in your knowledge model. Apply to hussh roles in one tap."
          icon={Briefcase}
          accent="neutral"
        />
      </AppPageHeaderRegion>

      <AppPageContentRegion className="space-y-4 pb-24 pt-0">
        {!ready ? (
          <p className="px-1 text-sm text-muted-foreground">Unlock your vault to see your resume.</p>
        ) : (
          <>
            <input
              ref={fileInput}
              type="file"
              accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              className="sr-only"
              aria-label="Upload your resume"
              onChange={(e) => void onFile(e.target.files?.[0])}
            />

            {draft ? (
              <ResumeEditor draft={draft} onChange={setDraft} onSave={saveDraft} onCancel={() => setDraft(null)} busy={busy === "save"} />
            ) : (
              <section className={CARD} aria-labelledby="resume-heading">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 id="resume-heading" className="text-lg font-semibold">
                      {saved ? saved.name || "Your resume" : "Your resume"}
                    </h2>
                    <p className="mt-0.5 text-sm text-muted-foreground">
                      {saved
                        ? [saved.headline, `${saved.experience.length} roles`, `${saved.skills.length} skills`].filter(Boolean).join(" · ")
                        : "Upload a PDF or Word file. You'll review it before anything is saved."}
                    </p>
                  </div>
                  <Button type="button" size="sm" disabled={busy === "parse"} onClick={() => fileInput.current?.click()}>
                    {busy === "parse" ? "Reading…" : saved ? "Replace" : "Upload"}
                  </Button>
                </div>
                {saved ? (
                  <Button type="button" size="sm" variant="none" effect="fade" className="mt-3" onClick={() => setDraft(saved)}>
                    Edit
                  </Button>
                ) : null}
              </section>
            )}

            <section className={CARD} aria-labelledby="roles-heading">
              <h2 id="roles-heading" className="text-lg font-semibold">
                Open roles at hussh
              </h2>
              {roles === null ? (
                <p className="mt-2 text-sm text-muted-foreground">Loading…</p>
              ) : roles.length === 0 ? (
                <p className="mt-2 text-sm text-muted-foreground">No open roles right now.</p>
              ) : (
                <ul className="mt-3 divide-y">
                  {roles.map((role) => (
                    <li key={`${role.family}:${role.slug}`} className="flex items-center justify-between gap-3 py-3">
                      <div className="min-w-0">
                        <p className="truncate font-medium">{role.title}</p>
                        <p className="truncate text-sm text-muted-foreground">{[role.group, role.cities.slice(0, 2).join(", ")].filter(Boolean).join(" · ")}</p>
                      </div>
                      {applied.has(role.slug) ? (
                        <span className="shrink-0 text-sm text-muted-foreground">Applied</span>
                      ) : (
                        <Button
                          type="button"
                          size="sm"
                          variant="none"
                          effect="fade"
                          disabled={!saved || isEmptyResume(saved)}
                          onClick={() => setApplying(role)}
                        >
                          Apply
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {!saved ? <p className="mt-2 text-xs text-muted-foreground">Save your resume first to apply.</p> : null}
            </section>

            {applying && saved ? (
              <section className={`${CARD} border-foreground/30`} aria-labelledby="confirm-heading">
                <h2 id="confirm-heading" className="text-lg font-semibold">
                  Apply to {applying.title}?
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  hussh careers will receive exactly this, from your signed-in account. Nothing else leaves your
                  knowledge model.
                </p>
                <pre className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap rounded-xl bg-muted/40 p-3 text-xs">{resumeToText(saved)}</pre>
                <div className="mt-4 flex gap-2">
                  <Button type="button" size="sm" disabled={busy === "apply"} onClick={apply}>
                    {busy === "apply" ? "Sending…" : "Send application"}
                  </Button>
                  <Button type="button" size="sm" variant="none" effect="fade" onClick={() => setApplying(null)}>
                    Cancel
                  </Button>
                </div>
              </section>
            ) : null}

            {applications.length ? (
              <section className={CARD} aria-labelledby="applications-heading">
                <h2 id="applications-heading" className="text-lg font-semibold">
                  Your applications
                </h2>
                <ul className="mt-3 divide-y">
                  {applications.map((a) => (
                    <li key={a.receipt_id} className="flex items-center justify-between gap-3 py-3 text-sm">
                      <div className="min-w-0">
                        <p className="truncate font-medium">{a.role_title}</p>
                        <p className="text-muted-foreground">
                          {new Date(a.sent_at).toLocaleDateString()}
                          {a.reference ? ` · ${a.reference}` : ""}
                        </p>
                      </div>
                      {a.status_link?.startsWith("https://") ? (
                        <a href={a.status_link} target="_blank" rel="noopener noreferrer" className="shrink-0 underline underline-offset-2">
                          Status
                        </a>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </>
        )}
      </AppPageContentRegion>
    </AppPageShell>
  );
}

function ResumeEditor(props: {
  draft: Resume;
  onChange: (next: Resume) => void;
  onSave: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const { draft, onChange } = props;
  const set = <K extends keyof Resume>(key: K, value: Resume[K]) => onChange({ ...draft, [key]: value });
  return (
    <section className={CARD} aria-labelledby="review-heading">
      <h2 id="review-heading" className="text-lg font-semibold">
        Check your resume
      </h2>
      <p className="mt-0.5 text-sm text-muted-foreground">Fix anything we got wrong. It's saved only to your knowledge model.</p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {(["name", "headline", "location"] as const).map((key) => (
          <label key={key} className="block text-sm capitalize">
            <span className="text-muted-foreground">{key}</span>
            <input className={FIELD} value={draft[key]} onChange={(e) => set(key, e.target.value)} />
          </label>
        ))}
      </div>
      <label className="mt-3 block text-sm">
        <span className="text-muted-foreground">Summary</span>
        <textarea className={FIELD} rows={3} value={draft.summary} onChange={(e) => set("summary", e.target.value)} />
      </label>
      <label className="mt-3 block text-sm">
        <span className="text-muted-foreground">Skills (comma separated)</span>
        <input
          className={FIELD}
          value={draft.skills.join(", ")}
          onChange={(e) => set("skills", e.target.value.split(",").map((s) => s.trim()).filter(Boolean))}
        />
      </label>
      <div className="mt-4">
        <p className="text-sm text-muted-foreground">Experience</p>
        <ul className="mt-1 space-y-2">
          {draft.experience.map((role, i) => (
            <li key={i} className="flex items-start justify-between gap-2 rounded-xl border p-3 text-sm">
              <span>
                <span className="font-medium">{role.title || "Role"}</span>
                {role.organization ? `, ${role.organization}` : ""}
                <span className="block text-muted-foreground">{[role.start, role.end].filter(Boolean).join(" – ")}</span>
              </span>
              <button
                type="button"
                className="text-muted-foreground underline underline-offset-2"
                onClick={() => set("experience", draft.experience.filter((_, j) => j !== i))}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="mt-4">
        <p className="text-sm text-muted-foreground">Education</p>
        <ul className="mt-1 space-y-2">
          {draft.education.map((edu, i) => (
            <li key={i} className="flex items-start justify-between gap-2 rounded-xl border p-3 text-sm">
              <span>
                <span className="font-medium">{edu.institution || "School"}</span>
                {[edu.degree, edu.field].filter(Boolean).length ? ` · ${[edu.degree, edu.field].filter(Boolean).join(", ")}` : ""}
              </span>
              <button
                type="button"
                className="text-muted-foreground underline underline-offset-2"
                onClick={() => set("education", draft.education.filter((_, j) => j !== i))}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="mt-5 flex gap-2">
        <Button type="button" size="sm" disabled={props.busy} onClick={props.onSave}>
          {props.busy ? "Saving…" : "Save to my knowledge model"}
        </Button>
        <Button type="button" size="sm" variant="none" effect="fade" onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
    </section>
  );
}
