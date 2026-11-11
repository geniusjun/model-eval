import type { Helper, InitializeResult, Service } from './protocol.js';

// What `initialize` declares about the code behind the adapter, compared between two starts of
// one run (adapter-protocol §`initialize`, §Time Limits and Recovery).

export type AdapterChange = 'adapter-version' | 'helper-version' | 'service';

function sameHelper(a: Helper | undefined, b: Helper | undefined): boolean {
  return a?.language === b?.language && a?.version === b?.version;
}

/**
 * `treeHash` when both sides have one, else `version` and `dirty`, so a new commit with identical
 * content is the same service and a hash missing on one side cannot count as a change.
 */
export function sameServiceCode(a: Service | undefined, b: Service | undefined): boolean {
  if (a?.treeHash !== undefined && b?.treeHash !== undefined) {
    return a.treeHash === b.treeHash;
  }
  return a?.version === b?.version && a?.dirty === b?.dirty;
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
