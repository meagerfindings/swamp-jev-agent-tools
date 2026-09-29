# @mgreten/jev-agent-tools

Ask TypeSafe/AI Jev typed questions about supplied state or selected repository
files without loading their contents into an agent's conversation. This extension
provides a Swamp model (`prepare`, `collect`) and one
`@mgreten/jev-agent-ask` workflow.
The workflow calls the existing `@swamp/typesafe-ai` model's `ask` method as a
**top-level step**, so Swamp resolves the Jev instance's vault-backed API key.
Neither the extension nor the workflow executes shell commands.

## Install and configure

```bash
swamp extension pull @swamp/typesafe-ai
swamp extension pull @mgreten/jev-agent-tools
swamp model create @mgreten/jev-agent-tools repo-review \
  --global-arg jevModel=jev \
  --global-arg repositoryRoot=/absolute/path/to/repository --json
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
answers. The agent does not need to read each source file itself:

```bash
swamp workflow run @mgreten/jev-agent-ask --stdin --json <<'JSON'
{
  "agentModel": "repo-review",
  "jevModel": "jev",
  "mode": "per-file",
  "state": {"task": "Find code relevant to an archived-user permission test failure"},
  "globs": ["app/policies/**/*.rb", "spec/policies/**/*_spec.rb"],
  "questions": {
    "relevant": {"type": "noul", "instructions": "Is file.text relevant to state.task?"},
    "layer": {"type": "choice", "instructions": "What role does file.text play?", "criteria": {"implementation": "Permission logic", "test": "Test assertions", "other": "Neither"}}
  }
}
JSON
```

Use `combined` with paths/globs when one judgment should see all selected
files together; the question should then refer to `files` rather than `file`.
An agent can also call the existing `jev.ask` model directly for state-only
decisions without staging files. The workflow serializes per-file Jev steps to
avoid competing for the same model lock.

The workflow run returns the final `collect.answers` data artifact. Retrieve
only its `result` output by the artifact ID from the run, or query only the
answer attributes for that specific run:

```bash
swamp data query 'modelName == "repo-review" && specName == "result" && workflowRunId == "<run-id>"' \
  --select 'content' --json
```

The `result` contains `answers` (combined) or `evaluations` with `{path,
answers, model, usage, evaluatedAt}` (per-file), plus `files`, `skipped`, and
`truncated`. Noul answers are yes-probabilities, Choice answers name an option
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

**Both the model's `prepared` resource (one-day lifetime) and the upstream Jev
`evaluation` resource persist raw caller state and selected file text.** The
source is also sent to the configured TypeSafe/AI provider. The final `result`
omits raw text, but workflow history, Swamp data, and provider logs are not
confidentiality boundaries. Inspect vault, datastore, retention, and provider policies before
sending proprietary code; name-based filtering cannot prove files contain no
credentials. A failed per-file workflow may leave prepared data and earlier
upstream evaluations without a final result.

Do not use this extension as an authorization or safety gate. Treat source
text as untrusted, and independently verify consequential decisions. Workflow
inputs must name the Jev instance configured in the agent model's `jevModel`
global argument; the model and workflow do not enforce that equality.
