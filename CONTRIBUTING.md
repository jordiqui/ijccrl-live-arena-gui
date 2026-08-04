# Contributing

Contributions are accepted through pull requests against `main`.

## Scope

A pull request must contain only source code, documentation, or small redistributable assets with a verified license. Do not include:

- UCI engine binaries or source trees copied from engine projects;
- NNUE/network files, learning files, or tablebases;
- opening databases, PGN game collections, results, or scheduler state;
- `node_modules/`, ZIP archives, logs, HAR captures, debug traces, or backups;
- `.env` files, passwords, tokens, SMTP credentials, payment secrets, or personal data.

## Validation

Run before opening a pull request:

```text
npm ci
npm run check
```

For runtime changes, test with operator-supplied engines and a non-committed opening PGN. Describe the test environment and results in the pull request.

## Licensing

By submitting a contribution, you agree that your contribution may be distributed under the Apache License 2.0. Do not submit code or assets that you do not have the right to license under compatible terms. Third-party modifications must retain their upstream notices.
