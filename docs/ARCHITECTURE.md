# Architecture

## Runtime components

### `server.js`

Creates the Express application, HTTP server, primary broadcast WebSocket, chat WebSocket integration, optional support/account subsystem, voting API, static-file routes, runtime snapshots, and the bridge between scheduler events and client messages.

### `uci_proxy.js`

Owns UCI process lifecycle and match execution. It sends UCI commands, parses engine responses, enforces time-control behaviour, tracks clocks, builds PGN evidence, applies configured rules, and emits structured callbacks to the server.

### `scheduler.js`

Builds deterministic round-robin pairings, assigns mirrored colour legs to the same opening line, persists progress, resolves engine identifiers, detects incomplete slots, and resumes after interruption.

### `pgn_store.js`

Provides append-only PGN persistence and optional per-game files with atomic write patterns.

### `tools/chat_ws.js`

Implements the `/ws-chat` runtime, origin checks, guest identity, moderation commands, rate limits, history, and support-tier metadata.

### `tools/support_store.js`

Implements the local SQLite persistence layer for accounts, sessions, verification, password resets, and payment records. SQLite files are created at runtime under `out/` and are never distributed.

### `tools/support_auth.js`

Implements registration, authentication, verification, reset flows, cookies, and optional SMTP dispatch.

### `tools/paypal_support.js`

Implements the optional payment start/return/webhook integration. No payment URL or secret is embedded in the public source defaults.

### `public/index.html`

Contains the responsive IJCCRL broadcast client: board bootstrap, WebSocket state reconciliation, clocks, engine telemetry, evaluation graph, standings, crosstable, vote interface, chat rail, and support UI integration.

## Data flow

1. The operator supplies an even list of external UCI executables and an opening PGN.
2. The scheduler selects the next mirrored game slot and opening line.
3. The UCI proxy launches both engines and executes the game.
4. Structured callbacks update server-side authoritative state.
5. The server broadcasts state over `/ws` and exposes snapshots over HTTP.
6. The browser reconciles snapshots and incremental messages, renders the live scene, and maintains monotonic clock display between authoritative updates.
7. Runtime evidence is written beneath `out/`.

## Persistence boundary

All mutable state belongs under `out/`:

- PGN bundles and per-game PGNs;
- scheduler state and results;
- vote state and ballots;
- chat history and moderation state;
- account/payment SQLite files and logs.

This boundary is intentional: source control contains application code, while runtime evidence remains local to the operator.
