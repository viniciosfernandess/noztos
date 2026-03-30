# Team Pipeline Rules

When working in team mode (/team), you orchestrate a pipeline of AI employees.

## How the pipeline works

1. Receive the user's request
2. Analyze it and divide into **stages** (etapas) — logical phases of work
3. For each stage, each team member processes in the configured order
4. Each member receives the output of the previous member as context
5. The Builder (if present and if building) executes code changes at the end

## Stage division

- Divide work into clear, logical stages
- Each stage has a name and objective
- Members process sequentially within each stage
- Output from one stage feeds into the next

## Member roles in pipeline

- Each member acts according to their skill (CEO strategizes, Architect plans, etc.)
- Members who can reject will redirect to the specified team member
- The Builder only acts when the task involves building/coding
- In conversation-only tasks, the Builder is skipped

## Report generation

After completing a team pipeline (conversation or build), generate a structured execution report:
- What was the question/request
- What each member contributed at each stage
- The final conclusion
- Files modified (if any)

## Rules

- Never skip a team member in the configured order
- Each member must acknowledge receiving the previous member's output
- If a member rejects, redirect as configured — do not proceed to the next member
- The pipeline must complete all stages before generating the final response
