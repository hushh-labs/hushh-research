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

/** Anything that is not a letter, a digit, or a combining mark separates one
 *  word from the next, which keeps "Jean-Luc", "O'Brien" and "R. Meena"
 *  splitting the way a reader would split them.
 *
 *  `\p{M}` is what makes this work for Indic names. A matra is a combining
 *  mark, not a letter, so without it "झुम्मा" splits into ["झ","म","म",""] and
 *  "नीलेश" into ["न","ल","श"] — every syllable read as a separate word. Word
 *  beginnings then mean nothing, and a one-letter query can rank a mid-word
 *  hit as a beginning and drop a real match. With `\p{M}` both stay whole.
 *  `normalizeSpokenName` in the Location page already treats marks this way. */
const WORD_BOUNDARY = /[^\p{L}\p{N}\p{M}]+/u;

/**
 * iOS smart punctuation, folded back to what the keyboard shows.
 *
 * Typing an apostrophe on an iPhone inserts U+2019, not U+0027 — but a name
 * stored from a web form holds the straight one. Searching O'Brien from the
 * app therefore compared "o’brien" against "o'brien" and found nothing, on the
 * one device where the user cannot type the other character. Curly double
 * quotes and the en dash get the same treatment for the same reason.
 */
const SMART_PUNCTUATION = /[‘’‛]/g;
const SMART_QUOTES = /[“”]/g;
const DASHES = /[‐-―]/g;

function normalize(value: string): string {
  return (
    value
      .trim()
      .toLocaleLowerCase()
      .replace(SMART_PUNCTUATION, "'")
      .replace(SMART_QUOTES, '"')
      .replace(DASHES, "-")
      // Strip accents so "Ánkit" is reachable by typing "ankit", which is what
      // a phone keyboard produces by default. Composed and decomposed spellings
      // of the same name also stop being two different strings.
      //
      // Deliberately only U+0300–U+036F, the combining marks NFD produces for
      // Latin, Greek and Cyrillic letters — NOT `\p{Diacritic}`, which also
      // matches the Devanagari virama and rewrites "झुम्मा" to "झुममा".
      // Marks in an Indic script are part of the letter, not decoration on it,
      // and stripping them undoes the word-splitting this file just gained.
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
  );
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

  // `leading` is split out of `beginners` for ONE character only: a person
  // typing a single letter is almost always reaching for someone whose name
  // STARTS with it, and without this tier "r" put Abdul Rashid above Roopmann
  // — both correct word-beginning matches, but the wrong one first. Reported
  // as "search is not effective at one character".
  //
  // This changes the ORDER, never the SET. Which people a query returns is a
  // protected behaviour (config/protected-behaviors.json,
  // "location-people-search-finds-a-person-from-one-letter"); requiring two
  // characters, as the report suggested, would delete it. Two-or-more stays
  // byte-identical so the documented "A-Z inside each group" still holds.
  const leading: T[] = [];
  const beginners: T[] = [];
  const loose: T[] = [];

  for (const item of items) {
    const haystack = normalize(searchTextOf(item));
    if (beginsAWord(haystack, needle)) {
      if (needle.length === 1 && haystack.startsWith(needle)) leading.push(item);
      else beginners.push(item);
    } else if (haystack.includes(needle)) loose.push(item);
  }

  if (needle.length === 1) {
    const begins = [...leading, ...beginners];
    return begins.length ? begins : loose;
  }
  return [...beginners, ...loose];
}

/**
 * Order a list of people the way a reader looks one up: A to Z.
 *
 * Connect has done this since it shipped, which is why its list is the one
 * people say works — you can find a name in it before you have typed anything,
 * because you already know roughly where it will be. The Location pickers were
 * rendering whichever order the server happened to return, so the same two
 * connections could swap places between two openings of the same sheet, and a
 * long list had no place to start looking.
 *
 * Sort the SOURCE list, not the filtered result. `filterPeopleByQuery` keeps
 * input order inside each of its two relevance groups, so an A–Z source comes
 * out as "names that begin with what you typed, A–Z, then the rest, A–Z" —
 * relevance first, alphabetical inside it. Re-sorting after the filter would
 * throw the relevance ranking away and put a mid-word match above the name the
 * query actually begins.
 *
 * `sensitivity: "base"` matches Connect exactly: "ánkit" and "Ankit" sort
 * together rather than after Z, and case never decides the order.
 */
export function sortPeopleByName<T>(
  items: readonly T[],
  nameOf: (item: T) => string,
): T[] {
  return [...items].sort((a, b) =>
    normalize(nameOf(a)).localeCompare(normalize(nameOf(b)), undefined, {
      sensitivity: "base",
    }),
  );
}
