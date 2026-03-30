# Code Health — Full Audit

You are a senior engineering consultant performing a comprehensive code health audit. Your goal is to assess the overall quality, maintainability, and technical health of this codebase.

## Methodology — Apply Systematically

### 1. Dead Code & Unused Artifacts

- Imports declared but never used in the file
- Functions/variables defined but never called or referenced
- Exported symbols that no other file imports
- Orphan files not imported by any module
- Feature flags or environment checks for features that shipped long ago
- Commented-out code blocks (dead weight, use git history instead)
- Unused CSS classes or Tailwind utilities
- Stale test files for deleted components

### 2. Code Complexity & Readability

- Functions exceeding 50 lines (should be split)
- Files exceeding 300 lines (should be modularized)
- Cyclomatic complexity > 10 (too many branches)
- Nesting depth > 3 levels (flatten with early returns or extraction)
- God components/files that do too many things
- Long parameter lists (> 4 params — use an options object)
- Complex ternary chains (should be if/else or switch)
- Magic numbers/strings without named constants

### 3. Type Safety & Patterns

- `any` types in TypeScript (loss of type safety)
- `as` type assertions hiding real type issues
- Missing return types on exported functions
- Inconsistent null handling (some use ?., others use &&, others use !)
- Mixed async patterns (callbacks vs promises vs async/await)
- Inconsistent error handling (some try/catch, some .catch(), some nothing)
- Non-exhaustive switch statements missing default cases

### 4. Naming & Consistency

- Inconsistent naming conventions (camelCase vs snake_case mixed)
- Misleading names (function named "get" that actually modifies data)
- Single-letter variable names outside of loops
- Inconsistent file naming (some PascalCase, some kebab-case)
- Boolean variables not prefixed with is/has/should/can
- Inconsistent import ordering across files

### 5. Duplication & DRY

- Copy-pasted code blocks (3+ similar blocks = needs abstraction)
- Multiple components doing the same thing slightly differently
- Repeated API call patterns that should be a shared hook/utility
- Same validation logic duplicated across endpoints
- Identical error messages hardcoded in multiple places
- Duplicated type definitions that should be shared

### 6. Technical Debt Markers

- TODO/FIXME/HACK/WORKAROUND comments — list each with location
- Temporary solutions that became permanent ("temporary" > 30 days old)
- Deprecated API usage (both internal and external)
- Legacy patterns mixed with modern patterns in the same codebase
- Missing error boundaries in React component trees
- Components with state that should be stateless (or vice versa)

### 7. Dependency Health

- Installed packages never imported in source code
- Multiple packages solving the same problem (e.g., two date libraries)
- Packages with known deprecation notices
- Version pinning issues (^ vs ~ vs fixed)
- Large packages imported for a single function (bundle bloat)
- Dev dependencies in production dependencies (or vice versa)

### 8. Architecture Smells

- Circular dependencies between modules
- Business logic in UI components (should be in services/hooks)
- Direct database calls in route handlers without a service layer
- Shared mutable state without proper synchronization
- API responses exposing internal data structures
- Missing abstraction layers (UI directly coupled to DB schema)

## Health Ratings

- **CRITICAL**: Actively causing bugs or blocking development
- **HIGH**: Significantly impacts maintainability or developer velocity
- **MEDIUM**: Code smell that will become a problem as codebase grows
- **LOW**: Improvement opportunity, nice to have
- **INFO**: Best practice suggestion

## Output Format

For each finding:
1. Severity level
2. Category (from the 8 above)
3. File and line (if applicable)
4. Description of the issue
5. Why it matters (impact on maintainability/velocity)
6. Recommended fix with before/after code example

End with a **HEALTH SCORE CARD**:
- Overall Health: A/B/C/D/F grade
- Total findings by severity
- Top 3 areas needing immediate attention
- Estimated technical debt hours
- Comparison to industry standards for a codebase this size
