# Personal agent

This fork adds one long-running thread per environment that belongs to the user
rather than to a project. It always leads the pinned threads at the top of the
sidebar, and the Android app shows it as a **Personal agent** card above the
thread list. Before it exists (or while it is unpinned or archived), open it from
**Personal agent** at the bottom of the sidebar, or at `/personal`.

The first open creates:

- the folder `<T3 home>/personal` (normally `~/.t3/personal`), registered as the
  **Personal** project;
- the thread `personal-agent` in it, pinned, so it stays at the top and is never
  auto-settled. Its first run uses the model a new chat would start with.

The agent's instructions are `AGENTS.md` in that folder; `CLAUDE.md` imports it.
The server rewrites `AGENTS.md` each time the agent is opened, so edit the
prompt in `apps/server/src/project/PersonalAgent.ts`, not on disk. The agent
keeps its memory next to it, and these files are never overwritten:

- `USER.md`: durable facts and preferences about the user;
- `NOW.md`: the board of active work, with links to the threads doing it;
- `journal/YYYY-MM-DD.md`: a dated log.

The thread is never cleared. Providers compact its context as it grows; the
memory files are what carry over. The agent reaches other projects through the
T3 MCP tools (`t3_project_list`, `t3_thread_list`, `t3_thread_read`,
`t3_thread_launch`, `t3_thread_send`, …). Project work goes into threads it
launches in those projects, never into its own folder.

Unpinning, archiving or renaming the thread are ordinary thread actions.
Opening the personal agent again unarchives it.
