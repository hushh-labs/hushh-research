import type { ReceiptSnapshot } from '@/lib/mail/receipt-snapshot';

type Resource = {
  snapshot: ReceiptSnapshot | null;
  hydrated: boolean;
  refreshing: boolean;
  error: string | null;
  attemptedAt: number;
  progress: null;
};

const listeners = new Set<() => void>();
let resource: Resource = {
  snapshot: null,
  hydrated: false,
  refreshing: false,
  error: null,
  attemptedAt: 0,
  progress: null,
};

/** A saved device snapshot boundary for the mounted presentation fixture. */
export class MailReceiptResourceService {
  static prime(snapshot: ReceiptSnapshot): void {
    resource = { ...resource, snapshot, hydrated: true, attemptedAt: Date.now() };
    listeners.forEach(listener => listener());
  }

  static subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  };

  static peek = () => resource;
  static isStale = () => false;
  static hydrate = async () => resource.snapshot;
  static refresh = async () => { throw new Error('Provider updates are outside the presentation fixture.'); };
  static retireObsolete = () => {};
  static clear = () => {};
}
