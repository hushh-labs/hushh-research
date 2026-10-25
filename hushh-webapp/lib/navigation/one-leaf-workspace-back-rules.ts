import { ROUTES } from "./routes";
import type { BackRule } from "./back-navigation-graph";

/** Leaf workspaces return to One after their registered feature layers unwind. */
export const ONE_LEAF_WORKSPACE_BACK_RULES: BackRule[] = [
  {
    id: "one-files",
    resolve: (pathname) => {
      if (pathname !== ROUTES.ONE_FILES) return undefined;
      return {
        backHref: ROUTES.ONE_HOME,
        width: "profile",
        align: "center",
        suppressFallbackTitle: false,
        items: [{ label: "One", href: ROUTES.ONE_HOME }, { label: "Files" }],
      };
    },
  },
  {
    id: "one-documents-open",
    resolve: (pathname) => {
      if (pathname !== ROUTES.ONE_DOCUMENTS_OPEN) return undefined;
      return { backHref: ROUTES.CONSENTS, width: "content", align: "center", hideBack: false,
        items: [{ label: "Access", href: ROUTES.CONSENTS }, { label: "Protected documents" }] };
    },
  },

  {
    id: "one-messages",
    resolve: (pathname) => {
      if (pathname !== ROUTES.ONE_MESSAGES) return undefined;
      return {
        backHref: ROUTES.ONE_HOME,
        backLabel: "Back to One",
        items: [{ label: "One", href: ROUTES.ONE_HOME }],
      };
    },
  },
  {
    id: "one-referrals",
    resolve: (pathname) => {
      if (pathname !== ROUTES.ONE_REFERRALS) return undefined;
      return {
        backHref: ROUTES.ONE_HOME,
        width: "content",
        align: "center",
        items: [{ label: "One", href: ROUTES.ONE_HOME }],
        suppressFallbackTitle: true,
      };
    },
  },
];
