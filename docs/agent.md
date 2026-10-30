# The agent

HeyNimbo has one agent. Voice and typed questions, explanations about the screen,
2D cards and 3D models, web research, files and coding all go through the same
turn; there is no separate Explain and Do mode. The model decides per request
whether to answer directly or to use tools, and keeps speaking and drawing while
it works.

## Engine

The agent runs on [Pi](https://github.com/badlogic/pi-mono)'s SDK
(`@earendil-works/pi-coding-agent`), in-process in Electron main
(`src/main/agent/engine.ts`). This is the same engine OpenBot runs for key-only
providers. Pi is ESM-only, so it is loaded with a dynamic `import()`.

- One Pi session per conversation, kept in memory (at most eight). A conversation
  reopened after a restart is seeded once with its saved exchanges.
- The answer connection from Settings maps to a Pi model. IDs Pi does not list yet
  reuse a sibling model of the same provider; OpenAI-compatible endpoints get a
  custom `openai-completions` model. The key is set per turn as a runtime key, so
  Pi never writes credentials.
- Pi's state lives in `userData/agent`, never in the owner's `~/.pi`.
- Screenshots are sent unresized: their pixels are the drawing coordinate space.
- Assistant text streams into the existing sentence/drawing parser, so speech, 2D
  and 3D work exactly as before. Tool steps are saved on the turn (`scene.steps`)
  and shown in Home and the notch.

## Tools

| Tool | What it does | Needs the owner's OK |
|---|---|---|
| `web_search` | Exa's keyless hosted search (MCP over HTTP) | No |
| `web_fetch` | Reads a public page through the SSRF-guarded fetch | No |
| `read`, `grep`, `find`, `ls` | Pi's file tools | No |
| `write`, `edit` | Pi's file tools | Only outside `~/HeyNimbo` |
| `bash` | Pi's shell tool | Every command (or once per conversation) |

`src/main/agent/policy.ts` decides before every call, in code. It resolves paths
exactly as Pi does (`@`, `~`, `file://`, symlinks including dangling ones) and the
tool then runs on the judged path. The file tools never open secret stores (`.ssh`,
`.env*`, keys, `credentials.json`/`auth.json`, Keychains) or HeyNimbo's own data
folder, and grep results from such files are dropped before the model sees them.
A command the owner approves runs with the owner's full access, which no path rule
limits; the approval sheet says so. Approvals are a sheet on Home whose text main
builds; a parentless dialog would run app-modal and freeze the app. Stop closes a
pending approval as a denial.

## Skills

Pi loads [Agent Skills](https://agentskills.io/specification) (`SKILL.md`
folders) from `~/.agents/skills`, `userData/agent/skills` and the workspace's
`.agents/skills`, the same folders Pi, Hermes and OpenBot share. The model sees
each skill's name and description and reads the full instructions when a task
matches.
