import { expect, type Page } from "@playwright/test";

type ReaderGeometry = {
  left: number;
  right: number;
  overflow: number;
  articleGap: string;
  sectionGap: string;
  minRowHeight: number;
};

export async function readerGeometry(page: Page): Promise<ReaderGeometry> {
  return page.evaluate(() => {
    const root = document.querySelector<HTMLElement>("[data-profile-pane-scroll-root='true']")!;
    const article = root.querySelector<HTMLElement>("[data-legal-document]")!;
    const r = root.getBoundingClientRect();
    const a = article.getBoundingClientRect();
    const innerLeft = r.left + root.clientLeft;
    const innerRight = innerLeft + root.clientWidth;
    const rows = [...article.querySelectorAll<HTMLElement>("[data-testid^='legal-reader-contents-'] button")];
    return {
      left: a.left - innerLeft,
      right: innerRight - a.right,
      overflow: root.scrollWidth - root.clientWidth,
      articleGap: getComputedStyle(article).rowGap,
      sectionGap: getComputedStyle(article.querySelector("[data-testid='legal-reader-body'] > section")!).rowGap,
      minRowHeight: Math.min(...rows.map((row) => row.getBoundingClientRect().height)),
    };
  });
}

export function assertReaderGeometry(geometry: ReaderGeometry, label: string) {
  expect(Math.abs(geometry.left - geometry.right), `${label}: equal side insets`).toBeLessThanOrEqual(0.5);
  expect(geometry.left % 4, `${label}: inset on the 4pt grid`).toBeLessThanOrEqual(0.5);
  expect(geometry.overflow, `${label}: no sideways scroll`).toBeLessThanOrEqual(0);
  expect(geometry.articleGap, `${label}: 32px between reader blocks`).toBe("32px");
  expect(geometry.sectionGap, `${label}: 12px inside a section`).toBe("12px");
  expect(geometry.minRowHeight, `${label}: contents rows are 44px targets`).toBeGreaterThanOrEqual(44);
}
