import { ExternalLink } from "@/components/icons";
import { Button } from "@/lib/morphy-ux/button";

/** Keep provider navigation separate from authenticated hosted-content reads. */
export function DocumentOriginalLink({ url, googleEmail }: { url: string; googleEmail: string | null }) {
  let target: URL;
  try {
    target = new URL(url);
    if (target.protocol !== "https:" || !["drive.google.com", "docs.google.com"].includes(target.hostname) || target.username || target.password) return null;
  } catch { return null; }
  if (googleEmail) target.searchParams.set("authuser", googleEmail);
  return <Button data-consent-role="compact-action" asChild size="sm" variant="none" effect="fade" className="min-h-11">
    <a href={target.href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" aria-label="Open in Google Drive">
      Open Drive <ExternalLink aria-hidden="true" className="ml-1.5 h-4 w-4" />
    </a>
  </Button>;
}
