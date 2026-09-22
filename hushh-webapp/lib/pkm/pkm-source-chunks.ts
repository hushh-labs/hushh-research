/** Formatting-only transport planning. Semantic selection belongs to the agent. */
export type PkmSourceSpan = Readonly<{ start: number; end: number }>;
type SourceBlock = PkmSourceSpan & Readonly<{ protectedContext: boolean }>;
export type PkmSourceChunk = Readonly<{ blocks: readonly SourceBlock[] }>;

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
  return source.slice(start, end);
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
    const markdown = /^\s*(#{1,6})\s+/.exec(line);
    const numbered = /^\s*\d{1,3}[.)]\s+\S/.test(line);
    const standalone =
      /^\s*(?:\*\*[^*]+\*\*|__[^_]+__|[A-Za-z][A-Za-z /&()-]{1,80}:)\s*$/.test(
        line,
      );
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
      { blocks: chunk.blocks.slice(0, split) },
      { blocks: chunk.blocks.slice(split) },
    ];
  }
  const block = chunk.blocks[0];
  if (!block || block.protectedContext || block.end - block.start < 96)
    return null;
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
