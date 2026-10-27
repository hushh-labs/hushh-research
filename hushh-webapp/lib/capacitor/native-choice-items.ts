import { Children, Fragment, isValidElement, type ReactNode } from "react";
export type SemanticChoiceOption = { value: string; label: string; disabled: boolean; artworkId?: string };

type Parts = { trigger: unknown; content: unknown; item: unknown; group: unknown };
export function plainChoiceText(node: ReactNode): string | null {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) {
    const pieces = node.map(plainChoiceText);
    return pieces.every(piece => piece !== null) ? pieces.join("") : null;
  }
  if (isValidElement<{ children?: ReactNode }>(node) && node.type === Fragment) return plainChoiceText(node.props.children);
  return null;
}
function authoredProps(props: Record<string, unknown>): boolean {
  return !props.asChild && !props.ref && !props.forceMount &&
    props["aria-label"] === undefined && props["aria-labelledby"] === undefined && props.textValue === undefined &&
    !Object.keys(props).some(key => key.startsWith("on") && props[key] !== undefined);
}

/** Read only known compound-component descriptions. Never render arbitrary
 * components, infer operations from DOM, or stringify a rich/protected body. */
export function collectImmediateChoices(children: ReactNode, parts: Parts): SemanticChoiceOption[] | null {
  let content: ReactNode;
  let contents = 0, triggers = 0, supported = true;
  function root(nodes: ReactNode): void {
    Children.forEach(nodes, node => {
      if (node === null || node === undefined || typeof node === "boolean") return;
      if (!isValidElement<Record<string, unknown>>(node)) { supported = false; return; }
      if (node.type === Fragment) { root(node.props.children as ReactNode); return; }
      if (node.type === parts.trigger) {
        if (node.props.asChild || Object.keys(node.props).some(key => key.startsWith("on") && node.props[key] !== undefined)) supported = false;
        triggers++; return;
      }
      if (node.type !== parts.content || !authoredProps(node.props)) { supported = false; return; }
      contents++; content = node.props.children as ReactNode;
    });
  }
  const options: SemanticChoiceOption[] = [];
  function items(nodes: ReactNode): void {
    Children.forEach(nodes, node => {
      if (node === null || node === undefined || typeof node === "boolean") return;
      if (!isValidElement<Record<string, unknown>>(node)) { supported = false; return; }
      if (node.type === Fragment) { items(node.props.children as ReactNode); return; }
      if (!authoredProps(node.props)) { supported = false; return; }
      if (node.type === parts.group) { items(node.props.children as ReactNode); return; }
      if (node.type !== parts.item) { supported = false; return; }
      const label = plainChoiceText(node.props.children as ReactNode)?.trim(), value = node.props.value;
      if (!label || label.length > 256 || typeof value !== "string" || !value ||
          (node.props.disabled !== undefined && typeof node.props.disabled !== "boolean")) { supported = false; return; }
      options.push({ value, label, disabled: node.props.disabled === true });
    });
  }
  root(children);
  if (!supported || contents !== 1 || triggers !== 1) return null;
  items(content);
  return supported && options.length <= 256 && new Set(options.map(option => option.value)).size === options.length ? options : null;
}
