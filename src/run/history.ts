import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { previousRun, type ProfileMap } from './cost.js';
import { manifestSchema, type Manifest } from './manifest.js';
import { listResultEntries, RUN_FILES } from './writer.js';

// The earlier runs of the output directory, for the `history` estimate basis (data-model §Cost).

async function readManifest(file: string): Promise<Manifest | undefined> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed = manifestSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Manifests under `runs/`; a folder without a readable manifest is not a run to learn from. */
export async function readRunManifests(outputDir: string): Promise<Manifest[]> {
  const runsDir = path.join(outputDir, 'runs');
  const manifests = await Promise.all(
    (await listResultEntries(runsDir)).map((name) =>
      readManifest(path.join(runsDir, name, RUN_FILES.manifest)),
    ),
  );
  return manifests.filter((manifest) => manifest !== undefined);
}

/** The `costProfile` of the previous run of this variant fingerprint, else none. */
export async function previousProfiles(
  outputDir: string,
  fingerprint: string,
): Promise<ProfileMap> {
  return previousRun(await readRunManifests(outputDir), fingerprint)?.costProfile ?? {};
}
