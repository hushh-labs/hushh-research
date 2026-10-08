"use client";

import { useEffect, useId, useMemo, useState } from "react";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

import styles from "./direct-message-emoji-picker.module.css";

type EmojiCategory = {
  id: string;
  label: string;
  icon: string;
  keywords: string[];
  emojis: string[];
};

const RECENT_EMOJI_STORAGE_KEY = "hushh.direct-messages.recent-emojis";
const MAX_RECENT_EMOJIS = 32;

// These categories mirror the familiar WhatsApp picker structure while keeping
// the selector local to direct messages and free from a second UI dependency.
const EMOJI_CATEGORIES: EmojiCategory[] = [
  {
    id: "smileys",
    label: "Smileys and people",
    icon: "🙂",
    keywords: ["smile", "face", "happy", "person", "love", "hand"],
    emojis: [
      "😀", "😃", "😄", "😁", "😆", "😅", "😂", "🤣", "😊", "😇",
      "🙂", "🙃", "😉", "😌", "😍", "🥰", "😘", "😗", "😙", "😚",
      "😋", "😛", "😝", "😜", "🤪", "🤨", "🧐", "🤓", "😎", "🥳",
      "🤩", "🥺", "🥹", "😏", "😒", "😞", "😔", "😟", "😕", "🙁",
      "☹️", "😣", "😖", "😫", "😩", "🥱", "😤", "😠", "😡", "🤬",
      "😱", "😨", "😰", "😥", "😓", "🤗", "🤔", "🫡", "🤭", "🫢",
      "🫣", "🤫", "🤥", "😶", "😶‍🌫️", "😐", "😑", "😬", "🫠", "🙄",
      "😯", "😦", "😧", "😮", "😲", "🥱", "😴", "🤤", "😪", "😵",
      "🤐", "🥴", "🤢", "🤮", "🤧", "😷", "🤒", "🤕", "🤑", "🤠",
      "😈", "👿", "👹", "👺", "🤡", "💩", "👋", "🤚", "🖐️", "✋",
      "🖖", "👌", "🤌", "🤏", "✌️", "🤞", "🫶", "🤟", "🤘", "🤙",
      "👈", "👉", "👆", "👇", "☝️", "👍", "👎", "✊", "👊", "🤝",
      "🙏", "💪", "❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "🤍",
      "🤎", "💔", "❣️", "💕", "💞", "💓", "💗", "💖", "💘", "💝",
    ],
  },
  {
    id: "animals",
    label: "Animals and nature",
    icon: "🐶",
    keywords: ["animal", "nature", "pet", "flower", "weather"],
    emojis: [
      "🐶", "🐱", "🐭", "🐹", "🐰", "🦊", "🐻", "🐼", "🐨", "🐯",
      "🦁", "🐮", "🐷", "🐽", "🐸", "🐵", "🙈", "🙉", "🙊", "🐒",
      "🐔", "🐧", "🐦", "🐤", "🦆", "🦅", "🦉", "🦇", "🐺", "🐗",
      "🐴", "🦄", "🐝", "🪲", "🐞", "🦋", "🐌", "🐛", "🕷️", "🐢",
      "🐍", "🦎", "🦖", "🦕", "🐙", "🦑", "🦐", "🦞", "🐠", "🐟",
      "🐡", "🐬", "🐳", "🐋", "🦈", "🐊", "🐅", "🐆", "🦓", "🦍",
      "🦧", "🐘", "🦣", "🦛", "🦏", "🐪", "🐫", "🦒", "🦘", "🐃",
      "🐂", "🐄", "🐎", "🐖", "🐏", "🐑", "🦙", "🐐", "🦌", "🐕",
      "🐩", "🐈", "🐓", "🦃", "🕊️", "🐇", "🦝", "🦨", "🦡", "🦫",
      "🌵", "🎄", "🌲", "🌳", "🌴", "🪴", "🌱", "🌿", "☘️", "🍀",
      "🎍", "🪷", "🌷", "🌹", "🥀", "🌺", "🌸", "💐", "🌼", "🌻",
      "🌞", "🌝", "🌛", "🌜", "🌚", "🌕", "🌖", "🌗", "🌘", "🌙",
      "⭐", "🌟", "💫", "✨", "☀️", "🌤️", "⛅", "🌦️", "🌈", "☁️",
      "🌧️", "⛈️", "🌩️", "❄️", "☃️", "🔥", "💧", "🌊", "🌍", "🌎",
    ],
  },
  {
    id: "food",
    label: "Food and drink",
    icon: "🍔",
    keywords: ["food", "drink", "coffee", "meal", "party"],
    emojis: [
      "🍏", "🍎", "🍐", "🍊", "🍋", "🍋‍🟩", "🍌", "🍉", "🍇", "🍓",
      "🫐", "🍈", "🍒", "🍑", "🥭", "🍍", "🥥", "🥝", "🍅", "🍆",
      "🥑", "🥦", "🥬", "🥒", "🌶️", "🫑", "🌽", "🥕", "🫒", "🧄",
      "🧅", "🥔", "🍠", "🥐", "🥯", "🍞", "🥖", "🥨", "🧀", "🥚",
      "🍳", "🧈", "🥞", "🧇", "🥓", "🥩", "🍗", "🍖", "🌭", "🍔",
      "🍟", "🍕", "🫓", "🥪", "🥙", "🧆", "🌮", "🌯", "🫔", "🥗",
      "🥘", "🫕", "🥫", "🍝", "🍜", "🍲", "🍛", "🍣", "🍱", "🥟",
      "🦪", "🍤", "🍙", "🍚", "🍘", "🍥", "🥠", "🥮", "🍢", "🍡",
      "🍧", "🍨", "🍦", "🥧", "🧁", "🍰", "🎂", "🍮", "🍭", "🍬",
      "🍫", "🍿", "🍩", "🍪", "🌰", "🥜", "🫘", "🍯", "🥛", "🫗",
      "☕", "🫖", "🍵", "🧃", "🥤", "🧋", "🍶", "🍺", "🍻", "🥂",
      "🍷", "🫗", "🍸", "🍹", "🧉", "🍾", "🧊", "🥄", "🍴", "🥢",
    ],
  },
  {
    id: "activities",
    label: "Activities",
    icon: "⚽",
    keywords: ["activity", "sport", "game", "music", "award"],
    emojis: [
      "⚽", "🏀", "🏈", "⚾", "🥎", "🎾", "🏐", "🏉", "🥏", "🎱",
      "🪀", "🏓", "🏸", "🏒", "🏑", "🥍", "🏏", "🪃", "🥅", "⛳",
      "🪁", "🏹", "🎣", "🤿", "🥊", "🥋", "🎽", "🛹", "🛷", "⛸️",
      "🥌", "🎿", "⛷️", "🏂", "🪂", "🏋️", "🤼", "🤸", "⛹️", "🤺",
      "🏇", "🏄", "🏊", "🤽", "🚣", "🧗", "🚵", "🚴", "🏆", "🥇",
      "🥈", "🥉", "🏅", "🎖️", "🏵️", "🎗️", "🎫", "🎟️", "🎪", "🤹",
      "🎭", "🩰", "🎨", "🎬", "🎤", "🎧", "🎼", "🎹", "🥁", "🪘",
      "🎷", "🎺", "🪗", "🎸", "🪕", "🎻", "🎲", "♟️", "🎯", "🎳",
      "🎮", "🎰", "🧩", "🪄", "🪩", "🎉", "🎊", "🎈", "🎂", "🎁",
    ],
  },
  {
    id: "travel",
    label: "Travel and places",
    icon: "🚗",
    keywords: ["travel", "place", "car", "home", "map"],
    emojis: [
      "🚗", "🚕", "🚙", "🚌", "🚎", "🏎️", "🚓", "🚑", "🚒", "🚐",
      "🛻", "🚚", "🚛", "🚜", "🏍️", "🛵", "🚲", "🛴", "🛹", "🚏",
      "🛣️", "🛤️", "🛢️", "⛽", "🚨", "🚥", "🚦", "🛑", "🚧", "⚓",
      "⛵", "🛶", "🚤", "🛳️", "⛴️", "🛥️", "🚢", "✈️", "🛩️", "🛫",
      "🛬", "🪂", "💺", "🚁", "🚟", "🚠", "🚡", "🛰️", "🚀", "🛸",
      "🏠", "🏡", "🏘️", "🏚️", "🏗️", "🏭", "🏢", "🏬", "🏣", "🏤",
      "🏥", "🏦", "🏨", "🏩", "🏪", "🏫", "🏬", "🏯", "🏰", "💒",
      "🗼", "🗽", "⛪", "🕌", "🛕", "🕍", "⛩️", "🕋", "⛲", "⛺",
      "🌁", "🌃", "🏙️", "🌄", "🌅", "🌆", "🌇", "🌉", "♨️", "🎠",
      "🎡", "🎢", "💈", "🎪", "🚂", "🚆", "🚇", "🚊", "🚉", "🗺️",
    ],
  },
  {
    id: "objects",
    label: "Objects",
    icon: "💡",
    keywords: ["object", "phone", "work", "technology", "tool"],
    emojis: [
      "⌚", "📱", "📲", "💻", "⌨️", "🖥️", "🖨️", "🖱️", "🖲️", "🕹️",
      "🗜️", "💽", "💾", "💿", "📀", "📼", "📷", "📸", "📹", "🎥",
      "📞", "☎️", "📟", "📠", "📺", "📻", "🎙️", "⏱️", "⏲️", "⏰",
      "🕰️", "⌛", "⏳", "📡", "🔋", "🪫", "🔌", "💡", "🔦", "🕯️",
      "🪔", "🧯", "🛢️", "💸", "💵", "💴", "💶", "💷", "🪙", "💳",
      "🧾", "💎", "⚖️", "🪜", "🧰", "🪛", "🔧", "🔨", "⚒️", "🛠️",
      "⛏️", "🪚", "🔩", "⚙️", "⛓️", "🧲", "🔫", "💣", "🧨", "🪓",
      "🔪", "🗡️", "⚔️", "🛡️", "🚬", "⚰️", "🪦", "⚱️", "🏺", "🔮",
      "📿", "🧿", "💈", "⚗️", "🔭", "🔬", "🕳️", "🩹", "🩺", "💊",
      "💉", "🩸", "🧬", "🦠", "🧫", "🧪", "🌡️", "🧹", "🧺", "🧻",
      "🚽", "🚰", "🚿", "🛁", "🛋️", "🛏️", "🧸", "🧷", "🧹", "🧼",
      "🪥", "🧽", "🧴", "🛎️", "🔑", "🗝️", "🚪", "🪑", "🛋️", "🛒",
    ],
  },
  {
    id: "symbols",
    label: "Symbols",
    icon: "❤️",
    keywords: ["symbol", "heart", "arrow", "check", "number"],
    emojis: [
      "🔇", "🔈", "🔉", "🔊", "📢", "📣", "📯", "🔔", "🔕", "🎵",
      "🎶", "💤", "💢", "💬", "💭", "🗯️", "♠️", "♣️", "♥️", "♦️",
      "🃏", "🀄", "🎴", "🔴", "🟠", "🟡", "🟢", "🔵", "🟣", "🟤",
      "⚫", "⚪", "🟥", "🟧", "🟨", "🟩", "🟦", "🟪", "🟫", "⬛",
      "⬜", "◼️", "◻️", "◾", "◽", "▪️", "▫️", "🔶", "🔷", "🔸",
      "🔹", "🔺", "🔻", "💠", "🔘", "🔳", "🔲", "✔️", "☑️", "✅",
      "❌", "❎", "➕", "➖", "➗", "✖️", "♾️", "‼️", "⁉️", "❓",
      "❔", "❕", "❗", "〰️", "💯", "🔞", "🔱", "⚜️", "〽️", "⚠️",
      "🚸", "🔰", "♻️", "✅", "🈯", "💹", "❇️", "✳️", "❎", "🌐",
      "Ⓜ️", "🈂️", "🛂", "🛃", "🛄", "🛅", "♿", "🚹", "🚺", "🚻",
      "🚼", "🚾", "🅿️", "🚰", "🚮", "🛑", "♈", "♉", "♊", "♋",
      "♌", "♍", "♎", "♏", "♐", "♑", "♒", "♓", "⛎", "🔀",
      "🔁", "🔂", "▶️", "⏩", "⏭️", "⏯️", "◀️", "⏪", "⏮️", "🔼",
      "⏫", "🔽", "⏬", "⏸️", "⏹️", "⏺️", "⏏️", "🎦", "🔅", "🔆",
    ],
  },
  {
    id: "flags",
    label: "Flags",
    icon: "🏳️",
    keywords: ["flag", "country", "place", "nation"],
    emojis: [
      "🏳️", "🏴", "🏁", "🚩", "🏳️‍🌈", "🏳️‍⚧️", "🇦🇺", "🇧🇷", "🇨🇦", "🇨🇳",
      "🇩🇪", "🇪🇸", "🇫🇷", "🇬🇧", "🇮🇳", "🇮🇩", "🇮🇹", "🇯🇵", "🇰🇷", "🇲🇽",
      "🇳🇱", "🇳🇿", "🇵🇭", "🇵🇱", "🇵🇹", "🇷🇺", "🇸🇦", "🇸🇬", "🇹🇭", "🇹🇷",
      "🇺🇦", "🇦🇪", "🇺🇸", "🇻🇳", "🇿🇦", "🇦🇷", "🇦🇹", "🇧🇪", "🇨🇭", "🇨🇴",
      "🇩🇰", "🇪🇬", "🇫🇮", "🇬🇷", "🇭🇰", "🇮🇪", "🇮🇱", "🇰🇪", "🇲🇾", "🇳🇴",
      "🇵🇰", "🇶🇦", "🇸🇪", "🇹🇼", "🇻🇪", "🇳🇬", "🇧🇩", "🇨🇱", "🇨🇿", "🇭🇺",
    ],
  },
];

const EMOJI_BY_VALUE = new Set(
  EMOJI_CATEGORIES.flatMap((category) => category.emojis),
);
const DEFAULT_CATEGORY = EMOJI_CATEGORIES[0]!;

// The picker is intentionally dependency-free, so keep the small searchable
// vocabulary here instead of pretending that a category label is an emoji
// index. These aliases cover the common names people use in a chat search
// (including the reported “cat” case) and can grow without changing the UI.
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
};

export function DirectMessageEmojiPicker({
  disabled = false,
  onEmojiSelect,
  label = "Choose emoji",
  triggerClassName,
  compact = false,
}: DirectMessageEmojiPickerProps) {
  const searchId = useId();
  const [open, setOpen] = useState(false);
  const [activeCategory, setActiveCategory] = useState(DEFAULT_CATEGORY.id);
  const [recent, setRecent] = useState<string[]>([]);
  const [query, setQuery] = useState("");

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
      const categoryTerms = [category.label, ...category.keywords]
        .join(" ")
        .toLocaleLowerCase();
      for (const emoji of category.emojis) {
        const terms = `${emoji} ${EMOJI_SEARCH_TERMS[emoji] || ""} ${categoryTerms}`;
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
          <span aria-hidden="true">☺</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={10}
        className={styles.content}
        aria-label="Emoji picker"
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
          role="tabpanel"
          aria-label={
            normalizedQuery
              ? `Emoji results for ${query.trim()}`
              : selectedCategory?.label || "Emoji"
          }
        >
          {emojis.map((emoji, index) => (
            <button
              key={`${emoji}-${index}`}
              type="button"
              className={styles.emojiButton}
              aria-label={`Use ${emoji}`}
              onClick={() => selectEmoji(emoji)}
            >
              {emoji}
            </button>
          ))}
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
