import express from "express";
import { fileURLToPath } from "node:url";
import { galeneClient } from "./galene.js";
import { loadModel } from "./model.js";
import { QUESTIONS } from "./questions.js";
import { RoundManager, RoundError } from "./rounds.js";
import { matchBuddies } from "./algorithms/matching.js";

const PORT = Number(process.env.PORT) || 3000;
const GALENE_URL = process.env.GALENE_URL || "http://localhost:8443";
const GLOVE_PATH = process.env.GLOVE_PATH ||
  fileURLToPath(new URL("../models/glove.6B.50d.txt", import.meta.url));
const DIST = fileURLToPath(new URL("../dist", import.meta.url));
const CHECK_INTERVAL_MS = 2000;

const { embeddings, spell } = await loadModel(GLOVE_PATH);

const rounds = new RoundManager({
  galene: galeneClient(GALENE_URL),
  questions: QUESTIONS,
  matcher: (remotes, buddies, questions) =>
    matchBuddies(remotes, buddies, questions, embeddings, spell),
});

const api = express.Router();

// the leader's "Start assignments" button (static/galene.js)
api.post("/rounds", async (req, res) => {
  const round = await rounds.startRound(req.body?.group);
  res.json({ round });
});

api.get("/rounds/:round/participants/:pid", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json(rounds.view(req.params.round, req.params.pid));
});

api.post("/rounds/:round/participants/:pid/answers", (req, res) => {
  rounds.submitAnswers(req.params.round, req.params.pid, req.body?.answers);
  res.status(204).end();
});

api.post("/rounds/:round/match", async (req, res) => {
  await rounds.matchNow(req.params.round);
  res.status(204).end();
});

const app = express();
app.use(express.json());
// Galene's proxy keeps the /assignment prefix, so routes include it.
app.use("/assignment/api", api);
app.use("/assignment", express.static(DIST));

// Express detects error handlers by their four parameters: keep _next.
app.use((err, req, res, _next) => {
  if (!(err instanceof RoundError))
    console.error(err);
  res.status(err.status || 500).json({ error: err.message });
});

setInterval(() => {
  rounds.checkAll().catch((err) => console.error(err));
}, CHECK_INTERVAL_MS);

app.listen(PORT, () => {
  console.log(`Assignment service on :${PORT}, Galene at ${GALENE_URL}`);
});
