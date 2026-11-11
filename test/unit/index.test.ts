import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import * as api from '../../src/index.js';

const ENTRY = fileURLToPath(new URL('../../src/index.ts', import.meta.url));
const TSCONFIG = fileURLToPath(new URL('../../tsconfig.json', import.meta.url));

const FUNCTIONS = [
  'buildComparison',
  'currentCases',
  'executeRun',
  'executeSwap',
  'lintProject',
  'loadProject',
  'processInterrupts',
  'readRunRecords',
  'regradeRun',
  'renderReport',
  'rewriteReport',
  'runDirectoryPath',
  'samplePlan',
  'writeComparison',
];

const SCHEMAS = [
  'casesFileSchema',
  'comparisonSchema',
  'configSchema',
  'manifestSchema',
  'rulesFileSchema',
  'swapRecordSchema',
  'trialLineSchema',
  'warningSchema',
];

const TYPES = [
  'AdapterFailure',
  'AdapterFault',
  'AdapterStartFailure',
  'AdapterUse',
  'Case',
  'CaseProblem',
  'CasesFile',
  'Cell',
  'ComparedRunRecords',
  'Comparison',
  'ComparisonConfig',
  'ComparisonInput',
  'ComparisonWriteOptions',
  'Config',
  'CurrentCase',
  'Diagnostic',
  'Gate',
  'GateConfig',
  'Grade',
  'GradeSet',
  'GradeSetHeader',
  'InterruptListener',
  'Interrupts',
  'Lang',
  'LintFinding',
  'LintOptions',
  'LoadResult',
  'LockOwner',
  'LockRefusal',
  'LogParams',
  'Manifest',
  'OverBudget',
  'PerRole',
  'PlannedCase',
  'PlannedCell',
  'Project',
  'RandomSource',
  'RegradeInput',
  'RenderFailure',
  'ReviewSamplesAt',
  'Rule',
  'RulesFile',
  'RunEnd',
  'RunReadProblem',
  'RunRecords',
  'RunRecordsResult',
  'RunRequest',
  'RunResult',
  'RunStartFailure',
  'RunStatus',
  'SamplePlan',
  'SamplePlanInput',
  'Sha256',
  'SignalTarget',
  'StatsConfig',
  'StopReason',
  'SuffixSource',
  'SwapEnd',
  'SwapRecord',
  'SwapRequest',
  'SwapResult',
  'SwapStartFailure',
  'ToolVersion',
  'TrialLine',
  'Variant',
  'Warning',
  'WrittenComparison',
];

/**
 * Named types reachable from the exports that stay unexported: parts of `Project`, of the
 * adapter fault and log records inside a run's result, and of the trial log a resume reads.
 */
const INTERNAL = [
  'AdapterChange',
  'GroupedLevel',
  'JsonObject',
  'Level',
  'LogGroup',
  'LossCause',
  'PathSegment',
  'Position',
  'ResolvedPaths',
  'SourceFile',
  'StoppingFault',
  'TrialLogContents',
];

interface Entry {
  readonly checker: ts.TypeChecker;
  readonly exports: readonly ts.Symbol[];
}

let entry: Entry | undefined;

/** The program of `src/index.ts` under the project's compiler options, built once. */
function loadEntry(): Entry {
  if (entry !== undefined) {
    return entry;
  }
  const config = ts.getParsedCommandLineOfConfigFile(
    TSCONFIG,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
      },
    },
  );
  if (config === undefined) {
    throw new Error(`cannot read ${TSCONFIG}`);
  }
  const program = ts.createProgram([ENTRY], config.options);
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(ENTRY);
  const module = source === undefined ? undefined : checker.getSymbolAtLocation(source);
  if (module === undefined) {
    throw new Error(`no module symbol for ${ENTRY}`);
  }
  entry = { checker, exports: checker.getExportsOfModule(module) };
  return entry;
}

function targetOf(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

/** The names `src/index.ts` exports, split into those with a runtime value and type-only ones. */
function declaredExports(): { values: string[]; types: string[] } {
  const { checker, exports } = loadEntry();
  const values: string[] = [];
  const types: string[] = [];
  for (const exported of exports) {
    const target = targetOf(checker, exported);
    (target.flags & ts.SymbolFlags.Value ? values : types).push(exported.name);
  }
  return { values: values.sort(), types: types.sort() };
}

function isObjectType(type: ts.Type): type is ts.ObjectType {
  return (type.flags & ts.TypeFlags.Object) !== 0;
}

function isTypeReference(type: ts.ObjectType): type is ts.TypeReference {
  return (type.objectFlags & ts.ObjectFlags.Reference) !== 0;
}

/**
 * Interfaces, classes and type aliases declared in `src/` that a caller meets through the
 * exports: in parameters, results and their fields, also aliases of types zod infers. Of
 * library and zod types only the type arguments are entered.
 */
function reachableNamedTypes(): Set<string> {
  const { checker, exports } = loadEntry();
  const source = ENTRY.slice(0, ENTRY.lastIndexOf('/') + 1);
  const inSource = (symbol: ts.Symbol | undefined) =>
    symbol?.declarations?.some((declaration) =>
      declaration.getSourceFile().fileName.startsWith(source),
    ) ?? false;
  const named = new Set<string>();
  const seen = new Set<ts.Type>();
  const seenNamed = new Set<ts.Symbol>();
  // Aliases zod infers resolve to anonymous types, so their names are read from the type
  // annotations that refer to them.
  const visitNode = (node: ts.Node): void => {
    if (ts.isTypeReferenceNode(node)) {
      const referenced = checker.getSymbolAtLocation(node.typeName);
      if (referenced !== undefined) {
        visitNamed(targetOf(checker, referenced));
      }
    }
    ts.forEachChild(node, visitNode);
  };
  const visitAnnotation = (declaration: ts.Declaration | undefined): void => {
    if (
      declaration !== undefined &&
      (ts.isPropertySignature(declaration) ||
        ts.isPropertyDeclaration(declaration) ||
        ts.isParameter(declaration)) &&
      declaration.type !== undefined
    ) {
      visitNode(declaration.type);
    }
  };
  const visitNamed = (symbol: ts.Symbol): void => {
    const kinds = ts.SymbolFlags.TypeAlias | ts.SymbolFlags.Interface | ts.SymbolFlags.Class;
    if (seenNamed.has(symbol) || !inSource(symbol) || !(symbol.flags & kinds)) {
      return;
    }
    seenNamed.add(symbol);
    named.add(symbol.name);
    for (const declaration of symbol.declarations ?? []) {
      if (ts.isTypeAliasDeclaration(declaration)) {
        visitNode(declaration.type);
      }
    }
    visit(checker.getDeclaredTypeOfSymbol(symbol));
  };
  const visit = (type: ts.Type): void => {
    if (seen.has(type)) {
      return;
    }
    seen.add(type);
    if (type.aliasSymbol !== undefined && inSource(type.aliasSymbol)) {
      named.add(type.aliasSymbol.name);
    }
    type.aliasTypeArguments?.forEach(visit);
    if (type.isUnionOrIntersection()) {
      type.types.forEach(visit);
      return;
    }
    if (!isObjectType(type)) {
      return;
    }
    if (isTypeReference(type)) {
      checker.getTypeArguments(type).forEach(visit);
    }
    const symbol = type.getSymbol();
    const anonymous = symbol?.name === '__type' || symbol?.name === '__object';
    if (!anonymous && !inSource(symbol)) {
      return;
    }
    if (symbol !== undefined && symbol.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.Class)) {
      named.add(symbol.name);
    }
    for (const property of type.getProperties()) {
      const declaration = property.valueDeclaration ?? property.declarations?.[0];
      if (declaration !== undefined) {
        visitAnnotation(declaration);
        visit(checker.getTypeOfSymbolAtLocation(property, declaration));
      }
    }
    for (const signature of [...type.getCallSignatures(), ...type.getConstructSignatures()]) {
      signature.getParameters().forEach((parameter) => {
        visitAnnotation(parameter.valueDeclaration);
        visit(checker.getTypeOfSymbol(parameter));
      });
      const returnType = signature.getDeclaration().type;
      if (returnType !== undefined) {
        visitNode(returnType);
      }
      visit(signature.getReturnType());
    }
  };
  for (const exported of exports) {
    const target = targetOf(checker, exported);
    if (!(target.flags & ts.SymbolFlags.Value)) {
      visitNamed(target);
    } else if (!SCHEMAS.includes(exported.name)) {
      visit(checker.getTypeOfSymbol(target));
    }
  }
  return named;
}

describe('public library API', () => {
  it('001 FR-019 FR-032 exports config loading, run, swap, grade, compare, report writers and schemas', () => {
    expect(Object.keys(api).sort()).toEqual([...FUNCTIONS, ...SCHEMAS].sort());
    for (const name of FUNCTIONS) {
      expect(typeof Reflect.get(api, name), name).toBe('function');
    }
    for (const name of SCHEMAS) {
      const schema: unknown = Reflect.get(api, name);
      expect(schema, name).toHaveProperty('safeParse');
    }
  });

  it('001 FR-019 FR-032 names the types of the parameters, results and records of that API', () => {
    const declared = declaredExports();
    expect(declared.values).toEqual([...FUNCTIONS, ...SCHEMAS].sort());
    expect(declared.types).toEqual(TYPES);
  }, 30_000);

  it('001 FR-019 FR-032 exports every named type a caller meets, except the listed internal ones', () => {
    const { checker, exports } = loadEntry();
    const exported = new Set(exports.map((symbol) => targetOf(checker, symbol).name));
    const unexported = [...reachableNamedTypes()].filter((name) => !exported.has(name));
    expect(unexported.sort()).toEqual(INTERNAL);
  }, 30_000);
});
