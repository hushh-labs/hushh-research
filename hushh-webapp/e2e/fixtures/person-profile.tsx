import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AppPageShell } from "@/components/app-ui/app-page-shell";
import { HelperText, RowLabel } from "@/components/app-ui/typography";
import { ConsentScopeNestedList } from "@/components/consent/consent-scope-nested-list";
import { InformationRequestReviewFields } from "@/components/consent/information-request-review-fields";
import { PersonProfileHero, PersonProfileTaskContent, PersonProfileEmptyState } from "@/components/connections/person-profile-hero";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FileText, MessageCircle, ShieldCheck, CreditCard, Share2, Settings, ChevronRight, LockKeyhole, Mail, Phone, MoreHorizontal } from "@/components/icons";
import { Button } from "@/lib/morphy-ux/button";
import { SectionCard, StatusPill } from "@/lib/morphy-ux/ui/surface-primitives";
import type { ConsentScopeItem } from "@/lib/consent/consent-scope-items";
import type { RequestablePersonScope } from "@/lib/services/person-profile-service";
import styles from "@/components/connections/person-profile-page.module.css";

// Production presentation primitives and catalog, with synthetic public details.
// Authority, request dialogs and service lifetimes belong to the component tests.
const items: ConsentScopeItem[] = ["Professional", "Financial", "Location", "Interests", "Personal", "Education", "Contact"].map((label) => ({
  id: `synthetic-${label}`, label: `${label} details`, domainKey: label.toLowerCase(),
  domainLabel: label, pathSegments: ["details"], searchText: `${label} details`.toLowerCase(),
}));
const reviewScope: RequestablePersonScope = {
  scopeRef: "synthetic-wallet-summary",
  label: "Wallet summary with a long unbroken reference 123456789012345678901234567890",
  description: null,
  domain: "wallet",
  sensitivity: "VerySensitiveClassificationLabel",
  wildcard: true,
};

function Fixture() {
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [reviewOpen, setReviewOpen] = useState(false);
  const [purpose, setPurpose] = useState("");
  const [durationHours, setDurationHours] = useState(168);
  return <AppPageShell width="agent" fitContent>
    <div className={styles.page} data-profile-fixture>
      <PersonProfileHero
        profile={{ displayName: "Aarav Sharma", verifiedRole: "Verified professional" }}
        status={<StatusPill className={styles.status} tone="ready">Connected</StatusPill>}
        options={<Button size="icon-touch" variant="none" effect="fade" className={styles.overflow} aria-label="Profile options"><MoreHorizontal /></Button>}
        contacts={<><a href="mailto:aarav@example.test"><Mail aria-hidden="true" /><span dir="auto">aarav@example.test</span></a><a href="tel:+14155550100"><Phone aria-hidden="true" /><span dir="auto">+14155550100</span></a></>}
        primaryActions={<><Button size="compact" data-id="request"><FileText aria-hidden="true" />Browse</Button><Button size="compact" variant="none" effect="fade" className={styles.share} aria-label="Share profile" data-id="share"><Share2 aria-hidden="true" />Share</Button></>}
        tasks={<>{[
          { id: "request-files", label: "Request files", Icon: FileText, tone: "blue" as const },
          { id: "ask-about-files", label: "Ask about files", Icon: MessageCircle, tone: "pink" as const },
          { id: "request-scope", label: "Request scope", Icon: ShieldCheck, tone: "lilac" as const },
          { id: "request-cards", label: "Request cards", Icon: CreditCard, tone: "amber" as const },
        ].map(({ id, ...content }) => <Button key={id} variant="none" effect="fade" data-id={id}><PersonProfileTaskContent {...content} /></Button>)}</>}
        footer={<Button size="compact" variant="none" effect="fade" className={styles.manage} data-id="manage"><Settings aria-hidden="true" /><span>Manage access</span><ChevronRight aria-hidden="true" /></Button>}
      />
      <section className={styles.section}><h2 className={styles.heading}>Shared with you</h2><PersonProfileEmptyState icon={<LockKeyhole />} label="Nothing shared yet" /></section>
      <section className={`${styles.section} ${styles.available}`}><h2 className={styles.heading}>Available to request</h2>
        <ConsentScopeNestedList items={items} searchPlaceholder="Search categories" showDomainFilter categorySelectionInDetail rootLabel="All" selection={{ selectedIds, onToggleMany: (ids, select) => setSelectedIds((current) => {
          const next = new Set(current); ids.forEach((id) => select ? next.add(id) : next.delete(id)); return next;
        }) }} />
      </section>
      <section className={`${styles.section} ${styles.history}`}><h2 className={styles.heading}>Request history</h2>
        <PersonProfileEmptyState icon={<FileText />} label="No requests yet" />
        <SectionCard className={styles.historyGroup}>
          <div className={styles.historyRow}><div className="min-w-0 flex-1"><RowLabel as="p" className={`ui-text-row-label-emphasized ${styles.historyTitle}`}>Professional details</RowLabel><HelperText className={styles.historySupporting}>For an introduction</HelperText></div>
            <div className={styles.historyActions}><StatusPill tone="neutral">Pending</StatusPill><Button size="compact" variant="none" effect="fade">Details</Button><Button size="compact" variant="none" effect="fade">Withdraw request</Button></div>
          </div>
          <div className={styles.pagination}><Button size="compact" variant="none" effect="fade">Previous</Button><span className="text-muted-foreground">1 of 2</span><Button size="compact" variant="none" effect="fade">Next</Button></div>
        </SectionCard>
      </section>
      <div className={styles.review}><Button size="compact" data-id="review" onClick={() => setReviewOpen(true)}>Review request</Button></div>
    </div>
    <Dialog modal open={reviewOpen} onOpenChange={setReviewOpen}>
      <DialogContent className="consent-presentation-surface w-[calc(100%-2rem)] max-w-[30rem] max-h-[min(32rem,calc(100dvh-2rem-var(--app-safe-area-top-effective,0px)-env(safe-area-inset-bottom,0px)))] gap-3 overflow-hidden p-4 sm:max-w-[30rem]">
        <DialogHeader className="shrink-0 pr-8 text-left">
          <DialogTitle className="[overflow-wrap:anywhere]">Request information from Aarav Sharma</DialogTitle>
          <DialogDescription>They&rsquo;ll see what you request, why, and for how long.</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain pr-1">
          <InformationRequestReviewFields scopes={[reviewScope]} purpose={purpose} durationHours={durationHours}
            onPurposeChange={setPurpose} onDurationChange={setDurationHours} />
        </div>
        <DialogFooter className="shrink-0 flex-row items-center justify-end border-t border-border/60 pt-3">
          <Button type="button" variant="none" effect="fade" onClick={() => setReviewOpen(false)}>Cancel</Button>
          <Button type="button" variant="blue-gradient" effect="fill" disabled={purpose.trim().length < 8}>Send request</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </AppPageShell>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);
