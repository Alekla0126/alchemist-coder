# Security Policy

Please **do not** open public issues for security problems.

Report vulnerabilities privately through GitHub's **"Report a vulnerability"** button (Security → Advisories) or by email to security@alekla.com. Include steps to reproduce and the affected version. We aim to acknowledge reports within 72 hours.

Especially relevant areas: handling of API keys and tokens, the IPC bridge between the renderer and the main process, subprocess execution of agent CLIs, and anything that could write to `~/.claude` or `~/.codex`.
