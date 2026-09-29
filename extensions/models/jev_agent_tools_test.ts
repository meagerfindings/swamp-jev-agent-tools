import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model } from "./jev_agent_tools.ts";

const questions = {
  route: {
    type: "choice" as const,
    instructions: "Which category fits?",
    criteria: { bug: "A defect", feature: "A new capability" },
  },
  urgency: {
    type: "score" as const,
    instructions: "How urgent is it?",
    criteria: ["Routine", "Soon", "Immediate"],
  },
  actionable: { type: "noul" as const, instructions: "Can an agent act?" },
};
const answers = {
  route: {
    type: "choice",
    choice: "bug",
    confidence: 0.91,
    probabilities: { bug: 0.91, feature: 0.09 },
  },
  urgency: {
    type: "score",
    score: 1.7,
    legend: { "0": "Routine", "1": "Soon", "2": "Immediate" },
    confidence: 0.8,
    probabilities: { "0": 0.1, "1": 0.2, "2": 0.7 },
  },
  actionable: { type: "noul", noul: 0.87 },
};

function mockContext(root: string) {
  const written: Array<
    { spec: string; name: string; data: Record<string, unknown> }
  > = [];
  const evaluations: Array<{ name: string; attributes: unknown }> = [];
  const batches: Array<{ name: string; attributes: unknown }> = [];
  const context = {
    globalArgs: { jevModel: "jev", repositoryRoot: root },
    logger: { info: (_message: string) => {} },
    writeResource: (
      spec: string,
      name: string,
      data: Record<string, unknown>,
    ) => {
      written.push({ spec, name, data });
      return Promise.resolve({ spec, name });
    },
    readModelData: (definition: string, spec: string) => {
      if (definition === "repo-review" && spec === "prepared") {
        return Promise.resolve(
          written.filter((item) => item.spec === "prepared")
            .map(({ name, data }) => ({ name, attributes: data })),
        );
      }
      assertEquals(definition, "jev");
      assert(["evaluation", "triageBatch"].includes(spec));
      return Promise.resolve(spec === "evaluation" ? evaluations : batches);
    },
  };
  return { context, written, evaluations, batches };
}

async function withRepo(
  test: (root: string, outside: string) => Promise<void>,
) {
  const root = await Deno.makeTempDir();
  const outside = await Deno.makeTempDir();
  try {
    await test(root, outside);
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
}

Deno.test("combined mode scopes files and passes typed questions without executing Jev", async () => {
  await withRepo(async (root, outside) => {
    await Deno.writeTextFile(`${root}/src.ts`, "safe source");
    await Deno.writeTextFile(`${root}/.env`, "hidden secret");
    await Deno.writeTextFile(`${outside}/outside.txt`, "outside secret");
    await Deno.symlink(`${outside}/outside.txt`, `${root}/escape.txt`);
    const { context, written, evaluations } = mockContext(root);
    await model.methods.prepare.execute({
      mode: "combined",
      state: { task: "review" },
      questions,
      paths: ["src.ts", ".env", "escape.txt", "../outside.txt"],
    }, context);
    assertEquals(evaluations.length, 0);
    const staged = written[0].data;
    assertEquals(staged.files, ["src.ts"]);
    assertEquals((staged.skipped as unknown[]).length, 3);
    const requests = staged.requests as Array<
      { name: string; questions: unknown; state: unknown }
    >;
    assertEquals(requests.length, 1);
    assertEquals(requests[0].questions, questions);
    assertEquals(requests[0].state, {
      state: { task: "review" },
      files: [{ path: "src.ts", text: "safe source" }],
    });
    assert(!JSON.stringify(staged).includes("outside secret"));
  });
});

Deno.test("per-file mode correlates independent Jev answers and keeps raw source out of results", async () => {
  await withRepo(async (root) => {
    await Deno.writeTextFile(`${root}/alpha.txt`, "alpha unique content");
    await Deno.writeTextFile(`${root}/beta.txt`, "beta unique content");
    const { context, written, batches } = mockContext(root);
    await model.methods.prepare.execute({
      mode: "per-file",
      state: "review",
      questions,
      globs: ["*.txt"],
    }, context);
    const staged = written[0];
    const requests = staged.data.requests as Array<
      { name: string; path: string; state: unknown }
    >;
    assertEquals(requests.map(({ path }) => path), ["alpha.txt", "beta.txt"]);
    assertEquals(new Set(requests.map(({ name }) => name)).size, 2);
    assertEquals(
      (requests[1].state as { file: { text: string } }).file.text,
      "beta unique content",
    );
    batches.push({
      name: `triage-batch-${staged.data.batchName}`,
      attributes: {
        results: [
          {
            id: requests[1].name,
            answers: { ...answers, actionable: { type: "noul", noul: 0.02 } },
          },
          { id: requests[0].name, answers },
        ],
        failures: [],
        model: "jev-model",
        totalInputTokens: 31,
        totalOutputTokens: 8,
        evaluatedAt: "2026-09-29T00:00:00Z",
      },
    });
    await model.methods.collect.execute({
      preparationName: staged.name,
      sourceModel: "repo-review",
    }, context);
    const result = written[1].data;
    assertEquals(
      (result.evaluations as Array<{ path: string }>).map((item) => item.path),
      ["alpha.txt", "beta.txt"],
    );
    assertEquals(
      (result.evaluations as Array<{ answers: typeof answers }>)[0].answers
        .urgency.score,
      1.7,
    );
    assertEquals(
      (result.evaluations as Array<{ answers: typeof answers }>)[1].answers
        .actionable.noul,
      0.02,
    );
    assertEquals(result.usage, { input_tokens: 31, output_tokens: 8 });
    assertEquals(
      (result.evaluations as Array<{ usage?: unknown }>)[0].usage,
      undefined,
    );
    assert(!JSON.stringify(result).includes("unique content"));
  });
});

Deno.test("per-file collect rejects partial batch failure and duplicate IDs", async () => {
  await withRepo(async (root) => {
    await Deno.writeTextFile(`${root}/a.txt`, "one");
    await Deno.writeTextFile(`${root}/b.txt`, "two");
    const { context, written, batches } = mockContext(root);
    await model.methods.prepare.execute({
      mode: "per-file",
      state: "",
      questions,
      globs: ["*.txt"],
    }, context);
    const staged = written[0];
    const ids = (staged.data.requests as Array<{ name: string }>).map((
      { name },
    ) => name);
    const batch = {
      results: [{ id: ids[0], answers }],
      failures: [{ id: ids[1], reason: "evaluation unavailable" }],
      model: "jev-model",
      totalInputTokens: 13,
      totalOutputTokens: 4,
      evaluatedAt: "2026-09-29T00:00:00Z",
    };
    batches.push({
      name: `triage-batch-${staged.data.batchName}`,
      attributes: batch,
    });
    const collect = () =>
      model.methods.collect.execute({
        preparationName: staged.name,
        sourceModel: "repo-review",
      }, context);
    await assertRejects(collect, Error, "missing, failed, or duplicate");
    batch.failures = [];
    batch.results.push({ id: ids[0], answers });
    await assertRejects(collect, Error, "missing, failed, or duplicate");
    assertEquals(written.length, 1);
  });
});

Deno.test("collect rejects a missing or mismatched Jev response without writing a partial result", async () => {
  await withRepo(async (root) => {
    const { context, written, evaluations } = mockContext(root);
    await model.methods.prepare.execute({
      mode: "combined",
      state: "check",
      questions,
    }, context);
    const staged = written[0];
    await assertRejects(
      () =>
        model.methods.collect.execute({
          preparationName: staged.name,
          sourceModel: "repo-review",
        }, context),
      Error,
      "missing or malformed",
    );
    const name = (staged.data.requests as Array<{ name: string }>)[0].name;
    evaluations.push({
      name: `evaluation-${name}`,
      attributes: {
        answers: { ...answers, route: { ...answers.route, choice: "other" } },
        model: "jev-model",
        usage: { input_tokens: 13, output_tokens: 4 },
        evaluatedAt: "2026-09-29T00:00:00Z",
      },
    });
    await assertRejects(
      () =>
        model.methods.collect.execute({
          preparationName: staged.name,
          sourceModel: "repo-review",
        }, context),
      Error,
      "unknown Choice value",
    );
    assertEquals(written.length, 1);
  });
});

Deno.test("per-file mode reports truncation after twenty matches", async () => {
  await withRepo(async (root) => {
    for (let i = 0; i < 21; i++) {
      await Deno.writeTextFile(
        `${root}/item-${String(i).padStart(2, "0")}.txt`,
        `item ${i}`,
      );
    }
    const { context, written } = mockContext(root);
    await model.methods.prepare.execute({
      mode: "per-file",
      state: "",
      questions,
      globs: ["item-*.txt"],
    }, context);
    assertEquals((written[0].data.requests as unknown[]).length, 20);
    assertEquals(written[0].data.truncated, true);
    assertEquals(written[0].data.skipped, [{
      path: "item-20.txt",
      reason: "file count limit exceeded",
    }]);
  });
});

Deno.test("prepare rejects malformed questions and oversized state before persistence", async () => {
  await withRepo(async (root) => {
    const { context, written } = mockContext(root);
    await assertRejects(
      () =>
        model.methods.prepare.execute({
          mode: "combined",
          state: "x",
          questions: {
            invalid: {
              type: "score",
              instructions: "rate",
              criteria: ["only one"],
            },
          },
        }, context),
      Error,
      "2 to 10 criteria",
    );
    await assertRejects(
      () =>
        model.methods.prepare.execute({
          mode: "combined",
          state: "x".repeat(250_000),
          questions,
        }, context),
      Error,
      "request exceeds",
    );
    assertEquals(written, []);
  });
});
