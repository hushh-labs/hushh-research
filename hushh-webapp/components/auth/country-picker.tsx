"use client";

import { useMemo, useRef } from "react";
import { Check, ChevronDown, Search } from "@/components/icons";
import { Dialog, DialogClose, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import type { CountryPhoneOption } from "@/lib/constants/country-phone-options";
import styles from "./country-picker.module.css";

type CountryPickerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  query: string;
  onQueryChange: (query: string) => void;
  options: readonly CountryPhoneOption[];
  selected: CountryPhoneOption;
  onSelect: (value: string) => void;
};

function flag(country: string) {
  return String.fromCodePoint(...country.toUpperCase().split("").map((letter) => 127397 + letter.charCodeAt(0)));
}

/** Presentation only: filtering, selection, and phone rules belong to the flow. */
export function CountryPicker({ open, onOpenChange, query, onQueryChange, options, selected, onSelect }: CountryPickerProps) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const sections = useRef(new Map<string, HTMLElement>());
  const groups = useMemo(() => {
    const result = new Map<string, CountryPhoneOption[]>();
    for (const option of options) {
      const letter = option.label.normalize("NFD").replace(/[\u0300-\u036f]/g, "").charAt(0).toUpperCase();
      const group = result.get(letter) ?? [];
      group.push(option);
      result.set(letter, group);
    }
    return [...result.entries()];
  }, [options]);

  return (
    <Dialog modal open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <button
          id="phone-flow-country"
          data-voice-control-id="phone-flow-country"
          type="button"
          className={styles.trigger}
          aria-label={`Country code: ${selected.label} (${selected.dialCode})`}
        >
          <span data-country-flag={selected.value} aria-hidden="true">{flag(selected.value)}</span>
          <span>{selected.dialCode}</span>
          <ChevronDown size={14} aria-hidden="true" />
        </button>
      </DialogTrigger>
      <DialogContent
        className={`${styles.surface} translate-x-0 translate-y-0`}
        showCloseButton={false}
        data-keyboard-anchor="bottom"
        srDescription="Search or browse countries, then select a country and dialing code."
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          titleRef.current?.focus();
        }}
      >
        <header className={styles.header}>
          <DialogTitle ref={titleRef} tabIndex={-1} className={styles.title}>Select country</DialogTitle>
          <DialogClose asChild><button type="button" className={styles.cancel}>Cancel</button></DialogClose>
        </header>
        <div className={styles.listRegion}>
          <div className={styles.list} aria-label="Countries">
            {groups.length === 0 && <p className={styles.empty} role="status">No country codes found.</p>}
            {groups.map(([letter, countries]) => (
              <section key={letter} aria-label={letter} ref={(node) => { if (node) sections.current.set(letter, node); else sections.current.delete(letter); }}>
                <h3 className={styles.groupTitle}>{letter}</h3>
                {countries.map((country) => (
                  <button
                    type="button"
                    key={country.value}
                    className={styles.row}
                    aria-label={`${country.label} (${country.dialCode})`}
                    aria-pressed={selected.value === country.value}
                    onClick={() => onSelect(country.value)}
                  >
                    <span className={styles.dialCode}>{country.dialCode}</span>
                    <span className={styles.flag} aria-hidden="true">{flag(country.value)}</span>
                    <span className={styles.name}>{country.label}</span>
                    {selected.value === country.value && <Check className={styles.check} size={18} aria-hidden="true" />}
                  </button>
                ))}
              </section>
            ))}
          </div>
          {!query && groups.length > 1 && (
            <nav className={styles.index} aria-label="Country alphabet">
              {groups.map(([letter]) => <button key={letter} type="button" aria-label={`Jump to ${letter}`} onClick={() => sections.current.get(letter)?.scrollIntoView({ block: "start" })}>{letter}</button>)}
            </nav>
          )}
        </div>
        <div className={styles.searchRegion}>
          <label className={styles.search}>
            <Search size={20} aria-hidden="true" />
            <input type="search" aria-label="Search countries" placeholder="Search countries" autoComplete="off" autoCorrect="off" spellCheck={false} value={query} onChange={(event) => onQueryChange(event.target.value)} />
          </label>
        </div>
      </DialogContent>
    </Dialog>
  );
}
