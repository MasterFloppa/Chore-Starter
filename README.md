# Chore Starter

**Give it the task. Get the first draft. You stay in charge.**

A minimal, local-first AI personal assistant for the chores you keep putting off.
It prepares a useful draft and a small checklist from a plain-language task.
Nothing is sent, submitted, purchased or scheduled automatically.

Built for the Hacktoberfest Open-Source AI Challenge, Week 3: Slow and Steady.

## What it does

- Give it a task in plain language: a refund request, an awkward message, or a chore you need to plan.
- A local Ollama model prepares an editable **email**, **message**, or **plan**, with a short review checklist.
- Missing details are requested or left as placeholders. Read the result before using it: an AI can still make mistakes.
- Your tasks and edits stay in local history. No account or hosted AI key is required.
- **Copy**, **download**, and **open email draft** all require a separate preview and confirmation.
- No email is sent. Nothing is purchased, submitted, scheduled or changed in an external account.

This is a preparation assistant, not an autonomous agent that operates your computer.

## Run it

You need **Node 22.12+** and [Ollama](https://ollama.com). Node 24 is recommended.

```powershell
ollama pull gemma3:4b
npm install
npm start
```

Open **http://127.0.0.1:8788**. Keep the terminal open; Ctrl+C stops the app.

If `gemma3:4b` is already installed, skip the pull. Use the **Local AI / Model setup** button to choose
another installed model. On a laptop CPU, preparation may take 30–90 seconds.

For development, `npm run dev` runs the API on port 8788 and the UI on **http://127.0.0.1:5174**.

## A typical workflow

1. Describe the task, or select an example and change its details.
2. Click **Prepare it**. This runs AI and saves a draft locally; it does not carry out the chore.
3. Edit the wording, fill the placeholders, and review the checklist.
4. Choose **Copy draft**, **Download task**, or **Open email draft**.
5. Read the exact content in the preview. **Cancel** does nothing; **Confirm** authorizes that one action.
6. If you open an email draft, your own email app still handles review and sending.

Previously prepared tasks can be reopened from the history at the bottom of the page.
The confirmation history records approvals, not proof of email delivery or task completion.

## How confirmation works

The model only produces structured text. It has no tools or execution permissions.

The server creates a random, two-minute approval token bound to the **task, revision, action and content**.
An edit revokes outstanding previews. A cancelled, expired or already-used token is rejected.
Confirming a copy cannot be turned into an email handoff. Approvals do not survive a server restart.

Supported actions are a small allowlist, not arbitrary code or model-generated commands:

| Action | What confirmation permits |
| --- | --- |
| Copy draft | Release the reviewed text for copying in the browser |
| Download task | Download a Markdown bundle in the browser |
| Open email draft | Open an encoded `mailto:` link for the recipient you entered; never send |

No mail provider, calendar, payment service, shell or web-automation connector is installed.

## Architecture

```text
React + Vite
    |
    v
Local Hono API (127.0.0.1 only)
    |-- Ollama -> Gemma 3 4B -> validated draft
    |-- revisioned drafts -> local JSON file
    `-- preview -> confirmation gate -> browser copy / download / email draft
```

The API rejects foreign origins and requires a browser session token for writes.
The model endpoint is restricted to loopback addresses, and model requests do not follow HTTP redirects.
Cloud-backed models advertised by a local Ollama server are excluded and cannot receive a task.
Nothing in this app runs on a recurring timer.

## Configuration and privacy

Copy `.env.example` to `.env` if you need to change a default. Shell environment variables take precedence.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8788` | Local API and production UI port |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Local Ollama endpoint; hosted endpoints are rejected |
| `CHORE_STARTER_MODEL` | `gemma3:4b` | Model for a new installation; later changes use Settings |
| `CHORE_STARTER_DATA` | `data/state.json` | Project-relative or absolute storage path |

Tasks, prompts and approval history are stored unencrypted on this machine in `data/state.json`.
Protect that file as personal data; it is excluded from Git. An unreadable or corrupt file is not silently replaced.
For a fresh start, stop the app, back up the file, then remove it before restarting.
The default history limit is 200 tasks.

Preparing a task contacts your **local Ollama endpoint**. Copying or downloading stays in your browser.
Choosing an email handoff passes the reviewed draft to your configured email application.
The app has no analytics, no cloud AI fallback and no background sending.

## Checks

```powershell
npm run typecheck
npm test
npm run build
```

The automated checks use a fake model and temporary data. No Ollama installation or personal task data
is needed to run them. They cover storage, input validation, model failures, revision conflicts and the confirmation gate.

## Troubleshooting

- **Model setup / Ollama offline:** start Ollama and choose an installed model. No fabricated draft is substituted on failure.
- **Port already in use:** stop the other process using that port or set `PORT` in `.env`.
- **Confirmation expired / draft changed:** reopen the action preview and check the current version.
- **Clipboard access blocked:** the app offers the approved text for manual copying.
- **Connection lost while cancelling:** the preview still closes; any unused server approval expires after two minutes. A warning explains that server-side revocation could not be confirmed.
- **Email app does not open:** configure a default mail app, or copy the reviewed draft manually.
- **Not a public demo:** localhost is only accessible on this machine. Use a video for the challenge submission unless you separately deploy a demo.

## Challenge

Built for [Hacktoberfest Open-Source AI Challenge Week 3: Slow and Steady](https://dev.to/challenges/hacktoberfest-week3-2026-10-19).
Gemma provides the open-weight language layer. GitHub Copilot was used during development.

## License

MIT
