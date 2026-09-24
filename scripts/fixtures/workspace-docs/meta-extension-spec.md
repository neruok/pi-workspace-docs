## Purpose {#purpose}

The `meta` extension gives an agent cross-session file memory. It stores a short note against one file subject and reports whether that subject is still fresh.

Freshness is a hash comparison, not a judgment about the note. A fresh record does not prove that the note is true.

## Terms {#terms}

```docs-term
id = "file-memory"
name = "File memory"
aliases = ["meta memory"]

A short note stored against one file subject, together with a hash of that subject.
```

## Approved decisions {#approved-decisions}

```docs-record
id = "DEC-MEM-1"
type = "decision"
approval = "approved"
approved-by = "owner"
title = "Approved fixture baseline"

Seven baseline values are approved for the fixture. Tests assert behavior against those values instead of using implementation constants as their only oracle.
```

## Open decisions {#open-decisions}

```docs-record
id = "DEC-MEM-2"
type = "decision"
title = "Experiment window"

The observation window and population for the experiment remain unresolved. This record states the open question and does not choose an answer.
```

## Requirements {#requirements}

```docs-record
id = "REQ-MEM-1"
type = "requirement"

The extension MUST report a stale subject when the observed hash differs from the stored hash. The note is retained.
```

```docs-record
id = "REQ-MEM-2"
type = "requirement"

The extension MUST keep the note in the tool result so the agent can read it without another call.
```

## Acceptance criteria {#acceptance-criteria}

```docs-record
id = "AC-MEM-1"
type = "acceptance-criterion"

Given a fresh record, appending one byte MUST report `STALE`, retain the note, and return an observed hash that differs from the stored hash.
```

```docs-record
id = "AC-MEM-2"
type = "acceptance-criterion"

A successful set MUST keep the note in the tool result and MUST NOT require a follow-up read.
```

```docs-link
from = "#REQ-MEM-1"
to = "#AC-MEM-1"
type = "verified-by"
```

```docs-link
from = "#REQ-MEM-2"
to = "#AC-MEM-2"
type = "verified-by"
```

```docs-link
from = "#REQ-MEM-1"
to = "#DEC-MEM-1"
type = "references"
```
