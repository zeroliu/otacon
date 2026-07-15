import type { QuizDefinition } from "./model";
import { QuizCard } from "./quiz-card";

const ORDER = { grading: 0, retry: 1, unanswered: 2, passed: 3 } as const;

export function QuizSection({
  quizzes,
  disabled,
  onSubmit,
}: {
  quizzes: QuizDefinition[];
  disabled?: boolean;
  onSubmit: (id: string, answer: string) => Promise<void>;
}) {
  const passed = quizzes.filter((quiz) => quiz.status === "passed").length;
  const ordered = [...quizzes].sort((a, b) => ORDER[a.status] - ORDER[b.status]);
  return (
    <div className="pr-quiz-experience">
      <header className="pr-quiz-progress" aria-label={`${passed} of ${quizzes.length} concepts demonstrated`}>
        <strong>{passed}/{quizzes.length} demonstrated</strong>
        <span>{quizzes.length - passed} remaining · pending answers appear first</span>
      </header>
      <div className="pr-quiz-list">
        {ordered.map((quiz) => (
          <QuizCard
            key={quiz.id}
            quiz={quiz}
            number={quizzes.findIndex((item) => item.id === quiz.id) + 1}
            disabled={disabled}
            onSubmit={(answer) => onSubmit(quiz.id, answer)}
          />
        ))}
      </div>
    </div>
  );
}
