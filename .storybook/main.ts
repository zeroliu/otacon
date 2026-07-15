import type { StorybookConfig } from "@storybook/react-vite";

const config: StorybookConfig = {
  framework: "@storybook/react-vite",
  addons: ["@storybook/addon-a11y"],
  stories: ["../src/ui/**/*.stories.@(ts|tsx)"],
  viteFinal(config) {
    return {
      ...config,
      define: {
        ...config.define,
        __OTACON_VERSION__: JSON.stringify("storybook"),
      },
    };
  },
};

export default config;
