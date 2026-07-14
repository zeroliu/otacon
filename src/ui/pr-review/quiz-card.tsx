import { useEffect, useState } from "react";
import type { QuizDefinition } from "./model";

export function QuizCard({
  quiz,
  number,
  disabled = false,
  onSubmit,
}: {
  quiz: QuizDefinition;
  number: number;
  disabled?: boolean;
  onSubmit: (answer: string) => Promise<void>;
}) {
  const [answer, setAnswer] = useState(quiz.answer ?? "");

  useEffect(() => {
    setAnswer(quiz.answer ?? "");
  }, [quiz.id, quiz.answer]);

  const submit = (): void => {
    if (disabled || answer.trim() === "" || quiz.status === "grading") return;
    void onSubmit(answer);
  };

  return (
    <article
      className={`pr-quiz-card is-${quiz.status}`}
      data-quiz-id={quiz.id}
      aria-busy={quiz.status === "grading"}
    >
      <header className="pr-quiz-head">
        <span className="pr-quiz-number">Q{number}</span>
        <span className="pr-quiz-concept">{quiz.concept}</span>
        <span className={`pr-quiz-state is-${quiz.status}`} aria-live="polite">
          {quiz.status === "unanswered"
            ? "unanswered"
            : quiz.status === "grading"
              ? "agent grading…"
              : quiz.status === "retry"
                ? "try again"
                : "understood"}
        </span>
      </header>

      <p className="pr-quiz-prompt">{quiz.prompt}</p>

      {quiz.status === "passed" ? (
        <div className="pr-quiz-verdict is-passed">
          <strong>Correct.</strong> {quiz.feedback}
          <span className="pr-memory-receipt">
            ✓ added to {quiz.knowledgeScope === "user" ? "User" : "Project"} knowledge
          </span>
        </div>
      ) : quiz.status === "grading" ? (
        <div className="pr-grading" role="status">
          <span className="pr-grading-cursor" aria-hidden="true">▍</span>
          Checking the causal chain, not just matching keywords…
        </div>
      ) : (
        <>
          {quiz.kind === "choice" && quiz.options !== undefined ? (
            <div className="pr-choice-list" role="group" aria-label="answer choices">
              {quiz.options.map((option) => (
                <button
                  key={option}
                  type="button"
                  className={answer === option ? "pr-choice active" : "pr-choice"}
                  aria-pressed={answer === option}
                  disabled={disabled}
                  onClick={() => {
                    setAnswer(option);
                    void onSubmit(option);
                  }}
                >
                  {option}
                </button>
              ))}
            </div>
          ) : (
            <textarea
              className="pr-quiz-answer"
              aria-label={`Answer quiz ${number}`}
              rows={4}
              value={answer}
              disabled={disabled}
              placeholder="Explain it in your own words…"
              onInput={(event) => setAnswer(event.currentTarget.value)}
            />
          )}

          {quiz.status === "retry" && (
            <div className="pr-quiz-verdict is-retry" role="alert">
              <strong>Not quite.</strong> {quiz.feedback}
              <span>Revise the answer above and send it again.</span>
            </div>
          )}

          {quiz.kind === "open" && (
            <div className="pr-quiz-actions">
              <span>Open answer · graded by the review agent</span>
              <button
                type="button"
                className="btn btn-primary"
                disabled={disabled || answer.trim() === ""}
                onClick={submit}
              >
                {quiz.status === "retry" ? "Retry answer" : "Check answer"}
              </button>
            </div>
          )}
        </>
      )}
    </article>
  );
}
