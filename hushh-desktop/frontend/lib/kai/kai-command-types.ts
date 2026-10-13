export type KaiCommandAction =
  | "analyze"
  | "optimize"
  | "import"
  | "consent"
  | "profile"
  | "history"
  | "dashboard"
  | "home";

export type KaiWorkspaceTab = "history" | "debate" | "summary" | "transcript";

export type KaiCommandParams = {
  symbol?: string;
  focus?: "active";
  tab?: KaiWorkspaceTab;
};
