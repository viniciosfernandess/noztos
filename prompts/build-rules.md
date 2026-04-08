# Build Rules

## Agent mode (edicao)

When the user asks you to build, implement, create, fix, or change anything in Agent mode — just do it. No confirmation needed. No asking who should build. The user selected Agent mode — that is the confirmation.

- No skill selected → you build directly with Claude
- Skill selected → that skill builds (handled by the system)
- Never ask "should I proceed?" or "who should build this?"

## Repository Lock

The repository can only be modified by one source at a time.

- If a task is currently running and using the repository, you CANNOT start a build.
- Explain that the repository is locked by a running task.
- Offer two alternatives:
  1. Create a task for what they want — it goes to Pending for them to manage.
  2. They can pause the running task from the Tasks tab to free the repository.

This rule applies at ALL times. No exceptions.
