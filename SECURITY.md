# Security Policy

## Supported versions

Only the latest release of Clickr AI gets security fixes: https://github.com/JustEhannn/clickr-ai/releases/latest

## Reporting a vulnerability

Please do not open a public issue for a security problem.

- Use GitHub's private reporting: **Security → Report a vulnerability** on this repository, or
- email clickraisupport@gmail.com with "Security" in the subject.

Include what you found, how to reproduce it, and which version you used. I aim to reply within a week and to fix confirmed problems in the next release, and I'll credit you if you'd like.

## What Clickr does and doesn't do

- It runs the AI model on your own computer. It has no accounts and no servers of its own, and it sends no telemetry.
- It connects to GitHub (to download the pinned llama.cpp engine and check for updates) and to Hugging Face (to download the model you choose).
- App updates are signed; the app only installs an update signed with the project's key.
- Agent Mode can click, type and change files on your computer, so it asks for approval before actions that matter and has a Stop button.
