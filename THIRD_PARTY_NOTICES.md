# Third-Party Notices

The Apache License 2.0 in the repository root applies to the original IJCCRL source code authored by Jorge Ruiz Centelles. It does not replace the licenses of the components listed below.

## Installed Node.js dependencies

The exact dependency graph is recorded in `package-lock.json`. Direct dependencies are:

| Component | Version in lockfile | License | Project |
|---|---:|---|---|
| chess.js | 1.4.0 | BSD-2-Clause | https://github.com/jhlywa/chess.js |
| Express | 5.2.1 | MIT | https://github.com/expressjs/express |
| Nodemailer | 8.0.5 | MIT-0 | https://github.com/nodemailer/nodemailer |
| ws | 8.19.0 | MIT | https://github.com/websockets/ws |

Transitive packages retain the license metadata distributed with their npm packages. Running `npm ci` installs those packages into `node_modules/`, which is intentionally excluded from Git.

## Vendored browser components

### chess.js

Files:

- `public/vendor/chess.js`
- `_dev_vendor/chess.js`

Copyright Jeff Hlywa and contributors. Licensed under the BSD 2-Clause License. The upstream license header is preserved in the source files.

### chessboard.js 1.0.0

Files:

- `public/chessboardjs/js/chessboard-1.0.0.min.js`
- `public/chessboardjs/css/chessboard-1.0.0.min.css`

Copyright 2019 Chris Oakman. Licensed under the MIT License. Upstream license headers are preserved.

### jQuery 3.6.0

File:

- `public/vendor/jquery-3.6.0.min.js`

Copyright OpenJS Foundation and other contributors. Licensed under the MIT License. The upstream license header is preserved.

### Cburnett/Wikipedia chess pieces

Location:

- Embedded as data URIs in `public/index.html` to keep the public source tree self-contained.

These images are the Cburnett-style chess pieces commonly distributed with chessboard.js and derived from the Wikimedia Commons chess-piece set. Attribution: Cburnett. License: Creative Commons Attribution-ShareAlike 3.0 Unported (CC BY-SA 3.0). Source category: https://commons.wikimedia.org/wiki/Category:SVG_chess_pieces

Redistributions and adaptations of those images must comply with CC BY-SA 3.0. They are not relicensed under Apache-2.0.

## External software not distributed here

UCI chess engines, neural-network files, opening suites, Syzygy tablebases, Cloudflare software, and payment services are not part of this repository. Their names may appear in configuration examples or protocol output, but each remains subject to its own license and terms.
