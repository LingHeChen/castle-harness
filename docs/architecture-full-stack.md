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

### 1. Contract-first decomposition

Decomposition emits, in the **earliest wave**, a set of *contract* tasks: the DB
schema, the shared types, the API interface. Everything else depends on them.
Freezing the contract early is the single biggest lever for keeping parallel
development clean — it minimizes churn in shared files. Contracts aren't immutable,
but changing one is a deliberate, coordinated act (below), never a casual edit.

### 2. The shared-edit protocol — a spectrum

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

### 3. Mid-build replanning

The plan is not frozen after approval. When a task reports "I need something the
plan doesn't have," or a shared change is too large to absorb, the harness pauses,
replans the affected subtree (decomposition scoped to that region), and surfaces a
**replan checkpoint** the human can review — the same HIL machinery as the
approve-plan checkpoint. "Small change → ripple re-test" and "large change →
replan" are the two ends of one spectrum, not separate systems.

### 4. Integration test environment

Unit acceptance (`bun test <file>` per task) is necessary but not sufficient — real
bugs live in integration: state machines, concurrency (two users race for the last
item), the DB↔API↔client seam. This needs a **test-environment harness**: bring up
the DB and server, seed data, hit endpoints, tear down. It's a subsystem, not more
test files. Integration tests gate the whole build, above the per-task unit gate.

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
| **T1** | small multi-file single-language app, end-to-end | near (contract-first + integration tests) |
| **T2** | small full-stack app (frontend + backend + DB), shared contract, integration + security/perf review, human at the boundaries | **the target of this document** |
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
