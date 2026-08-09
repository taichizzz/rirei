# Security Policy

## Supported Versions

Rirei is pre-release software. Security fixes are applied to the current `main` branch and the
latest published release only.

## Reporting a Vulnerability

Please use GitHub's private vulnerability reporting for this repository. Do not open a public
issue containing credentials, private paths, provider transcripts, terminal output, approval
payloads, or exploit details.

Include the affected version or commit, operating system, reproduction steps, expected impact,
and whether the issue requires a malicious repository or local process. Remove tokens and
personal data from logs before attaching them.

You should receive an acknowledgement within seven days. Publication timing will be coordinated
after a fix is available.

## Scope

Security-sensitive areas include state-file confinement, Git/worktree safety, provider command
construction, PTY ownership, Electron IPC, deep links, activity snapshots, usage collectors,
and the future authenticated permission-approval channel.

See `docs/security.md` for the product's trust boundaries and current limitations.
