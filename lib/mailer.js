import nodemailer from 'nodemailer';

const beijingFormatter = new Intl.DateTimeFormat('zh-CN-u-nu-latn', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23'
});

export function formatBeijingTime(value) {
  return beijingFormatter.format(new Date(value)).replaceAll('/', '-');
}

function mailConfig() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  const to = process.env.ALERT_EMAIL_TO || user;
  return { user, pass, to, enabled: Boolean(user && pass && to) };
}

function transport() {
  const config = mailConfig();
  if (!config.enabled) return null;
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user: config.user, pass: config.pass }
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export async function sendSignalEmail(result) {
  const sender = transport();
  const config = mailConfig();
  if (!sender || !result.newSignals?.length) return { sent: false, reason: 'disabled_or_no_signals' };
  const rows = result.newSignals.map(signal => `
    <tr>
      <td>${escapeHtml(signal.symbol)}</td>
      <td>${signal.side === 1 ? '多' : '空'}</td>
      <td>${escapeHtml(signal.layer)}</td>
      <td>${Number(signal.score).toFixed(4)}</td>
      <td>${Number(signal.entry_price).toPrecision(8)}</td>
      <td>${Number(signal.stop_price).toPrecision(8)}</td>
    </tr>`).join('');
  await sender.sendMail({
    from: `"衡势 Quant" <${config.user}>`,
    to: config.to,
    subject: `衡势影子信号 ${result.newSignals.length} 笔｜${result.rapidBull ? '快速牛市' : '常态'}`,
    html: `
      <h2>衡势 V12.4 前瞻影子信号</h2>
      <p><strong>仅用于纸面验证，真实下单永久禁用。</strong></p>
      <p>信号K线（北京时间）：${escapeHtml(formatBeijingTime(result.barTime))}</p>
      <table border="1" cellpadding="6" cellspacing="0">
        <thead><tr><th>合约</th><th>方向</th><th>分层</th><th>分数</th><th>模拟入场</th><th>止损</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`
  });
  return { sent: true };
}

export async function sendFailureEmail(error, context = {}) {
  const sender = transport();
  const config = mailConfig();
  if (!sender) return { sent: false, reason: 'disabled' };
  await sender.sendMail({
    from: `"衡势 Quant" <${config.user}>`,
    to: config.to,
    subject: '衡势扫描失败',
    text: [
      '衡势影子扫描失败。',
      `时间（北京时间）：${formatBeijingTime(Date.now())}`,
      `K线（北京时间）：${context.barTime ? formatBeijingTime(context.barTime) : 'unknown'}`,
      `错误：${String(error?.stack || error?.message || error).slice(0, 3000)}`
    ].join('\n')
  });
  return { sent: true };
}

export async function sendTestEmail() {
  const sender = transport();
  const config = mailConfig();
  if (!sender) throw new Error('Gmail credentials are not configured');
  const info = await sender.sendMail({
    from: `"衡势 Quant" <${config.user}>`,
    to: config.to,
    subject: '衡势 Quant Gmail 通知测试',
    text: `Gmail 通知已连接。\n时间（北京时间）：${formatBeijingTime(Date.now())}\n模式：PAPER_ONLY`
  });
  return { accepted: info.accepted, rejected: info.rejected, messageId: info.messageId };
}

export function isMailConfigured() {
  return mailConfig().enabled;
}
