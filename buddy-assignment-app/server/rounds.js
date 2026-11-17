import { randomUUID } from "node:crypto";

/**
 * Round status:
 *   starting   → links are being sent
 *   collecting → waiting for answers
 *   matching   → computing and applying the assignment
 *   done       → pairs are applied in Galene
 *   superseded → a newer round of the same group replaced this one
 *
 * Other requests can run at every `await`, so a round is claimed
 * (e.g. status = "matching") before the first await.
 */

const PARTICIPANT_ROLES = new Set(["remote", "buddyDevice"]);
const MAX_ANSWER_LENGTH = 2000;

/** An error with the HTTP status the API should answer with. */
export class RoundError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export class RoundManager {
  /** round id → round */
  #rounds = new Map();
  /** group name → its current round */
  #current = new Map();

  /**
   * @param {object} options
   * @param {ReturnType<import("./galene.js").galeneClient>} options.galene
   * @param {(remotes: any[], buddies: any[], questions: any[]) =>
   *          {pairs: {remoteId: string, buddyDeviceId: string, score: number}[]}} options.matcher
   * @param {{id: number, text: string}[]} options.questions
   * @param {(id: string) => string} [options.linkFor] the link sent to a
   *        participant (relative to Galene's origin)
   */
  constructor({ galene, matcher, questions, linkFor }) {
    this.galene = galene;
    this.matcher = matcher;
    this.questions = questions;
    this.linkFor = linkFor ||
      ((roundId, clientId) =>
        `/assignment/?round=${encodeURIComponent(roundId)}` +
        `&participant=${encodeURIComponent(clientId)}`);
  }

  /**
   * Start a new round in group: clear the assignments in Galene and
   * send every remote participant and buddy device its link.
   * @returns {Promise<string>} the round id
   */
  async startRound(group) {
    if (typeof group !== "string" || group === "")
      throw new RoundError(400, "missing group");

    const round = {
      id: randomUUID(),
      group,
      status: "starting",
      /** client id → {id, username, role} */
      participants: new Map(),
      /** ids of the participants still in the group */
      present: new Set(),
      /** client id → {questionId: answer} */
      answers: new Map(),
      pairs: [],
      lastError: null,
    };
    // Register the round before any await: a concurrent start (double
    // press) then supersedes this one, and vice versa.
    const previous = this.#current.get(group);
    if (previous)
      previous.status = "superseded";
    this.#current.set(group, round);
    this.#rounds.set(round.id, round);

    try {
      const clients = await this.galene.listClients(group);
      for (const c of clients) {
        if (!PARTICIPANT_ROLES.has(c.role))
          continue;
        round.participants.set(c.id, {
          id: c.id, username: c.username || "unknown", role: c.role,
        });
        round.present.add(c.id);
      }
      if (round.status === "superseded")
        return round.id;

      await this.galene.setAssignment(group, []);
      if (round.status === "superseded")
        return round.id;

      round.status = "collecting";
      await this.galene.openUrls(group,
        [...round.participants.keys()].map((id) => ({
          client: id, url: this.linkFor(round.id, id),
        })));
    } catch (err) {
      // e.g. the group isn't running: forget the round
      this.#rounds.delete(round.id);
      if (this.#current.get(group) === round)
        this.#current.delete(group);
      throw new RoundError(502, err.message);
    }
    return round.id;
  }

  /** Store the answers of participant pid (resubmitting overwrites). */
  submitAnswers(roundId, pid, answers) {
    const round = this.#round(roundId);
    this.#participant(round, pid);
    if (round.status !== "collecting")
      throw new RoundError(409, `the round is ${round.status}`);
    if (typeof answers !== "object" || answers === null)
      throw new RoundError(400, "answers must be an object");

    const clean = {};
    for (const q of this.questions) {
      clean[q.id] = String(answers[q.id] ?? "")
        .trim()
        .slice(0, MAX_ANSWER_LENGTH);
    }
    round.answers.set(pid, clean);

    // Don't make the participant wait for the matching; check() never
    // throws (it records errors in round.lastError).
    void this.check(round);
  }

  /** Match the participants that have answered so far. */
  async matchNow(roundId) {
    const round = this.#round(roundId);
    if (round.status !== "collecting")
      throw new RoundError(409, `the round is ${round.status}`);
    const matched = await this.#match(round);
    if (!matched && round.status === "collecting") {
      throw new RoundError(409, round.lastError ||
        "need at least one remote participant and one buddy device " +
        "who answered");
    }
  }

  /**
   * Periodic check of every collecting round: participants may have
   * left the meeting, which can complete a round without a new answer.
   */
  async checkAll() {
    await Promise.all(
      [...this.#current.values()].map((round) => this.check(round))
    );
  }

  /** Match round if every participant still present has answered. */
  async check(round) {
    if (round.status !== "collecting")
      return;
    try {
      this.#updatePresence(round, await this.galene.listClients(round.group));
    } catch (err) {
      round.lastError = err.message;
      return;
    }
    const present = [...round.present];
    const complete = present.length > 0 &&
      present.every((id) => round.answers.has(id)) &&
      this.#answered(round, "remote").length > 0 &&
      this.#answered(round, "buddyDevice").length > 0;
    if (complete)
      await this.#match(round);
  }

  /** What the page of participant pid shows. */
  view(roundId, pid) {
    const round = this.#round(roundId);
    const me = this.#participant(round, pid);

    let buddy = null;
    const pair = round.pairs.find(
      (p) => p.remoteId === pid || p.buddyDeviceId === pid);
    if (pair) {
      const id = pair.remoteId === pid ? pair.buddyDeviceId : pair.remoteId;
      const b = round.participants.get(id);
      buddy = {
        username: b.username, role: b.role,
        answers: round.answers.get(id) || {},
      };
    }

    return {
      status: round.status,
      questions: this.questions,
      me: { ...me, answered: round.answers.has(pid) },
      myAnswers: round.answers.get(pid) || null,
      participants: [...round.participants.values()]
        .filter((p) => round.present.has(p.id))
        .map((p) => ({
          id: p.id, username: p.username, role: p.role,
          answered: round.answers.has(p.id),
        })),
      buddy,
      error: round.lastError,
    };
  }

  /**
   * Compute the matching of the answered, present participants and
   * apply it in Galene.  Returns whether a matching was applied.
   */
  async #match(round) {
    if (round.status !== "collecting")
      return false;
    // claim the round before the first await (see the top comment)
    round.status = "matching";
    try {
      this.#updatePresence(round, await this.galene.listClients(round.group));
      if (round.status !== "matching")
        return false;

      const remotes = this.#answered(round, "remote");
      const buddies = this.#answered(round, "buddyDevice");
      if (remotes.length === 0 || buddies.length === 0) {
        round.status = "collecting";
        return false;
      }

      const { pairs } = this.matcher(remotes, buddies, this.questions);
      await this.galene.setAssignment(round.group, pairs.map((p) => ({
        remote: p.remoteId, buddyDevice: p.buddyDeviceId,
      })));
      if (round.status !== "matching")
        return false;
      round.pairs = pairs;
      round.lastError = null;
      round.status = "done";
      return true;
    } catch (err) {
      // e.g. somebody left between listClients and setAssignment;
      // the next check retries
      console.error(`Matching round ${round.id} failed:`, err);
      round.lastError = err.message;
      if (round.status === "matching")
        round.status = "collecting";
      return false;
    }
  }

  /** The present participants of role that have answered. */
  #answered(round, role) {
    return [...round.participants.values()]
      .filter((p) => p.role === role && round.present.has(p.id) &&
        round.answers.has(p.id))
      .map((p) => ({
        id: p.id, name: p.username, answers: round.answers.get(p.id),
      }));
  }

  #updatePresence(round, clients) {
    const ids = new Set(clients.map((c) => c.id));
    round.present = new Set(
      [...round.participants.keys()].filter((id) => ids.has(id)));
  }

  #round(roundId) {
    const round = this.#rounds.get(roundId);
    if (!round)
      throw new RoundError(404, "no such round");
    return round;
  }

  #participant(round, pid) {
    const p = round.participants.get(pid);
    if (!p)
      throw new RoundError(404, "not a participant of this round");
    return p;
  }
}
