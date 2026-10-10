import { defineConfig } from 'vitest/config';

// Live tests against real OpenRouter free models. Run manually: npx vitest run -c vitest.live.config.ts
// Needs a key in OPENROUTER_API_KEY (or a proxy that injects one).
export default defineConfig({
  test: { include: ['tests/live/**/*.test.ts'], environment: 'jsdom', testTimeout: 120000 },
});
