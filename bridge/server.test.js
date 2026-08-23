"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// server.lib.js exports the pure logic with no side effects (no socket bind) - server.js is the
// thin entrypoint that wires it to a real HTTP listener. Tests exercise the lib directly.
const mod = require("./server.lib.js");

test("runWithFallbacks: first candidate up -> wins at index 0, standby untouched", async () => {
  const [out, idx] = await mod.runWithFallbacks(["printf primary", "printf standby"], "");
  assert.equal(out, "primary");
  assert.equal(idx, 0);
});

test("runWithFallbacks: primary down -> standby wins at index 1", async () => {
  const [out, idx] = await mod.runWithFallbacks(["false", "printf standby"], "");
  assert.equal(out, "standby");
  assert.equal(idx, 1);
});

test("runWithFallbacks: all candidates fail -> rejects", async () => {
  await assert.rejects(() => mod.runWithFallbacks(["false", "false"], ""));
});

test("runWithFallbacks: single candidate behaves as before", async () => {
  const [out, idx] = await mod.runWithFallbacks(["printf only"], "");
  assert.equal(out, "only");
  assert.equal(idx, 0);
});

test("candidateLabel: index 0 is always the primary, any later index is the standby", () => {
  assert.equal(mod.candidateLabel("source-2", "central (standby)", 0), "source-2");
  assert.equal(mod.candidateLabel("source-2", "central (standby)", 1), "central (standby)");
  assert.equal(mod.candidateLabel("source-2", "central (standby)", 2), "central (standby)");
});

test("roleCandidates: reads primary + contiguous _2/_3, stops at a gap", () => {
  const saved = { ...process.env };
  process.env.R_2 = "cmd2";
  process.env.R_3 = "cmd3";
  delete process.env.R_4;
  assert.deepEqual(mod.roleCandidates("R", "cmd1"), ["cmd1", "cmd2", "cmd3"]);

  delete process.env.R_2;
  process.env.R_3 = "cmd3";
  assert.deepEqual(mod.roleCandidates("R", "cmd1"), ["cmd1"]);

  delete process.env.R_3;
  assert.deepEqual(mod.roleCandidates("R", "cmd1"), ["cmd1"]);
  process.env = saved;
});

test("assembleConfig: maps flapPower->jump, pipeGap->gap, pipeSpeed->speed; omits absent optionals", () => {
  const physics = '{"gravity":2200,"flapPower":420,"pipeGap":115,"pipeSpeed":220}';
  const art = '{"theme":"night","birdColor":"#00ff41","birdEmoji":"\u{1F576}️","title":"Neo: Matrix Flap"}';
  const cfg = mod.assembleConfig(physics, art);
  assert.deepEqual(cfg, {
    gravity: 2200, jump: 420, gap: 115, speed: 220,
    theme: "night", birdColor: "#00ff41", birdEmoji: "\u{1F576}️", title: "Neo: Matrix Flap",
  });
  const json = JSON.stringify(cfg);
  assert.ok(!json.includes("flapPower"), "the handler's field name does not leak to the browser");
  assert.ok(!json.includes("palette"), "no palette key when the art agent didn't invent one");
});

test("assembleConfig: carries through optional palette/pipeEmoji/bgEffect", () => {
  const physics = '{"gravity":2200,"flapPower":420,"pipeGap":115,"pipeSpeed":220}';
  const art = '{"theme":"day","birdColor":"#f7d51d","birdEmoji":"","title":"Forest","pipeEmoji":"\u{1F332}","bgEffect":"snow"}';
  const cfg = mod.assembleConfig(physics, art);
  assert.equal(cfg.pipeEmoji, "\u{1F332}");
  assert.equal(cfg.bgEffect, "snow");
});

test("assembleConfig: a missing required field is a hard error (fail closed)", () => {
  assert.throws(() => mod.assembleConfig('{"gravity":1}', '{"theme":"x","birdColor":"y","birdEmoji":"z","title":"t"}'));
});

test("runCrewStreaming: happy path emits per-role events and a terminal built event", async () => {
  const safety = 'printf \'{"ok":true,"reason":""}\'';
  const physics = 'printf \'{"gravity":2200,"flapPower":420,"pipeGap":115,"pipeSpeed":220}\'';
  const art = 'printf \'{"theme":"night","birdColor":"#00ff41","birdEmoji":"X","title":"Neo"}\'';
  const events = await collect(safety, [physics], art);
  const stages = events.map((e) => e.stage);
  assert.ok(stages.includes("safety"));
  assert.ok(stages.includes("physics") && stages.includes("art"));
  const last = events[events.length - 1];
  assert.equal(last.stage, "built");
  assert.equal(last.config.speed, 220);
  assert.ok(Array.isArray(last.auction) && last.auction.length > 0);
});

test("runCrewStreaming: a safety rejection short-circuits before any fragment calls", async () => {
  const safety = 'printf \'{"ok":false,"reason":"anti-prompt"}\'';
  const physics = 'printf \'{"gravity":1,"flapPower":1,"pipeGap":1,"pipeSpeed":1}\'';
  const art = 'printf \'{"theme":"x","birdColor":"y","birdEmoji":"z","title":"t"}\'';
  const events = await collect(safety, [physics], art);
  const last = events[events.length - 1];
  assert.equal(last.stage, "rejected");
  assert.equal(last.safety.ok, false);
  assert.ok(!events.some((e) => e.stage === "physics"));
});

test("runCrewStreaming: a failing role command terminates with a stage:error event", async () => {
  const safety = 'printf \'{"ok":true,"reason":""}\'';
  const art = 'printf \'{"theme":"x","birdColor":"y","birdEmoji":"z","title":"t"}\'';
  const events = await collect(safety, ["false"], art);
  assert.equal(events[events.length - 1].stage, "error");
});

test("runCrewStreaming: physics and art run concurrently, not serially", async () => {
  const dir = path.join(require("node:os").tmpdir(), `crew_conc_${process.pid}`);
  const fs = require("node:fs");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const barrier = (out) =>
    `echo x >> ${dir}/started; for i in $(seq 1 300); do [ "$(wc -l < ${dir}/started)" -ge 2 ] && break; sleep 0.02; done; printf '${out}'`;
  const safety = 'printf \'{"ok":true,"reason":""}\'';
  const physics = barrier('{"gravity":1800,"flapPower":430,"pipeGap":140,"pipeSpeed":130}');
  const art = barrier('{"theme":"day","birdColor":"#f7d51d","birdEmoji":"","title":"T"}');

  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("serialized crew hung on the barrier past 3s")), 3000));
  const events = await Promise.race([collect(safety, [physics], art), timeout]);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(events[events.length - 1].stage, "built");
});

/** Drive runCrewStreaming with a fake writable response, collecting parsed NDJSON events. */
async function collect(safety, physicsCmds, art) {
  const chunks = [];
  const fakeRes = {
    write(s) { chunks.push(s); return true; },
  };
  await mod.runCrewStreaming("test prompt", safety, physicsCmds, art, fakeRes);
  return chunks.join("").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

test("runCmd: a role command writing more than MAX_CMD_OUTPUT_BYTES to stdout is killed and rejected, not buffered without limit", async () => {
  // A role command that just keeps writing -- the real hazard this closes: a misbehaving or
  // compromised role command (or a runaway loop) growing this bridge process's memory without
  // limit. `yes` writes forever; if the bound didn't work this would hang. Outer guard: `sh -c
  // "yes x"` forks a REAL child on this system rather than exec-replacing itself, so an earlier
  // version of this fix (killing only the tracked `sh` pid) orphaned `yes` and it kept running
  // forever even after the promise rejected correctly -- this timeout would have caught that too.
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("runCmd did not reject within 5s")), 5000));
  await Promise.race([assert.rejects(() => mod.runCmd("yes x", ""), /stdout exceeded/), timeout]);
});

test("runCmd: normal, well-under-the-limit output still works", async () => {
  const out = await mod.runCmd("printf hello", "");
  assert.equal(out, "hello");
});

test("readJsonBody: a request body over MAX_BODY_BYTES is rejected and the stream is destroyed, not buffered without limit", async () => {
  const { EventEmitter } = require("node:events");
  const req = new EventEmitter();
  let destroyed = false;
  req.destroy = () => { destroyed = true; };

  const promise = mod.readJsonBody(req);
  // One chunk already over the limit -- the real attacker-reachable case: this is the bridge's
  // own public POST endpoint, exposed straight to the browser/internet via Caddy.
  req.emit("data", Buffer.alloc(mod.MAX_BODY_BYTES + 1, "x"));

  await assert.rejects(promise, /exceeds .* bytes/);
  assert.ok(destroyed, "the oversized request stream must be destroyed, not left to keep sending");
});

test("readJsonBody: a normal, well-under-the-limit body still parses", async () => {
  const { EventEmitter } = require("node:events");
  const req = new EventEmitter();
  req.destroy = () => {};

  const promise = mod.readJsonBody(req);
  req.emit("data", Buffer.from('{"prompt":"a tiny flappy game"}'));
  req.emit("end");

  const body = await promise;
  assert.deepEqual(body, { prompt: "a tiny flappy game" });
});
