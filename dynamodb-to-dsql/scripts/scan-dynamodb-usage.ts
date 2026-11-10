#!/usr/bin/env bun
// Static inventory of DynamoDB usage in a code base.
//
//   bun scan-dynamodb-usage.ts <dir> [--json] [--ignore a,b]
//
// Read-only. Regex based on purpose: it finds candidates, a human or agent confirms them.
// Output ids refer to references/pattern-catalog.md.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export type Operation =
  | "Get"
  | "Put"
  | "Update"
  | "Delete"
  | "Query"
  | "Scan"
  | "BatchGet"
  | "BatchWrite"
  | "TransactGet"
  | "TransactWrite"
  | "PartiQL";

export interface Call {
  readonly file: string;
  readonly line: number;
  readonly operation: Operation;
  readonly style: "command" | "method";
  readonly fields: ReadonlyArray<string>;
  readonly expressions: Readonly<Record<string, string>>;
  readonly keyAttributes: ReadonlyArray<string>;
  readonly flags: ReadonlyArray<string>;
  readonly patterns: ReadonlyArray<string>;
  readonly transactItems: number;
}

export interface Signal {
  readonly id: string;
  readonly label: string;
  readonly patterns: ReadonlyArray<string>;
  readonly hits: ReadonlyArray<{ readonly file: string; readonly line: number; readonly text: string }>;
}

export interface Report {
  readonly files: number;
  readonly dynamoFiles: ReadonlyArray<string>;
  readonly libraries: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly calls: ReadonlyArray<Call>;
  readonly signals: ReadonlyArray<Signal>;
  readonly keyAttributes: Readonly<Record<string, number>>;
  readonly wrapperImports: Readonly<Record<string, ReadonlyArray<string>>>;
}

export interface SourceFile {
  readonly path: string;
  readonly text: string;
}

const libraryPatterns: ReadonlyArray<readonly [string, RegExp]> = [
  ["@aws-sdk/client-dynamodb", /["']@aws-sdk\/client-dynamodb["']/],
  ["@aws-sdk/lib-dynamodb", /["']@aws-sdk\/lib-dynamodb["']/],
  ["@aws-sdk/util-dynamodb", /["']@aws-sdk\/util-dynamodb["']/],
  ["aws-sdk (v2)", /["']aws-sdk["']|["']aws-sdk\/clients\/dynamodb["']/],
  ["dynamodb-toolbox", /["']dynamodb-toolbox/],
  ["electrodb", /["']electrodb["']/],
  ["dynamoose", /["']dynamoose["']/],
  ["@beesolve/dynamo-helpers", /["']@beesolve\/dynamo-helpers["']/],
  ["dynamodb-onetable", /["']dynamodb-onetable["']/],
];

const commandNames: Readonly<Record<string, Operation>> = {
  GetCommand: "Get",
  GetItemCommand: "Get",
  PutCommand: "Put",
  PutItemCommand: "Put",
  UpdateCommand: "Update",
  UpdateItemCommand: "Update",
  DeleteCommand: "Delete",
  DeleteItemCommand: "Delete",
  QueryCommand: "Query",
  ScanCommand: "Scan",
  BatchGetCommand: "BatchGet",
  BatchGetItemCommand: "BatchGet",
  BatchWriteCommand: "BatchWrite",
  BatchWriteItemCommand: "BatchWrite",
  TransactGetCommand: "TransactGet",
  TransactGetItemsCommand: "TransactGet",
  TransactWriteCommand: "TransactWrite",
  TransactWriteItemsCommand: "TransactWrite",
  ExecuteStatementCommand: "PartiQL",
  BatchExecuteStatementCommand: "PartiQL",
  ExecuteTransactionCommand: "PartiQL",
};

const methodNames: Readonly<Record<string, Operation>> = {
  get: "Get",
  getItem: "Get",
  put: "Put",
  putItem: "Put",
  update: "Update",
  updateItem: "Update",
  delete: "Delete",
  deleteItem: "Delete",
  query: "Query",
  scan: "Scan",
  batchGet: "BatchGet",
  batchGetItem: "BatchGet",
  batchWrite: "BatchWrite",
  batchWriteItem: "BatchWrite",
  transactGet: "TransactGet",
  transactGetItems: "TransactGet",
  transactWrite: "TransactWrite",
  transactWriteItems: "TransactWrite",
};

const operationPatterns: Readonly<Record<Operation, ReadonlyArray<string>>> = {
  Get: ["P11"],
  Put: ["P20"],
  Update: ["P22"],
  Delete: ["P24"],
  Query: ["P13"],
  Scan: ["P14"],
  BatchGet: ["P12"],
  BatchWrite: ["P26"],
  TransactGet: ["P12"],
  TransactWrite: ["P25"],
  PartiQL: ["P13"],
};

const expressionFields = [
  "KeyConditionExpression",
  "FilterExpression",
  "ConditionExpression",
  "UpdateExpression",
  "ProjectionExpression",
] as const;

const plainFields = [
  "TableName",
  "IndexName",
  "ConsistentRead",
  "Limit",
  "ExclusiveStartKey",
  "ScanIndexForward",
  "ReturnValues",
  "ReturnValuesOnConditionCheckFailure",
  "ClientRequestToken",
  "Select",
  "RequestItems",
  "TransactItems",
  "Segment",
  "TotalSegments",
] as const;

const signalDefinitions: ReadonlyArray<{
  readonly id: string;
  readonly label: string;
  readonly patterns: ReadonlyArray<string>;
  readonly regex: RegExp;
}> = [
  {
    id: "composite-key",
    label: "Composite key encoded in a string (template with `#`, or split on `#`)",
    patterns: ["P02"],
    regex: /`[^`\n]*(\$\{[^}]*\}[#|][^`\n]*|[#|]\$\{[^}]*\})[^`\n]*`|\.split\(\s*["'][#|]["']\s*\)|["'][A-Za-z_]+#["']/,
  },
  {
    id: "sets",
    label: "DynamoDB sets (new Set, createSet, NumberSet/StringSet, ADD/DELETE on a set)",
    patterns: ["P05"],
    regex: /\bnew Set\(|\bcreateSet\b|\bStringSet\b|\bNumberSet\b|\bSS\s*:|\bNS\s*:/,
  },
  {
    id: "ttl",
    label: "TTL style attribute (expiresAt, ttl, TimeToLive)",
    patterns: ["P29"],
    regex: /\b(expiresAt|expireAt|expires_at|ttl|TimeToLive|timeToLiveAttribute)\b/,
  },
  {
    id: "counter-name",
    label: "Counter-like attribute names (xxxCount, count)",
    patterns: ["P07"],
    regex: /\b[a-z]\w*Count\b/,
  },
  {
    id: "version",
    label: "Optimistic locking attribute (version, revision, etag)",
    patterns: ["P27"],
    regex: /\b(version|revision|etag)\b\s*[:=]/i,
  },
  {
    id: "idempotency",
    label: "Idempotency token on transactions",
    patterns: ["P28"],
    regex: /\bClientRequestToken\b/,
  },
  {
    id: "stream",
    label: "DynamoDB Streams consumer or stream configuration",
    patterns: ["P30"],
    regex: /\bDynamoDBStreamEvent\b|\bDynamoDBStreamHandler\b|\bDynamoDBRecord\b|\bStreamViewType\b|\bstreamArn\b|\bStreamSpecification\b/,
  },
  {
    id: "marshalling",
    label: "Manual attribute-value marshalling (marshall, unmarshall, { S: ... })",
    patterns: ["P37", "P38"],
    regex: /\bmarshall\(|\bunmarshall\(|\bconvertToAttr\b|\{\s*(S|N|BOOL|L|M)\s*:/,
  },
  {
    id: "error-mapping",
    label: "DynamoDB error handling (ConditionalCheckFailed, TransactionCanceled, CancellationReasons, Throttling)",
    patterns: ["P31"],
    regex: /ConditionalCheckFailed|TransactionCanceled|CancellationReasons|ProvisionedThroughputExceeded|ThrottlingException|TransactionConflict/,
  },
  {
    id: "read-validation",
    label: "Schema validation of items after read (parse/safeParse near data access)",
    patterns: ["P35"],
    regex: /\b(safeParse|parseOne|v\.parse|z\.parse|\.parse\()/,
  },
  {
    id: "chunking",
    label: "Hand written chunking or unprocessed-items loops",
    patterns: ["P12", "P26"],
    regex: /UnprocessedKeys|UnprocessedItems|splitArrayToChunks|\bchunk(s|ed)?\b/i,
  },
  {
    id: "iac-table",
    label: "Infrastructure: DynamoDB table definition",
    patterns: ["P01", "P03"],
    regex: /dynamodb\.(Table|TableV2)\b|\bnew (Table|TableV2)\(|AWS::DynamoDB::(Table|GlobalTable)|aws_dynamodb_table|\baws-dynamodb\b/,
  },
  {
    id: "iac-gsi",
    label: "Infrastructure: secondary indexes",
    patterns: ["P03"],
    regex: /addGlobalSecondaryIndex|addLocalSecondaryIndex|GlobalSecondaryIndex|LocalSecondaryIndex|globalSecondaryIndexes|localSecondaryIndexes/,
  },
  {
    id: "iac-features",
    label: "Infrastructure: PITR, replicas, backup, deletion protection, billing mode",
    patterns: ["P29", "P40"],
    regex: /pointInTimeRecovery|replicationRegions|ReplicaSpecification|deletionProtection|billingMode|BillingMode|PAY_PER_REQUEST/,
  },
];

const ignoredDirectories = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".svelte-kit",
  ".next",
  "cdk.out",
  "coverage",
  ".turbo",
  ".output",
]);
const sourceExtension = /\.(ts|tsx|js|jsx|mjs|cjs|svelte|vue|py)$/;

export function scanSources(props: { readonly files: ReadonlyArray<SourceFile> }): Report {
  const libraries: Record<string, Array<string>> = {};
  const wrapperImports: Record<string, Array<string>> = {};
  const dynamoFiles: Array<string> = [];
  const calls: Array<Call> = [];
  const keyAttributes: Record<string, number> = {};
  const signalHits = new Map<string, Array<{ file: string; line: number; text: string }>>();

  for (const file of props.files) {
    const usedLibraries = libraryPatterns.filter(([, regex]) => regex.test(file.text));
    const isInfrastructure = signalDefinitions
      .filter((definition) => definition.id.startsWith("iac-"))
      .some((definition) => definition.regex.test(file.text));
    if (usedLibraries.length === 0 && !isInfrastructure) continue;

    dynamoFiles.push(file.path);
    for (const [name] of usedLibraries) (libraries[name] ??= []).push(file.path);
    collectWrapperImports({ file, wrapperImports });

    if (usedLibraries.length > 0) {
      for (const call of findCalls(file)) {
        calls.push(call);
        for (const attribute of call.keyAttributes)
          keyAttributes[attribute] = (keyAttributes[attribute] ?? 0) + 1;
      }
    }

    const lines = file.text.split("\n");
    for (const definition of signalDefinitions) {
      const isInfrastructureSignal = definition.id.startsWith("iac-");
      if (!isInfrastructureSignal && usedLibraries.length === 0) continue;
      lines.forEach((text, index) => {
        if (isNoise(text) || !definition.regex.test(text)) return;
        const hits = signalHits.get(definition.id) ?? [];
        hits.push({ file: file.path, line: index + 1, text: text.trim().slice(0, 160) });
        signalHits.set(definition.id, hits);
      });
    }
  }

  const signals = signalDefinitions.flatMap((definition): Array<Signal> => {
    const hits = signalHits.get(definition.id);
    if (hits == null) return [];
    return [{ id: definition.id, label: definition.label, patterns: definition.patterns, hits }];
  });

  return {
    files: props.files.length,
    dynamoFiles,
    libraries,
    calls,
    signals,
    keyAttributes,
    wrapperImports,
  };
}

function isNoise(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("/*") ||
    /console\.|\blog\(|sortBy\(/.test(trimmed)
  );
}

function collectWrapperImports(props: {
  readonly file: SourceFile;
  readonly wrapperImports: Record<string, Array<string>>;
}): void {
  const pattern = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["']@beesolve\/dynamo-helpers["']/g;
  for (const match of props.file.text.matchAll(pattern)) {
    for (const rawName of (match[1] ?? "").split(",")) {
      const name = rawName.trim().split(/\s+as\s+/)[0]?.replace(/^type\s+/, "");
      if (name == null || name === "") continue;
      (props.wrapperImports[name] ??= []).push(props.file.path);
    }
  }
}

function findCalls(file: SourceFile): Array<Call> {
  const calls: Array<Call> = [];
  const commandRegex = /new\s+([A-Za-z]+Command)\s*\(/g;
  for (const match of file.text.matchAll(commandRegex)) {
    const operation = commandNames[match[1] ?? ""];
    if (operation == null || match.index == null) continue;
    const openIndex = match.index + match[0].length - 1;
    calls.push(buildCall({ file, operation, style: "command", openIndex, index: match.index }));
  }

  const methodRegex = /\.\s*(get|getItem|put|putItem|update|updateItem|delete|deleteItem|query|scan|batchGet|batchGetItem|batchWrite|batchWriteItem|transactGet|transactGetItems|transactWrite|transactWriteItems)\s*\(/g;
  for (const match of file.text.matchAll(methodRegex)) {
    const operation = methodNames[match[1] ?? ""];
    if (operation == null || match.index == null) continue;
    const openIndex = match.index + match[0].length - 1;
    const call = buildCall({ file, operation, style: "method", openIndex, index: match.index });
    const hasTarget = ["TableName", "RequestItems", "TransactItems"].some((field) =>
      call.fields.includes(field),
    );
    if (!hasTarget) continue;
    calls.push(call);
  }
  return calls.sort((left, right) => left.line - right.line);
}

function buildCall(props: {
  readonly file: SourceFile;
  readonly operation: Operation;
  readonly style: "command" | "method";
  readonly openIndex: number;
  readonly index: number;
}): Call {
  const args = extractBalanced({ text: props.file.text, openIndex: props.openIndex });
  const fields = [...plainFields, ...expressionFields].filter((field) =>
    new RegExp(`\\b${field}\\b`).test(args),
  );
  const expressions: Record<string, string> = {};
  for (const field of expressionFields) {
    const value = readLiteralField({ args, field });
    if (value != null) expressions[field] = value;
  }
  const transactItems = props.operation === "TransactWrite" || props.operation === "TransactGet"
    ? (args.match(/\b(Put|Update|Delete|ConditionCheck|Get)\s*:\s*\{/g) ?? []).length
    : 0;
  const flags = describeFlags({ operation: props.operation, args, fields, expressions });
  const keyAttributes = readKeyAttributes(args);
  const patterns = new Set<string>(operationPatterns[props.operation]);
  for (const flag of flags) for (const pattern of flagPatterns[flag] ?? []) patterns.add(pattern);

  return {
    file: props.file.path,
    line: props.file.text.slice(0, props.index).split("\n").length,
    operation: props.operation,
    style: props.style,
    fields,
    expressions,
    keyAttributes,
    flags,
    patterns: [...patterns].sort(),
    transactItems,
  };
}

const flagPatterns: Readonly<Record<string, ReadonlyArray<string>>> = {
  "reverse-index": ["P03"],
  "prefix-query": ["P09"],
  "filter-expression": ["P13"],
  "condition:not-exists": ["P21"],
  "condition:exists": ["P22"],
  "condition:key-equality": ["P22"],
  "condition:other": ["P24", "P27"],
  "update:templated": ["P23"],
  "update:ADD": ["P05", "P07", "P23"],
  "update:DELETE": ["P05", "P23"],
  "update:arithmetic": ["P07", "P23"],
  "update:if_not_exists": ["P23"],
  "update:list_append": ["P06", "P23"],
  "update:REMOVE": ["P23"],
  "pagination": ["P15"],
  "projection": ["P16"],
  "consistent-read": ["P17"],
  "client-request-token": ["P28"],
  "transaction:condition-check": ["P25"],
  "sort-order": ["P33"],
  "unconditional-put": ["P20"],
};

function describeFlags(props: {
  readonly operation: Operation;
  readonly args: string;
  readonly fields: ReadonlyArray<string>;
  readonly expressions: Readonly<Record<string, string>>;
}): Array<string> {
  const flags: Array<string> = [];
  const { args, fields, expressions } = props;
  if (fields.includes("IndexName")) flags.push("reverse-index");
  if (fields.includes("FilterExpression")) flags.push("filter-expression");
  if (fields.includes("ProjectionExpression")) flags.push("projection");
  if (fields.includes("ConsistentRead")) flags.push("consistent-read");
  if (fields.includes("ExclusiveStartKey") || /LastEvaluatedKey/.test(args)) flags.push("pagination");
  if (fields.includes("ScanIndexForward")) flags.push("sort-order");
  if (fields.includes("ClientRequestToken")) flags.push("client-request-token");
  if (/\bConditionCheck\s*:/.test(args)) flags.push("transaction:condition-check");

  const keyCondition = expressions.KeyConditionExpression;
  if (keyCondition != null && /begins_with|BETWEEN/i.test(keyCondition)) flags.push("prefix-query");

  const condition = expressions.ConditionExpression;
  if (condition != null) {
    if (/attribute_not_exists/.test(condition)) flags.push("condition:not-exists");
    if (/attribute_exists/.test(condition)) flags.push("condition:exists");
    const keyEquality = /^(#?\w+ = :\w+)( AND #?\w+ = :\w+)*$/;
    const parts = condition.split(" || ");
    if (parts.every((part) => keyEquality.test(part))) flags.push("condition:key-equality");
    else if (!/attribute_(not_)?exists/.test(condition)) flags.push("condition:other");
  } else if (props.operation === "Put" && fields.includes("TableName") && !/ConditionExpression/.test(args)) {
    flags.push("unconditional-put");
  }

  const update = expressions.UpdateExpression;
  if (update != null) {
    if (/\$\{/.test(update)) flags.push("update:templated");
    if (/\bADD\b/.test(update)) flags.push("update:ADD");
    if (/\bDELETE\b/.test(update)) flags.push("update:DELETE");
    if (/\bREMOVE\b/.test(update)) flags.push("update:REMOVE");
    if (/if_not_exists/.test(update)) flags.push("update:if_not_exists");
    if (/list_append/.test(update)) flags.push("update:list_append");
    if (/[#\w.]+\s*[+-]\s*[:#]/.test(update)) flags.push("update:arithmetic");
  }
  return flags;
}

function readLiteralField(props: { readonly args: string; readonly field: string }): string | undefined {
  const values: Array<string> = [];
  const regex = new RegExp(`\\b${props.field}\\b\\s*:\\s*(["'\`])`, "g");
  for (const match of props.args.matchAll(regex)) {
    if (match.index == null) continue;
    const quote = match[1] ?? '"';
    const start = match.index + match[0].length;
    let end = start;
    while (end < props.args.length) {
      const character = props.args[end];
      if (character === "\\") {
        end += 2;
        continue;
      }
      if (character === quote) break;
      end += 1;
    }
    values.push(props.args.slice(start, end).replace(/\s+/g, " ").trim());
  }
  return values.length === 0 ? undefined : values.join(" || ");
}

function readKeyAttributes(args: string): Array<string> {
  const names = new Set<string>();
  const keyRegex = /\b(Key|ExclusiveStartKey)\s*:\s*\{/g;
  for (const match of args.matchAll(keyRegex)) {
    if (match.index == null) continue;
    const block = extractBalanced({ text: args, openIndex: match.index + match[0].length - 1, open: "{", close: "}" });
    for (const attribute of block.matchAll(/(?:^|[,{])\s*([A-Za-z_]\w*)\s*(?::|(?=[,}]|$))/g)) {
      if (attribute[1] != null) names.add(attribute[1]);
    }
  }
  return [...names];
}

export function extractBalanced(props: {
  readonly text: string;
  readonly openIndex: number;
  readonly open?: string;
  readonly close?: string;
}): string {
  const open = props.open ?? "(";
  const close = props.close ?? ")";
  let depth = 0;
  let quote: string | undefined;
  for (let index = props.openIndex; index < props.text.length; index += 1) {
    const character = props.text[index];
    if (quote != null) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") quote = character;
    else if (character === open) depth += 1;
    else if (character === close) {
      depth -= 1;
      if (depth === 0) return props.text.slice(props.openIndex + 1, index);
    }
  }
  return props.text.slice(props.openIndex + 1);
}

export function formatReport(report: Report): string {
  const lines: Array<string> = [];
  lines.push("# DynamoDB usage inventory", "");
  lines.push(`Scanned ${report.files} source files, ${report.dynamoFiles.length} touch DynamoDB.`, "");

  lines.push("## Libraries", "");
  const libraryNames = Object.keys(report.libraries);
  if (libraryNames.length === 0) lines.push("None detected.");
  for (const name of libraryNames) lines.push(`- ${name}: ${report.libraries[name]?.length ?? 0} file(s)`);
  lines.push("");

  const wrapperNames = Object.keys(report.wrapperImports);
  if (wrapperNames.length > 0) {
    lines.push("## Helper wrappers imported (read their source, they hide Dynamo calls)", "");
    for (const name of wrapperNames)
      lines.push(`- \`${name}\` used in ${report.wrapperImports[name]?.length ?? 0} file(s)`);
    lines.push("");
  }

  lines.push("## Operations", "");
  const byOperation = new Map<Operation, number>();
  for (const call of report.calls) byOperation.set(call.operation, (byOperation.get(call.operation) ?? 0) + 1);
  for (const [operation, count] of [...byOperation].sort()) lines.push(`- ${operation}: ${count}`);
  lines.push("");

  lines.push("## Key attributes seen in Key blocks", "");
  const keys = Object.entries(report.keyAttributes).sort((left, right) => right[1] - left[1]);
  if (keys.length === 0) lines.push("None found (keys may be built in helpers).");
  for (const [name, count] of keys) lines.push(`- \`${name}\` x${count}`);
  lines.push("");

  lines.push("## Calls", "");
  lines.push("| Location | Operation | Fields | Flags | Patterns |", "|---|---|---|---|---|");
  for (const call of report.calls) {
    const transact = call.transactItems > 0 ? ` (${call.transactItems} items)` : "";
    lines.push(
      `| ${call.file}:${call.line} | ${call.operation}${transact} | ${call.fields.join(", ")} | ${call.flags.join(", ")} | ${call.patterns.join(", ")} |`,
    );
  }
  lines.push("");

  const withExpressions = report.calls.filter((call) => Object.keys(call.expressions).length > 0);
  if (withExpressions.length > 0) {
    lines.push("## Literal expressions", "");
    for (const call of withExpressions) {
      lines.push(`- ${call.file}:${call.line} ${call.operation}`);
      for (const [field, value] of Object.entries(call.expressions)) lines.push(`  - ${field}: \`${value}\``);
    }
    lines.push("");
  }

  lines.push("## Signals", "");
  for (const signal of report.signals) {
    lines.push(`### ${signal.label} (${signal.patterns.join(", ")})`, "");
    for (const hit of signal.hits.slice(0, 15)) lines.push(`- ${hit.file}:${hit.line} \`${hit.text}\``);
    if (signal.hits.length > 15) lines.push(`- ... ${signal.hits.length - 15} more`);
    lines.push("");
  }
  return lines.join("\n");
}

function collectFiles(props: { readonly root: string; readonly ignore: ReadonlySet<string> }): Array<SourceFile> {
  const files: Array<SourceFile> = [];
  const walk = (directory: string) => {
    for (const name of readdirSync(directory)) {
      if (ignoredDirectories.has(name) || props.ignore.has(name)) continue;
      const path = join(directory, name);
      const stats = statSync(path);
      if (stats.isDirectory()) walk(path);
      else if (sourceExtension.test(name) && stats.size < 1_000_000)
        files.push({ path: relative(props.root, path), text: readFileSync(path, "utf8") });
    }
  };
  walk(props.root);
  return files;
}

if (import.meta.main) {
  const arguments_ = process.argv.slice(2);
  const root = arguments_.find((argument) => !argument.startsWith("--"));
  if (root == null) {
    console.error("usage: bun scan-dynamodb-usage.ts <dir> [--json] [--ignore a,b]");
    process.exit(2);
  }
  const ignoreIndex = arguments_.indexOf("--ignore");
  const ignore = new Set((ignoreIndex >= 0 ? (arguments_[ignoreIndex + 1] ?? "") : "").split(",").filter(Boolean));
  const report = scanSources({ files: collectFiles({ root, ignore }) });
  console.log(arguments_.includes("--json") ? JSON.stringify(report, null, 2) : formatReport(report));
}
