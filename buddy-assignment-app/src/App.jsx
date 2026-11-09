import { useState, useEffect } from "react";
import { loadGloveFromUrl } from "./algorithms/glove";
import { loadSpellChecker } from "./algorithms/spellchecker";
import { compareParticipants } from "./algorithms/matching";
import { QUESTIONS_COUNT, PARTICIPANTS_COUNT, GLOVE_MODEL_PATH } from "./config";
import "./App.css";

function createQuestions(count) {
  const safeCount = Math.max(1, Number(count) || 2);
  const list = [];
  for (let i = 1; i <= safeCount; i++) {
    list.push({
      id: i,
      name: `Question ${i}`,
    });
  }
  return list;
}

const sampleQuestions =
  [
    "What hobby or skill would you like to learn?",
    "What superpower would you like to have?",
    "What movie, book, or show have you enjoyed recently?"
  ]

function createParticipants(count) {
  const safeCount = Math.max(1, Number(count) || 2);
  const list = [];
  for (let i = 1; i <= safeCount; i++) {
    list.push({
      id: i,
      name: `Participant ${i}`,
      answers: {}
    });
  }
  return list;
}

function App() {
  const [embeddings, setEmbeddings] = useState(null);
  const [loadingModel, setLoadingModel] = useState(true);

  const [spell, setSpell] = useState(null);

  const [questions, setQuestions] = useState(() => createQuestions(QUESTIONS_COUNT));
  const [participants, setParticipants] = useState(() => createParticipants(PARTICIPANTS_COUNT));
  const [matchResult, setMatchResult] = useState([]);

  // Initialize GloVe model and spellchecker on mount
  useEffect(() => {
    async function init() {
      // 1. Initialize spellchecker
      try {
        const checker = await loadSpellChecker(import.meta.env.BASE_URL);
        setSpell(checker);
      } catch (err) {
        console.warn("Could not load spellchecker dictionary:", err);
      }

      // 2. Load local GloVe embeddings file in the background
      try {
        setLoadingModel(true);
        const glove = await loadGloveFromUrl(GLOVE_MODEL_PATH);
        setEmbeddings(glove);
      } catch (err) {
        console.error("Failed to load embeddings:", err);
      } finally {
        setLoadingModel(false);
      }
    }

    init();
  }, []);

  // Update participant answer
  function updateAnswer(id, questionId, value) {
    setParticipants((prev) =>
      prev.map((p) => {
        if (p.id !== id) return p;

        return {
          ...p,
          answers: {
            ...p.answers,
            [questionId]: value
          }
        };
      })
    );
  }

  // Execute matching using local GloVe embeddings
  function handleFindMatches() {
    if (!embeddings) return;
    const result = compareParticipants(participants, questions, embeddings, spell);
    setMatchResult(result);
  }

  return (
    <div className="app-container">
      <header className="app-header">
        <h1>Find Your Meeting Buddy</h1>
        <p className="subtitle">
          Answer the questions below and we'll automatically match you with your buddy!
        </p>
      </header>

      {/* Participants Input Section */}
      <section className="main-section">

        <div className="questions-list">
          {questions.map((q, questionIndex) => (
            <div key={q.id} className="question-card">
              <h3>{`Question ${questionIndex + 1}`}</h3>
              <h4>{sampleQuestions[questionIndex]}</h4>

              <div className="participants-list">
                {participants.map((p) => (
                  <div key={p.id} className="participant-card">
                    <div className="participant-name">
                      {p.name}
                    </div>
                    <textarea
                      className="participant-answer-input"
                      rows={1}
                      value={p.answers?.[q.id] || ""}
                      onChange={(e) =>
                        updateAnswer(p.id, q.id, e.target.value)
                      }
                      placeholder="Enter answer"
                    />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="action-row">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!embeddings || loadingModel}
            onClick={handleFindMatches}
          >
            {loadingModel ? "Initializing..." : "Find Buddy Matches"}
          </button>
        </div>
      </section>

      {/* Results Section */}
      {matchResult && matchResult.assignedPairs && (
        <section className="results-section">
          {/* Suggested Buddy Assignments */}
          <div className="assigned-pairs-card">
            <h3>Suggested Buddy Assignments</h3>
            <p className="pairs-desc">
              Optimal buddy pairings based on answer similarity:
            </p>
            <div className="pairs-list">

              {matchResult.assignedPairs.map((pair) => (
                <div key={pair.id} className="pair-pill">

                  <span className="pair-names">
                    <strong>{pair.participant1}</strong> &harr; <strong>{pair.participant2}</strong>
                  </span>

                  <span className="pair-score">
                    {pair.percentage}% match
                  </span>

                </div>
              ))}

              {matchResult.unmatched && matchResult.unmatched.length > 0 && (
                <div className="unmatched-note">
                  Unpaired participant: {matchResult.unmatched.join(", ")}
                </div>
              )}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

export default App;
