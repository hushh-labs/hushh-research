/** Browser-side measurement shared by title-only Settings row consumers. */
export function titleOnlyControlsAreCentered(node: Element): boolean {
  const title = node.querySelector('[data-slot="settings-row-title"]');
  if (!title) return false;
  const bounds = title.getBoundingClientRect();
  const titleCenter = bounds.top + bounds.height / 2;
  const controls = [...node.querySelectorAll('[data-slot="settings-row-icon"],[data-slot="settings-row-chevron"]')];
  return controls.length > 0 && controls.every((control) => {
    const box = control.getBoundingClientRect();
    return Math.abs(titleCenter - box.top - box.height / 2) <= 1;
  });
}
