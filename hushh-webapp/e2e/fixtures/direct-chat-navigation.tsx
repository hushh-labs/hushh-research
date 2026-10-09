import { useSyncExternalStore, type AnchorHTMLAttributes } from "react";
const subscribe = (listener: () => void) => { window.addEventListener("popstate", listener); return () => window.removeEventListener("popstate", listener); };
const navigate = (url: string) => { history.pushState({}, "", url); window.dispatchEvent(new PopStateEvent("popstate")); };
const router = { push: navigate, replace: navigate, prefetch: () => {} };
export const useRouter = () => router;
export const usePathname = () => location.pathname;
export const useSearchParams = () => new URLSearchParams(useSyncExternalStore(subscribe, () => location.search));
export default function Link(props: AnchorHTMLAttributes<HTMLAnchorElement>) { return <a {...props} />; }
