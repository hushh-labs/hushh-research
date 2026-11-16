import type { SharedWikiLibrary } from "./library";

let activeSharedWiki: SharedWikiLibrary | null = null;

export function bindActiveSharedWiki(wiki: SharedWikiLibrary | null): () => void {
  activeSharedWiki = wiki;
  return () => {
    if (activeSharedWiki === wiki) {
      activeSharedWiki = null;
    }
  };
}

export function peekActiveSharedWiki(): SharedWikiLibrary | null {
  return activeSharedWiki;
}
