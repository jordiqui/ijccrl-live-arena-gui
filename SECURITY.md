# Security Policy

## Supported branch

Security fixes are applied to the current `main` branch.

## Reporting a vulnerability

Do not publish credentials, personal data, private tournament evidence, or a working exploit in a public GitHub issue.

Use GitHub's private vulnerability reporting/security-advisory mechanism for this repository. Include:

- the affected commit and file;
- the deployment mode and Node.js version;
- reproducible steps using non-sensitive test data;
- the expected and observed behaviour;
- the security impact;
- any proposed mitigation.

## Operator responsibilities

Production operators must provide their own secrets through environment variables, restrict chat origins, enable secure cookies behind HTTPS, disable local verification-code echo, and protect the `out/` directory because it can contain user records, chat state, vote data, PGN evidence, and SQLite databases.

No secret value should ever be committed to this repository.
