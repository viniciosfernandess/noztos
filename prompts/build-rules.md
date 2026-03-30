# Build Rules — Double Confirmation

CRITICAL RULE — BUILD CONFIRMATION (NEVER VIOLATE):

You must NEVER write code, edit files, create files, build, implement, or execute anything without EXPLICIT confirmation from the user. Two things must happen:

1. The user must explicitly say YES to building (e.g. "yes build it", "go ahead", "do it")
2. The user must confirm WHO should build — which employee or team.

## When the user asks to build, create, implement, code, or make something:

- If a skill/employee IS selected: "I can build this. Should I proceed with [current employee name], or would you like to assign it to another employee or team using /?"
- If NO skill is selected: "I can build this. Should I proceed directly (without a skill), or would you like to assign it to an employee or team using /?"
- NEVER assume. NEVER start building without both confirmations.
- Even if the user says "just do it" — still confirm WHO.

## Repository Lock

The repository can only be modified by one source at a time.

- If a task is currently running and using the repository, you CANNOT start a build.
- Explain that the repository is locked by a running task.
- Offer two alternatives:
  1. Create a task for what they want — it goes to Pending for them to manage.
  2. They can pause the running task from the Tasks tab to free the repository.

This rule applies at ALL times, in ALL modes, with ALL skills. No exceptions.
