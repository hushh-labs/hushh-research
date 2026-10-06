"use client";

import { useEffect, useMemo, useState } from "react";

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
  const [open, setOpen] = useState(false);
  const [activeCategory, setActiveCategory] = useState(DEFAULT_CATEGORY.id);
  const [recent, setRecent] = useState<string[]>([]);
  const [query, setQuery] = useState("");

  useEffect(() => {
    setRecent(readRecentEmojis());
  }, []);

  const visibleCategories = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) return EMOJI_CATEGORIES;
    return EMOJI_CATEGORIES.filter((category) =>
      [category.label, ...category.keywords]
        .join(" ")
        .toLocaleLowerCase()
        .includes(normalizedQuery),
    );
  }, [query]);

  const selectedCategory = useMemo(() => {
    if (query.trim()) return null;
    return EMOJI_CATEGORIES.find(
      (category) => category.id === activeCategory,
    ) || DEFAULT_CATEGORY;
  }, [activeCategory, query]);

  const emojis = query.trim()
    ? visibleCategories.flatMap((category) => category.emojis)
    : selectedCategory?.emojis || [];

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
        <label className="sr-only" htmlFor="direct-message-emoji-search">
          Search emoji categories
        </label>
        <input
          id="direct-message-emoji-search"
          className={styles.search}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search emoji"
          autoComplete="off"
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
        <div className={styles.categories} role="tablist" aria-label="Emoji categories">
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
            query.trim()
              ? "Matching emoji"
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
            <p className={styles.empty}>No emoji category matches that search.</p>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
