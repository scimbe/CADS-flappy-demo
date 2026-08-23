#!/usr/bin/env node
"use strict";

/**
 * flappy-crew-bridge (Node.js port, thin-bridge migration — see CADS-Tunnel#219):
 * the HTTP bridge the flappy-demo browser POSTs prompts to.
 *
 * A static Caddy page can't speak the QUIC/Noise channel, so the browser POSTs {prompt} here
 * and this service runs the crew - safety_check first, then physics + art - via one configurable
 * shell command per role, and streams back newline-delimited JSON progress events ending in the
 * exact {safety, auction, config} (or {stage:"rejected"|"error"}) shape the browser expects.
 *
 * Role commands are unchanged from the previous Rust bridge - each is however you reach that
 * role's service/<slug> (in production: an `ct-agent channel` invocation over the real
 * Agent-Fabric tunnel to sink/source-2, built by compose.flappy-demo.yml from the CREW_*_GRANT/
 * HOLDER_KEY/NOISE_KEY env vars). This bridge only replaces the HTTP server + wire-format
 * assembly that used to live in CADS-Tunnel core (crates/agent/src/bin/crew_bridge.rs +
 * ct_common::crew) - the dial mechanism itself was already fully generic/CLI-driven and needed
 * zero core changes to move here.
 *
 * Env:
 *   CREW_SAFETY_CMD    - stdin=prompt -> stdout {"ok":bool,"reason":str}
 *   CREW_PHYSICS_CMD   - stdin=prompt -> stdout {gravity,flapPower,pipeGap,pipeSpeed}
 *   CREW_PHYSICS_CMD_2, _3, ... - ordered failover candidates (#207 Slice A), contiguous from _2
 *   CREW_ART_CMD       - stdin=prompt -> stdout {theme,birdColor,birdEmoji,title,palette?,pipeEmoji?,bgEffect?}
 *   CREW_ART_CMD_2, _3, ... - ordered failover candidates (#207 Slice A), contiguous from _2, same as physics
 *   CREW_BRIDGE_LISTEN - default 0.0.0.0:8788
 *   CREW_PROMPT_COUNT_FILE - default ./prompt-count.json; global counter of successful builds (GET /crew/count)
 *
 * Fail-closed: safety runs first and {ok:false} short-circuits to a rejection (no fragment
 * calls); a role command failing/malformed output -> a terminal {stage:"error"} event, so the
 * browser falls back to its local stand-in.
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Global "prompts built" counter shown on the studio's main page. Counts successful builds only
// (a stage:"built" terminal event) -- rejected/errored attempts don't produce a game, so counting
// them would overstate what the crew actually created. Same atomic-write-then-rename pattern as
// CADS-webconference-demo's access-requests.json (bridge/server.js there): the in-memory value is
// the runtime source of truth, the file is only a load-on-boot / write-through backup so a bridge
// restart doesn't reset the count to zero.
const PROMPT_COUNT_FILE = process.env.CREW_PROMPT_COUNT_FILE || "./prompt-count.json";
let promptCount = 0;
try {
  const raw = fs.readFileSync(PROMPT_COUNT_FILE, "utf8");
  const parsed = JSON.parse(raw);
  if (typeof parsed.count === "number" && Number.isFinite(parsed.count) && parsed.count >= 0) {
    promptCount = Math.floor(parsed.count);
  }
  process.stderr.write(`flappy-crew-bridge: loaded prompt count ${promptCount} from ${PROMPT_COUNT_FILE}\n`);
} catch (e) {
  if (e.code !== "ENOENT") {
    process.stderr.write(`flappy-crew-bridge: could not load ${PROMPT_COUNT_FILE}: ${e.message} -- starting count at 0\n`);
  }
}
function incrementPromptCount() {
  promptCount += 1;
  const tmp = `${PROMPT_COUNT_FILE}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ count: promptCount }));
    fs.renameSync(tmp, PROMPT_COUNT_FILE);
  } catch (e) {
    process.stderr.write(`flappy-crew-bridge: could not persist prompt count to ${PROMPT_COUNT_FILE}: ${e.message}\n`);
  }
  return promptCount;
}
function getPromptCount() {
  return promptCount;
}

// #232, operator request: sharing should hand recipients a real, tappable link, not just a
// downloaded/attached .html file (attachments need a "download & open" step in most chat apps
// and don't preview; a link just opens). Each generated game is POSTed here once, stored under a
// random UUID, and served back verbatim on GET -- a tiny, purpose-built pastebin, not a general
// upload service (fixed size cap, fixed extension, no directory listing, no overwrite/delete).
const SHARED_GAMES_DIR = process.env.CREW_SHARED_GAMES_DIR || "./data/shared-games";
const SHARED_GAME_MAX_BYTES = 200 * 1024; // real games are ~10KB; generous headroom, not unbounded
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
try {
  fs.mkdirSync(SHARED_GAMES_DIR, { recursive: true });
} catch (e) {
  process.stderr.write(`flappy-crew-bridge: could not create ${SHARED_GAMES_DIR}: ${e.message}\n`);
}

// Fixed-window rate limiter, keyed by caller IP -- same shape as CADS-webconference-demo's
// bridge/server.js makeRateLimiter, reimplemented here since this repo has no shared dep on it.
function makeRateLimiter(maxCount, windowMs) {
  const hits = new Map(); // key -> { count, windowStart }
  return function rateLimited(key) {
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || now - entry.windowStart >= windowMs) {
      hits.set(key, { count: 1, windowStart: now });
      return false;
    }
    entry.count += 1;
    return entry.count > maxCount;
  };
}
const shareRateLimited = makeRateLimiter(10, 60 * 1000);
const callerIp = (req) => (req.socket && req.socket.remoteAddress) || "unknown";

function isValidSharedGameId(id) {
  return typeof id === "string" && UUID_RE.test(id);
}

async function shareHandler(req, res) {
  if (shareRateLimited(callerIp(req))) {
    res.writeHead(429, { "content-type": "text/plain" });
    return res.end("too many shares from this address, try again in a minute");
  }
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    res.writeHead(400, { "content-type": "text/plain" });
    return res.end("invalid JSON body");
  }
  const html = typeof body.html === "string" ? body.html : "";
  if (!html || !html.startsWith("<!doctype html>")) {
    res.writeHead(400, { "content-type": "text/plain" });
    return res.end("expected {html: a full standalone game document}");
  }
  if (Buffer.byteLength(html, "utf8") > SHARED_GAME_MAX_BYTES) {
    res.writeHead(413, { "content-type": "text/plain" });
    return res.end(`game too large to share (max ${SHARED_GAME_MAX_BYTES} bytes)`);
  }
  const id = crypto.randomUUID();
  const dest = path.join(SHARED_GAMES_DIR, `${id}.html`);
  const tmp = `${dest}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, html, "utf8");
    fs.renameSync(tmp, dest);
  } catch (e) {
    res.writeHead(500, { "content-type": "text/plain" });
    return res.end(`could not persist shared game: ${e.message}`);
  }
  res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify({ id }));
}

function serveSharedGame(id, res) {
  if (!isValidSharedGameId(id)) {
    res.writeHead(404, { "content-type": "text/plain" });
    return res.end("not found");
  }
  const filePath = path.join(SHARED_GAMES_DIR, `${id}.html`);
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) {
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("not found (this game link may be wrong, or has expired)");
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=86400" });
    res.end(html);
  });
}

const ROLE_CMD_TIMEOUT_MS = 60_000;
// Role replies are small JSON fragments ({"ok":bool,"reason":str} etc.) - 1 MiB is enormously
// generous. Without this, a misbehaving/compromised role command (or an attacker-influenced
// prompt tricking one into echoing unbounded output) could grow this bridge process's memory
// without limit; the ROLE_CMD_TIMEOUT_MS alone doesn't help since a fast pipe can write a lot
// of data well within 60s.
const MAX_CMD_OUTPUT_BYTES = 1024 * 1024;

/** Run one role command with `input` on stdin. Non-zero exit / empty stdout / timeout -> reject. */
function runCmd(cmd, input, timeoutMs = ROLE_CMD_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    // `detached: true` makes `child` the leader of its own new process group (POSIX), so
    // `killChildGroup` below can kill the whole group, not just the immediate `sh` PID. Found
    // while writing MAX_CMD_OUTPUT_BYTES's own test: `sh -c "yes x"` on this system forks a
    // real `yes` child rather than exec-replacing itself, so a plain `child.kill("SIGKILL")`
    // only killed `sh`, leaving `yes` orphaned (reparented to pid 1) and still running/writing
    // forever - the exact same latent gap already existed on the ROLE_CMD_TIMEOUT_MS path
    // above, for any role command that forks rather than execs; this fixes both at once.
    const child = spawn("sh", ["-c", cmd], { stdio: ["pipe", "pipe", "pipe"], detached: true });
    const killChildGroup = () => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // The group may already be gone (`sh` already exited on its own) - fall back to the
        // plain PID so this never throws either way.
        try { child.kill("SIGKILL"); } catch { /* already dead */ }
      }
    };
    let stdout = "";
    let stderr = "";
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      killChildGroup();
      reject(new Error(`role command timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    const failOversized = (which) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      killChildGroup();
      reject(new Error(`role command ${which} exceeded ${MAX_CMD_OUTPUT_BYTES} bytes`));
    };
    child.stdout.on("data", (d) => {
      if (done) return;
      stdout += d;
      if (stdout.length > MAX_CMD_OUTPUT_BYTES) failOversized("stdout");
    });
    child.stderr.on("data", (d) => {
      if (done) return;
      stderr += d;
      if (stderr.length > MAX_CMD_OUTPUT_BYTES) failOversized("stderr");
    });
    // Best-effort write, same as the Rust bridge: a role command that answers before draining
    // stdin makes this fail with EPIPE - deliberately ignored, the exit code + stdout decide.
    child.stdin.on("error", () => {});
    child.stdin.write(input, () => {});
    child.stdin.end();

    child.on("error", (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(new Error(`spawn role command failed: ${e.message}`));
    });
    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code !== 0) {
        const err = stderr.trim();
        reject(new Error(`role command exited ${code}${err ? `: ${err}` : ""}`));
        return;
      }
      const out = stdout.trim();
      if (!out) {
        reject(new Error(`role command exited ${code} but produced no output`));
        return;
      }
      resolve(out);
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Up to `maxAttempts` tries on failure, with jittered backoff between them.
 *
 * Found via a real live-browser test (not just curl): physics and art dial the edge relay
 * CONCURRENTLY (both start together, see runCrew below), and each role's serve process only
 * admits ONE session at a time — a second concurrent dial to the SAME role while the first is
 * still being served gets rejected at the admission layer ("edge relay refused the channel join",
 * "channel join admission exchange stalled (#140)", or "early eof"), not queued.
 *
 * A short fixed backoff (150-450ms, an earlier version of this fix) only clears a genuinely
 * momentary relay race — it does NOT help here, because the peer stays busy for the length of a
 * WHOLE claude -p call (commonly 5-20s), so a contending request exhausts a sub-second retry
 * budget long before the first request finishes and frees the slot. Confirmed via real concurrent
 * browser/curl load: 2-4 simultaneous builds hitting the same role reliably failed under the
 * short-backoff version. Exponential backoff with jitter, capped and given enough total attempts
 * to plausibly outlast one other concurrent call, is the actual fix.
 */
async function runCmdWithRetries(cmd, input, maxAttempts) {
  const BASE_MS = 500;
  const CAP_MS = 4000;
  let lastErr = new Error("no attempts made");
  for (let i = 0; i < Math.max(maxAttempts, 1); i++) {
    if (i > 0) {
      const delay = Math.min(CAP_MS, BASE_MS * 2 ** (i - 1));
      await sleep(delay + Math.floor(Math.random() * delay * 0.5));
    }
    try {
      return await runCmd(cmd, input);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

/** 5 total attempts (~500ms/1s/2s/4s backoff between them) - the default for a role with no
 * configured standby; sized to plausibly outlast one other concurrent caller on the same role. */
function runCmdAsync(cmd, input) {
  return runCmdWithRetries(cmd, input, 5);
}

/**
 * #207 Slice A - ordered-candidate failover: try candidates in order, first success wins.
 * Non-last candidates get exactly 1 attempt (fail fast, fall through); the LAST candidate gets
 * the full backoff-retry budget (nowhere further to go, worth paying the retry cost). Returns
 * [output, winningIndex] so the caller can report who actually served the request.
 */
async function runWithFallbacks(candidates, input) {
  const lastIndex = candidates.length - 1;
  let lastErr = new Error("no role command configured");
  for (let i = 0; i < candidates.length; i++) {
    const attempts = i === lastIndex ? 5 : 1;
    try {
      const out = await runCmdWithRetries(candidates[i], input, attempts);
      return [out, i];
    } catch (e) {
      if (candidates.length > 1) {
        process.stderr.write(
          `flappy-crew-bridge: role candidate ${i + 1}/${candidates.length} failed (${e.message}); trying next (#207)\n`
        );
      }
      lastErr = e;
    }
  }
  throw lastErr;
}

/** Primary + contiguous fallbacks <key>_2, <key>_3, ... from env; stop at the first unset. */
function roleCandidates(primaryKey, primary) {
  const v = [primary];
  let n = 2;
  while (process.env[`${primaryKey}_${n}`]) {
    v.push(process.env[`${primaryKey}_${n}`]);
    n += 1;
  }
  return v;
}

function candidateLabel(primary, standby, winningIndex) {
  return winningIndex === 0 ? primary : standby;
}

/** The visible auction for the demo crew (mirrors ct_common::crew's demo_auction). */
function demoAuction(physicsWho, artWho) {
  return [
    { role: "physics", bids: [{ who: physicsWho, model: "claude", units: 20, price: 50, win: true }] },
    { role: "art", bids: [{ who: artWho, model: "claude", units: 20, price: 40, win: true }] },
  ];
}

/**
 * Merge the physics + art fragments into the demo config, reconciling field names
 * (flapPower->jump, pipeGap->gap, pipeSpeed->speed) - mirrors ct_common::crew::CrewConfig.
 * Throws on a missing required field (fail closed, never a partial/garbage config).
 */
function assembleConfig(physicsJson, artJson) {
  const physics = JSON.parse(physicsJson);
  const art = JSON.parse(artJson);
  for (const k of ["gravity", "flapPower", "pipeGap", "pipeSpeed"]) {
    if (physics[k] === undefined) throw new Error(`physics fragment missing "${k}"`);
  }
  for (const k of ["theme", "birdColor", "birdEmoji", "title"]) {
    if (art[k] === undefined) throw new Error(`art fragment missing "${k}"`);
  }
  const cfg = {
    gravity: physics.gravity,
    jump: physics.flapPower,
    gap: physics.pipeGap,
    speed: physics.pipeSpeed,
    theme: art.theme,
    birdColor: art.birdColor,
    birdEmoji: art.birdEmoji,
    title: art.title,
  };
  if (art.palette !== undefined) cfg.palette = art.palette;
  if (art.pipeEmoji !== undefined) cfg.pipeEmoji = art.pipeEmoji;
  if (art.bgEffect !== undefined) cfg.bgEffect = art.bgEffect;
  return cfg;
}

/** Write one NDJSON event to the response stream. Returns false if the client is already gone
 * (disconnected/backgrounded mid-build) instead of throwing — callers should stop driving the
 * pipeline forward in that case rather than paying for further LLM calls nobody will read. */
function emit(res, ev) {
  if (res.destroyed || res.writableEnded) {
    process.stderr.write(`flappy-crew-bridge: client gone, dropping stage=${ev.stage}\n`);
    return false;
  }
  try {
    res.write(JSON.stringify(ev) + "\n");
    return true;
  } catch (e) {
    process.stderr.write(`flappy-crew-bridge: write failed (client gone?) at stage=${ev.stage}: ${e.message}\n`);
    return false;
  }
}

/** Drive the crew safety -> (physics || art) -> assemble, streaming one event per step. */
async function runCrewStreaming(prompt, safetyCmd, physicsCmds, artCmds, res) {
  emit(res, { stage: "safety", status: "start" });
  let safetyOut;
  try {
    safetyOut = await runCmdAsync(safetyCmd, prompt);
  } catch (e) {
    return emit(res, { stage: "error", message: `safety_check unreachable: ${e.message}` });
  }
  let verdict;
  try {
    verdict = JSON.parse(safetyOut);
  } catch (e) {
    return emit(res, { stage: "error", message: `safety_check reply not JSON: ${e.message}` });
  }
  if (verdict.ok !== true) {
    const reason = typeof verdict.reason === "string" ? verdict.reason : "rejected by the safety agent";
    return emit(res, { stage: "rejected", safety: { ok: false, reason } });
  }
  // If the client is already gone (backgrounded tab, dropped network, etc.), stop here rather
  // than paying for the physics + art LLM calls nobody will read.
  if (!emit(res, { stage: "safety", status: "ok" })) return;

  emit(res, { stage: "physics", status: "start" });
  emit(res, { stage: "art", status: "start" });
  const physicsP = runWithFallbacks(physicsCmds, prompt).then(
    (r) => { emit(res, { stage: "physics", status: "done" }); return r; }
  );
  const artP = runWithFallbacks(artCmds, prompt).then(
    (r) => { emit(res, { stage: "art", status: "done" }); return r; }
  );
  const [physicsResult, artResult] = await Promise.allSettled([physicsP, artP]);

  if (physicsResult.status === "rejected") {
    return emit(res, { stage: "error", message: `physics role unreachable: ${physicsResult.reason.message}` });
  }
  if (artResult.status === "rejected") {
    return emit(res, { stage: "error", message: `art role unreachable: ${artResult.reason.message}` });
  }
  const [physicsOut, physicsWinner] = physicsResult.value;
  const [artOut, artWinner] = artResult.value;

  let cfg;
  try {
    cfg = assembleConfig(physicsOut, artOut);
  } catch (e) {
    return emit(res, { stage: "error", message: `crew fragments malformed: ${e.message}` });
  }

  const physicsWho = candidateLabel("source-2", "central (standby)", physicsWinner);
  const artWho = candidateLabel("sink", "central (standby)", artWinner);
  incrementPromptCount();
  emit(res, {
    stage: "built",
    safety: { ok: true, reason: "" },
    auction: demoAuction(physicsWho, artWho),
    config: cfg,
  });
}

// A game-prompt is a few sentences; 64 KiB is enormously generous. Without this, any client
// (this is the bridge's own public POST endpoint, exposed straight to the browser/internet via
// Caddy) could send an arbitrarily large request body and grow this process's memory without
// limit - the same unbounded-read shape as MAX_CMD_OUTPUT_BYTES above, but directly
// attacker-reachable rather than needing a misbehaving role command.
const MAX_BODY_BYTES = 64 * 1024;

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    let bytes = 0;
    let done = false;
    req.on("data", (d) => {
      if (done) return;
      bytes += d.length;
      if (bytes > MAX_BODY_BYTES) {
        done = true;
        req.destroy();
        reject(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`));
        return;
      }
      body += d;
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", (e) => {
      if (done) return;
      done = true;
      reject(e);
    });
  });
}

async function buildHandler(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    res.writeHead(400, { "content-type": "text/plain" });
    return res.end("invalid JSON body");
  }
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (prompt.length < 3) {
    res.writeHead(400, { "content-type": "text/plain" });
    return res.end("say a bit more about the game you want");
  }
  const safetyCmd = process.env.CREW_SAFETY_CMD;
  const physicsCmd = process.env.CREW_PHYSICS_CMD;
  const artCmd = process.env.CREW_ART_CMD;
  if (!safetyCmd || !physicsCmd || !artCmd) {
    res.writeHead(500, { "content-type": "text/plain" });
    return res.end("crew role commands not configured");
  }
  const physicsCmds = roleCandidates("CREW_PHYSICS_CMD", physicsCmd);
  const artCmds = roleCandidates("CREW_ART_CMD", artCmd);

  res.writeHead(200, {
    "content-type": "application/x-ndjson",
    "cache-control": "no-store",
  });
  try {
    await runCrewStreaming(prompt, safetyCmd, physicsCmds, artCmds, res);
  } catch (e) {
    // Defensive: runCrewStreaming should never throw (every branch returns after emit()), but
    // don't let an unexpected bug hang the response open.
    emit(res, { stage: "error", message: `internal bridge error: ${e.message}` });
  } finally {
    res.end();
  }
}

function requestListener(req, res) {
  if (req.method === "POST" && req.url === "/crew/build") {
    buildHandler(req, res).catch((e) => {
      try {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end(`internal error: ${e.message}`);
      } catch {
        /* response already sent */
      }
    });
    return;
  }
  if (req.method === "GET" && req.url === "/crew/count") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ count: promptCount }));
    return;
  }
  if (req.method === "POST" && req.url === "/share") {
    shareHandler(req, res).catch((e) => {
      try {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end(`internal error: ${e.message}`);
      } catch {
        /* response already sent */
      }
    });
    return;
  }
  if (req.method === "GET" && req.url.startsWith("/g/")) {
    serveSharedGame(req.url.slice("/g/".length), res);
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
}

module.exports = {
  runCmd,
  runCmdWithRetries,
  runCmdAsync,
  runWithFallbacks,
  roleCandidates,
  candidateLabel,
  demoAuction,
  assembleConfig,
  readJsonBody,
  buildHandler,
  requestListener,
  incrementPromptCount,
  getPromptCount,
  isValidSharedGameId,
  shareHandler,
  serveSharedGame,
  runCrewStreaming,
  MAX_BODY_BYTES,
  MAX_CMD_OUTPUT_BYTES,
};
