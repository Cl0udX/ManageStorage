# .opencode

Configuración de agentes para trabajar este proyecto con opencode (u otra IA). **El contexto completo está en `../AGENTS.md`**
(opencode lo carga solo; `opencode.json` además referencia `docs/ARCHITECTURE.md`).

- `agents/` — subagentes: `sync-guardian`, `tester`, `ui-friendly`, `deployer`, `db-inspector`
- `commands/` — `/test`, `/status`, `/db`, `/backup`

Si usas otra herramienta (Claude Code, Codex, Cursor…), pídele que lea `AGENTS.md` y `docs/ARCHITECTURE.md` y trate los
archivos de `agents/` como "roles" con sus permisos: cada uno dice qué puede y qué no puede tocar.
Nota de formato: opencode ≥1.x usa `.opencode/agents/` y `.opencode/commands/` (plural).
