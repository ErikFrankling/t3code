# Claude

T3 Code uses Claude Code's login and configuration. Start with the default provider
for one account; [provider setup](./install.md#providers) covers installation and
shared provider settings.

## Separate accounts or configurations

Use a separate Claude config directory for each account. This also works for named
presets that need different Claude settings or a router connection.

Keep your existing account in the default directory. On the environment's machine,
create the second login:

```bash
mkdir -p ~/.claude_personal
CLAUDE_CONFIG_DIR=~/.claude_personal claude auth login
```

Add another Claude instance in **Settings > Providers**:

| Instance        | Binary path | CLAUDE_CONFIG_DIR path |
| --------------- | ----------- | ---------------------- |
| Claude Work     | `claude`    | Leave empty            |
| Claude Personal | `claude`    | `~/.claude_personal`   |

An empty config-directory setting uses Claude Code's normal configuration. The
custom setting changes `CLAUDE_CONFIG_DIR`, leaving `HOME` and the system keychain
location intact. Use the same variable for the login command. Setting `HOME`
instead can put credentials where this provider will not find them.

Check the account reported in provider settings after signing in. By default,
only Claude instances with the same config directory can resume the same native
session. Separate account directories keep their local conversation state isolated.

For presets that differ only in API keys or endpoints, use the instance's
**Environment variables**. Variable assignments do not belong in **Launch arguments**.

Claude Code's verbose mode can stay enabled when you use Claude for text generation, including
thread titles, branch names, commit messages, and pull request descriptions. On a remote connection,
T3 Code uses the Claude configuration on the connected server.

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

Set **Auto-compact after** in the Claude provider settings to an integer between
`100000` and `1000000`. For example, `300000` asks Claude to summarize at about
300,000 tokens. This changes when compaction happens, not the model's context
window. Leave it empty for Claude Code's default.

You can also send `/compact` in an existing conversation. Web and desktop offer
**Compact context** from the context meter. When you return to a large thread
after Claude's prompt cache expires, a **Compact** chip with the thread's token count shows
next to the send button. While it is on, Enter summarizes the history first, then
sends your message. Click the chip to switch it to **Full** and keep the full
history for that message. The cache lasts about an hour on a Claude
subscription and 5 minutes with an API key, Bedrock, or Vertex. See [commands and skills](./composer.md#commands-and-skills) for using
composer commands.

**Compact idle threads** in **Settings > Providers > Advanced** controls this for threads
over 200,000 tokens. Each Claude provider's settings can override it:

- **When you return** shows the **Compact** chip described above. This is the default.
- **Before the cache expires (beta)** compacts an idle thread shortly before its
  prompt cache expires, so coming back does not reprocess the whole conversation.
  The compaction appears in the thread as a `/compact` turn sent by T3 Code.
- **Never** skips idle compaction and Claude's resume prompt. **Auto-compact after**
  still applies, and you can still compact by hand.

## Usage limits

If your Claude subscription runs out of usage mid-turn, the thread shows which
limit was reached and the remaining wait when Claude provides a reset time.
Claude Code holds the turn until that window reopens, so it can keep showing as
working. Wait for the reset, or stop the turn and continue later. The warning's
timestamp shows when the displayed wait started.

## Skills

Claude skills come from the config directory's `skills` folder and the project's
`.claude/skills` folder. If both define the same name, the config-directory copy
wins. Skills disabled in Claude's settings do not appear in the composer.

Use `$` in the composer to select a skill. Enabled installed Claude plugins also
contribute skills under names such as `plugin:review`. Skills marked `disable-model-invocation`
can still be started by you. Invoke those one per message: Claude directly runs
only the last named skill and may try to start earlier ones through its Skill
tool, which refuses skills reserved for manual invocation.

## Task lists

To show Claude task lists in the web and desktop apps, add
`CLAUDE_CODE_ENABLE_TODO_TOOLS=1` under **Variables** in the Claude instance's
**Environment** section in **Settings > Providers**. Each update shows as a Tasks
row in the thread; open it to see every step.

## OpenRouter

Create a Claude instance with its own config directory, such as
`~/.claude_openrouter`, and keep **Binary path** set to `claude`. In that instance's
**Environment variables**, use:

| Variable               | Value                                     |
| ---------------------- | ----------------------------------------- |
| `ANTHROPIC_BASE_URL`   | `https://openrouter.ai/api`               |
| `ANTHROPIC_AUTH_TOKEN` | Your OpenRouter API key, marked Sensitive |
| `ANTHROPIC_API_KEY`    | An explicitly empty value                 |

If that Claude config directory has a cached Anthropic login, run `/logout` in a
Claude Code session using that directory before starting the router setup. Cached
login credentials can conflict with the router token.

Select the model you want in T3 Code. For an OpenRouter model outside the built-in
list, open that Claude instance in **Settings > Providers** and add its full model
ID with **Add custom model**. Then select it in the chat model picker.
`ANTHROPIC_DEFAULT_*_MODEL` variables map Claude Code aliases such as `sonnet`; they
do not replace the explicit model ID selected in T3 Code. Custom models may have
fewer effort, thinking, or context controls than built-in models.

Verify the model used in OpenRouter's activity dashboard. For current compatibility
requirements, use the
[OpenRouter Claude Code guide](https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration).

## Other routers

A local router uses an ordinary Claude provider instance. Give it a separate
config directory and put the router's endpoint and credential variables in that
instance's **Environment variables**. The router must run where the environment
can reach it. Follow the [Claude Code Router instructions](https://github.com/musistudio/claude-code-router)
for its installation and routing configuration.
