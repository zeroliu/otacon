import type { Preview } from "@storybook/react-vite";
import { MINIMAL_VIEWPORTS, RESPONSIVE_VIEWPORT_VALUE } from "storybook/viewport";
import "../src/ui/styles.css";

const preview: Preview = {
  parameters: {
    layout: "fullscreen",
    viewport: {
      options: MINIMAL_VIEWPORTS,
    },
    a11y: {
      test: "error",
    },
  },
  initialGlobals: {
    viewport: { value: RESPONSIVE_VIEWPORT_VALUE, isRotated: false },
  },
};

export default preview;
