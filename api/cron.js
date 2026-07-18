import { runShadowScan } from '../lib/scanner.js';

function authorized(request) {
  const secret = process.env.CRON_SECRET;
  return Boolean(secret && request.headers.authorization === `Bearer ${secret}`);
}

export default async function handler(request, response) {
  response.setHeader('cache-control', 'no-store');
  if (!authorized(request)) {
    return response.status(401).json({ ok: false, error: 'unauthorized' });
  }
  if (request.query?.probe === '1') {
    return response.status(200).json({
      ok: true,
      status: 'authorized_probe',
      scheduler: 'supabase-cron',
      liveOrdersEnabled: false
    });
  }
  try {
    const result = await runShadowScan();
    console.info(JSON.stringify({
      component: 'hengshi-cron',
      event: 'request_succeeded',
      status: result.status,
      runId: result.runId ?? null,
      liveOrdersEnabled: false
    }));
    return response.status(200).json({ ok: true, ...result });
  } catch (error) {
    console.error(JSON.stringify({
      component: 'hengshi-cron',
      event: 'request_failed',
      error: String(error?.message || error).slice(0, 1000),
      liveOrdersEnabled: false
    }));
    return response.status(500).json({
      ok: false,
      error: error.message,
      liveOrdersEnabled: false
    });
  }
}
