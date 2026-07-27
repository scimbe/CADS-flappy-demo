#!/usr/bin/env node
"use strict";

// Thin entrypoint: bind the HTTP listener around server.lib.js's request handler. Kept separate
// from the library so tests can exercise the pure logic without binding a real socket.

const http = require("http");
const { requestListener } = require("./server.lib.js");

const listenAddr = process.env.CREW_BRIDGE_LISTEN || "0.0.0.0:8788";
const lastColon = listenAddr.lastIndexOf(":");
const host = lastColon >= 0 ? listenAddr.slice(0, lastColon) : "0.0.0.0";
const port = Number(lastColon >= 0 ? listenAddr.slice(lastColon + 1) : listenAddr);

const server = http.createServer(requestListener);
server.listen(port, host || "0.0.0.0", () => {
  process.stderr.write(`flappy-crew-bridge: serving POST /crew/build on ${host || "0.0.0.0"}:${port}\n`);
});
