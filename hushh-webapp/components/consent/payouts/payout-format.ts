export const money = (cents: number | null) => cents === null ? "Calculating" : new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD",
}).format(cents / 100);
export const shortDate = (value: string) => new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
export const coins = (value: number) => `${value.toLocaleString()} Hussh Coins`;
