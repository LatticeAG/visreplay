# Security policy

## Supported versions

The current `1.x` release line of `@latticeag/visreplay` is supported.

## Reporting a vulnerability

Report vulnerabilities through GitHub private vulnerability reporting on
[LatticeAG/visreplay](https://github.com/LatticeAG/visreplay).

Do not file secrets, session files, or live credentials in public issues.

## What this package does and does not promise

VisReplay is a local recorder. Session files are plaintext JSON on the user's
disk. Default key and pattern redaction is best-effort. It is not a guarantee
that a secret never reaches a file.

A value already written to a local session file cannot be recovered as
unredacted by this project, and this project will not promise that recovery.
If a live credential was recorded, rotate it.

Do not commit live keys. Use environment variables for credentials in any
application that you wrap with this SDK.
