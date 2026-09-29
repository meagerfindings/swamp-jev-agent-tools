/**
 * Agent-facing, repository-scoped Jev questions backed by @swamp/typesafe-ai.
 * @module
 */
import { z } from "npm:zod@4";
import { isAbsolute, join, relative } from "node:path";

const MAX_FILES = 20;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 192 * 1024;
const MAX_WALK_ENTRIES = 10_000;
const MAX_WALK_DEPTH = 12;
const MAX_QUESTIONS = 32;
const MAX_SELECTORS = 100;
const MAX_REQUEST_BYTES = 240 * 1024;

const NoulQuestionSchema = z.object({
  type: z.literal("noul"),
  instructions: z.string().min(1).max(2_000),
});
const ChoiceQuestionSchema = z.object({
  type: z.literal("choice"),
  instructions: z.string().min(1).max(2_000),
  criteria: z.record(z.string(), z.string().min(1).max(1_000)),
});
const ScoreQuestionSchema = z.object({
  type: z.literal("score"),
  instructions: z.string().min(1).max(2_000),
  criteria: z.array(z.string().min(1).max(1_000)),
});
const QuestionSchema = z.discriminatedUnion("type", [
  NoulQuestionSchema,
  ChoiceQuestionSchema,
  ScoreQuestionSchema,
]);
const QuestionsSchema = z.record(
  z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
  QuestionSchema,
);

const GlobalArgsSchema = z.object({
  jevModel: z.string().min(1),
  repositoryRoot: z.string().min(1).describe(
    "Explicit repository root used to scope file reads.",
  ),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const StateSchema = z.union([
  z.string(),
  z.record(z.string(), z.unknown()),
  z.array(z.unknown()),
]);
const PrepareArgsSchema = z.object({
  mode: z.enum(["combined", "per-file"]),
  state: StateSchema,
  questions: QuestionsSchema,
  paths: z.array(z.string()).optional(),
  globs: z.array(z.string()).optional(),
});
const CollectArgsSchema = z.object({
  preparationName: z.string().min(1),
  sourceModel: z.string().min(1),
});
const RequestSchema = z.object({
  name: z.string(),
  path: z.string().optional(),
  state: StateSchema,
  questions: QuestionsSchema,
});
const PreparedSchema = z.object({
  mode: z.enum(["combined", "per-file"]),
  requests: z.array(RequestSchema).min(1),
  batchName: z.string().optional(),
  files: z.array(z.string()),
  skipped: z.array(z.object({ path: z.string(), reason: z.string() })),
  truncated: z.boolean(),
});

const UsageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
});
const AnswerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"), noul: z.number().min(0).max(1) }),
  z.object({
    type: z.literal("choice"),
    choice: z.string(),
    confidence: z.number().min(0).max(1),
    probabilities: z.record(z.string(), z.number().min(0).max(1)),
  }),
  z.object({
    type: z.literal("score"),
    score: z.number().finite(),
    legend: z.record(z.string(), z.union([z.string(), z.null()])),
    confidence: z.number().min(0).max(1),
    probabilities: z.record(z.string(), z.number().min(0).max(1)),
  }),
]);
const EvaluationSchema = z.object({
  answers: z.record(z.string(), AnswerSchema),
  model: z.string(),
  usage: UsageSchema,
  evaluatedAt: z.string(),
});
const BatchSchema = z.object({
  results: z.array(z.object({
    id: z.string(),
    answers: z.record(z.string(), AnswerSchema),
  })),
  failures: z.array(z.object({ id: z.string(), reason: z.string() })),
  model: z.string(),
  totalInputTokens: z.number().int().nonnegative(),
  totalOutputTokens: z.number().int().nonnegative(),
  evaluatedAt: z.string(),
});
const SkippedSchema = z.object({ path: z.string(), reason: z.string() });
const ResultSchema = z.object({
  files: z.array(z.string()),
  truncated: z.boolean().describe(
    "True when file-count, size, or traversal-depth limits omitted candidate files.",
  ),
  answers: z.record(z.string(), AnswerSchema).optional(),
  model: z.string().optional(),
  usage: UsageSchema.optional(),
  evaluatedAt: z.string().optional(),
  evaluations: z.array(z.object({
    path: z.string(),
    answers: z.record(z.string(), AnswerSchema),
    model: z.string(),
    usage: UsageSchema.optional(),
    evaluatedAt: z.string(),
  })).optional(),
  skipped: z.array(SkippedSchema),
});

type Questions = z.infer<typeof QuestionsSchema>;
type Evaluation = z.infer<typeof EvaluationSchema>;
type SkippedFile = z.infer<typeof SkippedSchema>;
type DataRecord = {
  name: string;
  attributes?: unknown;
};
type MethodContext = {
  globalArgs: GlobalArgs;
  logger: {
    info: (message: string, properties?: Record<string, unknown>) => void;
  };
  writeResource: (
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<unknown>;
  readModelData?: (
    definition: string,
    spec: string,
  ) => Promise<DataRecord[] | undefined>;
};

function validateQuestions(raw: unknown): Questions {
  const questions = QuestionsSchema.parse(raw);
  const entries = Object.entries(questions);
  if (entries.length === 0 || entries.length > MAX_QUESTIONS) {
    throw new Error(
      `questions must contain between 1 and ${MAX_QUESTIONS} entries`,
    );
  }
  for (const [name, question] of entries) {
    if (question.type === "choice") {
      const count = Object.keys(question.criteria).length;
      if (count < 2 || count > 255) {
        throw new Error(
          `Choice question "${name}" must have 2 to 255 criteria`,
        );
      }
    } else if (
      question.type === "score" &&
      (question.criteria.length < 2 || question.criteria.length > 10)
    ) {
      throw new Error(`Score question "${name}" must have 2 to 10 criteria`);
    }
  }
  return questions;
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" ||
    (rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\") &&
      !isAbsolute(rel));
}

function isExcludedRelativePath(path: string): boolean {
  const segments = path.split(/[\\/]/);
  return segments.some((segment) => {
    const lower = segment.toLowerCase();
    return segment.startsWith(".") || lower === "env" || lower === "secrets" ||
      lower === "credentials" || lower === "node_modules" ||
      /(^|[._-])(secret|token|credential)([._-]|$)/i.test(segment) ||
      /\.(pem|key|p12|pfx|keystore)$/i.test(segment);
  });
}

function globToRegExp(glob: string): RegExp {
  let result = "^";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") {
        i++;
        result += "(?:.*/)?";
      } else result += ".*";
    } else if (char === "*") result += "[^/]*";
    else if (char === "?") result += "[^/]";
    else result += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return new RegExp(`${result}$`);
}

function validateRelativeSelector(path: string): string | null {
  if (
    !path || path.includes("\0") || isAbsolute(path) ||
    /^[A-Za-z]:[\\/]/.test(path)
  ) {
    return "not a relative repository path";
  }
  const normalized = path.replaceAll("\\", "/");
  if (normalized.split("/").includes("..")) {
    return "parent traversal is not allowed";
  }
  if (isExcludedRelativePath(normalized)) {
    return "excluded hidden or sensitive path";
  }
  return null;
}

async function walkFiles(
  root: string,
): Promise<{ paths: string[]; skipped: SkippedFile[] }> {
  const paths: string[] = [];
  const skipped: SkippedFile[] = [];
  let visited = 0;
  async function visit(
    directory: string,
    prefix: string,
    depth: number,
  ): Promise<void> {
    if (depth > MAX_WALK_DEPTH) {
      skipped.push({
        path: prefix || ".",
        reason: "directory recursion limit reached",
      });
      return;
    }
    for await (const entry of Deno.readDir(directory)) {
      visited++;
      if (visited > MAX_WALK_ENTRIES) {
        throw new Error("repository walk exceeded the fixed entry limit");
      }
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (isExcludedRelativePath(rel)) continue;
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory) await visit(fullPath, rel, depth + 1);
      else if (entry.isFile || entry.isSymlink) paths.push(rel);
    }
  }
  await visit(root, "", 0);
  return { paths, skipped };
}

async function selectFiles(
  rootPath: string,
  selectors: { paths?: string[]; globs?: string[] },
): Promise<
  {
    files: Array<{ path: string; text: string }>;
    skipped: SkippedFile[];
    truncated: boolean;
  }
> {
  if (
    (selectors.paths?.length ?? 0) + (selectors.globs?.length ?? 0) >
      MAX_SELECTORS
  ) {
    throw new Error(
      `at most ${MAX_SELECTORS} paths and globs may be requested`,
    );
  }
  if (!isAbsolute(rootPath)) {
    throw new Error("repositoryRoot must be an explicit absolute path");
  }
  const root = await Deno.realPath(rootPath);
  const skipped: SkippedFile[] = [];
  const requested: string[] = [];
  for (const path of selectors.paths ?? []) {
    const reason = validateRelativeSelector(path);
    if (reason) skipped.push({ path, reason });
    else requested.push(path.replaceAll("\\", "/"));
  }

  const globs: RegExp[] = [];
  for (const pattern of selectors.globs ?? []) {
    const reason = validateRelativeSelector(pattern);
    if (reason) skipped.push({ path: pattern, reason });
    else globs.push(globToRegExp(pattern.replaceAll("\\", "/")));
  }
  if (globs.length) {
    const walked = await walkFiles(root);
    skipped.push(...walked.skipped);
    for (const pattern of globs) {
      for (const candidate of walked.paths) {
        if (pattern.test(candidate)) requested.push(candidate);
      }
    }
  }

  const unique = [...new Set(requested)].sort();
  const files: Array<{ path: string; text: string }> = [];
  let totalBytes = 0;
  for (const path of unique) {
    if (files.length >= MAX_FILES) {
      skipped.push({ path, reason: "file count limit exceeded" });
      continue;
    }
    try {
      const candidate = await Deno.realPath(join(root, path));
      if (!isWithin(root, candidate)) {
        skipped.push({ path, reason: "resolved path escapes repository root" });
        continue;
      }
      const canonicalRelativePath = relative(root, candidate).replaceAll(
        "\\",
        "/",
      );
      if (isExcludedRelativePath(canonicalRelativePath)) {
        skipped.push({ path, reason: "resolved path is hidden or sensitive" });
        continue;
      }
      const info = await Deno.stat(candidate);
      if (!info.isFile) {
        skipped.push({ path, reason: "not a regular file" });
        continue;
      }
      if (info.size > MAX_FILE_BYTES) {
        skipped.push({ path, reason: "file size limit exceeded" });
        continue;
      }
      if (totalBytes + info.size > MAX_TOTAL_BYTES) {
        skipped.push({ path, reason: "total file size limit exceeded" });
        continue;
      }
      const bytes = await Deno.readFile(candidate);
      if (bytes.byteLength > MAX_FILE_BYTES) {
        skipped.push({ path, reason: "file size limit exceeded" });
        continue;
      }
      if (totalBytes + bytes.byteLength > MAX_TOTAL_BYTES) {
        skipped.push({ path, reason: "total file size limit exceeded" });
        continue;
      }
      if (bytes.includes(0)) {
        skipped.push({ path, reason: "binary file" });
        continue;
      }
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        skipped.push({ path, reason: "not valid UTF-8 text" });
        continue;
      }
      files.push({ path, text });
      totalBytes += bytes.byteLength;
    } catch (error) {
      skipped.push({
        path,
        reason: error instanceof Deno.errors.NotFound
          ? "file not found"
          : "file could not be read safely",
      });
    }
  }
  return {
    files,
    skipped,
    truncated: skipped.some(({ reason }) =>
      reason === "file count limit exceeded" ||
      reason === "file size limit exceeded" ||
      reason === "total file size limit exceeded" ||
      reason === "directory recursion limit reached"
    ),
  };
}

function validateAnswers(
  raw: unknown,
  questions: Questions,
): Evaluation["answers"] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Jev evaluation has malformed answers");
  }
  const answers = raw as Record<string, unknown>;
  const expectedKeys = Object.keys(questions).sort();
  if (Object.keys(answers).sort().join("\0") !== expectedKeys.join("\0")) {
    throw new Error(
      "Jev evaluation answer keys do not match the submitted questions",
    );
  }
  const clean: Record<string, z.infer<typeof AnswerSchema>> = {};
  for (const [name, question] of Object.entries(questions)) {
    const answer = AnswerSchema.parse(answers[name]);
    if (answer.type !== question.type) {
      throw new Error(`Jev returned the wrong answer type for "${name}"`);
    }
    if (answer.type === "choice" && question.type === "choice") {
      if (!(answer.choice in question.criteria)) {
        throw new Error(`Jev returned an unknown Choice value for "${name}"`);
      }
      const probabilityKeys = Object.keys(answer.probabilities).sort();
      if (
        probabilityKeys.join("\0") !==
          Object.keys(question.criteria).sort().join("\0")
      ) {
        throw new Error(`Jev returned malformed probabilities for "${name}"`);
      }
    } else if (answer.type === "score" && question.type === "score") {
      if (answer.score < 0 || answer.score > question.criteria.length - 1) {
        throw new Error(
          `Jev returned a Score outside the criteria range for "${name}"`,
        );
      }
      const probabilityKeys = Object.keys(answer.probabilities).sort();
      const expectedKeys = question.criteria.map((_, index) => String(index))
        .sort();
      if (probabilityKeys.join("\0") !== expectedKeys.join("\0")) {
        throw new Error(`Jev returned malformed probabilities for "${name}"`);
      }
    }
    clean[name] = answer;
  }
  return clean;
}

function validateRequestBudget(request: z.infer<typeof RequestSchema>): void {
  if (
    new TextEncoder().encode(JSON.stringify({
      state: request.state,
      questions: request.questions,
    })).length > MAX_REQUEST_BYTES
  ) throw new Error(`Jev request exceeds the ${MAX_REQUEST_BYTES}-byte budget`);
}

function parseEvaluation(
  record: DataRecord | undefined,
  questions: Questions,
): Evaluation {
  if (
    !record?.attributes || typeof record.attributes !== "object" ||
    Array.isArray(record.attributes)
  ) {
    throw new Error("Jev evaluation resource is missing or malformed");
  }
  const attrs = record.attributes as Record<string, unknown>;
  const answers = validateAnswers(attrs.answers, questions);
  return EvaluationSchema.parse({
    answers,
    model: attrs.model,
    usage: attrs.usage,
    evaluatedAt: attrs.evaluatedAt,
  });
}

function makeEvaluationName(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

async function writeResult(
  context: MethodContext,
  result: z.infer<typeof ResultSchema>,
): Promise<{ dataHandles: unknown[] }> {
  const validated = ResultSchema.parse(result);
  const handle = await context.writeResource(
    "result",
    `result-${makeEvaluationName()}`,
    validated,
  );
  return { dataHandles: [handle] };
}

/** Swamp model that delegates typed judgments to an existing Jev instance. */
export const model = {
  type: "@mgreten/jev-agent-tools",
  version: "2026.09.29.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    prepared: {
      description:
        "Scoped source and questions staged for a top-level Jev workflow step. Contains raw state and file text.",
      schema: PreparedSchema,
      lifetime: "1d" as const,
      garbageCollection: 200,
    },
    result: {
      description:
        "Typed Jev answers and safe file-path metadata; raw state remains in prepared and upstream Jev evaluations.",
      schema: ResultSchema,
      lifetime: "30d" as const,
      garbageCollection: 200,
    },
  },
  methods: {
    prepare: {
      description:
        "Stage scoped repository text and typed questions; combined mode makes one Jev request, per-file mode batches independent states with bounded concurrency. The prepared resource contains raw source.",
      arguments: PrepareArgsSchema,
      execute: async (
        args: z.infer<typeof PrepareArgsSchema>,
        context: MethodContext,
      ) => {
        const questions = validateQuestions(args.questions);
        const selected = await selectFiles(
          context.globalArgs.repositoryRoot,
          args,
        );
        if (args.mode === "per-file" && !selected.files.length) {
          throw new Error("per-file mode selected no readable text files");
        }
        const nonce = makeEvaluationName();
        const requests = args.mode === "combined"
          ? [{
            name: `agent-${nonce}`,
            state: selected.files.length
              ? { state: args.state, files: selected.files }
              : args.state,
            questions,
          }]
          : selected.files.map((file, index) => ({
            name: `agent-${nonce}-${index}`,
            path: file.path,
            state: { state: args.state, file },
            questions,
          }));
        for (const request of requests) validateRequestBudget(request);
        const prepared = PreparedSchema.parse({
          mode: args.mode,
          requests,
          ...(args.mode === "per-file" ? { batchName: `batch-${nonce}` } : {}),
          files: selected.files.map(({ path }) => path),
          skipped: selected.skipped,
          truncated: selected.truncated,
        });
        context.logger.info("Staged {count} Jev request(s)", {
          count: requests.length,
        });
        const handle = await context.writeResource(
          "prepared",
          `prepared-${nonce}`,
          prepared,
        );
        return { dataHandles: [handle] };
      },
    },
    collect: {
      description:
        "Correlate Jev answers with staged requests, reject missing or failed items, and store answer-only results.",
      arguments: CollectArgsSchema,
      execute: async (
        args: z.infer<typeof CollectArgsSchema>,
        context: MethodContext,
      ) => {
        if (!context.readModelData) {
          throw new Error("readModelData is required to collect evaluations");
        }
        context.logger.info("Collecting Jev answers for {preparation}", {
          preparation: args.preparationName,
        });
        const preparations = await context.readModelData(
          args.sourceModel,
          "prepared",
        );
        const staged = PreparedSchema.parse(
          preparations?.find((record) => record.name === args.preparationName)
            ?.attributes,
        );
        if (staged.mode === "per-file") {
          const records = await context.readModelData(
            context.globalArgs.jevModel,
            "triageBatch",
          );
          const record = records?.find((item) =>
            item.name === `triage-batch-${staged.batchName}`
          );
          const batch = BatchSchema.parse(record?.attributes);
          const expected = new Set(staged.requests.map(({ name }) => name));
          if (
            batch.failures.length || batch.results.length !== expected.size ||
            batch.results.some(({ id }) => !expected.delete(id)) ||
            expected.size
          ) {
            throw new Error(
              "Jev batch has missing, failed, or duplicate file evaluations",
            );
          }
          const evaluations = staged.requests.map((request) => {
            const item = batch.results.find(({ id }) => id === request.name)!;
            return {
              path: request.path!,
              answers: validateAnswers(item.answers, request.questions),
              model: batch.model,
              evaluatedAt: batch.evaluatedAt,
            };
          });
          context.logger.info("Collected {count} Jev evaluation(s)", {
            count: evaluations.length,
          });
          return await writeResult(context, {
            files: staged.files,
            truncated: staged.truncated,
            evaluations,
            usage: {
              input_tokens: batch.totalInputTokens,
              output_tokens: batch.totalOutputTokens,
            },
            skipped: staged.skipped,
          });
        }
        const records = await context.readModelData(
          context.globalArgs.jevModel,
          "evaluation",
        );
        const evaluation = parseEvaluation(
          records?.find((record) =>
            record.name === `evaluation-${staged.requests[0].name}`
          ),
          staged.requests[0].questions,
        );
        context.logger.info("Collected {count} Jev evaluation(s)", {
          count: 1,
        });
        return await writeResult(context, {
          files: staged.files,
          truncated: staged.truncated,
          ...evaluation,
          skipped: staged.skipped,
        });
      },
    },
  },
};
