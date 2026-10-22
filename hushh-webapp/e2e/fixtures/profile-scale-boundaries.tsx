// Minimal routing stand-ins for the profile-scale surfaces fixture. Everything
// the fixture renders (Feed rows, the Agents roster, the Circles card, the
// dialog) is production source; only next/link and next/navigation are replaced.
import type { AnchorHTMLAttributes, ReactNode } from "react";

const record = (href: string) => { document.body.dataset.lastNavigation = href; };

export default function Link({
  href,
  children,
  prefetch: _prefetch,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; prefetch?: boolean; children?: ReactNode }) {
  return (
    <a href={href} onClick={(event) => { event.preventDefault(); record(String(href)); }} {...rest}>
      {children}
    </a>
  );
}

const router = { push: record, replace: record, prefetch: () => {}, back: () => {}, refresh: () => {} };
export const useRouter = () => router;
export const usePathname = () => "/one";
export const useSearchParams = () => new URLSearchParams();

// Firebase initialises at import time against a project this fixture has no key
// for. Nothing here signs in.
export const app = null;
export const auth = { currentUser: null };
export const getRecaptchaVerifier = () => null;
export const prepareRecaptchaVerifier = async () => null;
export const resetRecaptcha = () => {};
