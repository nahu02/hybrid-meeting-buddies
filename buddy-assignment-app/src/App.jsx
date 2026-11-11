import { useState, useEffect } from "react";
import { loadGloveFromUrl } from "./algorithms/glove";
import { loadSpellChecker } from "./algorithms/spellchecker";
import { compareParticipants } from "./algorithms/matching";
import { QUESTIONS_COUNT } from "./config";
import "./App.css";

function createQuestions(count) {
  const safeCount = Math.max(1, Number(count) || 2);
  const list = [];
  for (let i = 1; i <= safeCount; i++) {
    list.push({
      id: i,
      answer: ""
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

function App() {
  // const [embeddings, setEmbeddings] = useState(null);
  // const [loadingModel, setLoadingModel] = useState(true);
  // const [matchResult, setMatchResult] = useState([]);
  // const [spell, setSpell] = useState(null);

  const [questions, setQuestions] = useState(() => createQuestions(QUESTIONS_COUNT));
  const [submitted, setSubmitted] = useState(false);

  // Initialize GloVe model and spellchecker on mount
  // useEffect(() => {
  //   async function init() {
  //     // 1. Initialize spellchecker
  //     try {
  //       const checker = await loadSpellChecker(import.meta.env.BASE_URL);
  //       setSpell(checker);
  //     } catch (err) {
  //       console.warn("Could not load spellchecker dictionary:", err);
  //     }

  //     // 2. Load local GloVe embeddings file in the background
  //     try {
  //       setLoadingModel(true);
  //       const glove = await loadGloveFromUrl(GLOVE_MODEL_PATH);
  //       setEmbeddings(glove);
  //     } catch (err) {
  //       console.error("Failed to load embeddings:", err);
  //     } finally {
  //       setLoadingModel(false);
  //     }
  //   }

  //   init();
  // }, []);

  // Update participant answer
  function updateAnswer(questionId, value) {
    setQuestions((prev) =>
      prev.map((q) =>
        q.id === questionId ? { ...q, answer: value } : q));
  }

  // Execute matching using local GloVe embeddings
  // function handleFindMatches() {
  //   if (!embeddings) return;
  //   const result = compareParticipants(participants, questions, embeddings, spell);
  //   setMatchResult(result);
  // }

  function convertAnswersToJSON() {
    const jsonData = JSON.stringify(questions, null, 2);

    console.log("Participants as JSON:", jsonData);
  }

  return (
    <div className="app-container">
      {!submitted ? (
        <section className="main-section">
          <header className="app-header">
            <h1>Find Your Meeting Buddy</h1>
            <p className="subtitle">
              Answer the questions below and we'll automatically match you with your buddy!
            </p>
          </header>

          {/* Answers Input Section */}
          <section className="answers-section">
            <div className="questions-list">
              {questions.map((q, index) => (
                <div key={q.id} className="question-card">
                  <h3>{`Question ${index + 1}`}</h3>
                  <h4>{sampleQuestions[index]}</h4>
                  <textarea
                    className="participant-answer-input"
                    rows={3}
                    value={q.answer}
                    onChange={(e) => updateAnswer(q.id, e.target.value)}
                    placeholder="Enter answer"
                  />
                </div>
              ))}
            </div>

            <div className="action-row">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  convertAnswersToJSON();
                  setSubmitted(true);
                }}
              >
                Find Your Buddy!
              </button>
            </div>
          </section>
        </section>
      ) : (
        <section className="main-section waiting-section">
          <h2>Your answers have been submitted!</h2>
          <p>Please wait while we find your buddy.</p>
        </section>
      )}
    </div>
  );
}

export default App;
