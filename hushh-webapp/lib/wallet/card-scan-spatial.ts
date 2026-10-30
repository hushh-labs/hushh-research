import type { CardImageBox } from "./card-scan-image";
export interface CardTextObservation { text: string; bbox: CardImageBox; confidence: number }

/** Only neighboring numeric glyphs in one printed number region may be joined.
 * Transcript order is not spatial evidence; distant four-digit codes stay out. */
export function spatialCardNumbers(observations: CardTextObservation[]): string[] {
  // Keep short/uncertain neighbors as boundaries too. Dropping the final digit
  // of a 13-digit number can manufacture a different checksum-valid 12-digit PAN.
  const groups = observations.filter(item => /^[0-9]{1,6}$/.test(item.text.trim()) && item.bbox.y1 > item.bbox.y0);
  const rows: CardTextObservation[][] = [];
  for (const group of groups.sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0)) {
    const row = rows.find(items => {
      const anchor = items[0]!, h = Math.min(anchor.bbox.y1 - anchor.bbox.y0, group.bbox.y1 - group.bbox.y0);
      return Math.min(anchor.bbox.y1, group.bbox.y1) - Math.max(anchor.bbox.y0, group.bbox.y0) >= h * .6;
    });
    if (row) row.push(group); else rows.push([group]);
  }
  const candidates: string[] = [];
  for (const row of rows) {
    const ordered = row.sort((a, b) => a.bbox.x0 - b.bbox.x0);
    let text = "", confident = true;
    for (let next = 0; next < ordered.length; next++) {
      const b = ordered[next]!, a = ordered[next - 1];
      if (a) {
        const ah = a.bbox.y1 - a.bbox.y0, bh = b.bbox.y1 - b.bbox.y0;
        if (Math.max(ah, bh) > Math.min(ah, bh) * 1.5 || b.bbox.x0 - a.bbox.x1 > Math.max(ah, bh) * 1.5 || b.bbox.x0 < a.bbox.x1 - ah * .2) {
          if (confident && text.length >= 12 && text.length <= 19) candidates.push(text); text = ""; confident = true;
        }
      }
      text += b.text.trim();
      confident &&= b.confidence >= 55;
    }
    if (confident && text.length >= 12 && text.length <= 19) candidates.push(text);
  }
  // Genuine compact multi-row layouts; other layouts require manual correction.
  const singles = rows.filter(row => row.length === 1).flat().sort((a, b) => a.bbox.y0 - b.bbox.y0);
  for (let start = 0; start < singles.length; start++) {
    const block = [singles[start]!];
    for (let next = start + 1; next < singles.length; next++) {
      const a = block[block.length - 1]!, b = singles[next]!, ah = a.bbox.y1 - a.bbox.y0, bh = b.bbox.y1 - b.bbox.y0;
      if (Math.abs(a.bbox.x0 - b.bbox.x0) > Math.min(ah, bh) * .4 || b.bbox.y0 - a.bbox.y1 > Math.min(ah, bh) * .7 || Math.max(ah, bh) > Math.min(ah, bh) * 1.3) break;
      block.push(b);
    }
    const pattern = block.map(item => item.text.trim().length).join(",");
    if (block.every(item => item.confidence >= 55) && ["4,4,4", "4,4,4,4", "4,6,5", "4,6,4"].includes(pattern)) candidates.push(block.map(item => item.text.trim()).join(""));
    start += block.length - 1;
  }
  return candidates;
}
