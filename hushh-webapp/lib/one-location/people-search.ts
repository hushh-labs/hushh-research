/**
 * How a typed query narrows a list of people.
 *
 * Every people picker on the Location surface filtered with a bare
 * `includes()`. With connections named "Ankit Kumar Singh" and "Neelesh
 * Meena", typing `n` matched BOTH — "Ankit" and "Singh" each carry an "n" — so
 * the list never narrowed and one-letter search read as broken. You had to
 * reach two characters before a substring became rare enough to tell two
 * people apart.
 *
 * People read a name from the start of its words: `n` means Neelesh, `kum`
 * means Kumar. So a query that BEGINS a word ranks above one that merely
 * appears inside it.
 *
 * A single character is only meaningful as a beginning — mid-word it matches
 * most names in any list — so a one-character query keeps just the
 * word-beginning matches, and falls back to loose matches only when nothing
 * begins with it (so it can never empty a list that has a match). From two
 * characters on nothing is dropped at all: beginnings lead, loose matches
 * follow, so `ingh` still finds Singh.
 */

/** Anything that is not a letter or a digit separates one word from the next,
 *  which keeps "Jean-Luc", "O'Brien" and "R. Meena" splitting the way a reader
 *  would split them. */
const WORD_BOUNDARY = /[^\p{L}\p{N}]+/u;

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase();
}

/** Does `query` begin the whole string, or any word inside it? */
function beginsAWord(haystack: string, query: string): boolean {
  return haystack.split(WORD_BOUNDARY).some((word) => word.startsWith(query));
}

/**
 * Filter `items` by a person-name query, most-expected match first.
 *
 * `searchTextOf` may return more than a name (a headline, a relationship, a
 * reason) — every word of whatever it returns is searchable.
 */
export function filterPeopleByQuery<T>(
  items: readonly T[],
  query: string,
  searchTextOf: (item: T) => string,
): T[] {
  const needle = normalize(query);
  if (!needle) return [...items];

  const beginners: T[] = [];
  const loose: T[] = [];

  for (const item of items) {
    const haystack = normalize(searchTextOf(item));
    if (beginsAWord(haystack, needle)) beginners.push(item);
    else if (haystack.includes(needle)) loose.push(item);
  }

  if (needle.length === 1) return beginners.length ? beginners : loose;
  return [...beginners, ...loose];
}
