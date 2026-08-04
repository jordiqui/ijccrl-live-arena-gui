# Configuration Reference

Configuration is read from environment variables. Node.js 22 supports loading `.env` directly with `node --env-file=.env server.js`, exposed as `npm run start:env`.

## Required external resources

| Variable | Description |
|---|---|
| `IJCCRL_ENGINES` | Semicolon-separated absolute paths to an even number of UCI executables. Missing files are filtered; fewer than two valid engines abort startup. |
| `IJCCRL_OPENINGS_PGN` | Absolute path to an existing PGN opening suite. `OPENINGS_PGN_PATH` remains accepted as a compatibility alias. |

## Service and event identity

| Variable | Default | Description |
|---|---:|---|
| `PORT` | `3012` | HTTP and WebSocket port. |
| `IJCCRL_EVENT_NAME` | `IJCCRL Live` | PGN/event label. |
| `IJCCRL_PHASE_NAME` | empty | Tournament phase label. `IJCCRL_PHASE` is accepted as an alias. |

## Time control and engine defaults

| Variable | Default | Description |
|---|---:|---|
| `IJCCRL_BASE_MS` | `600000` | Base time per engine in milliseconds. |
| `IJCCRL_INC_MS` | `2000` | Increment per move in milliseconds. |
| `IJCCRL_THREADS` | `1` | Default UCI thread count. |
| `IJCCRL_HASH_MB` | `64` | Default UCI hash size in MiB. |
| `IJCCRL_CLOCK_MODE` | `passthrough` | Match-clock policy. |
| `IJCCRL_INFO_THROTTLE_MS` | `250` | Engine-info broadcast throttle. |
| `IJCCRL_MOVE_OVERHEAD_MS` | `75` | Common UCI move-overhead value when supported. |
| `IJCCRL_MULTIPV` | `1` | Common MultiPV value when supported. |
| `IJCCRL_PONDER` | `false` | Common Ponder value. |
| `IJCCRL_OWN_BOOK` | `false` | Common OwnBook value. |
| `IJCCRL_CHESS960` | `false` | Common Chess960 value. |

## Openings and scheduler

| Variable | Default | Description |
|---|---:|---|
| `IJCCRL_OPENINGS_PLY_LIMIT` | `16` | Maximum opening plies applied. |
| `IJCCRL_OPENINGS_SOURCE_LABEL` | operator label | Source text embedded in metadata/PGN. |
| `IJCCRL_PHASE1_OPENINGS_MAX` | `25` | Maximum opening chunks loaded for the phase. |
| `IJCCRL_PHASE1_GAMES_PER_ENGINE` | computed | Default is `2 × (engine count - 1)`. |
| `IJCCRL_PHASE1_WHITE_TARGET` | computed | Default is `engine count - 1`. |
| `IJCCRL_PHASE1_BLACK_TARGET` | computed | Default is `engine count - 1`. |
| `IJCCRL_ENGINE_ALIASES_JSON` | `{}` | JSON object mapping aliases to canonical engine IDs. |
| `IJCCRL_SCHEDULER_CONTINUOUS` | `0` | Continue requesting scheduler slots when enabled. |

## Syzygy

| Variable | Default | Description |
|---|---:|---|
| `IJCCRL_SYZYGY_PATH` | empty | Optional tablebase directory. `SYZYGY_PATH` is an alias. |
| `IJCCRL_SYZYGY_PROBE_LIMIT` | `6` when a path exists | Maximum piece count. |
| `IJCCRL_SYZYGY_PROBE_DEPTH` | engine default | Optional engine probe depth. |
| `IJCCRL_SYZYGY_50_MOVE_RULE` | engine default | Optional engine-specific 50-move interpretation. |
| `IJCCRL_TB_TURBO` | `1` | Enables low-piece-count turbo policy. |
| `IJCCRL_TB_TURBO_MODE` | `movetime` | Turbo policy mode. |
| `IJCCRL_TB_TURBO_MOVETIME_MS` | `25` | Turbo movetime. |

## Rules and adjudication

| Variable | Default | Description |
|---|---:|---|
| `IJCCRL_3FOLD_RULE` | `true` | Threefold repetition. |
| `IJCCRL_50_MOVE_RULE` | `true` | Fifty-move rule. |
| `IJCCRL_IM_RULE` | `true` | Insufficient material. |
| `IJCCRL_ADJ_ENABLED` | `false` | Enables score-based adjudication. |
| `IJCCRL_ADJ_WIN_CP` | source default | Winning threshold in centipawns. |
| `IJCCRL_ADJ_WIN_MOVES` | source default | Consecutive moves required. |
| `IJCCRL_ADJ_DRAW_CP` | source default | Draw-band threshold. |
| `IJCCRL_ADJ_DRAW_MOVES` | source default | Consecutive moves required. |
| `IJCCRL_ADJ_MIN_PLY` | source default | Minimum ply before adjudication. |

## WebSocket and state transport

| Variable | Default | Description |
|---|---:|---|
| `IJCCRL_WS_PING_MS` | `20000` | WebSocket ping interval. |
| `IJCCRL_WS_STATE_KEEPALIVE_MS` | `1500` | Authoritative state replay interval. |
| `IJCCRL_WS_STATE_KEEPALIVE_PGN_EVERY` | `4` | PGN replay cadence. |
| `IJCCRL_WS_CONNECT_ENGINE_REPLAY_MS` | `90` | Engine-state replay delay for new clients. |
| `IJCCRL_LIVE_CLOCK_HEARTBEAT_MS` | `1000` | Clock heartbeat emitted by the UCI layer. |
| `IJCCRL_ENGINE_SCORE_ORIENTATION` | `white_perspective` | UI score orientation. |
| `IJCCRL_BLACK_ENGINE_SCORE_INPUT_FRAME` | `engine_side` | Frame assumed for black-engine scores. |

## Chat

| Variable | Default | Description |
|---|---:|---|
| `IJCCRL_CHAT_ORIGINS` | local plus IJCCRL hosts | Semicolon-separated origin allowlist. Set explicitly in production. |
| `IJCCRL_CHAT_ADMIN_SECRET` | empty | Enables moderation/admin actions. `IJCCRL_CHAT_ADMIN` remains an alias. |
| `IJCCRL_CHAT_ADMIN_TTL_MS` | 12 hours | Admin cookie lifetime. |

## Optional support/account subsystem

The subsystem remains disabled until `IJCCRL_SUPPORT_COOKIE_SECRET` or the chat-admin fallback is set.

| Variable | Default | Description |
|---|---:|---|
| `IJCCRL_SUPPORT_COOKIE_SECRET` | empty | HMAC/session secret. Must be strong and unique. |
| `IJCCRL_SUPPORT_COOKIE_NAME` | `ijccrl_support` | Cookie name. |
| `IJCCRL_SUPPORT_SECURE_COOKIES` | `false` | Set `true` behind HTTPS. |
| `IJCCRL_SUPPORT_SESSION_TTL_DAYS` | `30` | Session duration. |
| `IJCCRL_SUPPORT_LOGIN_CODE_TTL_MINUTES` | `15` | Login-code lifetime. |
| `IJCCRL_SUPPORT_DEV_ECHO_CODES` | `false` | Local code/verification echo. Keep `false` in production. |
| `IJCCRL_SUPPORT_PAYPAL_URL` | empty | Optional operator-supplied payment URL. |
| `IJCCRL_SUPPORT_HOME_URL` | local URL | Public canonical home URL. |
| `IJCCRL_SUPPORT_MAIL_ENABLED` | `false` | Enables SMTP delivery when all SMTP values exist. |
| `IJCCRL_SUPPORT_MAIL_FROM` | empty | Sender address. |
| `IJCCRL_SUPPORT_MAIL_REPLY_TO` | empty | Reply-to address. |
| `IJCCRL_SUPPORT_SMTP_HOST` | empty | SMTP host. |
| `IJCCRL_SUPPORT_SMTP_PORT` | `0` | SMTP port. |
| `IJCCRL_SUPPORT_SMTP_SECURE` | `false` | TLS mode used by Nodemailer. |
| `IJCCRL_SUPPORT_SMTP_USER` | empty | SMTP user. |
| `IJCCRL_SUPPORT_SMTP_PASS` | empty | SMTP password. Never commit it. |

## Output ownership

`out/` is created automatically and may contain personal data and tournament evidence. Back it up and protect it according to the operator's own retention and privacy policy; do not publish it as source code.
