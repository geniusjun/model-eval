import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { isMissing } from './layout.js';

/**
 * The result page template (feature 002) as the package ships it: `dist/viewer/report.html`,
 * next to the built `dist/report/` modules. A source checkout has none until the viewer is built.
 */
export const PAGE_TEMPLATE = fileURLToPath(new URL('../viewer/report.html', import.meta.url));

/** The template's text, or undefined when there is no template at `file`. */
export async function readPageTemplate(file: string = PAGE_TEMPLATE): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (isMissing(error)) {
      return undefined;
    }
    throw error;
  }
}
