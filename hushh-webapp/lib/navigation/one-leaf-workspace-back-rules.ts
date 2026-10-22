import { ROUTES } from "./routes";
import type { BackRule } from "./back-navigation-graph";

/** Leaf workspaces return to One after their registered feature layers unwind. */
export const ONE_LEAF_WORKSPACE_BACK_RULES: BackRule[] = [
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
