/** Formatting-only transport planning. Semantic selection belongs to the agent. */
export type PkmSourceSpan = Readonly<{ start: number; end: number }>;
type SourceBlock = PkmSourceSpan & Readonly<{ protectedContext: boolean }>;
export type PkmSourceChunk = Readonly<{
  blocks: readonly SourceBlock[];
  /**
   * Heading lines sent ahead of a protected section's later lines so the body
   * keeps its attribution after a split. Context is never part of the covered
   * range: it is transport only, so coverage still accounts every body line once.
   */
  context?: readonly PkmSourceSpan[];
}>;

export const PKM_PROPOSAL_CHARS = 6_000;
const MAX_BLOCKS = 6;

export function sourceChunkRange(chunk: PkmSourceChunk): PkmSourceSpan {
  return {
    start: chunk.blocks[0]!.start,
    end: chunk.blocks[chunk.blocks.length - 1]!.end,
  };
}

export function sourceChunkText(source: string, chunk: PkmSourceChunk): string {
  const { start, end } = sourceChunkRange(chunk);
  const body = source.slice(start, end);
  if (!chunk.context?.length) return body;
  const prefix = chunk.context
    .map((span) => {
      const line = source.slice(span.start, span.end);
      return line.endsWith("\n") ? line : `${line}\n`;
    })
    .join("");
  return prefix + body;
}

const MARKDOWN_HEADING = /^\s*(#{1,6})\s+/;
const STANDALONE_LABEL =
  /^\s*(?:\*\*[^*]+\*\*|__[^_]+__|[A-Za-z][A-Za-z /&()-]{1,80}:)\s*$/;

/** A line that names a section without stating a fact, or null. */
function headingLevel(line: string): number | null {
  const markdown = MARKDOWN_HEADING.exec(line);
  if (markdown) return markdown[1]!.length;
  return STANDALONE_LABEL.test(line) ? 6 : null;
}

function lineSpans(source: string, start: number, end: number): PkmSourceSpan[] {
  const spans: PkmSourceSpan[] = [];
  let cursor = start;
  while (cursor < end) {
    const newline = source.indexOf("\n", cursor);
    const lineEnd = newline === -1 || newline >= end ? end : newline + 1;
    spans.push({ start: cursor, end: lineEnd });
    cursor = lineEnd;
  }
  return spans;
}

/** The innermost heading path in force after `spans`, outermost first. */
function headingChain(source: string, spans: readonly PkmSourceSpan[]): PkmSourceSpan[] {
  const chain: Array<{ span: PkmSourceSpan; level: number }> = [];
  for (const span of spans) {
    const level = headingLevel(source.slice(span.start, span.end));
    if (level === null) continue;
    while (chain.length && chain[chain.length - 1]!.level >= level) chain.pop();
    chain.push({ span, level });
  }
  return chain.map((entry) => entry.span);
}

/**
 * Split a protected section between whole lines, never inside one. The later
 * half carries the heading chain that was in force at the split, so a bullet
 * never loses the heading that attributes it. Returns null when the section has
 * fewer than two content lines: there is then nothing to split without cutting
 * a single statement apart.
 */
function splitProtectedBlockByLines(
  source: string,
  block: SourceBlock,
  context: readonly PkmSourceSpan[] | undefined,
): PkmSourceChunk[] | null {
  const lines = lineSpans(source, block.start, block.end);
  const isContent = (span: PkmSourceSpan) => {
    const text = source.slice(span.start, span.end);
    return Boolean(text.trim()) && headingLevel(text) === null;
  };
  const contentBefore: number[] = [];
  let seen = 0;
  for (const span of lines) {
    contentBefore.push(seen);
    if (isContent(span)) seen += 1;
  }
  if (seen < 2) return null;
  const middle = (block.start + block.end) / 2;
  let split = -1;
  for (let index = 1; index < lines.length; index++) {
    const before = contentBefore[index]!;
    const previousText = source.slice(lines[index - 1]!.start, lines[index - 1]!.end);
    // Both halves must state something, and a heading stays with its body.
    if (before === 0 || before === seen || headingLevel(previousText) !== null) continue;
    if (split === -1 || Math.abs(lines[index]!.start - middle) < Math.abs(lines[split]!.start - middle)) {
      split = index;
    }
  }
  if (split === -1) return null;
  const boundary = lines[split]!.start;
  const inherited = context ?? [];
  // Headings that open the later half already travel in its body; they still
  // retire a sibling heading from the carried path (## Food replaces ## Health).
  const leadingHeadings: PkmSourceSpan[] = [];
  for (const span of lines.slice(split)) {
    const text = source.slice(span.start, span.end);
    if (!text.trim()) continue;
    if (headingLevel(text) === null) break;
    leadingHeadings.push(span);
  }
  const laterContext = headingChain(source, [...inherited, ...lines.slice(0, split), ...leadingHeadings])
    .filter((span) => span.end <= boundary);
  return [
    {
      blocks: [{ start: block.start, end: boundary, protectedContext: true }],
      ...(inherited.length ? { context: inherited } : {}),
    },
    {
      blocks: [{ start: boundary, end: block.end, protectedContext: true }],
      ...(laterContext.length ? { context: laterContext } : {}),
    },
  ];
}

function proseBlocks(
  source: string,
  start: number,
  end: number,
  limit: number,
): SourceBlock[] {
  const blocks: SourceBlock[] = [];
  while (end - start > limit) {
    const ceiling = start + limit;
    const boundaries = ["\n\n", "\n", ". ", "! ", "? ", ", ", " "].map(
      (separator) => {
        const index = source.lastIndexOf(separator, ceiling - separator.length);
        return index < start
          ? start
          : index + (/[.!?,]/.test(separator) ? 1 : 0);
      },
    );
    const preferred = Math.max(...boundaries);
    const boundary = preferred - start >= limit * 0.45 ? preferred : ceiling;
    blocks.push({ start, end: boundary, protectedContext: false });
    start = boundary;
  }
  if (start < end) blocks.push({ start, end, protectedContext: false });
  return blocks;
}

export function planPkmSourceChunks(source: string): PkmSourceChunk[] {
  const blocks: SourceBlock[] = [];
  let start = 0;
  let offset = 0;
  let headingLevel: number | null = null;
  let protectedContext = false;
  let hasBody = false;
  const push = (end: number) => {
    if (!source.slice(start, end).trim()) return;
    if (protectedContext) blocks.push({ start, end, protectedContext });
    else blocks.push(...proseBlocks(source, start, end, PKM_PROPOSAL_CHARS));
  };
  for (const line of source.match(/[^\n]*\n|[^\n]+$/g) || []) {
    const markdown = MARKDOWN_HEADING.exec(line);
    const numbered = /^\s*\d{1,3}[.)]\s+\S/.test(line);
    const standalone = STANDALONE_LABEL.test(line);
    const level = markdown
      ? markdown[1]!.length
      : numbered || standalone
        ? 6
        : null;
    const field =
      /^\s*(?:[-+]\s+)?(?:\*\*[^*]{1,160}:?\*\*|__[^_]{1,160}:?__|[A-Za-z][A-Za-z /&()-]{1,80}:)\s*\S/.test(
        line,
      );
    const closesSection =
      level !== null && (headingLevel === null || level <= headingLevel);
    if (hasBody && (closesSection || (headingLevel === null && field))) {
      push(offset);
      start = offset;
      hasBody = false;
      protectedContext = false;
    }
    if (level !== null) {
      headingLevel =
        headingLevel === null ? level : Math.min(headingLevel, level);
      protectedContext = true;
      // Numbered list items carry content on their heading line.
      if (numbered) hasBody = true;
    } else if (line.trim()) {
      hasBody = true;
      if (field) protectedContext = true;
    }
    offset += line.length;
  }
  push(source.length);

  const chunks: PkmSourceChunk[] = [];
  let pending: SourceBlock[] = [];
  for (const block of blocks) {
    if (
      pending.length &&
      (pending.length >= MAX_BLOCKS ||
        block.end - pending[0]!.start > PKM_PROPOSAL_CHARS)
    ) {
      chunks.push({ blocks: pending });
      pending = [];
    }
    pending.push(block);
  }
  if (pending.length) chunks.push({ blocks: pending });
  return chunks;
}

/**
 * Re-plan one previously prepared span, for a per-section retry. A span that was
 * split out of a protected section keeps that shape (and its heading context);
 * any other span is planned exactly as a fresh paste of the same text would be.
 */
export function planPkmSourceSelection(
  source: string,
  range: PkmSourceSpan,
  context?: readonly PkmSourceSpan[],
): PkmSourceChunk[] {
  const valid = (span: PkmSourceSpan) =>
    Number.isInteger(span.start) && Number.isInteger(span.end) &&
    span.start >= 0 && span.start < span.end && span.end <= source.length;
  if (!valid(range) || !(context ?? []).every((span) => valid(span) && span.end <= range.start)) {
    throw new Error("That section no longer matches this note. Review the note again.");
  }
  if (context?.length) {
    return [{ blocks: [{ start: range.start, end: range.end, protectedContext: true }], context }];
  }
  const shift = (block: SourceBlock): SourceBlock => ({
    ...block, start: block.start + range.start, end: block.end + range.start,
  });
  return planPkmSourceChunks(source.slice(range.start, range.end)).map((chunk) => ({
    blocks: chunk.blocks.map(shift),
  }));
}

export function splitPkmSourceChunk(
  source: string,
  chunk: PkmSourceChunk,
): PkmSourceChunk[] | null {
  if (chunk.blocks.length > 1) {
    const range = sourceChunkRange(chunk);
    const middle = (range.start + range.end) / 2;
    let split = 1;
    for (let index = 2; index < chunk.blocks.length; index++) {
      if (
        Math.abs(chunk.blocks[index]!.start - middle) <
        Math.abs(chunk.blocks[split]!.start - middle)
      )
        split = index;
    }
    return [
      {
        blocks: chunk.blocks.slice(0, split),
        ...(chunk.context?.length ? { context: chunk.context } : {}),
      },
      { blocks: chunk.blocks.slice(split) },
    ];
  }
  const block = chunk.blocks[0];
  if (!block) return null;
  if (block.protectedContext) {
    return splitProtectedBlockByLines(source, block, chunk.context);
  }
  if (block.end - block.start < 96) return null;
  const blocks = proseBlocks(
    source,
    block.start,
    block.end,
    Math.ceil((block.end - block.start) / 2),
  );
  const first = blocks[0];
  return first && first.end < block.end
    ? [
        { blocks: [first] },
        {
          blocks: [
            { start: first.end, end: block.end, protectedContext: false },
          ],
        },
      ]
    : null;
}
