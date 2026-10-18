# Flows

Every path through the user-facing requirements, including failure and permission branches. There is no permission branch: one local user (specification section 6).

## 1. Choose and check how each board is read (REQ-1, 2, 3, 4, 7, 21 to 24)

```mermaid
flowchart TD
  A[Open Search criteria] --> B{Sources load?}
  B -- no --> E[Error: could not load sources, Retry] --> A
  B -- yes --> C{Any source on?}
  C -- no --> D[Empty: turn on a board]
  D --> F
  C -- yes --> F[Each chip shows Public API, Account API or Browser]
  F --> G[Toggle a source on or off]
  F --> H[Open Access record for a source]
  H --> I[Drawer: public API, get endpoints, apply endpoints documented only, terms and risk, chosen path]
  I --> K[Drawer end: last scan checks, kept, rejected no URL, merged duplicate, failed full description]
  K --> J[Escape or Close: focus returns to the button]
  I --> J
  G --> F
```

## 2. A scan reports a failure (REQ-5, 6, 10, 25)

```mermaid
flowchart TD
  S[Scan runs per source] --> P{Source result}
  P -- ok --> OK[Branch completes, nothing new shown]
  P -- token missing --> M[Notice: LinkedIn scan failed, token missing, no request made] --> MA[Ba adds token to local secret storage, runs scan again]
  P -- 401 or 403 --> R[Notice: token rejected, no retry] --> RA[Ba renews token in local secret storage]
  P -- 429, 5xx, timeout --> T[Retries used up, notice: Remote OK scan failed, reason] --> TA[Ba runs scan later]
  P -- adapter broken --> AB[Notice: adapter broken] --> RP{Repair adopted?}
  RP -- yes --> AL[Activity log entry: Adopted]
  RP -- no --> NF[Notice adds: Automatic repair failed] --> AL2[Activity log entry: Not adopted, previous skill kept]
  OK --> O[Other sources go on in every branch]
  M --> O
  R --> O
  T --> O
```

## 3. Review an automatic skill repair (REQ-8, 9, 11, 12, 13)

```mermaid
flowchart TD
  A[Open Activity log, or follow the notice link] --> B{Entries load?}
  B -- no --> E[Error, Retry] --> A
  B -- yes --> C{Any entries?}
  C -- no --> D[Empty: nothing repaired yet]
  C -- yes --> F[List, newest first]
  F --> G[Expand an entry in place]
  G --> H[Reason, outcome, difference old to new]
  H --> I{Proposed changes outside skills?}
  I -- yes --> J[Listed under Not applied]
  I -- no --> K[Only skill files changed]
  F --> L[Entry Repairing: validation running, no second attempt]
```

## 4. The system extends the master CV (REQ-14 to 20, 26 to 28)

```mermaid
flowchart TD
  T[Tailor task finds a JD requirement the facts do not state] --> Q{Existing facts support or imply it?}
  Q -- no --> FR[Fact request raised as today, CV leaves it out]
  Q -- yes --> DR[Derived fact drafted citing source facts]
  DR --> V{Cites a fact, and no new number, year, duration, employer or title?}
  V -- no --> RJ[Not added, audit reason shown under Not added]
  V -- yes --> AD[Added as new master CV version]
  AD --> UB[Banner: Added N facts automatically, Undo]
  UB -- Undo --> UN[Master CV equals previous version]
  UB --> LS[Facts labelled Added automatically with Rests on or Implied from]
  LS --> ED[Ba edits a derived fact in place]
  LS --> SC{Ba edits or deletes a cited fact?}
  SC -- yes --> FL[Derived fact shows Source fact changed, held out of tailor tasks]
  FL -- Keep --> LS
  FL -- Delete --> GN[Fact removed]
```
