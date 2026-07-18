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

function formatPrice(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number.toPrecision(8) : '动态更新';
}

export function exitPresentation(signal) {
  const exit = signal.metadata?.exit ?? {};
  const maxHoldHours = Number(exit.maxHoldBars) * 4;
  const holdText = Number.isFinite(maxHoldHours) ? `${maxHoldHours}小时` : '按策略执行';
  if (Number(signal.side) === 1) {
    return {
      point: formatPrice(exit.referenceEma20),
      rule: '4小时K线收盘达到动态EMA20后，下一根开盘退出',
      holdText
    };
  }
  const trailAtr = Number.isFinite(Number(exit.trailAtr)) ? Number(exit.trailAtr) : 3;
  return {
    point: formatPrice(exit.referenceProfitPrice),
    rule: `${trailAtr}ATR移动止盈；该点位是参考盈利位，不挂固定止盈单`,
    holdText
  };
}

export function buildSignalEmail(result) {
  const rows = result.newSignals.map(signal => {
    const exit = exitPresentation(signal);
    return `
    <tr>
      <td>${escapeHtml(signal.symbol)}</td>
      <td>${signal.side === 1 ? '多' : '空'}</td>
      <td>${escapeHtml(signal.layer)}</td>
      <td>${Number(signal.score).toFixed(4)}</td>
      <td>${formatPrice(signal.entry_price)}</td>
      <td>${formatPrice(signal.stop_price)}</td>
      <td>${escapeHtml(exit.point)}</td>
      <td>${escapeHtml(exit.rule)}</td>
      <td>${escapeHtml(exit.holdText)}</td>
    </tr>`;
  }).join('');
  return `
      <h2>衡势 V12.4 前瞻影子信号</h2>
      <p><strong>仅用于纸面验证，真实下单永久禁用。</strong></p>
      <p>信号K线（北京时间）：${escapeHtml(formatBeijingTime(result.barTime))}</p>
      <table border="1" cellpadding="6" cellspacing="0">
        <thead><tr><th>合约</th><th>方向</th><th>分层</th><th>分数</th><th>模拟入场</th><th>初始止损</th><th>参考止盈点位</th><th>实际退出规则</th><th>最长持有</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p>做空参考止盈点位为入场价减3ATR，仅用于观察；实际按3ATR移动止盈继续跟随趋势。做多EMA20会随每根4小时K线动态更新。</p>
      <p>V12.7退出影子盘只做A/B研究，不改变本邮件的V12.4执行规则。</p>`;
}

export async function sendSignalEmail(result) {
  const sender = transport();
  const config = mailConfig();
  if (!sender || !result.newSignals?.length) return { sent: false, reason: 'disabled_or_no_signals' };
  await sender.sendMail({
    from: `"衡势 Quant" <${config.user}>`,
    to: config.to,
    subject: `衡势影子信号 ${result.newSignals.length} 笔｜${result.rapidBull ? '快速牛市' : '常态'}`,
    html: buildSignalEmail(result)
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
