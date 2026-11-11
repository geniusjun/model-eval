// The `--cases` pattern. Case IDs hold no `/`, so the glob of one path segment covers them:
// `*` (and `**`), `?`, `[...]` (`!` or `^` negates), `{a,b}` (nested too) and `\` to escape,
// inside brackets as well. Matching is case-sensitive on every OS; `path.matchesGlob` ignores
// the case of wildcard parts on macOS and Windows. Parsing and matching take time linear in the
// pattern and the ID, without backtracking. A bracket or brace without its close, a brace pair
// without a comma and braces nested deeper than `MAX_BRACE_DEPTH` are literal characters; a
// reversed range such as `[9-1]` matches nothing.

/** Keeps the recursion of parsing and matching shallow whatever the pattern. */
const MAX_BRACE_DEPTH = 64;

type GlobNode =
  | { readonly kind: 'one'; readonly test: (char: string) => boolean }
  | { readonly kind: 'any' }
  | { readonly kind: 'either'; readonly options: readonly (readonly GlobNode[])[] };

/** The index of the `]` that closes the class opened at `start`, or -1. */
function scanClass(glob: string, start: number): number {
  let index = start + 1;
  if (glob[index] === '!' || glob[index] === '^') {
    index += 1;
  }
  if (glob[index] === ']') {
    index += 1;
  }
  for (; index < glob.length; index += 1) {
    if (glob[index] === '\\') {
      index += 1;
    } else if (glob[index] === ']') {
      return index;
    }
  }
  return -1;
}

/**
 * `scanClass` for every `[` of `glob` in one linear pass overall: once a `[` has no close, no
 * later one has either, because both scans pair `\` with the same characters.
 */
function classEnds(glob: string): (start: number) => number {
  let unclosedFrom = Infinity;
  return (start) => {
    if (start >= unclosedFrom) {
      return -1;
    }
    const end = scanClass(glob, start);
    if (end === -1) {
      unclosedFrom = start;
    }
    return end;
  };
}

/** The positions of `{`, `,` and `}` that form alternations; the rest are literal. */
function alternations(glob: string, classEnd: (start: number) => number): Set<number> {
  const marks = new Set<number>();
  const open: { brace: number; commas: number[]; literal: boolean }[] = [];
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === '\\') {
      index += 1;
    } else if (char === '[') {
      const end = classEnd(index);
      index = end === -1 ? index : end;
    } else if (char === '{') {
      open.push({ brace: index, commas: [], literal: open.length >= MAX_BRACE_DEPTH });
    } else if (char === ',') {
      open.at(-1)?.commas.push(index);
    } else if (char === '}') {
      const group = open.pop();
      if (group !== undefined && !group.literal && group.commas.length > 0) {
        for (const mark of [group.brace, ...group.commas, index]) {
          marks.add(mark);
        }
      }
    }
  }
  return marks;
}

/** The test of the class between `start` (`[`) and `end` (`]`). */
function characterClass(glob: string, start: number, end: number): (char: string) => boolean {
  const chars = glob.slice(start + 1, end);
  const negated = chars[0] === '!' || chars[0] === '^';
  const ranges: { readonly from: string; readonly to: string }[] = [];
  let index = negated ? 1 : 0;
  const next = (): string => {
    const char = chars[index] ?? '';
    index += 1;
    if (char === '\\' && index < chars.length) {
      index += 1;
      return chars[index - 1] ?? '';
    }
    return char;
  };
  while (index < chars.length) {
    const from = next();
    if (chars[index] === '-' && index + 1 < chars.length) {
      index += 1;
      ranges.push({ from, to: next() });
    } else {
      ranges.push({ from, to: from });
    }
  }
  return (char) => negated !== ranges.some(({ from, to }) => from <= char && char <= to);
}

function parse(glob: string): readonly GlobNode[] {
  const classEnd = classEnds(glob);
  const marks = alternations(glob, classEnd);
  let index = 0;
  const sequence = (): GlobNode[] => {
    const nodes: GlobNode[] = [];
    while (index < glob.length) {
      const char = glob[index] ?? '';
      if (marks.has(index)) {
        if (char !== '{') {
          return nodes;
        }
        const options: GlobNode[][] = [];
        do {
          index += 1;
          options.push(sequence());
        } while (glob[index] === ',');
        index += 1;
        nodes.push({ kind: 'either', options });
        continue;
      }
      const end = char === '[' ? classEnd(index) : -1;
      if (char === '\\' && index + 1 < glob.length) {
        const escaped = glob[index + 1];
        nodes.push({ kind: 'one', test: (value) => value === escaped });
        index += 2;
      } else if (char === '*') {
        while (glob[index] === '*') {
          index += 1;
        }
        nodes.push({ kind: 'any' });
      } else if (char === '?') {
        nodes.push({ kind: 'one', test: () => true });
        index += 1;
      } else if (end !== -1) {
        nodes.push({ kind: 'one', test: characterClass(glob, index, end) });
        index = end + 1;
      } else {
        nodes.push({ kind: 'one', test: (value) => value === char });
        index += 1;
      }
    }
    return nodes;
  };
  return sequence();
}

/** The positions in `id` where `nodes` can end when they start at one of `starts`. */
function ends(nodes: readonly GlobNode[], id: string, starts: ReadonlySet<number>): Set<number> {
  let current = new Set(starts);
  for (const node of nodes) {
    if (current.size === 0) {
      break;
    }
    const next = new Set<number>();
    if (node.kind === 'one') {
      for (const position of current) {
        if (position < id.length && node.test(id[position] ?? '')) {
          next.add(position + 1);
        }
      }
    } else if (node.kind === 'any') {
      for (let position = Math.min(...current); position <= id.length; position += 1) {
        next.add(position);
      }
    } else {
      for (const option of node.options) {
        for (const position of ends(option, id, current)) {
          next.add(position);
        }
      }
    }
    current = next;
  }
  return current;
}

/** Whether a case ID matches `glob`. */
export function caseGlobMatcher(glob: string): (id: string) => boolean {
  const nodes = parse(glob);
  return (id) => ends(nodes, id, new Set([0])).has(id.length);
}
