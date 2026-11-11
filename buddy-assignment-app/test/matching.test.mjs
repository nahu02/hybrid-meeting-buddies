/**
 * Unit tests for the bipartite buddy matching
 * (src/algorithms/matching.js).  Run with `npm run test:matching`.
 */
import assert from "node:assert/strict";
import { matchBuddies } from "../src/algorithms/matching.js";

const embeddings = new Map([
  ["cooking", Float32Array.from([1, 0])],
  ["baking", Float32Array.from([0.9, 0.1])],
  ["painting", Float32Array.from([0, 1])],
  ["drawing", Float32Array.from([0.1, 0.9])],
]);
const questions = [{ id: 1 }, { id: 2 }];

const remotes = [
  { id: "r1", name: "R-one", answers: { 1: "cooking", 2: "baking" } },
  { id: "r2", name: "R-two", answers: { 1: "drawing", 2: "painting drawing" } },
  { id: "r3", name: "R-three", answers: { 1: "drawing", 2: "cooking" } },
];
const buddies = [
  { id: "b1", name: "B-one", answers: { 1: "cooking", 2: "baking" } },
  { id: "b2", name: "B-two", answers: { 1: "drawing painting", 2: "drawing" } },
];

// the optimal assignment pairs the two very similar participants and
// leaves the dissimilar remote unmatched
{
  const r = matchBuddies(remotes, buddies, questions, embeddings);
  const byRemote = Object.fromEntries(
    r.pairs.map((p) => [p.remoteId, p.buddyDeviceId])
  );
  assert.equal(r.pairs.length, 2);
  assert.equal(byRemote.r1, "b1");
  assert.equal(byRemote.r2, "b2");
  assert.deepEqual(r.unmatchedRemotes, ["R-three"]);
  assert.deepEqual(r.unmatchedBuddies, []);
}

// more buddies than remotes: every remote is matched
{
  const r = matchBuddies(
    remotes,
    [...buddies, { id: "b3", name: "B-three", answers: { 1: "cooking", 2: "cooking" } }],
    questions,
    embeddings
  );
  assert.equal(r.pairs.length, 3);
  assert.deepEqual(r.unmatchedBuddies, []);
}

// an empty side matches nobody
{
  const r = matchBuddies([], buddies, questions, embeddings);
  assert.equal(r.pairs.length, 0);
  assert.deepEqual(r.unmatchedBuddies, ["B-one", "B-two"]);
}

// the total similarity is maximal: giving the popular buddy to the
// remote that likes it most beats giving it to the other
{
  const emb = new Map([
    ["x", Float32Array.from([1, 0])],
    ["y", Float32Array.from([0, 1])],
  ]);
  const rs = [
    { id: "ra", name: "ra", answers: { 1: "x x y" } },
    { id: "rb", name: "rb", answers: { 1: "x" } },
  ];
  const bs = [
    { id: "ba", name: "ba", answers: { 1: "x" } },
    { id: "bb", name: "bb", answers: { 1: "x x y" } },
  ];
  const r = matchBuddies(rs, bs, [{ id: 1 }], emb);
  const byRemote = Object.fromEntries(
    r.pairs.map((p) => [p.remoteId, p.buddyDeviceId])
  );
  assert.equal(r.pairs.length, 2);
  // the identical-answer pairs score higher than the mixed ones
  assert.equal(byRemote.ra, "bb");
  assert.equal(byRemote.rb, "ba");
}

console.log("matching tests passed");
