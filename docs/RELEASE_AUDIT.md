# Public Source Release Audit

## Scope

This audit records the transformation of the operator archive `IJCCRL_UCI_Proxy.zip` into a source-only public repository. It is not a runtime-data migration and does not transfer engines, games, databases, credentials, or generated evidence.

## Source archive inventory

- Files: **5,076**
- Uncompressed size: **2.86 GiB**
- `.txt` files: **3,657**
- Runtime/output/debug files: **4,078**
- Backup or superseded-path matches: **1,592**
- Engine/binary/network matches: **208**
- Opening/game/database matches: **25**
- Installed dependency files under `node_modules/`: **841**

The category counts overlap by design and are used as exclusion controls, not as mutually exclusive accounting totals.

## Public release inventory

- Files: **48**
- Total size: **1.73 MiB**
- Runtime engines included: **0**
- Opening suites or tournament PGNs included: **0**
- SQLite databases included: **0**
- Runtime `out/`, historical `out_prev_*`, logs, packet captures, or debug traces included: **0**
- Backup copies included: **0**
- `.txt` files included: **0**
- Committed credentials or hosted-payment identifiers included: **0 detected by the release scanner**

## Retained source groups

- Tournament server, deterministic scheduler, UCI process bridge, and PGN store.
- WebSocket broadcast and moderated chat modules.
- Optional account/support/payment-return modules, disabled unless explicitly configured.
- Browser application and the minimum vendored browser dependencies required to render it.
- PGN audit and deduplication utilities.
- Installation, architecture, configuration, security, contribution, citation, and licensing documentation.

## Exclusion policy

The release excludes `node_modules/`, engines, neural networks, tablebases, opening suites, games, runtime state, databases, credentials, logs, archives, backups, and superseded copies. `.gitignore` repeats these controls to prevent accidental reintroduction.

## Validation performed

- JavaScript syntax validation with `node --check` for all retained authored entry points and the inline browser application script.
- Python bytecode compilation for the retained Python utilities.
- Repository-path policy scan for prohibited extensions and directory names.
- Pattern scan for private Windows workspace paths, embedded hosted-payment identifiers, private keys, and common credential formats.
- Local asset-reference verification for the browser's required JavaScript and CSS files.
- Controlled local startup with two external UCI mock processes and an external minimal PGN: `/health`, `/conditions`, and the browser root responded successfully; the deterministic scheduler loaded one opening and started the UCI match loop.

Dependency installation is defined by `package-lock.json` and is also checked by the repository's GitHub Actions workflow on a clean runner.
