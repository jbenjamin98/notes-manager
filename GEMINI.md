# Project Context & Multi-Agent Rules
- Read `SPEC.md` in the project root for the complete product architecture, schemas, and feature requirements before writing code.
- **Multi-Agent Environment:** This workspace is co-developed alongside Claude Code (`CLAUDE.md`).
- **Before Editing:** Always inspect the current state of files on disk (`package.json`, `src/main`, `src/preload`, `src/renderer`) rather than assuming prior state, as Claude Code may have modified IPC handlers, schemas, or components in a prior turn.
- **Architectural Consistency:** Match existing TypeScript interfaces, `contextBridge` (`window.api`) signatures, Tailwind v4 styling conventions, and SQLite (`sql.js` / `node:sqlite`) patterns already established in the codebase.
- **Spec Sync:** If we agree on a technical change that diverges from `SPEC.md`, update `SPEC.md` alongside the code so both agents stay aligned.