import { useRef } from "react";
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
  // Pending work sorts first when the reviewer arrives, but the order is
  // frozen for the life of the mounted section: re-sorting live would
  // teleport a card to the top of the list the moment it is answered.
  const frozenRank = useRef<Map<string, number> | null>(null);
  frozenRank.current ??= new Map(
    [...quizzes]
      .sort((a, b) => ORDER[a.status] - ORDER[b.status])
      .map((quiz, index) => [quiz.id, index]),
  );
  const rank = (quiz: QuizDefinition): number =>
    frozenRank.current!.get(quiz.id) ?? frozenRank.current!.size;
  const ordered = [...quizzes].sort((a, b) => rank(a) - rank(b));
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
