"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import catalogue from "@/lib/circle-chat/emoji-reactions.generated.json";
import { cn } from "@/lib/utils";

import styles from "./direct-message-emoji-picker.module.css";

const RECENT_EMOJI_STORAGE_KEY = "hushh.direct-messages.recent-emojis";
const MAX_RECENT_EMOJIS = 32;
const EMOJI_PAGE_SIZE = 128;
const EMOJI_CATEGORIES = catalogue.categories.map((category) => ({
  ...category,
  emojis: category.entries.map(([emoji]) => emoji!),
}));
const EMOJI_BY_VALUE = new Map(catalogue.categories.flatMap((category) =>
  category.entries.map(([emoji, name]) => [emoji!, name!] as const),
));
const DEFAULT_CATEGORY = EMOJI_CATEGORIES[0]!;

const EMOJI_SEARCH_TERMS: Record<string, string> = {
  "🐶": "dog puppy pet animal",
  "🐱": "cat kitten kitty pet animal",
  "🐭": "mouse animal pet",
  "🐹": "hamster animal pet",
  "🐰": "rabbit bunny animal pet",
  "🦊": "fox animal",
  "🐻": "bear animal",
  "🐼": "panda animal",
  "🐨": "koala animal",
  "🐯": "tiger animal",
  "🦁": "lion animal",
  "🐮": "cow animal farm",
  "🐷": "pig animal farm",
  "🐸": "frog animal",
  "🐵": "monkey animal",
  "🐔": "chicken animal bird farm",
  "🐧": "penguin bird animal",
  "🐦": "bird animal",
  "🦆": "duck bird animal",
  "🦉": "owl bird animal",
  "🐴": "horse animal",
  "🦄": "unicorn animal fantasy",
  "🐝": "bee insect animal",
  "🦋": "butterfly insect animal",
  "🐌": "snail animal",
  "🕷️": "spider insect animal",
  "🐢": "turtle animal",
  "🐍": "snake animal",
  "🦖": "dinosaur animal",
  "🐙": "octopus animal sea",
  "🐟": "fish animal sea",
  "🐬": "dolphin animal sea",
  "🐳": "whale animal sea",
  "🦈": "shark animal sea",
  "🐘": "elephant animal",
  "🦒": "giraffe animal",
  "🦘": "kangaroo animal",
  "🐐": "goat animal farm",
  "🐑": "sheep animal farm",
  "🦌": "deer animal",
  "🦓": "zebra animal",
  "🦍": "gorilla animal",
  "🐲": "dragon animal fantasy",
  "🌹": "rose flower",
  "🌻": "sunflower flower",
  "🌈": "rainbow weather",
  "☀️": "sun weather",
  "🌙": "moon night",
  "🔥": "fire hot",
  "❤️": "heart love",
  "💔": "broken heart sad",
  "👍": "thumbs up like approve",
  "👎": "thumbs down dislike",
  "🙏": "pray thanks please",
  "😂": "laugh funny tears joy",
  "😊": "smile happy",
  "😍": "love heart eyes",
  "😢": "sad cry tear",
  "😡": "angry mad",
  "🎉": "party celebrate",
  "🎂": "cake birthday",
  "☕": "coffee drink",
  "🍕": "pizza food",
  "🍔": "burger food",
  "🍎": "apple fruit food",
};

function readRecentEmojis(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const stored = JSON.parse(
      window.localStorage.getItem(RECENT_EMOJI_STORAGE_KEY) || "[]",
    );
    return Array.isArray(stored)
      ? stored.filter((value): value is string =>
          typeof value === "string" && EMOJI_BY_VALUE.has(value),
        )
      : [];
  } catch {
    return [];
  }
}

type DirectMessageEmojiPickerProps = {
  disabled?: boolean;
  onEmojiSelect: (emoji: string) => void;
  label?: string;
  triggerClassName?: string;
  compact?: boolean;
  dismissSignal?: number;
  restoreTriggerFocusOnSelect?: boolean;
  triggerIcon?: ReactNode;
  messagesLane?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

export function DirectMessageEmojiPicker({
  disabled = false,
  onEmojiSelect,
  label = "Choose emoji",
  triggerClassName,
  compact = false,
  dismissSignal,
  restoreTriggerFocusOnSelect = true,
  triggerIcon,
  messagesLane = false,
  open: controlledOpen,
  onOpenChange,
}: DirectMessageEmojiPickerProps) {
  const searchId = useId();
  const selectedEmoji = useRef(false);
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = useCallback((next: boolean) => {
    if (next) selectedEmoji.current = false;
    setInternalOpen(next);
    onOpenChange?.(next);
  }, [onOpenChange]);
  const [activeCategory, setActiveCategory] = useState(DEFAULT_CATEGORY.id);
  const [recent, setRecent] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(EMOJI_PAGE_SIZE);
  const grid = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setShown(EMOJI_PAGE_SIZE);
    grid.current?.scrollTo?.(0, 0);
  }, [activeCategory, query, open]);

  useEffect(() => {
    // Controlled reaction pickers already follow the owning message's state.
    // Only an explicit owner/route dismissal signal should reset this picker.
    if (dismissSignal !== undefined) setOpen(false);
  }, [dismissSignal, setOpen]);

  useEffect(() => {
    setRecent(readRecentEmojis());
  }, []);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const selectedCategory = useMemo(() => {
    if (query.trim()) return null;
    return EMOJI_CATEGORIES.find(
      (category) => category.id === activeCategory,
    ) || DEFAULT_CATEGORY;
  }, [activeCategory, query]);

  const emojis = useMemo(() => {
    if (!normalizedQuery) return selectedCategory?.emojis || [];
    const matches = new Set<string>();
    for (const category of EMOJI_CATEGORIES) {
      const categoryTerms = [category.label]
        .join(" ")
        .toLocaleLowerCase();
      for (const emoji of category.emojis) {
        const terms = `${emoji} ${EMOJI_BY_VALUE.get(emoji)} ${EMOJI_SEARCH_TERMS[emoji] || ""} ${categoryTerms}`.toLocaleLowerCase();
        if (terms.includes(normalizedQuery)) matches.add(emoji);
      }
    }
    return [...matches];
  }, [normalizedQuery, selectedCategory]);

  const selectEmoji = (emoji: string) => {
    const updated = [emoji, ...recent.filter((value) => value !== emoji)].slice(
      0,
      MAX_RECENT_EMOJIS,
    );
    setRecent(updated);
    try {
      window.localStorage.setItem(RECENT_EMOJI_STORAGE_KEY, JSON.stringify(updated));
    } catch {
      // The message composer remains fully usable when browser storage is unavailable.
    }
    selectedEmoji.current = true;
    onEmojiSelect(emoji);
    setOpen(false);
    setQuery("");
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(styles.trigger, triggerClassName)}
          aria-label={label}
          aria-expanded={open}
          data-compact={compact || undefined}
          disabled={disabled}
        >
          <span aria-hidden="true">{triggerIcon ?? "☺"}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        data-messages-type-scale={messagesLane || undefined}
        side="top"
        align="end"
        sideOffset={10}
        collisionPadding={8}
        className={styles.content}
        aria-label="Emoji picker"
        onCloseAutoFocus={(event) => {
          // The composer owns focus after insertion. Returning it to the
          // trigger races that handoff and moves the iOS keyboard again.
          if (selectedEmoji.current && !restoreTriggerFocusOnSelect) {
            event.preventDefault();
          }
          selectedEmoji.current = false;
        }}
      >
        <label className="sr-only" htmlFor={searchId}>
          Search emoji categories
        </label>
        <input
          id={searchId}
          className={styles.search}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search emoji"
          autoComplete="off"
          inputMode="search"
        />
        {!query.trim() && recent.length ? (
          <section className={styles.recent} aria-label="Recently used emoji">
            <span className={styles.sectionLabel}>Recently used</span>
            <div className={styles.recentList}>
              {recent.slice(0, 10).map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  className={styles.emojiButton}
                  aria-label={`Use ${emoji}`}
                  onClick={() => selectEmoji(emoji)}
                >
                  {emoji}
                </button>
              ))}
            </div>
          </section>
        ) : null}
        <div
          className={styles.categories}
          role="tablist"
          aria-label="Emoji categories"
          hidden={Boolean(normalizedQuery)}
        >
          {EMOJI_CATEGORIES.map((category) => (
            <button
              key={category.id}
              type="button"
              role="tab"
              aria-label={category.label}
              aria-selected={selectedCategory?.id === category.id}
              className={styles.categoryButton}
              onClick={() => {
                setQuery("");
                setActiveCategory(category.id);
              }}
              title={category.label}
            >
              {category.icon}
            </button>
          ))}
        </div>
        <div
          className={styles.grid}
          ref={grid}
          onScroll={(event) => {
            const element = event.currentTarget;
            // Grow only at the end of a batch; never set state per scroll frame.
            if (element.scrollHeight - element.scrollTop - element.clientHeight < 100 && shown < emojis.length) {
              setShown((count) => Math.min(count + EMOJI_PAGE_SIZE, emojis.length));
            }
          }}
          role="tabpanel"
          aria-label={
            normalizedQuery
              ? `Emoji results for ${query.trim()}`
              : selectedCategory?.label || "Emoji"
          }
        >
          {emojis.slice(0, shown).map((emoji, index) => (
            <button
              key={`${emoji}-${index}`}
              type="button"
              className={styles.emojiButton}
              aria-label={`Use ${emoji}`}
              title={EMOJI_BY_VALUE.get(emoji)}
              onClick={() => selectEmoji(emoji)}
            >
              {emoji}
            </button>
          ))}
          {shown < emojis.length ? <button type="button" className={styles.more}
            onClick={() => setShown((count) => count + EMOJI_PAGE_SIZE)}>More emoji</button> : null}
          {!emojis.length ? (
            <p className={styles.empty}>
              No emojis match “{query.trim()}”.
            </p>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
