# Lobby

T3 Code runs [Lobby](https://lobby.abloatai.com) cloud agents as a provider. Each T3 thread on Lobby is
one Lobby chat: the agent works in Lobby's own sandbox on a GitHub repository, on the models connected
to your Lobby account, and the chat also shows in Lobby. T3 Code talks to Lobby through the Lobby CLI's
`lobby acp` command and Lobby's public API.

## Set Up Lobby

1. Install the Lobby CLI on the machine running the T3 Code server:
   `npm install --global @abloatai/lobby` (Node 24).
2. Sign in once with `lobby login` (add `--site` for another Lobby), then create an API key for the
   repositories chats may use:
   `lobby api-keys create --name t3code --account ACCOUNT_ID --repository REPOSITORY_ID --scopes account:read,workspace:read,agent:write --output ./lobby.key`.
3. Open **Settings → Providers**, add Lobby, paste the key into **Lobby API key** (stored as a T3 secret,
   never in the settings file), set **Lobby URL** if you use another Lobby, and enable it.

## Repository

A chat runs on the GitHub repository of the project folder: the `origin` remote of the thread's
folder, matched against the repositories your key covers. Set **Repository ID** to run every chat on
one repository instead. A folder without a GitHub origin, or a repository the key does not cover,
stops the first message with an error that says so.

## Models

The model picker lists the models connected to your Lobby account (Claude, Codex and pi models), each
named with where it runs. **Reasoning** offers the levels Lobby offers for that model. The model and
level apply when the chat starts; changing them later starts the next new thread on the new model.

## What Works

- Replies stream, and the agent's tool calls show with their output.
- **Stop** stops the Lobby agent's turn. A follow-up message queues behind a running turn.
- After a T3 restart, a thread continues its Lobby chat.

Lobby agents run without approvals, so Lobby offers only **Full access**. Attachments, rollback, forks
and `/compact` are not supported. Open the chat in Lobby for its terminal, previews and files.
