---
name: workspace-docs-specifications
description: Create, rewrite, or review instructions, specifications, policies, runbooks, and acceptance criteria so behavior is unambiguous, deterministic, measurable, and testable. Use when requirements contain limits, states, decision logic, failure behavior, or compliance obligations. This skill governs semantics, not prose style.
---

# Write Deterministic Specifications

Write for an adversarially literal implementer.

Do not rely on the reader to infer intent. If correct behavior depends on information that is not written, the specification is incomplete.

This skill governs requirement semantics. Apply the separate STE100 skill for sentence structure, vocabulary, and controlled-language style.

## Classify the content

Classify each section as one of:

- **Normative:** Defines required, recommended, or optional behavior.
- **Descriptive:** Explains context, concepts, or rationale.
- **Procedural:** Defines actions and their execution order.
- **Reference:** Defines fields, states, interfaces, commands, or values.

Apply this skill primarily to normative and procedural content.

Keep requirements separate from rationale and examples. Examples are non-normative unless explicitly declared otherwise. Do not introduce a requirement only through an example, note, or rationale.

## Use normative keywords consistently

Use these meanings:

- `MUST` and `MUST NOT`: Mandatory requirements or prohibitions.
- `SHOULD` and `SHOULD NOT`: Defaults that permit exceptions.
- `MAY`: Optional behavior with no compliance implication.

For every `SHOULD` or `SHOULD NOT`, define:

1. the permitted exceptions; or
2. the decision procedure for deviating.

Do not use `SHOULD` when the behavior is mandatory.

## Make each requirement complete

For each consequential requirement, identify:

1. actor;
2. trigger;
3. preconditions;
4. required or prohibited action;
5. affected object;
6. scope;
7. limits;
8. exceptions;
9. failure behavior;
10. exhaustion behavior;
11. postconditions; and
12. acceptance criteria.

Use a compact sentence when it expresses these elements unambiguously. Use the expanded rule template when a requirement contains branching behavior, limits, exceptions, or failure paths.

A normative requirement should answer:

> Who does what, to which object, when, and under which conditions?

## Define terms and scope

Define each domain-specific term or cite its controlling definition.

Use one term for one concept. Do not alternate between synonyms unless they represent distinct concepts.

State the scope of every instruction. Identify whether it applies to:

- one request;
- one attempt;
- one candidate revision;
- one workflow run;
- one user;
- one workspace;
- one process;
- one deployment; or
- the entire system lifetime.

Do not use a pronoun when it could refer to more than one object.

## Make defaults explicit

For every optional or nullable input, define behavior when it is:

- omitted;
- empty;
- null;
- invalid;
- unavailable; or
- unknown.

Include only cases that the interface can produce.

Do not silently interpret missing or uncertain information as false. Use an explicit `UNKNOWN` state when the distinction affects behavior, and define its outcome.

## Enumerate finite values

When valid values are finite, list them.

Example:

```text
status MUST be one of:

- PENDING
- RUNNING
- SUCCEEDED
- FAILED
- CANCELLED
```

Do not instruct an implementer to choose an “appropriate” value from an unstated set.

## Define state transitions

For stateful systems, define:

* every state;
* every permitted source-to-destination transition;
* the event or condition that triggers each transition;
* forbidden transitions;
* terminal states;
* behavior for duplicate events;
* behavior for unknown events; and
* behavior after restart or recovery when applicable.

Each reachable state and event combination MUST produce one defined outcome unless nondeterminism is explicitly permitted.

## Define ordering and concurrency

If order matters:

1. number the steps;
2. state that they MUST execute in that order; and
3. define what happens when a preceding step fails.

If operations may execute concurrently, state that explicitly.

Define synchronization, completion, and cancellation behavior when concurrent operations affect one another.

Do not use temporal words such as `before` or `after` when they leave the relevant event or ordering ambiguous.

## Define decision logic

Use a decision table when behavior depends on multiple conditions.

Each reachable input combination SHOULD map to exactly one action. If multiple actions may occur, say so explicitly.

Include an `UNKNOWN` or default row when information can be incomplete.

For classification or selection logic, define:

1. criteria;
2. criterion precedence;
3. deterministic tie-breakers; and
4. behavior when the result remains indeterminate.

If nondeterminism is intentional, define the permitted variation and any reproducibility controls, such as a seed.

## Define precedence

When requirements can conflict, state their precedence.

Example:

1. safety and authorization invariants;
2. task-specific acceptance criteria;
3. workflow policy;
4. component defaults;
5. optimization preferences.

A lower-priority requirement MUST NOT override a higher-priority requirement.

Do not silently invent a precedence order. If the source material does not establish one, mark the issue as requiring a decision.

## Quantify every limit

For each limit, specify:

* numeric value;
* unit;
* inclusive or exclusive boundary;
* scope over which it is counted;
* reset point, if applicable;
* whether it is hard or soft; and
* behavior when it is reached or crossed.

Prefer unit-bearing names such as:

* `timeout_seconds`;
* `interval_ms`;
* `max_bytes`;
* `max_attempts`;
* `max_tool_calls`;
* `token_budget`.

Do not write `between 1 and 16` without defining whether the endpoints are included.

Prefer:

```text
Valid values are integers in the inclusive range 1–16.
```

## Distinguish hard and soft limits

A hard limit MUST NOT be exceeded.

Example:

```text
HARD LIMIT: The workflow MUST execute no more than 20 tool calls.
Tool call 20 is permitted. Tool call 21 is prohibited.
```

A soft limit defines a preferred boundary and MUST include crossing behavior.

Example:

```text
SOFT LIMIT: The workflow SHOULD execute no more than 12 tool calls.

If completing an acceptance criterion requires additional calls, the
workflow MAY continue to the hard limit of 20 calls and MUST record
which criterion required the additional calls.
```

Every soft limit MUST define:

* when it may be exceeded;
* what must happen when it is exceeded; and
* the final stopping condition.

## Define thresholds precisely

Replace subjective decision boundaries with measurable expressions.

Prefer:

```text
Escalate when confidence < 0.70.
A confidence value equal to 0.70 does not trigger escalation.
```

Avoid:

```text
Escalate when confidence is low.
```

Always define the equality case.

## Define resource budgets independently

Do not use one undefined `budget` for multiple resources.

Define applicable budgets independently, including:

* tool calls;
* model invocations;
* tokens;
* attempts;
* retries;
* wall-clock duration;
* automation runtime;
* concurrent workers;
* subprocesses;
* storage;
* network requests; and
* monetary cost.

For each finite budget, define its exhaustion behavior.

Example:

```text
When remaining_review_attempts reaches 0, the orchestrator MUST NOT
invoke another reviewer. It MUST transition the candidate to
REVIEW_EXHAUSTED.
```

## Define temporal behavior

Replace terms such as these when timing affects behavior:

* soon;
* recent;
* promptly;
* immediately;
* periodically;
* frequently;
* occasionally;
* stale.

Use an explicit:

* ordering constraint;
* deadline;
* duration;
* interval;
* timestamp comparison; or
* locally defined temporal term.

Example:

```text
The heartbeat interval MUST be 30 seconds with a permitted deviation
of ±5 seconds.
```

Do not invent a timing requirement when the source does not provide one. Mark it as a required decision.

## Define failure behavior

For each fallible operation where failure affects correctness, define:

* detectable failure conditions;
* per-attempt timeout;
* maximum total attempts, including the initial attempt;
* retryable failures;
* non-retryable failures;
* retry delay or backoff;
* fallback behavior;
* terminal state or reported error;
* cleanup obligations; and
* rollback obligations.

Example:

```text
The worker MUST make at most 3 checkout attempts.

The first attempt counts toward this limit. After the first and second
failures, the worker MUST wait 2 seconds and 4 seconds, respectively.

After the third failure, the worker MUST transition the task to
FAILED_CHECKOUT and delete temporary files created by that task.
```

## Define fail-open and fail-closed behavior

For authorization, validation, locking, safety checks, and destructive operations, define what happens when required information is unavailable.

State explicitly whether the operation:

* fails open;
* fails closed;
* remains pending; or
* requires escalation.

Do not silently choose a policy when the source requirements do not establish one.

## Identify invariants

Label properties that must always hold as `INVARIANT`.

Example:

```text
INVARIANT: A task MUST have at most one active owner.
```

```text
INVARIANT: completed_at MUST be null until the task enters a terminal
state.
```

Invariants take precedence over optimization goals.

## Replace ambiguous language

Treat subjective or unbounded terms as defects when they affect implementation or acceptance.

Flag terms such as:

* reasonable;
* appropriate;
* adequate;
* sufficient;
* significant;
* substantial;
* excessive;
* minimal;
* simple;
* complex;
* large;
* small;
* fast;
* slow;
* recent;
* stale;
* nearby;
* soon;
* frequently;
* occasionally;
* best;
* optimal;
* important;
* high quality;
* meaningful;
* some;
* several;
* few;
* many;
* usually;
* normally;
* typically;
* generally;
* `as needed`;
* `where appropriate`;
* `when necessary`;
* `if possible`;
* `etc.`;
* `and so on`.

Replace each consequential occurrence with:

* a threshold;
* an enumeration;
* a local definition;
* a decision procedure; or
* an unresolved decision marker.

These terms MAY remain in non-normative prose when they cannot affect implementation or acceptance.

## Do not fabricate precision

Do not invent thresholds, budgets, defaults, reliability targets, or failure policies.

If the source does not determine a material value:

1. insert `[DECISION REQUIRED: description]`;
2. explain which behavior the decision controls; and
3. request a decision from the user or designated authority.

If the user requested recommendations, provide a proposed value labeled `PROPOSED`. State its basis and keep it distinct from approved requirements.

## Define acceptance criteria

Every consequential requirement SHOULD have an observable acceptance criterion.

An acceptance criterion must identify:

* inputs or initial state;
* operation or stimulus;
* observable output or resulting state;
* relevant boundaries; and
* objective pass/fail conditions.

Prefer:

```text
PASS if all 100 test requests reach a terminal state within 60 seconds
and no request executes more than once.
```

Avoid:

```text
PASS if the scheduler behaves reliably.
```

For reliability claims, define the test population and required result. If a statistical guarantee is not justified, specify deterministic fault-injection cases instead.

## Use stable requirement identifiers

Assign stable identifiers to requirements that will be:

* tested;
* referenced;
* traced;
* superseded;
* reviewed independently; or
* used as transition guards.

Use one identifier for one semantic requirement.

When a new requirement replaces an old requirement, record the relationship explicitly. Do not reuse the old identifier for materially different semantics.

## Use the expanded rule template

Use this template for consequential or branching requirements:

```text
RULE-ID

Actor:
Trigger:
Preconditions:
Requirement:
Invariant:
Hard limits:
Soft limits:
Soft-limit behavior:
Exceptions:
Failure behavior:
Exhaustion behavior:
Postconditions:
Acceptance test:
```

Omit a field only when it does not apply. Do not omit it merely because the source material failed to define it.

## Perform an ambiguity review

Before delivering the document, perform a semantic review.

For each normative statement, ask:

> Could two competent, literal implementers follow this statement and
> produce materially different behavior?

If yes, rewrite the statement or mark the unresolved decision.

Verify that:

* actors, objects, triggers, and scope are explicit;
* terms and acronyms are defined;
* finite values are enumerated;
* defaults and exceptions are explicit;
* equality cases are defined;
* `UNKNOWN` behavior is defined;
* ordering and concurrency are explicit;
* precedence and tie-breakers are deterministic;
* limits include values, units, boundaries, scope, and exhaustion behavior;
* retries include maximum attempts and terminal behavior;
* every `SHOULD` has exception criteria;
* requirements do not exist only in examples or rationale;
* invariants are identified;
* state transitions include source and destination states; and
* acceptance criteria are observable.

Flag unresolved issues rather than hiding them in polished prose.

## Record in the workspace documentation store

When the project uses the workspace documentation extension, encode the specification as records instead of free prose:

- A normative requirement is a `docs-record` with `type = "requirement"`; its body carries the `MUST`/`SHOULD`/`MAY` statement.
- An acceptance criterion is a `docs-record` with `type = "acceptance-criterion"`.
- Link a requirement to its criterion with a `docs-link` of type `verified-by`.
- Keep rationale and examples in prose, not in a requirement body.
- Keep an unresolved choice as a proposed decision record; do not invent a value.

Use the `workspace-docs-authoring` skill for the store workflow. This skill still governs the requirement semantics.

## Deliver the result

When creating or rewriting a document, return:

1. the revised document;
2. a decision list containing only unresolved material choices; and
3. a brief conformance note identifying the semantic checks performed.

When reviewing without authorization to edit, report:

* the affected rule or passage;
* the ambiguity;
* the possible divergent behaviors;
* the recommended correction; and
* whether a policy decision is required.

Do not modify the source unless the user requested edits.
