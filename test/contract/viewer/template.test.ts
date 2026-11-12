import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { DATA_PLACEHOLDER, fillTemplate } from '../../../src/report/page-data.js';
import { pageDataSchema } from '../../../src/report/schema.js';
import { FIXTURES, readJsonFixture } from '../report/fixtures.js';

// 002 page-data §Embedded Block and plan D5 on the built template `dist/viewer/report.html`,
// which `pnpm test` builds first.

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const TEMPLATE = path.join(ROOT, 'dist/viewer/report.html');
const VIEWER_SOURCE = path.join(ROOT, 'viewer/src');

const DATA_BLOCK = `<script type="application/json" id="model-eval-data">${DATA_PLACEHOLDER}</script>`;
const SCRIPT_ELEMENT = /<script\b([^>]*)>([\s\S]*?)<\/script>/g;
const STYLE_ELEMENT = /<style\b[^>]*>([\s\S]*?)<\/style>/g;
const CSP_META = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"\s*\/?>/g;

interface ScriptElement {
  readonly attributes: string;
  readonly text: string;
}

function readTemplate(): string {
  return readFileSync(TEMPLATE, 'utf8');
}

function scripts(html: string): ScriptElement[] {
  return [...html.matchAll(SCRIPT_ELEMENT)].map((match) => ({
    attributes: match[1] ?? '',
    text: match[2] ?? '',
  }));
}

function isDataBlock(script: ScriptElement): boolean {
  return /\btype="application\/json"/.test(script.attributes);
}

/** The scripts a browser runs: every script element but the JSON data block. */
function executableScripts(html: string): ScriptElement[] {
  return scripts(html).filter((script) => !isDataBlock(script));
}

/** The markup outside script and style elements, where attributes live. */
function markup(html: string): string {
  return html.replace(SCRIPT_ELEMENT, '<script$1></script>').replace(STYLE_ELEMENT, '');
}

function inlineCss(html: string): string {
  return [...html.matchAll(STYLE_ELEMENT)].map((match) => match[1] ?? '').join('\n');
}

function cspContents(html: string): string[] {
  return [...html.matchAll(CSP_META)].map((match) => match[1] ?? '');
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('base64');
}

function viewerSourceFiles(): string[] {
  return readdirSync(VIEWER_SOURCE, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

const PAGE_FIXTURES = readdirSync(FIXTURES).filter((name) => /^page-.*\.json$/.test(name));

describe('002 result page template', () => {
  it('002 FR-001 FR-010 holds exactly one executable inline script and nothing it loads', () => {
    const html = readTemplate();
    const executable = executableScripts(html);
    expect(executable).toHaveLength(1);
    expect(executable[0]?.attributes ?? '').not.toMatch(/\bsrc=/);
    expect(executable[0]?.text.trim()).not.toBe('');
  });

  it('002 FR-001 FR-010 has no src or href attribute and no url( in its CSS other than data:', () => {
    const html = readTemplate();
    const links = [...markup(html).matchAll(/\s(?:src|href)\s*=\s*["']?([^"'\s>]*)/g)].map(
      (match) => match[1] ?? '',
    );
    expect(links.filter((link) => !link.startsWith('data:'))).toEqual([]);
    const urls = [...inlineCss(html).matchAll(/url\(\s*["']?([^"')\s]*)/g)].map(
      (match) => match[1] ?? '',
    );
    expect(urls.filter((url) => !url.startsWith('data:'))).toEqual([]);
  });

  it('002 FR-001 FR-010 has no dynamic import', () => {
    expect(readTemplate()).not.toContain('import(');
  });

  it('002 FR-010 carries a CSP that allows only its own script by hash, inline styles and data: images', () => {
    const html = readTemplate();
    const [script] = executableScripts(html);
    expect(cspContents(html)).toEqual([
      `default-src 'none'; script-src 'sha256-${sha256(script?.text ?? '')}'; style-src 'unsafe-inline'; img-src data:`,
    ]);
    expect(html.indexOf('http-equiv="Content-Security-Policy"')).toBeLessThan(
      html.indexOf('<script'),
    );
  });

  it('002 FR-001 holds the data placeholder once, inside the data block, and no viewer source names it', () => {
    const html = readTemplate();
    expect(html.split(DATA_PLACEHOLDER)).toHaveLength(2);
    expect(html).toContain(DATA_BLOCK);
    const naming = viewerSourceFiles().filter((file) =>
      readFileSync(file, 'utf8').includes(DATA_PLACEHOLDER),
    );
    expect(naming).toEqual([]);
  });

  it('002 FR-001 FR-010 keeps the script and the CSP when filled with each page fixture', () => {
    const html = readTemplate();
    const [script] = executableScripts(html);
    expect(PAGE_FIXTURES.length).toBeGreaterThan(0);
    for (const fixture of PAGE_FIXTURES) {
      const filled = fillTemplate(html, pageDataSchema.parse(readJsonFixture(fixture)));
      expect(executableScripts(filled), fixture).toEqual([script]);
      expect(cspContents(filled), fixture).toEqual(cspContents(html));
    }
  });

  it('002 FR-001 keeps the package dependencies to zod, ajv and yaml', () => {
    const manifest = z
      .object({ dependencies: z.record(z.string(), z.string()) })
      .parse(JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')));
    expect(Object.keys(manifest.dependencies).sort()).toEqual(['ajv', 'yaml', 'zod']);
  });
});
