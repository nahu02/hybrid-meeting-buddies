/**
 * End-to-end smoke test of the buddy assignment flow: a freshly built
 * Galene with a throwaway group, and the assignment service with a tiny
 * GloVe file behind Galene's -assignment proxy.  No media is exchanged.
 * Run with `npm run test:e2e`, after `npm run build`.
 */
import { execFileSync } from "node:child_process";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(appDir, "..");
const GROUP = "test";

/** Find a free TCP port by binding to port 0 and closing again. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

/**
 * A minimal Galene protocol client: enough of static/protocol.js to
 * join a group and track the user list.
 */
class Client {
  constructor(id) {
    this.id = id;
    this.queue = [];
    this.waiters = new Set();
    this.users = {};
  }

  async connect(url) {
    this.ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = () => reject(new Error("websocket error"));
    });
    this.ws.onmessage = (ev) => this.receive(JSON.parse(ev.data));
    this.send({ type: "handshake", version: ["2"], id: this.id });
    await this.wait((m) => m.type === "handshake", "handshake");
  }

  receive(m) {
    this.queue.push(m);
    if (m.type === "user") {
      if (m.kind === "delete") {
        delete this.users[m.id];
      } else {
        this.users[m.id] = {
          username: m.username,
          permissions: m.permissions || [],
          data: m.data || {},
        };
      }
    }
    // hand queued messages to matching waiters
    for (const w of [...this.waiters]) {
      const i = this.queue.findIndex(w.pred);
      if (i >= 0) {
        const msg = this.queue.splice(i, 1)[0];
        this.waiters.delete(w);
        w.resolve(msg);
      }
    }
  }

  send(m) {
    this.ws.send(JSON.stringify(m));
  }

  /** Wait for a message matching pred; the message is consumed. */
  wait(pred, what, timeout = 5000) {
    const i = this.queue.findIndex(pred);
    if (i >= 0)
      return Promise.resolve(this.queue.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const w = {
        pred,
        resolve: (m) => {
          clearTimeout(w.timer);
          resolve(m);
        },
      };
      w.timer = setTimeout(() => {
        this.waiters.delete(w);
        reject(new Error(`timed out waiting for ${what}`));
      }, timeout);
      this.waiters.add(w);
    });
  }

  join(username, data) {
    this.send({
      type: "join",
      kind: "join",
      group: GROUP,
      username,
      data,
    });
  }

  close() {
    this.ws?.close();
  }
}


/** Parse a link the way the page does (src/App.jsx: parseLocation). */
function parseLink(u) {
  const url = new URL(u, "http://placeholder");
  assert.equal(url.pathname, "/assignment/", `bad link ${u}`);
  return {
    round: url.searchParams.get("round"),
    participant: url.searchParams.get("participant"),
  };
}

const tmp = mkdtempSync(join(tmpdir(), "galene-e2e-"));
const children = [];
const clients = {};
let server = null;

/** Start a child process, collecting its output for error messages. */
function start(cmd, args, options) {
  const child = spawn(cmd, args, {
    ...options, stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  child.log = "";
  child.stdout.on("data", (d) => { child.log += d; });
  child.stderr.on("data", (d) => { child.log += d; });
  child.on("exit", (code) => {
    if (code && code !== 0 && !child.killed)
      console.error(`${cmd} exited: ${code}\n${child.log}`);
  });
  return child;
}

/** Poll f until it returns a truthy value. */
async function until(f, what, timeout = 10000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      const v = await f();
      if (v)
        return v;
    } catch {
      // not ready yet
    }
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function main() {
  const bin = join(tmp, "galene");
  execFileSync("go", ["build", "-o", bin, "."], {
    cwd: repoRoot,
    env: { ...process.env, CGO_ENABLED: "0" },
    stdio: ["ignore", "ignore", "inherit"],
  });

  mkdirSync(join(tmp, "groups"));
  mkdirSync(join(tmp, "data"));
  // a wildcard user accepts any username with any password, so the
  // test can pick the usernames freely (Galene requires a username on
  // every join; there are no fully anonymous groups)
  writeFileSync(
    join(tmp, "groups", `${GROUP}.json`),
    JSON.stringify({
      "wildcard-user": {
        "password": { "type": "wildcard" },
        "permissions": "present",
      },
    }) + "\n"
  );
  // a tiny GloVe file: "painting" and "drawing" are close, "reading"
  // is far from both
  const glove = join(tmp, "glove.txt");
  writeFileSync(glove, [
    "painting 1 0",
    "drawing 0.9 0.1",
    "reading 0 1",
  ].join("\n") + "\n");

  const port = await freePort();
  const servicePort = await freePort();
  const base = `http://127.0.0.1:${port}`;

  start("node", [join(appDir, "server", "index.js")], {
    env: {
      ...process.env,
      PORT: String(servicePort),
      GALENE_URL: base,
      GLOVE_PATH: glove,
    },
  });
  server = start(bin, [
    "-http", `127.0.0.1:${port}`,
    "-insecure",
    "-static", join(repoRoot, "static") + "/",
    "-groups", join(tmp, "groups") + "/",
    "-data", join(tmp, "data"),
    "-assignment", `http://127.0.0.1:${servicePort}`,
  ]);

  const status = await until(async () => {
    const r = await fetch(`${base}/group/${GROUP}/.status`);
    return r.ok && r.json();
  }, "Galene to come up");
  assert.equal(status.name, GROUP);
  const endpoint = status.endpoint || `ws://127.0.0.1:${port}/ws`;

  // the service answers through Galene's proxy (a 404 for an unknown
  // round comes from the service; the proxy itself answers 502)
  await until(async () => {
    const r = await fetch(`${base}/assignment/api/rounds/x/participants/y`);
    return r.status === 404;
  }, "the assignment service to come up", 30000);

  const api = async (method, path, body) => {
    const r = await fetch(`${base}/assignment/api${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    assert.ok(r.ok, `${method} ${path}: ${r.status} ${text}`);
    return text ? JSON.parse(text) : null;
  };
  const view = (round, pid) =>
    api("GET", `/rounds/${round}/participants/${pid}`);

  // the built page is served (npm run build first)
  {
    const r = await fetch(`${base}/assignment/?round=x&participant=y`);
    assert.equal(r.status, 200, "run `npm run build` first");
    const page = await r.text();
    assert.ok(page.includes('id="root"'), "not the built page");
    const m = page.match(/src="(\/assignment\/assets\/[^"]+\.js)"/);
    assert.ok(m, "no script asset in the built index.html");
    const a = await fetch(base + m[1]);
    assert.equal(a.status, 200);
    assert.match(a.headers.get("Content-Type") || "", /javascript/);
  }

  // 1. everybody joins
  const joinAs = async (id, username, role) => {
    const c = new Client(id);
    await c.connect(endpoint);
    c.username = username;
    c.join(username, { role });
    const m = await c.wait(
      (m) => m.type === "joined" && m.kind === "join",
      `join of ${id}`);
    assert.equal(m.group, GROUP);
    clients[id] = c;
    return c;
  };

  const leader = await joinAs("leader-id", "leader", "leader");
  await joinAs("remote-1", "alice", "remote");
  await joinAs("remote-2", "bob", "remote");
  await joinAs("buddy-1", "carol", "buddyDevice");
  const participants = ["remote-1", "remote-2", "buddy-1"];

  for (const id of ["leader-id", ...participants]) {
    await leader.wait(
      (m) => m.type === "user" && m.kind === "add" && m.id === id,
      `user add for ${id}`);
  }

  // 2. the leader starts a round
  const { round } = await api("POST", "/rounds", { group: GROUP });
  for (const id of participants) {
    const m = await clients[id].wait(
      (m) => m.type === "usermessage" && m.kind === "openUrl",
      `openUrl for ${id}`);
    assert.equal(m.privileged, true);
    assert.deepEqual(parseLink(m.value), { round, participant: id });
  }
  // the leader gets no link
  assert.equal(
    leader.queue.find(
      (m) => m.type === "usermessage" && m.kind === "openUrl"),
    undefined);

  let v = await view(round, "remote-1");
  assert.equal(v.status, "collecting");
  assert.equal(v.me.username, "alice");
  assert.deepEqual(v.participants.map((p) => p.id).sort(),
    [...participants].sort());

  // 3. everybody answers
  const answers = {
    "remote-1": { 1: "painting", 2: "painting", 3: "painting" },
    "remote-2": { 1: "reading", 2: "reading", 3: "reading" },
    "buddy-1": { 1: "drawing", 2: "drawing", 3: "drawing" },
  };
  for (const id of participants)
    await api("POST", `/rounds/${round}/participants/${id}/answers`,
      { answers: answers[id] });

  // 4. the service matches the most similar pair and applies it
  v = await until(async () => {
    const v = await view(round, "buddy-1");
    return v.status === "done" && v;
  }, "the round to be matched");
  assert.equal(v.buddy.username, "alice");
  assert.equal(v.buddy.answers[1], "painting");
  assert.equal((await view(round, "remote-2")).buddy, null);

  await leader.wait(
    (m) => m.type === "user" && m.kind === "change" &&
      m.id === "remote-1" && m.data?.assignedTo === "buddy-1",
    "assignment of the remote");
  await leader.wait(
    (m) => m.type === "user" && m.kind === "change" &&
      m.id === "buddy-1" && m.data?.assignedTo === "remote-1",
    "assignment of the buddy device");
  assert.equal(leader.users["remote-2"].data.assignedTo, undefined);

  // 5. starting again supersedes the round and clears the assignment
  const { round: second } = await api("POST", "/rounds", { group: GROUP });
  assert.equal((await view(round, "remote-1")).status, "superseded");
  assert.equal((await view(second, "remote-1")).status, "collecting");
  await leader.wait(
    (m) => m.type === "user" && m.kind === "change" &&
      m.id === "remote-1" && !m.data?.assignedTo,
    "the assignment to be cleared");

  // Galene's .assignment endpoint validates the pairs
  const put = (pairs) => fetch(
    `${base}/galene-api/v0/.groups/${GROUP}/.assignment`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(pairs),
    });
  let r = await put([{ remote: "remote-1", buddyDevice: "remote-2" }]);
  assert.equal(r.status, 400);
  assert.match(await r.text(), /remote-2 is not a buddyDevice/);
  r = await put([{ remote: "nobody", buddyDevice: "buddy-1" }]);
  assert.equal(r.status, 400);
  assert.match(await r.text(), /no such client: nobody/);

  console.log("e2e assignment flow test passed");
}

main().then(
  () => cleanup(0),
  (e) => {
    console.error("FAILED:", e.message);
    for (const p of children)
      if (p.log)
        console.error(p.log);
    cleanup(1);
  }
);

function cleanup(code) {
  for (const c of Object.values(clients))
    c.close();
  for (const p of children)
    if (p !== server)
      p.kill();
  if (server) {
    server.on("exit", () => {
      rmSync(tmp, { recursive: true, force: true });
      process.exit(code);
    });
    server.kill();
    // in case it doesn't exit
    setTimeout(() => {
      rmSync(tmp, { recursive: true, force: true });
      process.exit(code);
    }, 2000);
  } else {
    rmSync(tmp, { recursive: true, force: true });
    process.exit(code);
  }
}
