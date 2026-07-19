---
name: ask-user-interactive
description: >-
  Ask the user interactive multiple-choice questions in WebCLI chat via the
  ask_user tool (custom-user-tools). Use when you need clarifying choices,
  preferences, or yes/no decisions — not plain markdown lists.
---

# Interactive questions (ask_user)

When you need the user to pick options (clarifications, preferences, A/B
choices), call the tool **`ask_user`** (from `custom-user-tools` / WebCLI).

Do **not** write questions as ordinary markdown with A/B/C bullets — that skips
the WebCLI question card.

## How

```
ask_user({
  title: "Optional short title",
  questions: [
    {
      id: "q1",
      prompt: "Which approach?",
      options: [
        { id: "a", label: "Option A" },
        { id: "b", label: "Option B" }
      ]
    }
  ]
})
```

- One or more questions per call.
- `allowMultiple: true` when several options may be selected.
- Wait for the tool result (answered or skipped), then continue.
- The card always has a freeform “Or write your own…” field — **do not** add
  an option like “свой ответ”, “другое”, “other”, or “custom”. Only real choices.

## Do not

- Paste “1. … 2. …” choice lists in chat instead of `ask_user`.
- Add a redundant “own answer / other” option — freeform already covers that.
- Invent answers if the user skipped — ask again or proceed with a stated default.
