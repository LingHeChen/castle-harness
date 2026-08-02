# Notes on building a coding-agent harness

The model is the engine. The *harness* is everything around it that turns a
next-token predictor into something that can do work in a repository: the loop,
the tools, the context window, the memory, the observability, the interface.
Castle is a study of that layer. This is a writeup of the decisions that mattered.

## The model is not the agent

A raw model call takes messages in and streams text out. It doesn't call tools,
remember the last step, decide which file to read, or know when to stop. Every
one of those is harness work. So the first question isn't "which model" — it's
"what's the smallest set of moving parts that makes the model useful, and how do
they fit together?"

Castle's answer is four layers: an agent loop, a tool layer, a context manager,
and a trace. Everything else (a web dashboard, a spec-driven build pipeline) is
built *on top of* those, not woven into them.

## Decision 1: events are the seam

The agent loop (`src/core/agent.ts`) does not print anything. It yields an
`AgentEvent` stream — `step-start`, `text-delta`, `tool-call`, `tool-result`,
`compaction`, `step-finish`, `done`. That's the entire public surface.

That single choice paid for itself three times:

- the **terminal renderer** consumes the stream and draws it,
- the **web dashboard** forwards the same stream over a WebSocket and draws it live,
- the **trace** is just the stream written to JSONL, and `castle trace` reads it back.

Historical and live views fold through *one* function (`summarizeEvents`), so a
run looks identical whether you watch it in real time or replay it from disk. The
loop is the only code coupled to the model SDK; swapping the model or the frontend
never touches the other side. When I later added a whole build pipeline, it got
its own `BuildEvent` stream for free, and the live DAG in the browser was mostly
a matter of folding that stream.

If I had let the loop `console.log`, none of that would exist.

## Decision 2: context engineering is two levers, not one

The message window grows every step. Left alone, input tokens grow linearly and
cost grows quadratically, until you hit the context limit. The naive fix —
"summarize the history every step" — is actively wrong, because it breaks the
prompt prefix and destroys KV-cache hits.

So the context manager (`src/core/context.ts`) keeps two levers separate:

- **Cache-stable prefix.** Under budget, return the messages *untouched*. Nothing
  earlier is rewritten, so the prefix is byte-identical to the previous step and
  the provider's prefix cache hits. The system prompt is deliberately static for
  the same reason — no timestamps, no cwd interpolated into it.
- **Turn-safe compaction.** Only when the window exceeds a budget: pin the task
  and the recent turns, summarize the middle. This breaks the cache *once* in
  exchange for a bounded window. Compaction cuts only on turn boundaries, so an
  `assistant` tool call and the `tool` results it produced always move together —
  split them and the API rejects the request.

The harness measures the tradeoff instead of hiding it. A real 10-step run:

```
step   input   cached   hit%
   2    1155    1024     89%     ← append-only: prefix cache hits
   6    4652    1024     22%     ← cache reset right after a compaction
  10    3321    3200     96%
total: input=30812 cached=16256 (53% hit)
```

Input plateaus around 3–4k instead of growing unbounded; cache-hit stays high
while appending and dips right after each compaction. That dip is the *cost* of
lever B, and the reason lever A leaves history alone whenever it can.

## Decision 3: a subagent is a unit of context isolation

The interesting thing about subagents isn't parallelism — it's that a fresh
subagent has *no memory of how a thing was produced*. Castle uses this in the
build pipeline (`castle build`): one subagent writes acceptance tests, then a
**separate** subagent audits them for false-pass risk (tautological asserts,
mocked-away logic, happy-path-only). The auditor never saw the test-writer's
reasoning, so it can't rationalize it. An agent shouldn't mark its own homework.

`src/core/subagent.ts` exposes two primitives: `think()` (one structured,
tool-free call → a validated object) and `work()` (a full agentic sub-run). I
deliberately implemented `think()` as generate-text + JSON-schema instruction +
parse + zod-validate + retry, rather than leaning on a provider's structured-
output mode — the harness owns the contract, and it works against any model.

## Decision 4: let tests, not the model, end the loop

`castle build` is spec-driven: understand → decompose → write+audit acceptance
tests → develop → verify. The premise is that **the loop terminates when the
acceptance tests pass, not when the model announces it's done.** The judge is
objective and lives in the repo.

Two hard parts made this worth doing:

- **Parallel development without conflicts.** Each atomic task builds in its own
  git worktree; tasks in a wave run concurrently; branches merge back. Because the
  decomposition assigns disjoint files to parallel tasks, the merges are clean.
- **Honest failure.** Tasks that keep failing after bounded fix attempts are
  reported as failing, with the test output — not smoothed over.

I verified it end-to-end by building a real recursive-descent arithmetic
evaluator (tokenizer → parser → evaluator → facade) in an external repo: 4 tasks,
4 sound audits, 4/4 acceptance passed, and independently, correct precedence,
associativity, unary minus, and division-by-zero behaviour.

## What I'd be honest about in an interview

- **The innermost iteration is borrowed.** The "call model, run tools, repeat"
  mechanics come from the SDK (`streamText` + `stopWhen`); Castle shapes
  everything around it (context, tools, events, tracing) via a `prepareStep`
  hook. Taking full ownership of the loop — tools with no `execute`, hand-rolled
  iteration — is the obvious next step, and the one that would let me say every
  ring from the token stream to the stop decision is mine.
- **Model nondeterminism breaks clean A/Bs.** I wanted a crisp compaction-on vs
  compaction-off comparison; two runs of the "same" task take different paths, so
  the honest artifact is the with-compaction trace, not a manufactured delta.
- **Evals are toy-scale.** The build pipeline is verified on small real programs,
  not a benchmark suite. A proper eval harness (success rate / tokens / cost /
  cache-hit over a task set) is the next thing I'd build.

## The shape of it

```
castle run    → one agent loop (tools + KV-cache-aware context + trace)
castle trace  → replay any run's token/cache economics
castle serve  → dashboard: live agent stream + cache chart + live build DAG
castle build  → spec-driven: understand → decompose → audit tests → parallel dev → verify
```

Four commands, one event contract, on Bun + TypeScript, driving DeepSeek. The
whole thing is a bet that the interesting problems in agents live in the harness —
the loop, the window, the tool protocol, the cache economics — not in one more
wrapper over a chat endpoint.
