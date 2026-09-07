import next from "eslint-config-next";

const config = [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "next-env.d.ts",
    ],
  },
  ...next,
  {
    rules: {
      // Apostrophes/quotes in JSX text are fine; this rule is pure noise.
      "react/no-unescaped-entities": "off",
    },
  },
];

export default config;
