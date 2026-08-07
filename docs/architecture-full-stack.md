# Architecture: from one sentence to a small full-stack app

The north star: a user says *"build me a WeChat ordering mini-program"* and gets a
working, near-commercial full-stack app. The honest, reachable version of that: the
harness does ~90% of the engineering, and a human stays in the loop at a few
boundaries that can't — or shouldn't — be automated. External integrations
(WeChat login, payment) are mocked behind a clearly-marked boundary the human
verifies. This document is the architecture for getting there from where castle is
today — small, single-language, self-contained libraries with unit-level
acceptance.

## Why it's hard: leaves aren't independent

castle today assumes decomposition leaves touch **disjoint files**, build in
isolated git worktrees, and merge cleanly. That holds for a string library. It
breaks for full-stack code, for three reasons:

1. **Shared artifacts** — DB schema, API contracts, shared types, auth — are
   touched by many tasks.
2. **Shared code co-evolves**: building `checkout` often forces a change to the
   `order` model that `cart` also depends on.
3. **The real dependency graph is discovered during implementation**, not fully
   known at plan time.

A dependency DAG is the right *representation* — humans decompose with
dependencies too. The gap is that castle currently **freezes** tasks into
disjoint-file silos, while real development edits shared code freely and replans
constantly. Closing that gap is this document.

## The design

### 1. Contract-first decomposition ✅ implemented

Decomposition emits, in the **earliest wave**, a set of *contract* tasks: the DB
schema, the shared types, the API interface. Everything else depends on them.
Freezing the contract early is the single biggest lever for keeping parallel
development clean — it minimizes churn in shared files. Contracts aren't immutable,
but changing one is a deliberate, coordinated act (below), never a casual edit.

*Built:* after the recursive decomposition wires the feature DAG, a contract pass
(`src/build/contract.ts`) runs — `identifyContracts()` (a context-isolated model
call) names the shared artifacts, and `applyContracts()` (pure) lifts each into a
`kind: "contract"` task with no dependencies (so it lands in wave 0), makes it the
**sole owner** of its files, and rewires every consumer to depend on it. Single
ownership of every file is the invariant the shared-edit guard relies on.

### 2. The shared-edit protocol — a spectrum ✅ implemented (mechanical + semantic)

When a dev agent needs to modify a file it doesn't own (a shared/contract file),
the harness intercepts the write **at the tool layer** (the same seam the
permission system uses) and routes it through a coordinated protocol instead of a
raw edit. Every shared change lands somewhere on this spectrum:

```
small   → auto-merge onto the integration branch
medium  → merge + re-run the acceptance tests of every dependent task
break   → merge + spawn fix-agents for the dependents that now fail
large   → replan the affected subtree
```

**Mechanical layer (git).** A single global **integration branch** (trunk-based).
The requesting dev agent blocks; a dedicated editor agent makes the shared change
on its own branch and merges to the integration branch — serialized, one shared
write at a time. Dev agents branch from and rebase onto the integration branch.
(One global branch, not per-wave: contracts are global; per-wave branches add
complexity without solving cross-wave contract changes.)

**Semantic layer (the half a git merge doesn't cover).** A contract change
invalidates the *code* of dependents built against the old contract — `cart` was
written against the old `order` model and now calls a stale signature. So after a
shared change lands, the harness computes the dependents (tasks importing the
changed file), re-runs their acceptance, and spawns **fix-agents** for the ones
that break (reusing the existing acceptance fix loop). If a dependent can't be
fixed locally, it escalates to replanning.

The mechanical + semantic layers together are what "edit the shared file, then fix
everything it touched" means for a human. The naive version (block, dedicated
agent, merge back) is only the mechanical half.

*Built:* the guard seam is a `WriteGuard` threaded through the tool layer
(`AgentOptions` → `prepareAgent` → `buildTools` → the `write_file`/`edit_file`
tools), so every mutating file op can be allowed, denied, or *taken over*. In a
build, each dev agent gets a guard bound to its task id and worktree
(`SharedEditCoordinator.guardFor`). Writes to its own (or brand-new) files pass
through untouched; a write to a file another task owns is **serialized** through the
coordinator's queue (one shared change at a time), applied, classified by
magnitude (`editMagnitude`), and recorded. After the wave merges,
`rippleAfterWave` re-verifies the transitive dependents that already merged and
runs the acceptance fix loop on the ones that broke — the semantic ripple.
Ownership, classification, and dependent computation are pure functions in
`src/build/shared-edit.ts`; the stateful coordination is `src/build/coordinator.ts`.

*Honest scope:* the coordinator applies the shared change to the requesting
worktree (it rides that branch back to the integration tree) rather than running a
separate editor agent + rebase on all siblings mid-wave. Because contract-first
puts shared files in wave 0, they're built before feature waves start, so the
common case — a feature depending on a frozen contract — is fully handled. A
mid-wave shared change that two *concurrent* siblings both need is the boundary
that escalates to replanning (§3, not yet built).

### 3. Mid-build replanning

The plan is not frozen after approval. When a task reports "I need something the
plan doesn't have," or a shared change is too large to absorb, the harness pauses,
replans the affected subtree (decomposition scoped to that region), and surfaces a
**replan checkpoint** the human can review — the same HIL machinery as the
approve-plan checkpoint. "Small change → ripple re-test" and "large change →
replan" are the two ends of one spectrum, not separate systems.

### 4. Integration test environment ✅ implemented

Unit acceptance (`bun test <file>` per task) is necessary but not sufficient — real
bugs live in integration: state machines, concurrency (two users race for the last
item), the DB↔API↔client seam. This needs a **test-environment harness**: bring up
the DB and server, seed data, hit endpoints, tear down. It's a subsystem, not more
test files. Integration tests gate the whole build, above the per-task unit gate.

*Built:* the lifecycle subsystem is `src/build/testenv.ts` — `startServer()` spawns
the app with `PORT` injected, **polls readiness** (HTTP or TCP) so a slow boot
waits instead of flaking, captures stdout/stderr, and `stop()` tears down (SIGTERM
→ SIGKILL). A crash-on-boot or a never-listening server fails loudly with the
captured output instead of hanging every test. Phase 6 (`src/build/integration.ts`)
drives it: `planIntegration()` (isolated model call) decides whether the build is a
runnable app and returns the seed/start argv + the end-to-end scenarios;
`generateIntegrationTests()` writes tests that reach the app **only** through
`process.env.CASTLE_BASE_URL` (the harness owns the server, so "bring up / seed /
hit / tear down" lives in one place, not leaked across test files); then
`runIntegrationOnce()` seeds, brings the env up on a free port, runs `bun test
integration/`, tears it down — with a bounded fix loop on failure. It's a gate
*above* the unit gate: a build that passes every unit test but fails integration is
not done. A self-contained library (no runnable app) auto-skips. The lifecycle and
the gate are covered by real tests (a fixture server, pass/fail/crash-on-boot/
seed-failure) with no model in the loop.

### 5. Security & performance review, and the human sign-off queue

Two new adversarial review stages, built on the existing **context-isolated
auditor** pattern (the one that already keeps the agent from marking its own
homework):

- **Security review** — agents that hunt the low-threshold, high-severity classes:
  authz / IDOR, injection, secret handling, payment-boundary and callback
  verification. Multiple reviewers, majority vote.
- **Performance review** — N+1 queries, missing indexes, obvious hot paths.

A **risk classifier** routes findings: auto-fixable → fix-agent; needs-human-
judgment → a **human sign-off queue**, deferred and presented to the user. We can't
prove the absence of bugs; the honest target is to drive the probability of
low-threshold, high-severity defects **below what a typical developer achieves** —
and to make that *measurable* with an eval that injects and scores those bug
classes. That measurement is itself the point (it's "real tasks as the feedback
signal").

### 6. Multi-model routing

DeepSeek is a text/code model with no vision. UI/design tasks route to a
multimodal model for visual generation and design review; code tasks stay on
DeepSeek. The harness is model-agnostic per task — model routing is itself a
harness capability, not a workaround.

### 7. External boundaries

Real accounts, credentials, payment-merchant onboarding, deploy, ICP filing, and
store review are out of scope for autonomous work. External integrations (WeChat
login, payment) are **mocked behind an explicit boundary**. Those mock boundaries
— exactly where real bugs and security holes hide — are marked **human-must-
verify**; a passing build never claims those are production-ready.

### 8. Existing codebases (brownfield) 🚧 first piece built

Everything above assumes greenfield: the model *invents* the dependency graph
(each task declares its files and `dependsOn`). But most real work is changing an
existing repo, and the striking thing is that the two hardest pieces built so far —
the shared-edit protocol and the semantic ripple — are a **more natural fit** for
brownfield than greenfield. In greenfield, "a task edits a file it doesn't own" is
an edge case; in existing code, five tasks all needing to touch `models.ts` is the
*main* case.

The reframe that makes it work: **don't invent the graph, extract it.** An existing
repo already has its dependency graph — in the import edges between files. So the
only thing that changes is the *source* of the graph (model-declared →
statically-extracted); the ownership map, the transitive dependents, and the whole
shared-edit machinery run unchanged. There's a clean symmetry: greenfield =
contracts you *create and freeze*; brownfield = contracts that *already exist and
must not be carelessly broken* — same ownership + ripple protocol, different
provenance.

*Built (the linchpin):* `src/build/importgraph.ts` (pure) extracts the intra-repo
import graph — `parseImports` (string-aware: `import…from`, bare `import`, dynamic
`import()`, `require()`), `resolveSpecifier` (relative → repo file, extension +
`index`), `buildImportGraph`, `transitiveImporters` (reverse-transitive closure).
`ownershipFromImports()` then produces the *exact same* `Ownership` structure the
coordinator already consumes, with task-level dependents computed through the real
import edges and "shared" meaning "imported across an ownership boundary." So the
ripple in existing code is now *real* (backed by actual imports), not a plan-time
approximation — and it plugs into `classifyPath`/`dependentsOfPath` with zero
downstream change.

*Still to build for full brownfield:* (1) **change-set planning** — replace
top-down "split into new files" with "read the repo, locate what must change,
produce a change DAG over existing files" (needs a repo map + retrieval); (2) a
**regression gate** — run the existing test suite as a baseline and re-run the
existing tests covering a changed file during the ripple; (3) the **deferred git
mechanic** (dedicated editor agent → integration branch → siblings rebase) becomes
mandatory, since parallel edits to existing shared files conflict by default.

*Honest edge:* the real difficulty isn't any of the above — it's **comprehension at
scale**: retrieval quality, not touching what you shouldn't, respecting undocumented
invariants. This is exactly where interactive copilots win today, because the human
supplies the missing context. The honest bar: castle-brownfield works when the
change is localized and the repo's structure is legible; it degrades on sprawling,
poorly-factored, convention-heavy code.

## Where the human stays (by design, not by limitation)

- design sign-off (what the product is),
- plan approval (the DAG, before any code),
- replan review (when the plan changes under it),
- security sign-off (the risk queue),
- everything real-world: accounts, credentials, deploy, payment onboarding, store
  review, and commercial acceptance (someone takes responsibility for money).

## What this is not

- Not "one sentence, zero humans, guaranteed commercial-grade." No current system
  does that, and parts of it (accounts, filing, store review, being liable for
  money) are human by nature.
- Not a proof of correctness. It lowers defect probability; it does not eliminate
  it.

## Capability tiers

| Tier | Target | Status |
|------|--------|--------|
| **T0** | small single-language self-contained libs, unit-acceptance | ✅ verified |
| **T1** | small multi-file single-language app, end-to-end | contract-first ✅ + shared-edit protocol ✅ + integration gate ✅ |
| **T2** | small full-stack app (frontend + backend + DB), shared contract, integration + security/perf review, human at the boundaries | **the target of this document** — shared-contract foundation + integration env built; security/perf review, multi-model, replanning pending |
| **T3** | commercial WeChat mini-program, deployed, store-approved | moonshot; partly not automatable |

## What it reuses

This is an evolution of what's built, not a rewrite:

- the context-isolated adversarial **auditor** → security & performance review,
- the acceptance **fix loop** → ripple-fix for broken dependents,
- the **HIL checkpoints** (clarify, approve-plan) → the replan checkpoint,
- **git worktrees** → the integration branch + shared-edit protocol,
- **tool-layer interception** → the shared-file guard (and the permission system),
- the single **AgentEvent / BuildEvent** stream → replan / ripple / security events.

The pattern is already the right one. The full-stack jump is making shared code
first-class: contract-first, a coordinated shared-edit protocol with semantic
ripple, mid-build replanning, and review stages that target the bugs that actually
matter.
