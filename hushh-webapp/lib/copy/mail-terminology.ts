/**
 * Presentation vocabulary for app-owned labels, including legacy registry
 * labels and labels derived from stored keys. Never use on message bodies,
 * user-entered text, identifiers, scopes, or provider payloads.
 */
export function mailDisplayLabel(label: string): string {
  return label.replace(
    /(?<![\w@/.])(?:e-?mails?|gmail)(?![\w@]|\.[a-z])/gi,
    (word) => {
      const titleCase = word.charAt(0) === word.charAt(0).toUpperCase();
      if (/s$/i.test(word)) return titleCase ? "Mail messages" : "mail messages";
      return titleCase ? "Mail" : "mail";
    },
  );
}
