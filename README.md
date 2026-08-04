# IJCCRL Live Arena GUI

A real-time tournament controller and browser broadcast interface for UCI chess engines.

**Author and copyright holder:** Jorge Ruiz Centelles
**Primary license for the original IJCCRL source code:** Apache License 2.0

## Project status

This repository is the public, source-only distribution of the IJCCRL broadcast system. It contains the application code required to orchestrate UCI-engine matches, maintain deterministic tournament state, publish live data over HTTP and WebSocket transports, and render the IJCCRL live arena interface.

The repository intentionally contains **no chess-engine executables, neural-network files, Syzygy tablebases, opening databases, tournament PGNs, runtime output, user databases, credentials, logs, packet captures, or historical backups**. Operators must provide those resources separately and must comply with their respective licenses.

## Authorship and licensing boundary

The IJCCRL-specific architecture, orchestration logic, scheduler, UCI bridge, WebSocket/HTTP integration, support subsystem, tournament audit utilities, and application UI integration in this repository are original works authored by **Jorge Ruiz Centelles**.

Open source does not transfer copyright ownership. Copyright remains with Jorge Ruiz Centelles while the Apache License 2.0 grants recipients the rights defined in [`LICENSE`](LICENSE), including use, modification, redistribution, and commercial use, subject to the license conditions.

This repository also uses or vendors third-party components. Those components are **not** claimed as original IJCCRL works and remain under their own licenses. See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## Features

- Direct launch and supervision of external UCI chess-engine processes.
- Deterministic round-robin scheduling with mirrored colour legs.
- Persistent scheduler state, crash recovery, pending-game repair, and opening-index continuity.
- Configurable base time, increment, threads, hash, UCI options, and adjudication policy.
- Optional Syzygy tablebase configuration and probe controls.
- PGN opening-suite ingestion with configurable ply limits and source labels.
- Live clocks, moves, engine telemetry, evaluation, principal variations, PGN, results, metadata, and tournament state.
- HTTP endpoints for health, current PGN, results, clocks, metadata, conditions, scheduler state, and next pairing.
- WebSocket broadcast transport at `/ws` and moderated guest chat at `/ws-chat`.
- Responsive desktop/mobile web interface with board, engine panels, evaluation graph, standings, crosstable, vote panel, and chat rail.
- Optional account, premium-support, SMTP, and payment-return integration backed by Node's built-in SQLite API.
- Standalone PGN audit and deduplication utilities.

## Architecture

```text
External UCI engines
        │
        ▼
   uci_proxy.js ─────► PGN and runtime evidence (`out/`, ignored by Git)
        │
        ▼
   scheduler.js ◄──── persistent scheduler state
        │
        ▼
     server.js ─────► HTTP REST endpoints
        │             WebSocket `/ws`
        │             WebSocket `/ws-chat`
        ▼
   public/index.html ─► live browser interface
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for component responsibilities and data flow.

## Requirements

- Windows 10 or later is the primary supported operating environment.
- Node.js **22.13.0 or later**. The support subsystem uses `node:sqlite`; Node 22.13.0 is the first Node 22 release where that module is available without the `--experimental-sqlite` flag.
- At least two external UCI engine executables. The number of configured engines must be even.
- A PGN opening suite supplied by the operator.
- Optional Syzygy tablebases.
- PowerShell 5.1 or PowerShell 7 for the Windows launcher example.

This is a Node.js application. There is no native compilation step for the broadcast server itself. `npm ci` installs the JavaScript dependencies. Chess engines remain separate native executables and must be compiled or obtained according to each engine project's documentation and license.

## Installation

```powershell
git clone https://github.com/jordiqui/ijccrl-live-arena-gui.git
cd ijccrl-live-arena-gui
npm ci
Copy-Item .env.example .env
```

Edit `.env` and provide, at minimum:

- `IJCCRL_ENGINES`: an even, semicolon-separated list of absolute UCI executable paths.
- `IJCCRL_OPENINGS_PGN`: the absolute path to an existing PGN opening suite.

Windows paths may be written with forward slashes to avoid escaping problems:

```dotenv
IJCCRL_ENGINES=C:/Chess/Engines/EngineA.exe;C:/Chess/Engines/EngineB.exe
IJCCRL_OPENINGS_PGN=C:/Chess/Openings/my_openings.pgn
```

Then start the service:

```powershell
npm run start:env
```

The default local endpoint is:

```text
http://127.0.0.1:3012/
```

A parameterised PowerShell launcher is also provided:

```powershell
./scripts/start-windows.ps1 `
  -Engines "C:/Chess/Engines/EngineA.exe","C:/Chess/Engines/EngineB.exe" `
  -OpeningsPgn "C:/Chess/Openings/my_openings.pgn"
```

## Minimum configuration

| Variable | Required | Purpose |
|---|---:|---|
| `IJCCRL_ENGINES` | Yes | Even, semicolon-separated list of UCI executable paths. |
| `IJCCRL_OPENINGS_PGN` | Yes | Opening-suite PGN path. |
| `PORT` | No | HTTP/WebSocket port; default `3012`. |
| `IJCCRL_BASE_MS` | No | Base time in milliseconds; default `600000`. |
| `IJCCRL_INC_MS` | No | Increment in milliseconds; default `2000`. |
| `IJCCRL_THREADS` | No | Default engine thread count; default `1`. |
| `IJCCRL_HASH_MB` | No | Default engine hash size in MiB; default `64`. |
| `IJCCRL_SYZYGY_PATH` | No | Optional Syzygy directory. |
| `IJCCRL_PHASE1_GAMES_PER_ENGINE` | No | Scheduler target per engine. |
| `IJCCRL_PHASE1_WHITE_TARGET` | No | White-game target per engine. |
| `IJCCRL_PHASE1_BLACK_TARGET` | No | Black-game target per engine. |
| `IJCCRL_PHASE1_OPENINGS_MAX` | No | Maximum opening lines loaded by the scheduler. |
| `IJCCRL_CHAT_ORIGINS` | Production | Semicolon-separated WebSocket origin allowlist. |
| `IJCCRL_CHAT_ADMIN_SECRET` | No | Enables chat administration. Never commit the value. |
| `IJCCRL_SUPPORT_COOKIE_SECRET` | No | Enables the optional support/account subsystem. |

The complete configuration reference is in [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md).

## Runtime data

The application creates runtime material under `out/`, including PGN files, results, scheduler state, chat state, voting state, support databases, and audit evidence. The entire directory is excluded by `.gitignore` and must not be committed.

Before publishing any fork, run:

```powershell
npm run check
git status --short
```

Confirm that no engine binary, opening file, PGN, SQLite database, `.env`, log, backup, archive, or credential is staged.

## HTTP and WebSocket interfaces

Principal read endpoints include:

- `GET /health`
- `GET /pgn`
- `GET /pgns`
- `GET /results`
- `GET /meta`
- `GET /clocks`
- `GET /scheduler_state.json`
- `GET /upnext`
- `GET /conditions`
- `GET /debug/state`

WebSocket endpoints:

- `/ws`: live tournament and engine broadcast stream.
- `/ws-chat`: guest and registered-user chat stream.

Support and voting routes are enabled by configuration and are documented in the source and configuration reference.

## Reverse proxy and Cloudflare Tunnel

The service listens locally and can be exposed through a reverse proxy or Cloudflare Tunnel. TLS should terminate at the proxy. Production deployments must:

1. restrict `/ws-chat` origins with `IJCCRL_CHAT_ORIGINS`;
2. use strong, unique admin and cookie secrets;
3. set secure cookies when HTTPS is used;
4. disable local verification-code echo;
5. keep `.env`, `out/`, engines, databases, and tablebases outside Git.

No Cloudflare credentials or tunnel configuration are included in this repository.

## Audit utilities

```powershell
python scripts/audit_ijccrl_final.py out/games.pgn `
  --results out/results.json `
  --state out/scheduler_state.json `
  --write audit_out

node scripts/audit_pgn_rr.cjs out/games.pgn
python scripts/dedup_pgn.py out/games.pgn
```

These tools inspect files supplied by the operator; no tournament games are distributed in the repository.

## Repository hygiene

The public release excludes:

- `node_modules/`;
- all `*.txt` operational reports;
- `engines/` and executable binaries;
- `Openings/`, PGN/EPD suites, and opening caches;
- `out/`, `out_prev_*`, debug traces, and tournament results;
- SQLite databases and WAL/SHM files;
- ZIP archives and generated bundles;
- `.env`, passwords, SMTP credentials, admin secrets, and tokens;
- backup or superseded copies of `server.js`, `uci_proxy.js`, `index.html`, and chat modules.

## Security

See [`SECURITY.md`](SECURITY.md). Do not report credentials, personal data, or exploitable details in a public issue.

## Contributing

Pull requests are welcome. Changes must remain source-only and must not introduce engines, networks, tablebases, opening databases, tournament evidence, private credentials, or generated runtime state. See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

Copyright 2026 Jorge Ruiz Centelles.

The original IJCCRL code in this repository is licensed under the Apache License, Version 2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).

Third-party software and artwork retain their original licenses and copyright notices. The Apache License does not grant rights to third-party trademarks, service marks, engine names, or external project logos.
