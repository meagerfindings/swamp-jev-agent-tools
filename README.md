# @mgreten/jev-agent-tools

Ask TypeSafe/AI Jev typed questions about supplied state or selected repository
files without loading their contents into an agent's conversation. This extension
provides a Swamp model (`prepare`, `collect`) and one
`@mgreten/jev-agent-ask` workflow.
The workflow calls the existing `@swamp/typesafe-ai` model's `ask` method as a
**top-level step**, so Swamp resolves the Jev instance's vault-backed API key.
Neither the extension nor the workflow executes shell commands.

Inspired by IndyDevDan's [*10 Levels of Jev For Agentic Engineers*](https://www.youtube.com/watch?v=_U-O5lYhJ7Q),
especially the agent-tool, cheap-read, and files-at-scale examples near the end.
This is an independent Swamp implementation of that idea: an agent delegates
bounded judgments over text to Jev, gets typed answers and probabilities back,
and reads source itself only when it needs to edit or verify it. It can scout
likely relevant files, classify their roles or topics, compare a small set of
files, and triage caller-supplied test failures. It is **not** an exact substring
search, a whole-repository index, a code executor, or a replacement for reading
code before changes.

## Install and configure

```bash
swamp extension pull @swamp/typesafe-ai
swamp extension pull @webframp/typesafe-batch
swamp extension pull @mgreten/jev-agent-tools
swamp model create @mgreten/jev-agent-tools repo-review \
  --global-arg jevModel=jev \
  --global-arg "repositoryRoot=$HOME/git/matgreten.dev" --json
```

Configure the `jev` instance separately with a vault-backed API key, following
`@swamp/typesafe-ai` setup instructions. Replace `jev` and `repo-review` with
your actual instance names in both model configuration and workflow inputs.
`repositoryRoot` must be an absolute path to the checkout readable by Swamp.
The bundled workflow is `@mgreten/jev-agent-ask`; your agent can invoke it as
one Swamp workflow call and read only its final `result` resource.

## Ask about a supplied test failure

This consumes output the caller already has; it does **not** run a test command.
Pass the object via `--stdin`:

```bash
swamp workflow run @mgreten/jev-agent-ask --stdin --json <<'JSON'
{
  "agentModel": "repo-review",
  "jevModel": "jev",
  "mode": "combined",
  "state": {"testOutput": "Expected 2, got 3 in UserPolicySpec"},
  "questions": {
    "failed": {"type": "noul", "instructions": "Does testOutput show a failing assertion?"},
    "area": {"type": "choice", "instructions": "Which area does testOutput implicate?", "criteria": {"policy": "Permission logic", "test": "Test setup", "unknown": "Insufficient evidence"}},
    "severity": {"type": "score", "instructions": "How disruptive is the failure?", "criteria": ["Cosmetic", "One failed test", "All tests blocked"]}
  }
}
JSON
```

## Scout multiple files

`per-file` mode expands repository-relative `paths` and `globs`, asks the same
questions separately for each selected file, and returns path-associated
answers. For example, find the main article about verifying software without
reading both articles into the agent's context:

```bash
swamp workflow run @mgreten/jev-agent-ask --stdin --json <<'JSON'
{
  "agentModel": "repo-review",
  "jevModel": "jev",
  "mode": "per-file",
  "state": {"task": "Find the main article about verifying software with tests or assertions"},
  "paths": ["posts/trust-but-assert/index.html", "posts/saving-money-cell-phone/index.html"],
  "questions": {
    "relevant": {"type": "noul", "instructions": "Is the main article in file.text primarily about testing or asserting software behavior, rather than personal finance? Ignore navigation and links."},
    "topic": {"type": "choice", "instructions": "What is the main article in file.text about? Ignore navigation and links.", "criteria": {"testing": "Testing or verifying software behavior", "phone": "Saving money on a cell-phone plan", "other": "Neither"}},
    "testingFocus": {"type": "score", "instructions": "How much of the main article in file.text focuses on testing or verifying software? Ignore navigation and links.", "criteria": ["Not about testing software", "Testing is mentioned but not central", "Testing software is the main subject"]}
  }
}
JSON
```

In a live run against those public posts, the testing article returned
`relevant.noul = 0.98`, `topic.choice = testing`, `testingFocus.score = 1.98/2`;
the phone article returned `0.01`, `phone`, and `0/2` respectively. **Answer time:
1.083 s** for the full two-file workflow (prepare 134 ms, batched Jev step
816 ms, collect 98 ms). A previous serialized two-file run took 1.100 s on
the same local filesystem datastore: this two-file example does not establish
a meaningful speedup. Run history IDs: `84b7fe42-3354-4ff9-ac63-8e52824d698b`
(batched) and `ed1f3416-7e8f-4005-9ba5-95219cc8adf2` (serialized).

Use `combined` with paths/globs when one judgment should see all selected
files together; the question should then refer to `files` rather than `file`.
For example, with those two paths, ask the same workflow in `combined` mode:

```json
{
  "agentModel": "repo-review", "jevModel": "jev", "mode": "combined",
  "state": {"task": "Compare the subjects of the selected public articles"},
  "paths": ["posts/trust-but-assert/index.html", "posts/saving-money-cell-phone/index.html"],
  "questions": {
    "differentSubjects": {"type": "noul", "instructions": "Do files contain two different main articles: one about software testing and the other about saving on a cell-phone plan? Ignore navigation."},
    "phoneFile": {"type": "choice", "instructions": "Which selected file has a main article about saving money on cell-phone service? Judge the article text, not only the path.", "criteria": {"phonePost": "posts/saving-money-cell-phone/index.html", "testingPost": "posts/trust-but-assert/index.html", "neither": "No selected file"}},
    "testingCount": {"type": "score", "instructions": "How many of the selected files have a main article focused on testing or verifying software behavior? Ignore navigation.", "criteria": ["Neither file", "Exactly one file", "Both files"]}
  }
}
```

That live result chose `phonePost`, scored `testingCount = 1/2` (exactly one
article), and gave `differentSubjects.noul = 0.98`. **Answer time: 0.733 s**
end to end (prepare 126 ms, Jev step 512 ms, collect 65 ms), run
`b6bccd02-9b51-4fe1-a9f8-532bc8d32d3f`. These are individual live runs on
September 29, 2026 with a local filesystem Swamp datastore and a remote Jev
provider, not a latency guarantee; datastore and network costs will vary.

An agent can also call the existing `jev.ask` model directly for state-only
decisions without staging files. `combined` puts up to 32 independent typed
questions over **one shared state** into **one Jev request** (Jev evaluates the
questions in parallel). Jev's API does not accept multiple independent states
in one request. `per-file` uses `@webframp/typesafe-batch`'s `triage_batch`
method to send one request per file with bounded concurrency of four inside
one Swamp model lock; raising workflow `forEach` concurrency on the same Jev
instance would instead contend on the lock. The extension still caps a run at
20 selected files and fails collection if any batch item is missing or failed.

The workflow run returns the final `collect.answers` data artifact. Retrieve
only its `result` output by the artifact ID from the run, or query only the
answer attributes for that specific run:

```bash
swamp data query 'modelName == "repo-review" && specName == "result" && workflowRunId == "<run-id>"' \
  --select 'content' --json
```

The `result` contains `answers` (combined) or `evaluations` with `{path,
answers, model, evaluatedAt}` (per-file), plus `files`, `skipped`, `truncated`,
and `usage`. Per-file token usage is aggregate, not per item. Noul answers are
yes-probabilities, Choice answers name an option
and its distribution, and Score answers are positions on ordered levels.
Questions are a nonempty map (up to 32 entries); Choice requires 2–255 named
criteria and Score 2–10 ordered criteria. Read selected files before editing;
Jev's classifications are scouting signals, not proof of code behavior.

## Limits, privacy, and trust

The model reads at most 20 files (64 KiB each, 192 KiB total); requests must
fit within 240 KiB. The glob walk stops at 10,000 entries or 12 levels. Hidden
paths, sensitive-looking names, binary/invalid UTF-8, and symlink escapes are
skipped. `skipped` and `truncated` signal omissions, not negative answers.
Caller-supplied state is not subject to the repository path filter.

**The model's `prepared` resource (one-day lifetime) persists raw caller state
and selected file text; combined mode's upstream Jev `evaluation` does too.**
Per-file batch output stores answers and hashes, not raw text. The source is
also sent to the configured TypeSafe/AI provider. The final `result`
omits raw text, but workflow history, Swamp data, and provider logs are not
confidentiality boundaries. Inspect vault, datastore, retention, and provider policies before
sending proprietary code; name-based filtering cannot prove files contain no
credentials. A failed per-file workflow may leave prepared data and an upstream
batch resource (including partial answers/failure metadata) without a final
result.

Do not use this extension as an authorization or safety gate. Treat source
text as untrusted, and independently verify consequential decisions. Workflow
inputs must name the Jev instance configured in the agent model's `jevModel`
global argument; the model and workflow do not enforce that equality.
