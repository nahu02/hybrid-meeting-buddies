import { checkSpelling } from "./spellchecker.js";
import { sentenceVector, cosineSimilarity } from "./glove.js";

/**
 * Compare all participants pairwise using GloVe embeddings
 *
 * @param {Array<{ id: string | number, name: string, answer: string }>} participants
 * @param {Map<string, Float32Array>} embeddings
 * @param {any} [spell]
 * @returns {{ processedParticipants: Array<any>, matches: Array<any>, assignedPairs: Array<any>, unmatched: string[] }}
 */

export function compareParticipants(
  participants,
  questions,
  embeddings,
  spell = null
) {
  // 1. Process all participants' answers across all questions
  const processedParticipants = participants.map((p) => {
    const answers = {};

    questions.forEach((question) => {
      const rawAnswer = (p.answers?.[question.id] || "").trim();

      const correctedAnswer = spell
        ? checkSpelling(rawAnswer, spell)
        : rawAnswer;

      const vectorResult = rawAnswer
        ? sentenceVector(correctedAnswer, embeddings)
        : null;

      answers[question.id] = {
        rawAnswer,
        correctedAnswer,
        vector: vectorResult?.vector || null,
        words: vectorResult?.words || [],
        matchedWords: vectorResult?.matchedWords || [],
        missingWords: vectorResult?.missingWords || [],
        hasVector: Boolean(vectorResult?.vector)
      };
    });

    return {
      id: p.id,
      name: p.name,
      answers
    };
  });

  // 2. Calculate overall similarity for every participant pair
  const matches = [];

  for (let i = 0; i < processedParticipants.length; i++) {
    for (let j = i + 1; j < processedParticipants.length; j++) {
      const p1 = processedParticipants[i];
      const p2 = processedParticipants[j];

      const questionScores = [];

      questions.forEach((question) => {
        const a1 = p1.answers[question.id];
        const a2 = p2.answers[question.id];

        if (a1.vector && a2.vector) {
          const score = cosineSimilarity(a1.vector, a2.vector);

          questionScores.push({
            questionId: question.id,
            answer1: a1.rawAnswer,
            answer2: a2.rawAnswer,
            corrected1: a1.correctedAnswer,
            corrected2: a2.correctedAnswer,
            score,
            percentage: (score * 100).toFixed(2)
          });
        }
      });

      if (questionScores.length === 0) continue;

      const totalScore = questionScores.reduce(
        (sum, q) => sum + q.score,
        0
      );

      const overallScore = totalScore / questionScores.length;

      matches.push({
        id: `${p1.id}-${p2.id}`,
        participant1Id: p1.id,
        participant2Id: p2.id,
        participant1: p1.name,
        participant2: p2.name,
        score: overallScore,
        percentage: (overallScore * 100).toFixed(2),
        questionCount: questionScores.length,
        totalQuestions: questions.length,
        questionScores
      });
    }
  }

  // 3. Sort all matches by overall similarity
  matches.sort((a, b) => b.score - a.score);

  // 4. Find optimal non-overlapping buddy pairs
  const n = processedParticipants.length;

  if (n > 20) {
    throw new Error("Exact matching currently supports up to 20 participants.");
  }

  const edgeMap = new Map();

  matches.forEach((match) => {
    const i = processedParticipants.findIndex(
      (p) => p.id === match.participant1Id
    );
    const j = processedParticipants.findIndex(
      (p) => p.id === match.participant2Id
    );

    edgeMap.set(`${i}-${j}`, match);
  });

  const memo = new Map();

  function solve(mask) {
    if (mask === 0) {
      return {
        pairCount: 0,
        totalScore: 0,
        pairs: [],
        unmatched: []
      };
    }

    if (memo.has(mask)) return memo.get(mask);

    let i = 0;
    while (!(mask & (1 << i))) i++;

    const remaining = mask & ~(1 << i);
    const rest = solve(remaining);

    let best = {
      pairCount: rest.pairCount,
      totalScore: rest.totalScore,
      pairs: rest.pairs,
      unmatched: [...rest.unmatched, i]
    };

    for (let j = i + 1; j < n; j++) {
      if (!(remaining & (1 << j))) continue;

      const match = edgeMap.get(`${i}-${j}`);
      if (!match) continue;

      const result = solve(remaining & ~(1 << j));

      const candidate = {
        pairCount: result.pairCount + 1,
        totalScore: result.totalScore + match.score,
        pairs: [...result.pairs, match],
        unmatched: result.unmatched
      };

      if (
        candidate.pairCount > best.pairCount ||
        (
          candidate.pairCount === best.pairCount &&
          candidate.totalScore > best.totalScore
        )
      ) {
        best = candidate;
      }
    }

    memo.set(mask, best);
    return best;
  }

  const solution = solve((1 << n) - 1);

  return {
    processedParticipants,
    matches,
    assignedPairs: solution.pairs,
    unmatched: solution.unmatched.map(
      (i) => processedParticipants[i].name
    )
  };
}

/**
 * Maximum-weight bipartite matching (the Hungarian algorithm, the
 * classic JV augmenting-path formulation, O(rows^2 * cols)).
 *
 * weights[i][j] is the score of pairing row i with column j.  Every
 * row is matched (with columns >= rows) so that the cardinality is
 * maximal, and among those matchings the total weight is maximal.
 *
 * @param {number[][]} weights
 * @returns {number[]} result[i] is the column matched with row i (-1 if none)
 */
function matchHungarian(weights) {
  const n = weights.length;
  if (n === 0) return [];
  const m = weights[0].length;
  if (m === 0) return weights.map(() => -1);

  // the algorithm needs the rows to be the smaller side; remember the
  // orientation so we can translate the result back
  const transposed = n > m;
  const rows = Math.min(n, m);
  const cols = Math.max(n, m);
  const weight = transposed
    ? (i, j) => weights[j][i]
    : (i, j) => weights[i][j];

  // minimise the negated weight
  const cost = [];
  for (let i = 0; i < rows; i++) {
    cost.push([]);
    for (let j = 0; j < cols; j++) {
      cost[i].push(-weight(i, j));
    }
  }

  const INF = Infinity;
  const u = new Array(rows + 1).fill(0);
  const v = new Array(cols + 1).fill(0);
  // p[j] = the row (1-based) matched with column j; p[0] holds the row
  // being augmented
  const p = new Array(cols + 1).fill(0);
  const way = new Array(cols + 1).fill(0);

  for (let i = 1; i <= rows; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(cols + 1).fill(INF);
    const used = new Array(cols + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = INF;
      let j1 = 0;
      for (let j = 1; j <= cols; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= cols; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0 !== 0);
  }

  const columnOfRow = new Array(rows).fill(-1);
  for (let j = 1; j <= cols; j++) {
    if (p[j] !== 0) {
      columnOfRow[p[j] - 1] = j - 1;
    }
  }

  if (!transposed) {
    return columnOfRow;
  }
  const rowOfColumn = new Array(n).fill(-1);
  for (let i = 0; i < rows; i++) {
    rowOfColumn[columnOfRow[i]] = i;
  }
  return rowOfColumn;
}

/**
 * Pair every remote participant with a buddy device: the bipartite
 * counterpart of compareParticipants, which pairs arbitrary
 * participants.  The similarity of a remote and a buddy device is the
 * average of the per-question cosine similarities of their answers
 * (over the questions both of them answered), and the assignment
 * maximises the total similarity while pairing as many participants as
 * possible (everybody on the smaller side).
 *
 * @param {Array<{id: string | number, name: string, answers: Record<string, string>}>} remotes
 * @param {Array<{id: string | number, name: string, answers: Record<string, string>}>} buddies
 * @param {Array<{id: string | number}>} questions
 * @param {Map<string, Float32Array>} embeddings
 * @param {any} [spell]
 * @returns {{pairs: Array<{remoteId: any, buddyDeviceId: any, remoteName: string, buddyDeviceName: string, score: number, percentage: string}>, unmatchedRemotes: string[], unmatchedBuddies: string[]}}
 */
export function matchBuddies(
  remotes,
  buddies,
  questions,
  embeddings,
  spell = null
) {
  const answerVector = (participant, questionId) => {
    const raw = (participant.answers?.[questionId] || "").trim();
    if (!raw) return null;
    const corrected = spell ? checkSpelling(raw, spell) : raw;
    return sentenceVector(corrected, embeddings).vector;
  };

  const remoteVectors = remotes.map((r) =>
    Object.fromEntries(
      questions.map((q) => [q.id, answerVector(r, q.id)])
    )
  );
  const buddyVectors = buddies.map((b) =>
    Object.fromEntries(
      questions.map((q) => [q.id, answerVector(b, q.id)])
    )
  );

  const similarity = remotes.map((_, i) =>
    buddies.map((_, j) => {
      let sum = 0;
      let count = 0;
      for (const q of questions) {
        const v1 = remoteVectors[i][q.id];
        const v2 = buddyVectors[j][q.id];
        if (v1 && v2) {
          sum += cosineSimilarity(v1, v2);
          count++;
        }
      }
      return count > 0 ? sum / count : 0;
    })
  );

  const pairs = [];
  const unmatchedRemotes = [];
  const unmatchedBuddies = [];

  if (remotes.length === 0 || buddies.length === 0) {
    return {
      pairs,
      unmatchedRemotes: remotes.map((r) => r.name),
      unmatchedBuddies: buddies.map((b) => b.name),
    };
  }

  const buddyOfRemote = matchHungarian(similarity);

  for (let i = 0; i < remotes.length; i++) {
    const j = buddyOfRemote[i];
    if (j < 0) {
      unmatchedRemotes.push(remotes[i].name);
      continue;
    }
    const score = similarity[i][j];
    pairs.push({
      remoteId: remotes[i].id,
      buddyDeviceId: buddies[j].id,
      remoteName: remotes[i].name,
      buddyDeviceName: buddies[j].name,
      score,
      percentage: (score * 100).toFixed(2),
    });
  }

  const matchedBuddies = new Set(
    buddyOfRemote.filter((j) => j >= 0)
  );
  for (let j = 0; j < buddies.length; j++) {
    if (!matchedBuddies.has(j)) {
      unmatchedBuddies.push(buddies[j].name);
    }
  }

  pairs.sort((a, b) => b.score - a.score);
  return { pairs, unmatchedRemotes, unmatchedBuddies };
}
