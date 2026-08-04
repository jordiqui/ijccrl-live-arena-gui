// Browser shim for loading the vendored CommonJS build of chess.js.
// Load this file before /vendor/chess.js.

window.exports = window.exports || {};
window.module = window.module || { exports: window.exports };

// Expose the CommonJS identifiers in global script scope while chess.js loads.
var exports = window.exports; // eslint-disable-line no-var
var module = window.module;   // eslint-disable-line no-var
