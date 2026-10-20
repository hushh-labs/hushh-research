import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AppPageShell } from "@/components/app-ui/app-page-shell";
import { HelperText, RowLabel } from "@/components/app-ui/typography";
import { ConsentScopeNestedList } from "@/components/consent/consent-scope-nested-list";
import { PersonProfileHero, PersonProfileTaskContent, PersonProfileEmptyState } from "@/components/connections/person-profile-hero";
import { FileText, MessageCircle, ShieldCheck, CreditCard, Share2, Settings, ChevronRight, LockKeyhole, Mail, Phone, MoreHorizontal } from "@/components/icons";
import { Button } from "@/lib/morphy-ux/button";
import { SectionCard, StatusPill } from "@/lib/morphy-ux/ui/surface-primitives";
import type { ConsentScopeItem } from "@/lib/consent/consent-scope-items";
import styles from "@/components/connections/person-profile-page.module.css";

// Production presentation primitives and catalog, with synthetic public details.
// Authority, request dialogs and service lifetimes belong to the component tests.
const items: ConsentScopeItem[] = ["Professional", "Financial", "Location", "Interests", "Personal", "Education", "Contact"].map((label) => ({
  id: `synthetic-${label}`, label: `${label} details`, domainKey: label.toLowerCase(),
  domainLabel: label, pathSegments: ["details"], searchText: `${label} details`.toLowerCase(),
}));

function Fixture() {
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  return <AppPageShell width="agent" fitContent>
    <div className={styles.page} data-profile-fixture>
      <PersonProfileHero
        profile={{ displayName: "Aarav Sharma", verifiedRole: "Verified professional" }}
        status={<StatusPill className={styles.status} tone="ready">Connected</StatusPill>}
        options={<Button size="icon-touch" variant="none" effect="fade" className={styles.overflow} aria-label="Profile options"><MoreHorizontal /></Button>}
        contacts={<><a href="mailto:aarav@example.test"><Mail aria-hidden="true" /><span dir="auto">aarav@example.test</span></a><a href="tel:+14155550100"><Phone aria-hidden="true" /><span dir="auto">+14155550100</span></a></>}
        primaryActions={<><Button size="compact" data-id="request"><FileText aria-hidden="true" />Request</Button><Button size="compact" variant="none" effect="fade" className={styles.share} aria-label="Share profile" data-id="share"><Share2 aria-hidden="true" />Share</Button></>}
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
            <div className={styles.historyActions}><StatusPill tone="neutral">Pending</StatusPill><Button size="compact" variant="none" effect="fade">Details</Button><Button size="compact" variant="none" effect="fade">Withdraw pending</Button></div>
          </div>
          <div className={styles.pagination}><Button size="compact" variant="none" effect="fade">Previous</Button><span className="text-muted-foreground">1 of 2</span><Button size="compact" variant="none" effect="fade">Next</Button></div>
        </SectionCard>
      </section>
      <div className={styles.review}><Button size="compact" data-id="review">Review request</Button></div>
    </div>
  </AppPageShell>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);
