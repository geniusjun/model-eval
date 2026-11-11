import type { Helper, InitializeResult, Service } from './protocol.js';

// What `initialize` declares about the code behind the adapter, compared between two starts of
// one run (adapter-protocol §`initialize`, §Time Limits and Recovery).

export type AdapterChange = 'adapter-version' | 'helper-version' | 'service';

export function sameHelper(a: Helper | undefined, b: Helper | undefined): boolean {
  return a?.language === b?.language && a?.version === b?.version;
}

/** A part of the service code that a comparison could not check. */
export type UnverifiedService = 'service-version' | 'tree-hash';

export interface ServiceComparison {
  readonly changed: boolean;
  readonly unverified?: UnverifiedService;
}

/**
 * `treeHash` when both sides have one, else `version` and `dirty`, so a new commit with identical
 * content is the same service. A version missing on either side, or a dirty tree without
 * `treeHash`, cannot be verified and is not a change (data-model §Resume and Locking, rule 6).
 */
export function compareServiceCode(
  a: Service | undefined,
  b: Service | undefined,
): ServiceComparison {
  if (a?.treeHash !== undefined && b?.treeHash !== undefined) {
    return { changed: a.treeHash !== b.treeHash };
  }
  if (a?.version === undefined || b?.version === undefined) {
    return { changed: false, unverified: 'service-version' };
  }
  if (a.version !== b.version || a.dirty !== b.dirty) {
    return { changed: true };
  }
  return b.dirty === true ? { changed: false, unverified: 'tree-hash' } : { changed: false };
}

export function sameServiceCode(a: Service | undefined, b: Service | undefined): boolean {
  return !compareServiceCode(a, b).changed;
}

/** What a later start declares differently from the first. */
export function adapterChanges(first: InitializeResult, later: InitializeResult): AdapterChange[] {
  const changes: AdapterChange[] = [];
  if (first.adapter.version !== later.adapter.version) {
    changes.push('adapter-version');
  }
  if (!sameHelper(first.adapter.helper, later.adapter.helper)) {
    changes.push('helper-version');
  }
  if (!sameServiceCode(first.service, later.service)) {
    changes.push('service');
  }
  return changes;
}
