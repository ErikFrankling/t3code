# Claude

T3 Code drives your Claude Code installation, login, skills, and plugins. See [provider setup](./install.md#providers) for initial installation.

## Multiple accounts and presets

Isolate separate Claude accounts or router presets with distinct `CLAUDE_CONFIG_DIR` directories:

```bash
mkdir -p ~/.claude_personal
CLAUDE_CONFIG_DIR=~/.claude_personal claude auth login
```

Add a second Claude instance in **Settings → Providers** (or **Add Claude account** on mobile) pointing **CLAUDE_CONFIG_DIR path** to `~/.claude_personal` (leave empty for the default directory). Always use `CLAUDE_CONFIG_DIR` rather than `HOME` so system keychain paths stay intact.

- By default, existing threads can only switch between Claude instances sharing the same config directory (see [Resume the same session with another account](#resume-the-same-session-with-another-account)).
- Put API keys and endpoint overrides in **Environment variables** (not **Launch arguments**).
- Paths in `--settings` and `--append-system-prompt-file` expand `~` to the server's home directory; other relative paths resolve from the thread's workspace.

## Resume the same session with another account

To continue an existing thread when one Max account reaches its limit, opt both
Claude instances into a **Shared session group**. They must also share their
`projects` directory on the environment's machine. The group setting declares
that transcripts are shared; T3 Code does not create links or copy files for you.

For account A in `~/.claude` and a new account B in `~/.claude_2`:

1. Stop any Claude turns using these directories before changing storage.
2. Sign in separately:

   ```bash
   mkdir -p ~/.claude_2
   CLAUDE_CONFIG_DIR=~/.claude_2 claude auth login
   ```

3. Share only the transcript directory. If `~/.claude_2/projects` already exists,
   back it up first and merge any sessions you want to retain into the shared
   directory without overwriting files. The link destination must not already
   exist; do not run `ln` against an existing directory.

   ```bash
   mkdir -p ~/.claude/projects
   ln -s ~/.claude/projects ~/.claude_2/projects
   ```

4. In **Settings > Providers**, set account B's **CLAUDE_CONFIG_DIR path** to
   `~/.claude_2`. Set **Shared session group** to the same name, such as
   `personal-max`, on **both** instances. Leave each instance's credentials and
   other settings separate.
5. Stop the limited turn, select account B in the existing thread's model picker,
   and send your next message. T3 Code resumes the original Claude session ID
   (the SDK's `resume` option launches `claude --resume <session-id>`), retaining
   its saved context instead of creating a summary handoff. Switching back works
   the same way. Threads started before enabling the group are supported.

Only group names that match after trimming whitespace share continuation.
Blank groups retain the default config-directory behavior. Clear the setting on
both instances to opt out of cross-directory continuation; this does not undo
the filesystem link. To separate storage again, stop all affected turns and
replace the link with an independent directory, preserving any sessions you need.

The shared directory includes transcripts, subagent transcripts, and project
auto memory; it exposes those to both accounts. It does not share login credentials,
settings, or skills. Do not run the same session concurrently from another CLI
or thread. A matching group without accessible transcripts cannot resume a session.
See Claude Code's [directory reference](https://code.claude.com/docs/en/claude-directory)
and [CLI reference](https://code.claude.com/docs/en/cli-reference).

## Compact long conversations

- **Auto-compact threshold**: Set **Auto-compact after** (`100000`–`1000000` tokens) in the Claude instance settings to trigger summarization earlier without changing the model's context window.
- **Manual compaction**: Send `/compact` in chat.
- **Idle compaction (>200k tokens)**: Configure **Settings → Providers → Advanced → Compact idle threads** (overridable per instance):
  - **When you return** (default): Shows a **Compact** chip next to Send once Claude's prompt cache expires (~1 hour on subscriptions, 5 min on API/Bedrock/Vertex). Click it to switch to **Keep** if you want full history.
  - **Before the cache expires (beta)**: Automatically sends `/compact` shortly before the cache expires while history is still cached (falls back to **When you return** if missed).
  - **Never**: Disables idle compaction prompts.

## Steering, usage limits, and tasks

- **Steering**: Steered messages wait until Claude finishes its active tool calls, then enter the same turn (or queue for the next turn if Claude exits or drops them).
- **Usage limits**: Mid-turn limit hits display the window and reset time; Claude holds the turn until reset, or you can stop and resume later.
- **Task lists**: Add `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` in the instance's **Environment → Variables** to show Claude's task list progress in web and desktop threads.
- **Auto mode**: Uses Claude Code's native auto mode (disabled if `disableAutoMode` is set in Claude's managed, user, or project settings). See [Permission modes](./permission-modes.md).

## Skills and MCP sign-in

- **Skills**: Loaded from `<CLAUDE_CONFIG_DIR>/skills`, the project's `.claude/skills` (config dir wins on name collisions), and enabled Claude plugins (e.g. `plugin:review`). Invoke via `$`. Send `disable-model-invocation` skills one per message.
- **MCP OAuth**: When a Claude MCP server needs sign-in, click **Sign in** on the thread notice, approve in your browser, and paste the final redirect URL into T3 Code (**Finish sign-in**). Connectors added on `claude.ai` authenticate there instead.

## Claude in Chrome

To use the [Claude in Chrome extension](https://code.claude.com/docs/en/chrome) in T3 Code threads, add `--chrome` to **Launch arguments** in the Claude instance settings (applies to new sessions). Requires a direct Anthropic `/login` plan—not supported with API keys, `setup-token`, Bedrock/Vertex, or WSL.

## OpenRouter and local routers

Create a separate Claude instance with its own config directory (e.g. `~/.claude_openrouter`, after running `/logout` if it had a cached Anthropic login) and set **Environment variables**:

| Variable               | Value                                    |
| ---------------------- | ---------------------------------------- |
| `ANTHROPIC_BASE_URL`   | `https://openrouter.ai/api`              |
| `ANTHROPIC_AUTH_TOKEN` | Your OpenRouter API key (mark Sensitive) |
| `ANTHROPIC_API_KEY`    | Explicitly empty                         |

Add unlisted OpenRouter models via **Add custom model** in the instance settings. See the [OpenRouter Claude Code guide](https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration) or [Claude Code Router](https://github.com/musistudio/claude-code-router) for local router setup.
