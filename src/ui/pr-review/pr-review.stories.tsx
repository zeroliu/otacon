import { useMemo, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { RESPONSIVE_VIEWPORT_VALUE } from "storybook/viewport";
import {
  balancedFixture,
  expertFixture,
  knowledgeMarkdown,
  newerKnowledgeMarkdown,
  userKnowledgeMarkdown,
} from "./fixtures";
import { KnowledgeScreen } from "./knowledge-screen";
import { MemoryReviewAdapter } from "./model";
import type { ReviewPresentation } from "./model";
import { PrReviewScreen } from "./pr-review-screen";

const meta = {
  title: "PR Review/Full experience",
  parameters: { layout: "fullscreen" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

function ReviewFixture({ fixture }: { fixture: ReviewPresentation }) {
  const adapter = useMemo(() => new MemoryReviewAdapter(fixture), [fixture]);
  const [screen, setScreen] = useState<"review" | "knowledge">("review");
  return screen === "review" ? (
    <PrReviewScreen adapter={adapter} onOpenKnowledge={() => setScreen("knowledge")} />
  ) : (
    <KnowledgeScreen
      documents={{
        user: { markdown: userKnowledgeMarkdown },
        project: { markdown: knowledgeMarkdown },
      }}
      onBack={() => setScreen("review")}
    />
  );
}

export const BalancedDesktop: Story = {
  name: "Balanced · desktop",
  render: () => <ReviewFixture fixture={balancedFixture} />,
  globals: { viewport: { value: RESPONSIVE_VIEWPORT_VALUE, isRotated: false } },
};

export const BalancedPhone: Story = {
  name: "Balanced · phone",
  render: () => <ReviewFixture fixture={balancedFixture} />,
  globals: { viewport: { value: "mobile2", isRotated: false } },
};

export const ExpertDesktop: Story = {
  name: "Expert · desktop",
  render: () => <ReviewFixture fixture={expertFixture} />,
  globals: { viewport: { value: RESPONSIVE_VIEWPORT_VALUE, isRotated: false } },
};

export const ExpertPhone: Story = {
  name: "Expert · phone",
  render: () => <ReviewFixture fixture={expertFixture} />,
  globals: { viewport: { value: "mobile2", isRotated: false } },
};

export const KnowledgeSaved: Story = {
  name: "Knowledge · saved",
  render: () => (
    <KnowledgeScreen documents={{
      user: { markdown: userKnowledgeMarkdown },
      project: { markdown: knowledgeMarkdown },
    }} />
  ),
};

export const KnowledgeDirty: Story = {
  name: "Knowledge · dirty",
  render: () => (
    <KnowledgeScreen documents={{
      user: { markdown: userKnowledgeMarkdown },
      project: {
        markdown: `${knowledgeMarkdown}\n- Draft note awaiting save.\n`,
        baselineMarkdown: knowledgeMarkdown,
        state: "dirty",
      },
    }} />
  ),
};

export const KnowledgeConflict: Story = {
  name: "Knowledge · conflict",
  render: () => (
    <KnowledgeScreen documents={{
      user: { markdown: userKnowledgeMarkdown },
      project: {
        markdown: `${knowledgeMarkdown}\n- My unsaved interpretation.\n`,
        baselineMarkdown: knowledgeMarkdown,
        diskMarkdown: newerKnowledgeMarkdown,
        state: "conflict",
      },
    }} />
  ),
};
