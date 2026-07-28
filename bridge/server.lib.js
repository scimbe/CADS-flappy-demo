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
 *   CREW_BRIDGE_LISTEN - default 0.0.0.0:8788
 *
 * Fail-closed: safety runs first and {ok:false} short-circuits to a rejection (no fragment
 * calls); a role command failing/malformed output -> a terminal {stage:"error"} event, so the
 * browser falls back to its local stand-in.
 */

const { spawn } = require("child_process");

const ROLE_CMD_TIMEOUT_MS = 60_000;

/** Run one role command with `input` on stdin. Non-zero exit / empty stdout / timeout -> reject. */
function runCmd(cmd, input, timeoutMs = ROLE_CMD_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", cmd], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill("SIGKILL");
      reject(new Error(`role command timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
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
function demoAuction(physicsWho) {
  return [
    { role: "physics", bids: [{ who: physicsWho, model: "claude", units: 20, price: 50, win: true }] },
    { role: "art", bids: [{ who: "sink", model: "claude", units: 20, price: 40, win: true }] },
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

/** Write one NDJSON event to the response stream. */
function emit(res, ev) {
  res.write(JSON.stringify(ev) + "\n");
}

/** Drive the crew safety -> (physics || art) -> assemble, streaming one event per step. */
async function runCrewStreaming(prompt, safetyCmd, physicsCmds, artCmd, res) {
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
  emit(res, { stage: "safety", status: "ok" });

  emit(res, { stage: "physics", status: "start" });
  emit(res, { stage: "art", status: "start" });
  const physicsP = runWithFallbacks(physicsCmds, prompt).then(
    (r) => { emit(res, { stage: "physics", status: "done" }); return r; }
  );
  const artP = runCmdAsync(artCmd, prompt).then(
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
  const artOut = artResult.value;

  let cfg;
  try {
    cfg = assembleConfig(physicsOut, artOut);
  } catch (e) {
    return emit(res, { stage: "error", message: `crew fragments malformed: ${e.message}` });
  }

  const physicsWho = candidateLabel("source-2", "central (standby)", physicsWinner);
  emit(res, {
    stage: "built",
    safety: { ok: true, reason: "" },
    auction: demoAuction(physicsWho),
    config: cfg,
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
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

  res.writeHead(200, {
    "content-type": "application/x-ndjson",
    "cache-control": "no-store",
  });
  try {
    await runCrewStreaming(prompt, safetyCmd, physicsCmds, artCmd, res);
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
  runCrewStreaming,
  buildHandler,
  requestListener,
};
