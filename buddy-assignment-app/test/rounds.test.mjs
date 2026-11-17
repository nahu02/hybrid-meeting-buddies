/**
 * Unit tests for the round logic (server/rounds.js), against a fake
 * Galene.  Run with `npm run test:rounds`.
 */
import assert from "node:assert/strict";
import { RoundManager, RoundError } from "../server/rounds.js";

const questions = [{ id: 1, text: "Q1" }, { id: 2, text: "Q2" }];

/** A fake of server/galene.js that records every call. */
function fakeGalene(clients) {
  const fake = {
    clients,
    assignments: [],
    opened: [],
    failAssignment: false,
    async listClients() {
      return fake.clients;
    },
    async setAssignment(group, pairs) {
      if (fake.failAssignment)
        throw new Error("no such client");
      fake.assignments.push(pairs);
    },
    async openUrls(group, targets) {
      fake.opened.push(...targets);
    },
  };
  return fake;
}

// pairs remotes and buddies in order; records how often it ran
function fakeMatcher() {
  const m = (remotes, buddies) => {
    m.calls++;
    const n = Math.min(remotes.length, buddies.length);
    return {
      pairs: Array.from({ length: n }, (_, i) => ({
        remoteId: remotes[i].id, buddyDeviceId: buddies[i].id, score: 1,
      })),
    };
  };
  m.calls = 0;
  return m;
}

const people = () => [
  { id: "L", username: "leader", role: "leader" },
  { id: "r1", username: "Rita", role: "remote" },
  { id: "r2", username: "Rob", role: "remote" },
  { id: "b1", username: "Phone", role: "buddyDevice" },
];

function setup() {
  const galene = fakeGalene(people());
  const matcher = fakeMatcher();
  const rounds = new RoundManager({ galene, matcher, questions });
  return { galene, matcher, rounds };
}

// wait for the matching that submitAnswers starts in the background
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// starting a round clears assignments and sends links to remotes and
// buddy devices only
{
  const { galene, rounds } = setup();
  const id = await rounds.startRound("g");
  assert.deepEqual(galene.assignments, [[]]);
  assert.deepEqual(galene.opened.map((t) => t.client), ["r1", "r2", "b1"]);
  assert.match(galene.opened[0].url,
    new RegExp(`^/assignment/\\?round=${id}&participant=r1$`));

  const v = rounds.view(id, "r1");
  assert.equal(v.status, "collecting");
  assert.equal(v.me.username, "Rita");
  assert.equal(v.me.answered, false);
  assert.equal(v.participants.length, 3);
  assert.throws(() => rounds.view(id, "L"), RoundError);
}

// auto-match once everybody answered; exactly one matching
{
  const { galene, matcher, rounds } = setup();
  const id = await rounds.startRound("g");
  rounds.submitAnswers(id, "r1", { 1: " cooking ", 2: "flying" });
  rounds.submitAnswers(id, "b1", { 1: "baking" });
  await settle();
  assert.equal(rounds.view(id, "r1").status, "collecting");

  // resubmitting overwrites (e.g. the link opened in two tabs)
  rounds.submitAnswers(id, "r1", { 1: "painting", 2: "flying" });
  rounds.submitAnswers(id, "r2", { 1: "reading", 2: "x" });
  await settle();
  await rounds.checkAll(); // a concurrent check must not match again
  assert.equal(matcher.calls, 1);

  const v = rounds.view(id, "b1");
  assert.equal(v.status, "done");
  assert.equal(v.buddy.username, "Rita");
  assert.deepEqual(v.buddy.answers, { 1: "painting", 2: "flying" });
  assert.deepEqual(galene.assignments.at(-1), [{ remote: "r1", buddyDevice: "b1" }]);
  assert.equal(rounds.view(id, "r2").buddy, null);
  assert.deepEqual(rounds.view(id, "r1").myAnswers, { 1: "painting", 2: "flying" });

  assert.throws(() => rounds.submitAnswers(id, "r2", {}),
    (err) => err.status === 409);
}

// a participant leaving completes the round on the next check
{
  const { galene, rounds } = setup();
  const id = await rounds.startRound("g");
  rounds.submitAnswers(id, "r1", { 1: "a", 2: "b" });
  rounds.submitAnswers(id, "b1", { 1: "a", 2: "b" });
  await settle();
  assert.equal(rounds.view(id, "r1").status, "collecting");
  galene.clients = galene.clients.filter((c) => c.id !== "r2");
  await rounds.checkAll();
  assert.equal(rounds.view(id, "r1").status, "done");
  assert.equal(rounds.view(id, "r1").participants.length, 2);
}

// match now: with those who answered; refused when one side is missing
{
  const { rounds } = setup();
  const id = await rounds.startRound("g");
  rounds.submitAnswers(id, "r1", { 1: "a", 2: "b" });
  await settle();
  await assert.rejects(rounds.matchNow(id), (err) => err.status === 409);
  assert.equal(rounds.view(id, "r1").status, "collecting");

  rounds.submitAnswers(id, "b1", { 1: "a", 2: "b" });
  await rounds.matchNow(id);
  assert.equal(rounds.view(id, "r1").status, "done");
  assert.equal(rounds.view(id, "r1").buddy.username, "Phone");
}

// starting again supersedes the previous round
{
  const { galene, rounds } = setup();
  const first = await rounds.startRound("g");
  rounds.submitAnswers(first, "r1", { 1: "a", 2: "b" });
  const second = await rounds.startRound("g");
  assert.notEqual(first, second);
  assert.equal(rounds.view(first, "r1").status, "superseded");
  assert.equal(rounds.view(second, "r1").status, "collecting");
  assert.equal(rounds.view(second, "r1").me.answered, false);
  assert.equal(galene.opened.length, 6);

  // a double press: two starts at the same time, the last one wins
  const [a, b] = await Promise.all([
    rounds.startRound("g"), rounds.startRound("g"),
  ]);
  assert.equal(rounds.view(a, "r1").status, "superseded");
  assert.equal(rounds.view(b, "r1").status, "collecting");
}

// a failing setAssignment goes back to collecting and is retried
{
  const { galene, rounds } = setup();
  const id = await rounds.startRound("g");
  galene.failAssignment = true;
  for (const pid of ["r1", "r2", "b1"])
    rounds.submitAnswers(id, pid, { 1: "a", 2: "b" });
  await settle();
  let v = rounds.view(id, "r1");
  assert.equal(v.status, "collecting");
  assert.match(v.error, /no such client/);

  galene.failAssignment = false;
  await rounds.checkAll();
  v = rounds.view(id, "r1");
  assert.equal(v.status, "done");
  assert.equal(v.error, null);
}

// a group that isn't running
{
  const galene = fakeGalene([]);
  galene.listClients = async () => {
    throw new Error("404 not found");
  };
  const rounds = new RoundManager({
    galene, matcher: fakeMatcher(), questions,
  });
  await assert.rejects(rounds.startRound("nope"),
    (err) => err.status === 502);
  await assert.rejects(rounds.startRound(""), (err) => err.status === 400);
  assert.throws(() => rounds.view("nope", "r1"), (err) => err.status === 404);
}

console.log("round tests passed");
