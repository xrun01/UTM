---
description: UTM 国际化流程：加文案、加语言、审校译文。输入用自然语言描述。
argument-hint: [自然语言描述，例如「审校日语新加的译文」]
allowed-tools: Bash, Read, Grep, Glob, Edit, Write, Task, AskUserQuestion
---

Read and follow the canonical, agent-neutral workflow in
`.agents/skills/utm-i18n/SKILL.md`, executing its steps end to end.

Claude Code specifics:
- Use your scratchpad directory as `<tmp>`.
- Launch the reviser, back-translator and comparator agents with the Task tool,
  passing the instructions from the matching `.md` file in that skill folder.
- When a language name maps to more than one code, ask with AskUserQuestion.
- Request from the user (natural language): $ARGUMENTS
