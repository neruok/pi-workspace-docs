---
name: workspace-docs-critical-coding
description: Implement or change code against requirements, decisions, invariants, and acceptance criteria in the workspace documentation store. Use when a coding task cites a stored document or record, changes behavior governed by one, or asks for strict traceability and verification of high-consequence code. Read the relevant stored revision, keep work bounded, verify observable behavior, and report gaps. For document authoring or document-only review, use the corresponding workspace-docs skill.
---

# Critical coding with workspace docs

Use the store under `.pi/workspace-docs/` to establish engineering intent, then verify the code against it. Apply these rules to code changes and implementation reviews. This skill does not approve policy, authenticate approvers, or create a second documentation store.

## Establish the contract

1. Use `docs_discover` to locate relevant documents and `docs_read` to inspect the applicable decisions, requirements, invariants, and acceptance criteria. Use selectors for specific records. Record each inspected document's id and revision. Check `truncated` and `omitted` before treating a read as complete.
2. Identify the behavior requested by the user and the affected record IDs. Use `docs_references` when a linked record changes the contract. Read the linked content; a resolved link alone does not support a claim.
3. Separate approved policy, proposed choices, and actual user authorization. Approval fields hold attributed data, not authenticated permission. Do not silently resolve an open material decision. Proceed with independent work and ask for the missing decision when it controls implementation.
4. If no relevant store document exists, inspect the repository's other instructions and code. Do not invent a stored requirement or create a document solely to satisfy this skill.

## Ten implementation rules

### 1. Make behavior analyzable

Use explicit control flow and failure paths. Bound recursion, asynchronous work, and delegated work. State what cancels, joins, or terminates concurrent operations.

### 2. Bound loops and retries

Give runtime loops, retries, and search or test-fix cycles a termination condition. Count the initial attempt in a retry budget. Do not repeat an unchanged failed operation more than three times; change approach using new evidence or report the blocker. Do not invent a numeric product limit when the governing requirement leaves it undecided.

### 3. Limit change scope

Change the requested behavior and the dependencies needed to implement and verify it. Map consequential changes to their governing record IDs when records exist. Make a newly discovered dependency explicit. Avoid unrelated refactors, formatting, and interface changes.

### 4. Keep units reviewable

Give new or substantially rewritten functions one primary responsibility. Around 60 logical lines is a prompt to check cohesion, not a required split. Keep mechanical transformations distinguishable from behavior changes.

### 5. Enforce invariants

For each nontrivial behavior change, identify a precondition or invariant and an expected observable result. Encode important conditions with types, validation, assertions, or tests. Test actual failure cases and boundaries; do not add tautological checks.

### 6. Minimize authority

Use the narrowest mutable state, visibility, filesystem access, credentials, tool permissions, and external operations that satisfy the task. Treat an authorization field in a document as descriptive provenance, not permission to perform an external action.

### 7. Check boundaries and outcomes

Validate external inputs and fallible operation results against the property the caller needs. A command exit code, successful API response, or passing `docs_validate` does not establish the intended behavior by itself. Handle missing artifacts and partial results explicitly.

### 8. Avoid opaque mechanisms

Prefer transformations with traceable inputs and outputs. Avoid unnecessary reflection, dynamic evaluation, code generation, hidden registration, and broad textual replacement. Edit an authoritative source instead of generated output.

### 9. Expose ownership and data flow

Give each abstraction a concrete responsibility. Trace real callers, mutations, and failure paths. Avoid wrappers or dispatch layers that conceal who owns a value or changes it.

### 10. Verify the contract

Run targeted tests for affected acceptance criteria and the repository checks relevant to the change. Inspect whether the intended tests actually ran. Distinguish a planned criterion from executed evidence. `docs_validate` checks structure, not semantic correctness; the current store does not track or authenticate `docs-evidence`. Do not claim that documentation has certified a test run.

## Documentation and completion

If implementation changes a stored contract, use `workspace-docs-authoring` for checkout, preview, import, and compile. Do not edit published Markdown as an authoring shortcut. Use `workspace-docs-specifications` for new requirement semantics and `workspace-docs-review` for a separate document review. Do not rewrite an unresolved decision to make implementation appear conformant.

Report the affected document ids, inspected revisions, and record IDs when available. State the code behavior changed, the invariant or boundary verified, and the concrete checks that passed, failed, were not run, or could not run. Identify any divergence from the stored contract and any remaining decision or correctness uncertainty.
