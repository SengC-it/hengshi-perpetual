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
  try {
    const result = await runShadowScan();
    return response.status(200).json({ ok: true, ...result });
  } catch (error) {
    return response.status(500).json({
      ok: false,
      error: error.message,
      liveOrdersEnabled: false
    });
  }
}
