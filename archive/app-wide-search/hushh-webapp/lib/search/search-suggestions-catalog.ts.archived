/**
 * Search's own catalog of what it offers, authored by hand instead of derived
 * from the Kai action gateway's live reachability/usage heuristics.
 *
 * Search used to ask the gateway "what exists and what has this person done"
 * on every keystroke. That tied Search's behavior to gateway internals owned
 * by someone else, and it meant a brand-new destination only ever reached the
 * idle "Suggested" row once someone had already used it -- never on day one.
 * This file is the fix: a flat, static list Search owns outright. Each entry
 * only needs an `actionId` that the action runtime (still reached the same
 * way as always, via `onSelectAction`) already understands -- that id is the
 * one unavoidable shared vocabulary between Search and execution, not a code
 * dependency.
 *
 * Labels and keywords below are a point-in-time copy of what the gateway
 * reported on 2026-10-13, not a live read of it. `scripts/search/verify-search-catalog.mjs`
 * checks this list against the generated gateway so a renamed or retired
 * action_id is caught, and flags gateway destinations this list hasn't
 * triaged yet -- but nothing here re-imports gateway code.
 */

export type SearchCatalogIconHint =
  | "profile"
  | "consent"
  | "history"
  | "market"
  | "location"
  | "memory"
  | "wallet"
  | "feed"
  | "agents"
  | "generic";

export type SearchCatalogEntry = {
  actionId: string;
  label: string;
  keywords: readonly string[];
  icon: SearchCatalogIconHint;
};

/**
 * Shown before anyone types anything. Short and deliberately broad: the
 * handful of destinations useful to most people, most of the time, not a
 * dump of everything the app can do.
 */
export const IDLE_SUGGESTION_IDS: readonly string[] = [
  "route.one_location",
  "route.one_pkm",
  "route.one_wallet",
  "route.kai_dashboard",
  "route.kai_home",
  "route.one_feed",
  "route.one_agents",
  "route.profile",
  "route.consents",
];

/**
 * Everything Search can answer while typing. Limited to destinations a tap
 * can run from anywhere -- plain navigation, plus the few `kai_command`
 * entries (Profile, Consents, Analysis History, Portfolio Import) that are
 * destinations in the same sense. Mid-flow verbs that need a mounted screen
 * or a specific slot (approve this request, confirm this code) are left out
 * on purpose: offering them from search only ever produced a row that did
 * nothing when tapped.
 */
export const SEARCH_CATALOG: readonly SearchCatalogEntry[] = [
  { actionId: "route.getting_started", label: "Open Welcome", icon: "generic", keywords: ["open welcome", "show the welcome screen", "go to getting started", "start over", "show me what one can do"] },
  { actionId: "onboarding.continue", label: "Continue", icon: "generic", keywords: ["continue", "let's go", "get started", "next step", "move on"] },
  { actionId: "auth.sign_in_open", label: "Open Sign In", icon: "generic", keywords: ["sign in", "log in", "open sign in", "go to login", "sign me in"] },
  { actionId: "vault.setup_open", label: "Open Vault Setup", icon: "generic", keywords: ["set up my vault", "unlock my vault", "open vault setup", "finish setting up", "open one setup"] },
  { actionId: "route.one_connect", label: "Open Connect", icon: "generic", keywords: ["open connect", "connect", "find people", "add people", "add a connection", "connect with someone"] },
  { actionId: "route.kai_analysis", label: "Open Analysis Surface", icon: "market", keywords: ["open analysis", "go to analysis"] },
  { actionId: "location.open_now", label: "Open Location overview", icon: "location", keywords: ["location overview", "overview tab", "location now", "now tab", "location home", "location status", "am i sharing my location"] },
  { actionId: "location.open_people", label: "Open Location people", icon: "location", keywords: ["location people", "people tab", "who can see my location", "my circles", "location contacts"] },
  { actionId: "location.open_links", label: "Open Location links", icon: "location", keywords: ["location links", "links tab", "my location links", "temporary links"] },
  { actionId: "location.open_share", label: "Share my location", icon: "location", keywords: ["share my location", "share location", "send my location", "let someone see where i am", "share where i am"] },
  { actionId: "location.open_ask", label: "Ask for someone's location", icon: "location", keywords: ["ask for location", "request location", "where are you", "ask someone where they are", "request someone's location"] },
  { actionId: "location.open_invite", label: "Invite someone to Location", icon: "location", keywords: ["invite someone", "invite to location", "add someone to location", "invite a friend"] },
  { actionId: "location.open_create_circle", label: "Create a circle", icon: "location", keywords: ["open the create circle screen", "show me circle setup", "take me to create circle", "open create circle"] },
  { actionId: "location.open_join_circle", label: "Join a circle", icon: "location", keywords: ["join a circle", "join circle", "enter circle code", "use an invite code"] },
  { actionId: "location.open_temporary_link", label: "Create a temporary link", icon: "location", keywords: ["temporary link", "create a link", "share a link", "one time link", "link to my location"] },
  { actionId: "location.open_check_in", label: "Check in", icon: "location", keywords: ["check in", "check-in", "let them know i arrived", "i arrived", "send a check in"] },
  { actionId: "location.open_sos", label: "Open emergency SOS", icon: "location", keywords: ["open sos", "open the sos screen", "show me sos", "sos screen", "open emergency screen"] },
  { actionId: "location.open_sms_contacts", label: "Open emergency contacts", icon: "location", keywords: ["emergency contacts", "sms contacts", "who gets my sos", "alert contacts", "text contacts"] },
  { actionId: "location.open_settings", label: "Open Location privacy settings", icon: "location", keywords: ["location settings", "location privacy", "privacy settings", "location precision", "location options"] },
  { actionId: "location.open_active_shares", label: "Open active location shares", icon: "location", keywords: ["active shares", "who can see me right now", "live shares", "what am i sharing"] },
  { actionId: "location.open_shared_with_me", label: "Open locations shared with me", icon: "location", keywords: ["shared with me", "who is sharing with me", "see location", "where are my people"] },
  { actionId: "location.open_needs_review", label: "Open location requests to review", icon: "location", keywords: ["needs review", "pending requests", "location requests", "approve requests", "who asked for my location"] },
  { actionId: "location.add_connections", label: "Add people to share location with", icon: "location", keywords: ["add connections", "i have no connections", "no one to share with"] },
  { actionId: "location.open_map", label: "Open the location map", icon: "location", keywords: ["location map", "open the map", "show the map", "map view"] },
  { actionId: "location.open_circles", label: "Open Location circles", icon: "location", keywords: ["show my circles", "circles tab", "open circles"] },
  { actionId: "location.open_ratings", label: "Open place ratings", icon: "location", keywords: ["my ratings", "show my ratings"] },
  { actionId: "location.setup.start", label: "Start Location setup", icon: "location", keywords: ["start location setup", "set up location"] },
  { actionId: "route.one_agents", label: "Open Agents", icon: "agents", keywords: ["open agents", "open one agents", "go to agents", "show agents", "open the one dashboard", "open one"] },
  { actionId: "route.voice_settings", label: "Open Voice Settings", icon: "generic", keywords: ["voice settings", "open voice settings", "voice preferences", "open voice preferences"] },
  { actionId: "route.one_location", label: "Open Location", icon: "location", keywords: ["open location", "go to location", "show location"] },
  { actionId: "route.one_pkm_location_home", label: "Open Memory", icon: "memory", keywords: ["open memory", "memory home", "return to memory"] },
  { actionId: "route.one_pkm", label: "Open Memory", icon: "memory", keywords: ["open personal data", "open my personal data", "go to personal data", "show personal data", "open saved knowledge"] },
  { actionId: "route.one_feed", label: "Open Feed", icon: "feed", keywords: ["open my feed", "open feed", "go to my feed", "show my feed", "what's waiting for me"] },
  { actionId: "route.profile_my_data", label: "Open Memory", icon: "memory", keywords: ["open my saved details", "my saved details"] },
  { actionId: "route.profile_world_model", label: "Open Personal World Model", icon: "profile", keywords: ["personal world model", "pwm", "my public profile", "build my model"] },
  { actionId: "route.profile_request_pricing", label: "Open Request pricing", icon: "generic", keywords: ["set my Drive price", "document price", "request pricing"] },
  { actionId: "route.profile_payouts", label: "Open Payouts", icon: "wallet", keywords: ["link my bank", "set up payouts", "document earnings"] },
  { actionId: "route.profile_access_panel", label: "Open Access And Discoverability Panel", icon: "profile", keywords: ["open access settings", "who can find me", "discoverability settings", "open access panel"] },
  { actionId: "route.profile_privacy", label: "Open privacy settings", icon: "profile", keywords: ["privacy settings", "show my privacy settings"] },
  { actionId: "route.one_wallet", label: "Open Wallet", icon: "wallet", keywords: ["open my wallet", "go to wallet", "show my wallet", "open my cards", "show my cards page"] },
  { actionId: "route.ria_claim", label: "Claim RIA Profile", icon: "profile", keywords: ["claim my profile", "claim ria profile", "claim advisor profile", "claim my firm"] },
  { actionId: "route.ria_clients", label: "Open RIA Clients", icon: "generic", keywords: ["open ria clients", "show my advisor clients", "open client roster"] },
  { actionId: "route.ria_onboarding", label: "Open RIA Onboarding", icon: "generic", keywords: ["open ria onboarding", "finish advisor setup", "open advisor verification"] },
  { actionId: "route.ria_picks", label: "Open RIA Picks", icon: "generic", keywords: ["open ria picks", "open advisor picks", "show stock universe"] },
  { actionId: "ria.picks.open_source_kai", label: "Show Suggested Picks Source", icon: "generic", keywords: ["show kai list", "switch to kai picks", "open kai source"] },
  { actionId: "ria.picks.open_source_my", label: "Show My Advisor Picks", icon: "generic", keywords: ["show my picks", "switch to my list", "open advisor package"] },
  { actionId: "ria.picks.open_category_top_picks", label: "Show Top Picks", icon: "generic", keywords: ["show top picks", "open top picks tab", "show the top-picks category"] },
  { actionId: "ria.picks.open_category_avoid", label: "Show Avoid List", icon: "generic", keywords: ["show avoid list", "open avoid tab", "show exclusions"] },
  { actionId: "ria.picks.open_category_screening", label: "Show Screening Rules", icon: "generic", keywords: ["show screening", "open screening tab", "show screening rules"] },
  { actionId: "ria.picks.download_template", label: "Download Picks CSV Template", icon: "generic", keywords: ["download picks template", "get csv template", "download advisor picks template"] },
  { actionId: "route.ria_profile", label: "Open RIA Profile", icon: "profile", keywords: ["open ria profile", "open regulatory profile", "view advisor profile", "edit my advisor profile"] },
  { actionId: "route.kai_dashboard", label: "Open Portfolio Dashboard", icon: "market", keywords: ["open portfolio dashboard", "open portfolio", "show my portfolio"] },
  { actionId: "route.kai_home", label: "Open Market Home", icon: "market", keywords: ["open kai home", "open market home", "go to market home"] },
  { actionId: "setup.open_connections", label: "Choose your AI", icon: "generic", keywords: ["choose my ai", "set up AI access", "ai access", "choose gemini", "configure one", "use my gemini key"] },
  { actionId: "setup.open_gmail", label: "Connect Gmail", icon: "generic", keywords: ["connect gmail", "set up gmail", "open gmail setup"] },
  { actionId: "setup.open_calendar", label: "Connect your calendar", icon: "generic", keywords: ["connect calendar", "set up calendar", "open calendar setup"] },
  { actionId: "setup.open_location", label: "Set up location", icon: "location", keywords: ["set up location", "open location setup", "set up live sharing"] },
  { actionId: "setup.open_email", label: "Identity checks", icon: "generic", keywords: ["identity checks", "kyc", "set up kyc", "open kyc setup", "let one draft for me", "set up email", "open email setup"] },
  { actionId: "setup.open_finance", label: "Set up your money", icon: "market", keywords: ["set up finance", "set up my money", "open finance setup", "set up investing"] },
  { actionId: "setup.open_ria", label: "Set up your advisor profile", icon: "generic", keywords: ["set up ria", "set up my advisor profile", "open ria setup"] },
  { actionId: "setup.open_connected_systems", label: "Connect your CRM", icon: "generic", keywords: ["link my record to external systems", "link my record", "link my tools", "set up connected systems", "show crm systems", "connect crm", "connect my crm"] },
  { actionId: "ria.client_account.open_workspace_fallback", label: "Return To Client Information Explorer", icon: "generic", keywords: ["return to client workspace", "open workspace from account detail", "go back to client data"] },
  { actionId: "ria.client_request.open_access_fallback", label: "Return To Client Access", icon: "generic", keywords: ["return to client access", "open access from request detail", "go back to sharing"] },
  { actionId: "ria.client_workspace.open_overview_tab", label: "Show Client Overview", icon: "generic", keywords: ["show client overview", "open overview tab", "show at a glance"] },
  { actionId: "ria.client_workspace.open_access_tab", label: "Show Client Sharing", icon: "generic", keywords: ["show client sharing", "open access tab", "show sharing tab"] },
  { actionId: "ria.client_workspace.open_portfolio_tab", label: "Show Client Portfolio", icon: "generic", keywords: ["show client portfolio", "open portfolio tab", "show kai portfolio"] },
  { actionId: "ria.client_workspace.open_explorer_tab", label: "Show Client Information Explorer", icon: "generic", keywords: ["show client data", "open explorer tab", "show data explorer"] },
  { actionId: "ria.client_workspace.open_access_manager", label: "Open Access Manager", icon: "generic", keywords: ["open access manager", "open access", "review pending client access"] },
  { actionId: "route.profile", label: "Open Profile", icon: "profile", keywords: ["open profile", "go to profile"] },
  { actionId: "route.consents", label: "Open Consent Center", icon: "consent", keywords: ["open consent center", "open consents"] },
  { actionId: "route.analysis_history", label: "Open Analysis History", icon: "history", keywords: ["open analysis history", "show past analysis"] },
  { actionId: "route.kai_import", label: "Open Portfolio Import", icon: "market", keywords: ["open portfolio import", "import my portfolio"] },
  { actionId: "route.kai_portfolio_holdings", label: "Show Holdings", icon: "market", keywords: ["show my holdings", "show holdings", "open holdings"] },
  { actionId: "route.kai_portfolio_allocation", label: "Show Allocation", icon: "market", keywords: ["show my allocation", "show allocation", "open allocation"] },
  { actionId: "route.kai_portfolio_performance", label: "Show Performance", icon: "market", keywords: ["show my performance", "show performance", "open performance"] },
  { actionId: "route.kai_portfolio_sources", label: "Show Connected Sources", icon: "market", keywords: ["show my sources", "show connected sources", "open sources"] },
  { actionId: "route.kai_news", label: "Open Market News", icon: "market", keywords: ["open market news", "show market news", "show news"] },
  { actionId: "help.open_examples", label: "Open Location command settings", icon: "generic", keywords: ["what can i say", "what can you do", "show me examples", "show me around", "help"] },
  { actionId: "route.profile_referrals_panel", label: "Open Referrals", icon: "profile", keywords: ["open referrals", "invite friends", "my referral link", "show my referrals"] },
  { actionId: "route.profile_support_panel", label: "Open Support Panel", icon: "profile", keywords: ["open support", "contact support"] },
  { actionId: "route.profile_security_panel", label: "Open Vault Security Panel", icon: "profile", keywords: ["open security", "vault security"] },
];

/**
 * Reviewed and deliberately left out of the catalog, not simply unreviewed.
 * `verify-search-catalog.mjs` treats these the same as a catalog entry for
 * "has a person looked at this id" purposes, so a legacy or context-bound
 * action does not keep reappearing in the untriaged-action flag forever.
 */
export const EXCLUDED_ACTION_IDS: readonly string[] = [
  "route.connected_system_list", // Back-target only (an app-route-layout Back case), not a forward destination.
  "route.mail_connections", // Back-target only.
  "route.messages_connections", // Back-target only.
  "route.puppy_agents", // Back-target only.
  "route.wallet_profile_cards", // Back-target only.
  "route.profile_receipts", // Sub-page of a specific Gmail connection, not a standalone destination.
  "route.one_gmail_kyc", // Sub-flow of a specific Gmail connection.
  "route.profile_connected_systems", // Redundant with setup.open_connected_systems, already in the catalog.
  "route.profile_pkm_agent_lab", // Redundant with route.one_pkm -- both are "Open Memory".
  "route.person_profile", // Needs a specific person id; not reachable without one.
  "route.ria_client_workspace", // Needs a specific client id; not reachable without one.
  "route.ria_home", // Redundant landing page -- route.ria_picks and route.ria_clients are the real destinations.
  "route.ria_requests_compat", // Legacy compatibility route being phased out.
  "route.ria_settings_compat", // Legacy compatibility route being phased out.
  "route.ria_workspace_compat", // Legacy compatibility route being phased out.
];

const BY_ID = new Map(SEARCH_CATALOG.map((entry) => [entry.actionId, entry]));

export function getCatalogEntry(actionId: string): SearchCatalogEntry | undefined {
  return BY_ID.get(actionId);
}

/** The idle row, in authored order, skipping any id this list hasn't caught up with yet. */
export function getIdleSuggestions(): SearchCatalogEntry[] {
  return IDLE_SUGGESTION_IDS.flatMap((actionId) => {
    const entry = BY_ID.get(actionId);
    return entry ? [entry] : [];
  });
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/** How well `entry` answers `query`. Zero means "not a match". */
function scoreEntry(entry: SearchCatalogEntry, query: string): number {
  const label = normalize(entry.label);
  if (label === query) return 100;
  const exactKeyword = entry.keywords.some((keyword) => normalize(keyword) === query);
  if (exactKeyword) return 95;
  if (label.startsWith(query)) return 80;
  const prefixKeyword = entry.keywords.some((keyword) => normalize(keyword).startsWith(query));
  if (prefixKeyword) return 70;
  if (label.includes(query)) return 50;
  const containsKeyword = entry.keywords.some((keyword) => normalize(keyword).includes(query));
  if (containsKeyword) return 40;
  return 0;
}

/** Typed results: substring/alias match over the static catalog, ranked, no network round trip. */
export function searchCatalog(query: string, limit = 24): SearchCatalogEntry[] {
  const normalized = normalize(query);
  if (!normalized) return [];
  return SEARCH_CATALOG
    .map((entry) => ({ entry, score: scoreEntry(entry, normalized) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.entry.label.localeCompare(b.entry.label)))
    .slice(0, limit)
    .map(({ entry }) => entry);
}

/** An exact action name/alias typed in full, for Enter-to-run semantics. */
export function findExactCatalogMatch(query: string): SearchCatalogEntry | undefined {
  const normalized = normalize(query);
  if (!normalized) return undefined;
  return SEARCH_CATALOG.find(
    (entry) =>
      normalize(entry.label) === normalized ||
      entry.keywords.some((keyword) => normalize(keyword) === normalized),
  );
}
