"use client";

import { Component, createRef, type ReactNode } from "react";

type Anchor = { id: string; top: number; root: Element | null } | null;
/** React's before-mutation snapshot preserves the reading position without
 * a scroll-frame state update or a second scroll engine. */
export class ReceiptScrollContinuity extends Component<{ children: ReactNode; scope: string }> {
  private host = createRef<HTMLDivElement>();
  getSnapshotBeforeUpdate(previous: Readonly<{ children: ReactNode; scope: string }>): Anchor {
    if (previous.scope !== this.props.scope) return null;
    const root = document.querySelector('[data-app-scroll-root="true"]') ?? document.scrollingElement;
    if (!root || root.scrollTop < 1) return null;
    const top = root === document.scrollingElement ? 0 : root.getBoundingClientRect().top;
    const row = [...(this.host.current?.querySelectorAll<HTMLElement>("[data-receipt-row-id]") ?? [])]
      .find(element => element.getBoundingClientRect().bottom > top);
    return row ? { id: row.dataset.receiptRowId!, top: row.getBoundingClientRect().top, root } : null;
  }
  componentDidUpdate(_previous: unknown, _state: unknown, anchor: Anchor) {
    if (!anchor) return;
    const row = [...(this.host.current?.querySelectorAll<HTMLElement>("[data-receipt-row-id]") ?? [])]
      .find(element => element.dataset.receiptRowId === anchor.id);
    if (row && anchor.root) anchor.root.scrollTop += row.getBoundingClientRect().top - anchor.top;
  }
  render() { return <div className="space-y-3" ref={this.host} data-no-auto-fade="true">{this.props.children}</div>; }
}
