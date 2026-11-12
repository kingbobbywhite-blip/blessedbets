import { defineConfig, globalIgnores } from "eslint/config"
import nextPlugin from "@next/eslint-plugin-next"
import reactHooks from "eslint-plugin-react-hooks"
import tseslint from "typescript-eslint"

// Built from the same pieces as eslint-config-next (Next rules, React Hooks,
// typescript-eslint recommended) rather than that package itself, because its
// bundled eslint-plugin-react, -import and -jsx-a11y do not run on ESLint 10.
export default defineConfig(
  globalIgnores([
    ".next/**",
    "node_modules/**",
    "archive/**",
    "next-env.d.ts",
    // Vendored, minified Tesseract worker and WASM loaders served as-is.
    "public/tesseract/**",
    // A separate project with its own dependencies, checks and CI job.
    "switchboard/**",
  ]),
  tseslint.configs.recommended,
  reactHooks.configs.flat.recommended,
  // package.json overrides this plugin's fast-glob with tinyglobby, because
  // fast-glob pulls in braces, which has an advisory and no patched release.
  // The plugin's only glob runs when settings.next.rootDir is set, which it is
  // not here. If it is ever set, note tinyglobby expands a bare directory name
  // to its subdirectories as well.
  nextPlugin.configs["core-web-vitals"],
  {
    rules: {
      // The store hydrates from localStorage in a mount effect (there is no
      // window during SSR), and a few screens reset derived state when their
      // inputs change. Both are deliberate; this React Compiler rule flags them.
      "react-hooks/set-state-in-effect": "off",
    },
  },
)
