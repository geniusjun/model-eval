import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { parse as parseYaml, stringify } from 'yaml';

import { scenarioSchema, type Scenario } from '../../../src/adapter/mock-scenario.js';
import { scenarioFile } from './mock.js';
import type { Project } from './project.js';

// A project whose mock adapter reads its own copy of a scenario, so a test can change what the
// adapter declares or does between two segments of a run without changing its launch settings.

const CONFIG_FILE = 'model-eval.config.yaml';
const COPY_FILE = 'scenario.yaml';

export interface ScenarioCopy {
  edit(change: (scenario: Scenario) => Scenario): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The project's config file as YAML data. */
export async function readConfig(project: Project): Promise<Record<string, unknown>> {
  const config: unknown = parseYaml(await readFile(path.join(project.root, CONFIG_FILE), 'utf8'));
  if (!isRecord(config)) {
    throw new Error('the project config is not a mapping');
  }
  return config;
}

export async function writeConfig(
  project: Project,
  config: Readonly<Record<string, unknown>>,
): Promise<void> {
  await writeFile(path.join(project.root, CONFIG_FILE), stringify(config));
}

/**
 * Copies the project's scenario into the project and points `adapter.command` at the copy. Call
 * it before the first run, since the command is part of the run's `launchHash`.
 */
export async function copyScenario(project: Project, name: string): Promise<ScenarioCopy> {
  const source = scenarioFile(name);
  const copy = path.join(project.root, COPY_FILE);
  await writeFile(copy, await readFile(source, 'utf8'));
  const config = await readConfig(project);
  const adapter = config.adapter;
  if (!isRecord(adapter) || !Array.isArray(adapter.command)) {
    throw new Error('the project config has no adapter command');
  }
  const command: unknown[] = adapter.command;
  await writeConfig(project, {
    ...config,
    adapter: { ...adapter, command: command.map((part) => (part === source ? copy : part)) },
  });
  return {
    edit: async (change) => {
      const current = scenarioSchema.parse(parseYaml(await readFile(copy, 'utf8')));
      await writeFile(copy, stringify(change(current)));
    },
  };
}
