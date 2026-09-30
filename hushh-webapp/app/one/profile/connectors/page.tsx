// Connectors is a Profile section, not a page of its own. On the web the proxy
// sends this address into the Profile pane; inside the native bundle (no
// server) it renders the same Profile stack opened on Connectors, exactly as
// its sibling section routes do. The provider-registered OAuth return at
// ./oauth/return is a separate page and is unaffected.
export { default } from "@/app/profile/profile-workspace-page";
