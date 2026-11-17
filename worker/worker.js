// Cloudflare Worker 進入點：以 SQLite Durable Object (FugleHub) 統一維持唯一一條富果 WebSocket，
// 保護免費版連線額度不發生 1013 斷線，並對前端提供 SSE (/api/stream)、REST (/api/taiex) 與人數計次 (/api/stats/visits)
import { DurableObject } from 'cloudflare:workers';
import { FugleHubEngine, handleWorkerRequest } from './core.mjs';

export class FugleHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.engine = new FugleHubEngine({
      env,
      sql: ctx?.storage?.sql ?? null,
    });
  }

  async fetch(request) {
    return this.engine.handleFetch(request);
  }
}

export default {
  async fetch(request, env) {
    return handleWorkerRequest(request, env);
  },

  // 可選：若與既有盤後 Cron Trigger 共用同支 Worker，會一併喚醒 GitHub Actions workflow_dispatch
  async scheduled(event, env, ctx) {
    if (!env?.GITHUB_TOKEN || !env?.GITHUB_REPO) return;
    const workflow = env.GITHUB_WORKFLOW || 'update.yml';
    const ref = env.GITHUB_REF || 'main';
    const req = fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${workflow}/dispatches`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'cmoney-cron-worker',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref }),
    });
    if (ctx?.waitUntil) ctx.waitUntil(req);
    else await req;
  },
};
