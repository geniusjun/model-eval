import { startAdapter, type ShutdownOutcome, type StartOptions } from '../adapter/client.js';
import type { LogParams, Target } from '../adapter/protocol.js';
import { diagnostic, type Diagnostic, type LintFinding } from '../config/diagnostics.js';
import type { Project } from '../config/load.js';
import type { Variant } from '../config/schema.js';
import { toolPaths } from '../run/runner.js';
import {
  anchorMissing,
  renderFailures,
  renderVariant,
  unanchored,
  type RenderOutcome,
  type VariantRender,
} from './anchors.js';
import { derivedTracked } from './derived-tracked.js';
import { exampleMismatches } from './examples.js';
import { helperOutdated, type HelperReport } from './helper-version.js';
import { completedNotGated, excludedFromGate, samplePlanFindings } from './gate-config.js';
import { inputSchemaFindings } from './input-schema.js';
import {
  duplicateIds,
  languageGaps,
  missingLangs,
  ruleFilterMismatches,
  rulesWithoutCases,
  unknownRules,
  unknownTargets,
  unresolvedRefs,
} from './references.js';
import { lintSubject, type LintSubject } from './subject.js';

// `model-eval lint` as a library call: the lint codes of data-model §Validation Rules over a
// loaded project, without calling a model.

/**
 * `none` (`--no-adapter`) starts no adapter; `targets` starts the first variant's adapter for
 * its targets and input schemas; `render` (`--render`) starts each rendered variant's adapter.
 */
export type AdapterUse = 'none' | 'targets' | 'render';

export interface LintOptions {
  /** Finding file paths are relative to it. */
  readonly cwd: string;
  readonly adapter: AdapterUse;
  /** The variants `render` renders; every config variant when absent (`--variant`). */
  readonly variants?: readonly Variant[] | undefined;
  readonly tool: { readonly name: string; readonly version: string };
  readonly onStderr?: (line: string) => void;
  readonly onLog?: (params: LogParams) => void;
}

interface AdapterResults {
  /** The targets of the first adapter that started. */
  readonly targets?: readonly Target[] | undefined;
  readonly renders: readonly VariantRender[];
  /** The helper of every adapter that answered `initialize`, also before an `adapter-failed`. */
  readonly helpers: readonly HelperReport[];
  /** `adapter-failed`, after which no other adapter starts. */
  readonly failures: readonly LintFinding[];
}

function adapterFailed(subject: LintSubject, variant: string, detail: string): LintFinding {
  return {
    code: 'adapter-failed',
    params: { detail },
    variants: [variant],
    ...subject.configAt(['adapter', 'command']),
  };
}

function startOptions(project: Project, variant: Variant, options: LintOptions): StartOptions {
  const config = project.config.data;
  return {
    launch: {
      command: config.adapter.command,
      cwd: project.paths.adapterCwd,
      env: config.adapter.env,
    },
    initialize: {
      client: options.tool,
      variant: {
        id: variant.id,
        model: variant.model,
        ...(variant.params === undefined ? {} : { params: variant.params }),
      },
      timeoutMs: config.adapter.timeoutMs,
      toolPaths: toolPaths(project),
    },
    concurrency: config.run.concurrency,
    ...(options.onLog === undefined ? {} : { onLog: options.onLog }),
    ...(options.onStderr === undefined ? {} : { onStderr: options.onStderr }),
  };
}

/**
 * Why a started adapter fails lint: a render that broke the protocol, a protocol violation seen
 * up to its exit (stdout contamination after the last answer included) and, under `--render`,
 * a `shutdown` it did not answer with a result or did not exit after.
 */
function adapterProblem(
  rendered: RenderOutcome | undefined,
  shutdown: ShutdownOutcome,
  render: boolean,
): string | undefined {
  if (rendered?.ok === false) {
    return rendered.detail;
  }
  if (shutdown.violation !== undefined) {
    return shutdown.violation;
  }
  if (!render) {
    return undefined;
  }
  if (!shutdown.answered) {
    return 'the adapter did not answer shutdown with a result';
  }
  return shutdown.forced
    ? 'the adapter did not exit after answering shutdown, so it was stopped with a signal'
    : undefined;
}

/** Starts one adapter per variant in turn, each shut down before the next starts. */
async function useAdapters(project: Project, options: LintOptions): Promise<AdapterResults> {
  const config = project.config.data;
  const variants =
    options.adapter === 'render'
      ? (options.variants ?? config.variants)
      : config.variants.slice(0, 1);
  let targets: readonly Target[] | undefined;
  const renders: VariantRender[] = [];
  const helpers: HelperReport[] = [];
  const failed = (variant: Variant, detail: string): AdapterResults => ({
    targets,
    renders,
    helpers,
    failures: [adapterFailed(lintSubject(project, options.cwd), variant.id, detail)],
  });
  for (const variant of variants) {
    const started = await startAdapter(startOptions(project, variant, options));
    if (!started.ok) {
      return failed(variant, started.error.message);
    }
    const { client } = started;
    targets ??= client.info.targets;
    helpers.push({ variant: variant.id, helper: client.info.adapter.helper });
    let rendered: RenderOutcome | undefined;
    let shutdown: ShutdownOutcome;
    try {
      rendered =
        options.adapter === 'render'
          ? await renderVariant(
              client,
              lintSubject(project, options.cwd, targets),
              variant.id,
              config.sampling.seed,
            )
          : undefined;
    } finally {
      shutdown = await client.shutdown();
    }
    const problem = adapterProblem(rendered, shutdown, options.adapter === 'render');
    if (problem !== undefined) {
      return failed(variant, problem);
    }
    if (rendered?.ok === true) {
      renders.push(rendered.render);
    }
  }
  return { targets, renders, helpers, failures: [] };
}

/** Every lint finding of the project with its level, in the order of the checks above. */
export async function lintProject(project: Project, options: LintOptions): Promise<Diagnostic[]> {
  const adapter: AdapterResults =
    options.adapter === 'none'
      ? { renders: [], helpers: [], failures: [] }
      : await useAdapters(project, options);
  const subject = lintSubject(project, options.cwd, adapter.targets);
  const findings: LintFinding[] = [
    ...duplicateIds(subject),
    ...unknownRules(subject),
    ...missingLangs(subject),
    ...inputSchemaFindings(subject),
    ...unknownTargets(subject),
    ...unresolvedRefs(subject),
    ...exampleMismatches(subject),
    ...(await derivedTracked(subject)),
    ...adapter.failures,
    ...renderFailures(subject, adapter.renders),
    ...anchorMissing(subject, adapter.renders),
    ...ruleFilterMismatches(subject),
    ...rulesWithoutCases(subject),
    ...languageGaps(subject),
    ...completedNotGated(subject),
    ...excludedFromGate(subject),
    ...samplePlanFindings(subject),
    ...helperOutdated(adapter.helpers, subject.configAt(['adapter', 'command'])),
    ...unanchored(subject),
  ];
  return findings.map((finding) => diagnostic(finding));
}
