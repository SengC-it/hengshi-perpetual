import { STRATEGY } from '../config/strategy.js';
import { isDatabaseConfigured } from '../lib/db.js';
import { isMailConfigured } from '../lib/mailer.js';

export default function handler(_request, response) {
  response.setHeader('cache-control', 'no-store');
  response.status(200).json({
    ok: true,
    service: 'hengshi-perpetual',
    strategy: STRATEGY.version,
    authorization: STRATEGY.authorization,
    liveOrdersEnabled: false,
    causalSelection: true,
    validFrom: new Date(STRATEGY.validFrom).toISOString(),
    validThrough: new Date(STRATEGY.validThrough).toISOString(),
    integrations: {
      supabase: isDatabaseConfigured(),
      gmail: isMailConfigured()
    },
    time: new Date().toISOString()
  });
}
