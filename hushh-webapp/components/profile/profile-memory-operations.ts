/** Lifetime/order only. No credential, value, persistence or consent authority. */
export class ProfileMemoryOperations {
  private live = false;
  private preview: symbol | null = null;
  private readonly writers = new Map<string, symbol>();
  private readonly reads = new Map<string, symbol>();
  constructor(private readonly ownerIsCurrent: () => boolean) {}
  activate() { this.live = true; }
  retire() { this.live = false; this.preview = null; this.writers.clear(); this.reads.clear(); }
  current() { return this.live && this.ownerIsCurrent(); }
  beginPreview() { const token = Symbol(); this.preview = token; return token; }
  cancelPreview() { this.preview = null; }
  acceptsPreview(token: symbol) { return this.current() && this.preview === token; }
  beginRead(resource: string) {
    const token = Symbol(); this.reads.set(resource, token);
    return { current: () => this.current() && this.reads.get(resource) === token };
  }
  writing(domain: string) { return this.writers.has(domain); }
  beginWrite(domain: string) {
    if (!this.current() || this.writers.has(domain)) return null;
    const token = Symbol(); this.writers.set(domain, token);
    return { current: () => this.current() && this.writers.get(domain) === token,
      finish: () => { if (this.writers.get(domain) === token) this.writers.delete(domain); } };
  }
}
