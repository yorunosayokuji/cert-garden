import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Workers実runtime(workerd)+ローカルD1(miniflare)で試験する。migrationsは実ファイルを適用。
export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: { bindings: { TEST_MIGRATIONS: await readD1Migrations('./migrations') } },
    }),
  ],
  test: { setupFiles: ['./test/setup.ts'], include: ['test/**/*.test.ts'], testTimeout: 30000 },
}));
