import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import { z } from 'zod';

import * as protocol from '../src/adapter/protocol.js';
import { anyEnvelopeSchema, COMMANDS, envelopeSchema } from '../src/cli/results.js';
import { casesFileSchema, configSchema, rulesFileSchema } from '../src/config/schema.js';
import { comparisonSchema, pageDataSchema } from '../src/report/schema.js';
import { manifestSchema, swapRecordSchema } from '../src/run/manifest.js';
import { trialLineSchema } from '../src/run/records.js';

type JsonSchema = Record<string, unknown>;

const SCHEMA_DIR = new URL('../schemas/', import.meta.url);
const DRAFT = 'https://json-schema.org/draft/2020-12/schema';

/** Files people write are described as written (defaults optional); records as the tool writes them. */
function toJsonSchema(schema: z.ZodType, io: 'input' | 'output'): JsonSchema {
  return z.toJSONSchema(schema, { target: 'draft-2020-12', io, unrepresentable: 'throw' });
}

const PROTOCOL_MESSAGES: Record<string, z.ZodType> = {
  InitializeParams: protocol.initializeParamsSchema,
  InitializeResult: protocol.initializeResultSchema,
  RenderParams: protocol.renderParamsSchema,
  RenderResult: protocol.renderResultSchema,
  GenerateParams: protocol.generateParamsSchema,
  GenerateResult: protocol.generateResultSchema,
  RpcErrorData: protocol.rpcErrorDataSchema,
  ShutdownResult: protocol.shutdownResultSchema,
  CancelParams: protocol.cancelParamsSchema,
  CallsParams: protocol.callsParamsSchema,
  LogParams: protocol.logParamsSchema,
  AdapterMessage: protocol.adapterMessageSchema,
};

/** One document whose `$defs` hold every protocol message, sharing nested definitions. */
function protocolDocument(): JsonSchema {
  const defs: Record<string, unknown> = {};
  const addDef = (name: string, definition: unknown): void => {
    const existing = defs[name];
    if (existing !== undefined && !isDeepStrictEqual(existing, definition)) {
      throw new Error(`protocol definition ${name} differs between messages`);
    }
    defs[name] = definition;
  };
  for (const [name, schema] of Object.entries(PROTOCOL_MESSAGES)) {
    const { $schema: _draft, $defs: nested, ...definition } = toJsonSchema(schema, 'input');
    for (const [nestedName, nestedDefinition] of Object.entries(nested ?? {})) {
      addDef(nestedName, nestedDefinition);
    }
    addDef(name, definition);
  }
  return { $schema: DRAFT, title: 'model-eval adapter protocol v1', $defs: defs };
}

function documents(): Record<string, JsonSchema> {
  const commands = Object.fromEntries(
    COMMANDS.map((command) => [
      `${command}.schema.json`,
      toJsonSchema(envelopeSchema(command), 'output'),
    ]),
  );
  return {
    'config.schema.json': toJsonSchema(configSchema, 'input'),
    'rules.schema.json': toJsonSchema(rulesFileSchema, 'input'),
    'cases.schema.json': toJsonSchema(casesFileSchema, 'input'),
    'protocol.schema.json': protocolDocument(),
    'trial.schema.json': toJsonSchema(trialLineSchema, 'output'),
    'manifest.schema.json': toJsonSchema(manifestSchema, 'output'),
    'swap-record.schema.json': toJsonSchema(swapRecordSchema, 'output'),
    'comparison.schema.json': toJsonSchema(comparisonSchema, 'output'),
    'page-data.schema.json': toJsonSchema(pageDataSchema, 'output'),
    ...commands,
    'envelope.schema.json': toJsonSchema(anyEnvelopeSchema, 'output'),
  };
}

async function main(): Promise<void> {
  const files = documents();
  await mkdir(SCHEMA_DIR, { recursive: true });
  for (const stale of await readdir(SCHEMA_DIR)) {
    if (stale.endsWith('.schema.json') && !(stale in files)) {
      await rm(new URL(stale, SCHEMA_DIR));
    }
  }
  for (const [name, schema] of Object.entries(files)) {
    await writeFile(new URL(name, SCHEMA_DIR), `${JSON.stringify(schema, null, 2)}\n`);
  }
}

export { documents };

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  await main();
}
