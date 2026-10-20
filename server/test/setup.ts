import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

// 実ファイル migrations/*.sql をローカルD1へ適用してから各試験を始める
await applyD1Migrations(env.DB, (env as unknown as { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] }).TEST_MIGRATIONS);
