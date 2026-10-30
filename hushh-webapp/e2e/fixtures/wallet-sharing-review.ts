import type { Page } from "@playwright/test";

type WalletFixture = {
  open: (page: Page, width: number, theme: string, scenario: { cards: number; sharingHistory: boolean }, options: { height: number; shell: boolean }) => Promise<string[]>;
  mount: (page: Page) => Promise<void>;
};

/** Open the inert sharing fixture; confirmation and effects remain in each test. */
export async function openWalletSharingReview(page: Page, width: number, fixture: WalletFixture) {
  const errors = await fixture.open(page, width, "light", { cards: 3, sharingHistory: true }, { height: 844, shell: true });
  await fixture.mount(page);
  await page.getByRole("button", { name: "Wallet access", exact: true }).click();
  const sharing = page.getByTestId("wallet-sharing-content");
  const history = sharing.getByRole("region", { name: "Card sharing history", exact: true });
  await history.getByRole("button", { name: "View Everyday •••• 4242 shared with Sample recipient", exact: true }).click();
  const detail = page.getByRole("dialog", { name: "Sample recipient", exact: true });
  const revoke = detail.getByRole("button", { name: "Revoke Everyday •••• 4242 shared with Sample recipient", exact: true });
  const revocations = () => page.evaluate(() => (window.__walletEvents ?? []).filter(event => event.startsWith("sharing-revoke:")));
  return { errors, sharing, history, detail, revoke, revocations };
}
