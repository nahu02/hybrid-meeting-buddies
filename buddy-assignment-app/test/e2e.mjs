/**
 * End-to-end smoke test of the buddy assignment flow.  Run with
 * `npm run test:e2e` from buddy-assignment-app/.
 *
 * The test builds the Galene server, starts it with a throwaway
 * anonymous group, and then drives the whole flow over the websocket
 * protocol (the same subset of it that static/protocol.js implements;
 * no media is exchanged):
 *
 *   1. a leader, two remote participants and a buddy device join with
 *      their roles as join data;
 *   2. the leader starts the assignments: every remote and buddy
 *      device receives an openUrl message pointing at its assignment
 *      controller page (/assignment/<group>/<id>?role=<role>);
 *   3. one assignment controller per participant (the pages the app
 *      would open) joins with role assignmentController and submits
 *      its participant's answers;
 *   4. once everybody has answered, the elected controller (smallest
 *      participantId, mirroring src/galene.js) computes the matching
 *      with src/algorithms/matching.js and sends assignBuddies;
 *   5. every client observes the resulting assignedTo data changes.
 *
 * It also checks that the built app is served under /assignment/ (run
 * `npm run build` first) and that unauthorised or invalid assignBuddies
 * requests are rejected.
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
import { matchBuddies } from "../src/algorithms/matching.js";

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
 * join a group, track the user list and send user/group actions.
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

  userAction(kind, value) {
    this.send({
      type: "useraction",
      source: this.id,
      dest: this.id,
      username: this.username,
      kind,
      value,
    });
  }

  groupAction(kind, value) {
    this.send({
      type: "groupaction",
      source: this.id,
      kind,
      username: this.username,
      value,
    });
  }

  async expectError(value) {
    const m = await this.wait(
      (m) => m.type === "usermessage" && m.kind === "error",
      `error "${value}"`
    );
    assert.equal(m.value, value);
  }

  close() {
    this.ws?.close();
  }
}

/** Parse an openUrl value the way the app does (src/galene.js). */
function parseOpenUrl(u) {
  const m = u.match(/^\/assignment\/(.+)\/([^/?]+)\?(.*)$/);
  assert.ok(m, `bad openUrl ${u}`);
  return {
    group: m[1],
    participantId: m[2],
    role: new URLSearchParams(m[3]).get("role"),
  };
}

const tmp = mkdtempSync(join(tmpdir(), "galene-e2e-"));
const children = [];
const clients = {};
let server = null;

async function main() {
  // build the server
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

  const port = await freePort();
  server = spawn(bin, [
    "-http", `127.0.0.1:${port}`,
    "-insecure",
    "-static", join(repoRoot, "static") + "/",
    "-groups", join(tmp, "groups") + "/",
    "-data", join(tmp, "data"),
  ], { stdio: ["ignore", "pipe", "pipe"] });
  children.push(server);
  let log = "";
  server.stdout.on("data", (d) => { log += d; });
  server.stderr.on("data", (d) => { log += d; });
  server.on("exit", (code) => {
    if (code && code !== 0 && !server.killed)
      console.error("server exited:", code, log);
  });

  const base = `http://127.0.0.1:${port}`;
  const statusUrl = `${base}/group/${GROUP}/.status`;

  // wait for the server to come up
  let status = null;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(statusUrl);
      if (r.ok) {
        status = await r.json();
        break;
      }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(status, "server did not come up");
  assert.equal(status.name, GROUP);
  const endpoint = status.endpoint || `ws://127.0.0.1:${port}/ws`;

  // the built assignment app must be served (npm run build first)
  {
    const r = await fetch(`${base}/assignment/${GROUP}/some-id?role=remote`);
    assert.equal(r.status, 200);
    const page = await r.text();
    if (!page.includes('id="root"')) {
      throw new Error(
        "the assignment page is the placeholder, not the built app; " +
        "run `npm run build` in buddy-assignment-app first"
      );
    }
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
  const remote1 = await joinAs("remote-1", "alice", "remote");
  const remote2 = await joinAs("remote-2", "bob", "remote");
  await joinAs("buddy-1", "carol", "buddyDevice");

  // the leader sees everybody
  for (const id of ["leader-id", "remote-1", "remote-2", "buddy-1"]) {
    await leader.wait(
      (m) => m.type === "user" && m.kind === "add" && m.id === id,
      `user add for ${id}`);
  }

  // only the leader may start assignments
  remote1.groupAction("startAssignments");
  await remote1.expectError("not authorised");

  // 2. the leader starts the assignments
  leader.groupAction("startAssignments");
  const openUrls = {};
  for (const [id, role] of [
    ["remote-1", "remote"],
    ["remote-2", "remote"],
    ["buddy-1", "buddyDevice"],
  ]) {
    const m = await clients[id].wait(
      (m) => m.type === "usermessage" && m.kind === "openUrl",
      `openUrl for ${id}`);
    assert.equal(m.privileged, true);
    openUrls[id] = parseOpenUrl(m.value);
    assert.deepEqual(openUrls[id], {
      group: GROUP,
      participantId: id,
      role,
    });
  }
  // the leader gets no openUrl
  assert.equal(
    leader.queue.find(
      (m) => m.type === "usermessage" && m.kind === "openUrl"),
    undefined);

  // 3. one controller per participant joins and submits answers
  const controllers = {};
  for (const id of ["remote-1", "remote-2", "buddy-1"]) {
    const url = openUrls[id];
    const c = new Client(`controller-${id}`);
    await c.connect(endpoint);
    c.username = `controller-of-${url.participantId}`;
    c.join(c.username, {
      role: "assignmentController",
      participantId: url.participantId,
      participantRole: url.role,
    });
    await c.wait(
      (m) => m.type === "joined" && m.kind === "join",
      `controller join for ${id}`);
    controllers[id] = c;

    c.userAction("setdata", {
      answers: { 1: "i like painting and cooking", 2: "baking" },
    });
    // the controller sees its own data change
    await c.wait(
      (m) => m.type === "user" && m.kind === "change" &&
        m.id === c.id && m.data?.answers,
      `own answers of ${id}`);
  }

  // every controller sees every other participant's answers
  for (const [ownId, c] of Object.entries(controllers)) {
    for (const id of ["remote-1", "remote-2", "buddy-1"]) {
      if (id === ownId)
        continue; // already confirmed above
      await c.wait(
        (m) => m.type === "user" &&
          (m.kind === "change" || m.kind === "add") &&
          m.data?.role === "assignmentController" &&
          m.data?.participantId === id && m.data?.answers,
        `answers of ${id}`);
    }
  }

  // a participant (not a controller) may not assign buddies
  remote1.groupAction("assignBuddies", [
    { remote: "remote-1", buddyDevice: "buddy-1" },
  ]);
  await remote1.expectError("not authorised");

  // 4. the elected controller (smallest participantId, as in
  // src/galene.js) runs the matching and applies it
  const participants = [
    { id: "remote-1", role: "remote", username: "alice",
      answers: { 1: "i like painting and cooking", 2: "baking" } },
    { id: "remote-2", role: "remote", username: "bob",
      answers: { 1: "i like painting and cooking", 2: "baking" } },
    { id: "buddy-1", role: "buddyDevice", username: "carol",
      answers: { 1: "i like painting and cooking", 2: "baking" } },
  ];
  const matching = matchBuddies(
    participants.filter((p) => p.role === "remote"),
    participants.filter((p) => p.role === "buddyDevice"),
    [{ id: 1 }, { id: 2 }],
    null
  );
  assert.equal(matching.pairs.length, 1);

  const electedId = ["buddy-1", "remote-1", "remote-2"].sort()[0];
  const elected = controllers[electedId];
  elected.groupAction("assignBuddies",
    matching.pairs.map((p) => ({
      remote: p.remoteId,
      buddyDevice: p.buddyDeviceId,
    })));

  // 5. everybody observes the assignment
  const pair = matching.pairs[0];
  await leader.wait(
    (m) => m.type === "user" && m.kind === "change" &&
      m.id === pair.remoteId &&
      m.data?.assignedTo === pair.buddyDeviceId,
    "assignment of the remote");
  await leader.wait(
    (m) => m.type === "user" && m.kind === "change" &&
      m.id === pair.buddyDeviceId &&
      m.data?.assignedTo === pair.remoteId,
    "assignment of the buddy device");
  assert.equal(leader.users[pair.remoteId].data.assignedTo,
    pair.buddyDeviceId);
  assert.equal(leader.users[pair.buddyDeviceId].data.assignedTo,
    pair.remoteId);
  // the second remote stays unassigned
  await remote2.wait(
    (m) => m.type === "user" && m.kind === "change" &&
      m.id === pair.remoteId,
    "the other remote learns about the assignment");
  assert.equal(leader.users["remote-2"].data.assignedTo, undefined);

  // invalid pairs are rejected: two remotes are not a pair
  elected.groupAction("assignBuddies", [
    { remote: "remote-1", buddyDevice: "remote-2" },
  ]);
  await elected.expectError("client remote-2 is not a buddyDevice");

  // unknown ids are rejected
  elected.groupAction("assignBuddies", [
    { remote: "nobody", buddyDevice: "buddy-1" },
  ]);
  await elected.expectError("no such client: nobody");

  console.log("e2e assignment flow test passed");
}

main().then(
  () => cleanup(0),
  (e) => {
    console.error("FAILED:", e.message);
    cleanup(1);
  }
);

function cleanup(code) {
  for (const c of Object.values(clients))
    c.close();
  for (const p of children)
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
