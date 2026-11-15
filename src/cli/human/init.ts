import type { Lang } from '../../config/schema.js';
import type { AdapterLanguage } from '../templates/adapter.js';
import type { MessageKey } from '../../messages/index.js';
import { textOf } from './text.js';

// Human output of `init`: each file created or kept, the ignore entry, the next step.

export interface InitFile {
  /** Relative to the working directory, with `/` separators. */
  readonly path: string;
  /** `false` when the file existed and was left as it was. */
  readonly created: boolean;
}

/**
 * `added` when the entry was written, `present` when a line ignored the output directory
 * already, `outside` when the output directory is not below the `.gitignore` folder.
 */
export type IgnoreState = 'added' | 'present' | 'outside';

export interface InitOutcome {
  /** The config first, then the example rules and cases written with a new config. */
  readonly files: readonly InitFile[];
  readonly gitignore: {
    readonly path: string;
    /** The output directory relative to the config folder, with `/` separators: the entry. */
    readonly dir: string;
    /** The output directory as {@link InitFile.path} gives paths, `.` for the working folder. */
    readonly outputDir: string;
    readonly state: IgnoreState;
  };
  /** The config path when init created it from the template, so it still needs the user's values. */
  readonly templateConfig: string | undefined;
  /** With `--adapter`: the skeleton to connect to the service, and the config it goes with. */
  readonly adapter:
    | { readonly language: AdapterLanguage; readonly file: string; readonly config: string }
    | undefined;
}

const IGNORE_KEYS: Readonly<Record<IgnoreState, MessageKey>> = {
  added: 'human.init.ignored',
  present: 'human.init.alreadyIgnored',
  outside: 'human.init.outsideFolder',
};

/** The next step after `--adapter`; a Node adapter also needs the tool installed beside it. */
const NEXT_ADAPTER_KEYS: Readonly<Record<AdapterLanguage, MessageKey>> = {
  python: 'human.init.nextAdapter.python',
  node: 'human.init.nextAdapter.node',
};

export function initLines(lang: Lang, outcome: InitOutcome): string[] {
  const t = textOf(lang);
  const { files, gitignore, templateConfig, adapter } = outcome;
  return [
    ...files.map((file) =>
      t(file.created ? 'human.init.created' : 'human.init.kept', { path: file.path }),
    ),
    // The entry is the line written into .gitignore; the notice names paths from the working folder.
    t(IGNORE_KEYS[gitignore.state], {
      entry: `${gitignore.dir}/`,
      dir: gitignore.outputDir,
      path: gitignore.path,
    }),
    ...(adapter !== undefined
      ? [t(NEXT_ADAPTER_KEYS[adapter.language], { file: adapter.file, config: adapter.config })]
      : templateConfig === undefined
        ? []
        : [t('human.init.next', { config: templateConfig })]),
  ];
}
