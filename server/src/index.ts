import { createHandler } from './app.ts';
import type { AppEnv } from './env.ts';

// 本番入口。テスト用のverifier/鍵/モックはここへ一切入れない（実のfetchと時計だけを渡す）。
const handler = createHandler({
  now: () => Date.now(),
  fetch: (input, init) => fetch(input, init),
});

export default {
  fetch: (request: Request, env: AppEnv): Promise<Response> => handler(request, env),
};
