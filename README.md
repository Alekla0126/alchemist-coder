<div align="center">

# ⚗ Alchemist Coder

**The lab for your coding agents.**

Open several projects at once, follow every agent and every subagent it spawns, let Claude Code, Codex, Gemini CLI and Grok Build compete on the same task, edit with your VS Code themes (or any from Open VSX), and resume any conversation.

[coder.alekla.com](https://coder.alekla.com) · [Español](#español) · AGPL-3.0

</div>

> **Status: public beta (0.1.4).** [Download](https://coder.alekla.com/#download) for macOS (Apple Silicon or Intel), Windows or Linux (AppImage or .deb), or from [Releases](https://github.com/Alekla0126/alchemist-coder/releases). The builds aren't signed yet: the first time, on a Mac right-click the app and choose Open; on Windows choose More info → Run anyway. Things move fast and may break; feedback and issues are welcome.

## What it does

- **One history for all four agents.** Indexes Claude Code (`~/.claude/projects`), Codex (`~/.codex/sessions`), Gemini CLI (`~/.gemini/tmp/*/chats`) and Grok Build (`~/.grok/sessions`) into a local SQLite index with full-text search. Your original files are only read, never modified.
- **Keep every conversation.** Claude Code deletes transcripts after 30 days by default; the opt-in versioned backup mirrors your Claude Code and Codex history into a git repository you choose, and conversations the CLIs delete stay in the app. Export any conversation, subagents included, to Markdown, HTML or JSON.
- **An organization of agents.** A standing coordinator takes your assignments, plans them (review the plan first if you like) and hands the work to the agents you add over time, each with its own role and instructions, model, permissions and projects. A "Needs you" inbox gathers their questions, permission requests and plans, and each agent keeps a record of what it did.
- **Every project's agents in one place.** Switch the sidebar to All projects to follow the conversations and agents of every open project without switching, and read each conversation as one clean document.
- **Marketing mode.** A brand guide every agent reads (marketing/BRAND.md), a studio for posts, threads, emails, App Store and Google Play listings with real character limits and previews, an editorial calendar, and a marketing team in your organization. Agents may only claim what the brand guide lists.
- **A board for the work.** The Board lays out every task and conversation by phase (backlog, planning, implementing, validating, done). Conversations move on their own as their agents work; write tasks down and hand one to an agent with a click; open, close and reopen cards from icons on each card.
- **Everything about a message in chips.** Agent or Plan mode, permissions, agent CLI, model, reasoning effort, ready-made actions (plus your project's own in `ai-actions.md`) and how full the context is, all one click away under the message box.
- **Fits half a screen.** Fold the sidebar with one button (⌘B) or by dragging it away; below 900 px the sidebar floats over the page and the modes fit in one menu, so the app works side by side with another window.
- **Agent tree.** Every conversation shows the main agent, the subagents it launched and the ones those launched in turn, with live status, tokens, time, estimated cost, worktree and branch. Add an agent right there (its main agent launches it, with the type and task you choose), or take one out of the list or stop it.
- **Several projects at once**, with modes for agents, code, split view, terminal and history.
- **Four coding agents, one workspace.** Claude Code, Codex, Gemini CLI and Grok Build run through the [Agent Client Protocol](https://agentclientprotocol.com): you see their plan, every tool call, file diffs and cost live, approve or deny each permission inline, and switch mode (ask, accept edits, plan, allow everything) or model mid-session.
- **Arena: plan first, then let agents compete.** A planner agent drafts a plan in read-only mode; you edit and approve it; one to four agents (mix CLIs and models) solve the task in parallel, each in its own git worktree under `.alchemist/worktrees`. Compare their changes, diffs, tests, time and cost, then merge the winner (squash or merge commit) — your checkout is untouched until then.
- **Preview what agents build.** HTML and mockups run in a sandboxed, offline iframe; Markdown renders with Mermaid diagrams; images and SVG open as images — next to the code, or per agent in the Arena.
- **One extensions hub for four CLIs.** See every MCP server, skill and hook across Claude Code, Codex, Gemini CLI and Grok Build (including what Grok imports from Claude), copy a server to the agents that lack it with their own `mcp add`, and share one `AGENTS.md` with every agent.
- **Run agents with local models** (Ollama, LM Studio) — Claude Code and Codex work fully offline in the Community edition.

## Editions

| | Community (this repo) | Pro |
|---|---|---|
| License | AGPL-3.0 | Proprietary |
| History, search, agent tree, projects, modes | ✅ | ✅ |
| Agents with local models | ✅ | ✅ |
| Claude, ChatGPT, Gemini, Grok and Kimi K3 with your own account | — | ✅ |
| Sign in and end-to-end encrypted sync | — | ✅ |

Alchemist Coder never charges for tokens: you bring your own models, subscriptions and API keys.

## Requirements

- Node.js 22.13+ (the indexer uses the built-in `node:sqlite`) and pnpm 8+
- To run agents: `npx` (Node.js) for the Claude Code and Codex ACP adapters (pinned versions, fetched on first use), [Gemini CLI](https://github.com/google-gemini/gemini-cli) for Gemini, and optionally [Grok Build](https://x.ai/cli) (otherwise fetched through `npx`)
- Optional: [Ollama](https://ollama.com) or LM Studio for local models

## Getting started

```bash
pnpm install
pnpm dev          # run the desktop app
pnpm test         # unit tests
pnpm typecheck
pnpm index:smoke  # index your real history into a throwaway database and print stats
```

## Repository layout

```
apps/desktop            Electron app (main, preload, React renderer)
packages/core           Shared types, extension API, pricing, edition rules
packages/indexer        Claude Code + Codex parsers, agent tree, SQLite/FTS5 index, file watcher
packages/harness        ACP client for Claude Code, Codex, Gemini CLI and Grok Build (plus headless claude/codex fallbacks)
packages/providers-local Local model providers (Ollama, LM Studio)
packages/arena          Plan-first prompts and git worktrees for the Arena (create, diff, test, merge, clean up)
packages/themes         VS Code themes from .vsix packages and Open VSX (zip, JSONC, includes, checksums)
packages/archive        Conversation export (Markdown, HTML, JSON) and the versioned history backup
packages/extensions     Reads and edits the MCP servers, skills, hooks and instructions of the four agent CLIs
```

Extensions register harnesses, providers and feature gates through `defineExtension()` in `@alchemist-coder/core`.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md). Contributions require signing the [CLA](CLA.md) once.

## License

[GNU AGPL-3.0](LICENSE). Claude and Claude Code are trademarks of Anthropic, PBC. ChatGPT and Codex are trademarks of OpenAI. Kimi is a trademark of Moonshot AI. Alchemist Coder is an independent project and is not affiliated with any of them.

---

## Español

**El laboratorio de tus agentes de código.** Abre varios proyectos a la vez, sigue cada agente y cada subagente que lanza (y añade o quita agentes ahí mismo, en el árbol de la conversación), edita con tus temas de VS Code y retoma cualquier conversación de Claude Code o Codex. Conserva tu historial con un respaldo versionado (Claude Code borra las conversaciones de más de 30 días) y exporta cualquier conversación a Markdown, HTML o JSON. Claude Code, Codex, Gemini CLI y Grok Build corren por el Agent Client Protocol: ves su plan, cada herramienta, los diffs y el costo en vivo, y apruebas o niegas cada permiso ahí mismo. En la **Arena**, un agente planifica, tú apruebas el plan y hasta cuatro agentes compiten en worktrees de git; comparas sus cambios y tests y fusionas el mejor. La vista previa muestra el HTML, Markdown con diagramas e imágenes que crean los agentes, y el centro de extensiones ordena los MCP, skills, hooks y AGENTS.md de los cuatro CLIs. Con **Todos los proyectos** sigues a los agentes de cada proyecto abierto sin cambiar de proyecto; el **Tablero** ordena tareas y conversaciones por fase (pendiente, planificando, implementando, validando, hecho) con botones claros para abrir, cerrar y reabrir; los chips bajo el mensaje eligen modo, permisos, agente, modelo, esfuerzo y acciones y muestran el contexto; la barra lateral se pliega con un botón y la app cabe en media pantalla. El modo **Marketing** trae guía de marca, estudio de contenido con límites reales por red, calendario editorial y un equipo de marketing. En la vista **Organización**, un coordinador permanente recibe tus encargos, los planifica y reparte el trabajo entre los agentes que vas sumando, cada uno con su rol, instrucciones, modelo, permisos y proyectos. La edición Community es open source (AGPL-3.0) y funciona con modelos locales. [Descárgala](https://coder.alekla.com/es/#download) para macOS, Windows o Linux (beta pública, todavía sin firma: la primera vez, en Mac haz clic derecho en la app → Abrir; en Windows, Más información → Ejecutar de todas formas). Para contribuir, lee [CONTRIBUTING.md](CONTRIBUTING.md).
