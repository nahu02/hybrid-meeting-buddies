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
