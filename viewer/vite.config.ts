import { createHash } from 'node:crypto';
import { isBuiltin } from 'node:module';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// research R3: one HTML file that works from file://. Browsers load no extra chunk or module
// there, so the build fails on anything that would need one, and the CSP admits the one inline
// script by its hash.

const ENTRY_HTML = 'index.html';
const TEMPLATE_FILE = 'report.html';
const SCRIPT_HASH_PLACEHOLDER = '__SCRIPT_HASH__';
const INLINE_SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script>/g;

/** Fails the build on a Node built-in, which the page cannot run and must never bundle. */
function noNodeModules(): Plugin {
  return {
    name: 'model-eval:no-node-modules',
    enforce: 'pre',
    resolveId(source) {
      if (source.startsWith('node:') || isBuiltin(source)) {
        this.error(`the page imports the Node module ${source}`);
      }
      return null;
    },
  };
}

/** Fails the build on a second chunk or a dynamic import, before the chunk is inlined. */
function oneChunk(): Plugin {
  return {
    name: 'model-eval:one-chunk',
    generateBundle: {
      order: 'pre',
      handler(_options, bundle) {
        const chunks = Object.values(bundle).filter((output) => output.type === 'chunk');
        if (chunks.length !== 1) {
          this.error(`the page must build into one chunk, not ${String(chunks.length)}`);
        }
        for (const chunk of chunks) {
          for (const id of chunk.moduleIds) {
            const dynamic = this.getModuleInfo(id)?.dynamicallyImportedIds ?? [];
            if (dynamic.length > 0) {
              this.error(`${id} has a dynamic import, which file:// pages cannot load`);
            }
          }
        }
      },
    },
  };
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('base64');
}

/** Every script element's text except the JSON data block, which browsers never run. */
function executableScripts(html: string): string[] {
  return [...html.matchAll(INLINE_SCRIPT)]
    .filter((match) => !/\btype="application\/json"/.test(match[1] ?? ''))
    .map((match) => match[2] ?? '');
}

/**
 * After inlining: writes the SHA-256 of the one inline script into the CSP and emits the page as
 * `report.html`, the template feature 001 fills.
 */
function hashedTemplate(): Plugin {
  return {
    name: 'model-eval:hashed-template',
    enforce: 'post',
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const files = Object.keys(bundle);
        const entry = bundle[ENTRY_HTML];
        if (entry?.type !== 'asset' || files.length !== 1) {
          this.error(`expected only ${ENTRY_HTML} after inlining, found ${files.join(', ')}`);
        }
        const html = String(entry.source);
        const scripts = executableScripts(html);
        const [script] = scripts;
        if (script === undefined || scripts.length !== 1) {
          this.error(`expected one inline script, found ${String(scripts.length)}`);
        }
        if (html.split(SCRIPT_HASH_PLACEHOLDER).length !== 2) {
          this.error(`${ENTRY_HTML} must hold ${SCRIPT_HASH_PLACEHOLDER} once, in its CSP`);
        }
        const source = html.replace(SCRIPT_HASH_PLACEHOLDER, () => sha256(script));
        Reflect.deleteProperty(bundle, ENTRY_HTML);
        this.emitFile({ type: 'asset', fileName: TEMPLATE_FILE, source });
      },
    },
  };
}

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  plugins: [noNodeModules(), react(), oneChunk(), viteSingleFile(), hashedTemplate()],
  build: {
    outDir: fileURLToPath(new URL('../dist/viewer', import.meta.url)),
    emptyOutDir: true,
    modulePreload: false,
    reportCompressedSize: false,
  },
});
