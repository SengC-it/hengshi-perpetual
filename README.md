# 衡势 Quant

衡势是一个面向币安 USD-M 永续合约的多空分层量化研究与前瞻影子验证项目。当前部署版本冻结为 `hengshi-v12.4-shadow-2026q3`，只记录纸面信号和模拟持仓，不包含币安 API Key、下单接口或任何真实交易能力。

## 当前结论

- V12.4 历史压力回测收益约 28.54%，极端成本收益约 22.07%，约 0.84 个信号/天。
- V12.4 没有通过统一的留一季度稳健性门槛，因此不能直接视为实盘策略。
- 部署审计发现历史研究代码会在看完同一 UTC 日后保留“当天最高分”事件。线上系统已经禁用这项非因果选择，只在每根 4 小时 K 线收盘后使用当时可见信息排名。
- 线上结果与历史 headline 不会完全一致；这种差异是前瞻验证的一部分。

## 架构

- Vercel：静态状态页、受保护的 4 小时扫描 API。
- Supabase：扫描记录、信号、纸面持仓和已完成交易。
- Gmail：仅在出现新纸面信号或扫描失败时发送通知。
- Binance：只调用公开市场数据接口。

所有 Supabase 表启用 RLS，`anon` 和 `authenticated` 没有表权限。Vercel Functions 使用服务端密钥写入，浏览器只能通过 `/api/status` 读取经过筛选的状态数据。

## 本地验证

```powershell
npm.cmd install
npm.cmd test
```

复制 `.env.example` 为 `.env.local` 并填写服务端配置后，可以用 Vercel CLI 运行或部署。

## Supabase

迁移文件位于：

```text
supabase/migrations/202607160001_hengshi_shadow.sql
```

为安全复用共享的 `crypto-alerts` 项目，本系统只创建以下带前缀的对象：

```text
hengshi_scan_runs
hengshi_signals
hengshi_paper_positions
hengshi_paper_trades
```

应用迁移后，设置以下 Vercel 环境变量：

```text
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
```

服务密钥绝不能使用 `NEXT_PUBLIC_` 前缀，也不能提交到 Git。

## Gmail

项目使用 Gmail SMTP 和 Google App Password：

```text
GMAIL_USER
GMAIL_APP_PASSWORD
ALERT_EMAIL_TO
```

`GMAIL_APP_PASSWORD` 必须是启用两步验证后创建的应用专用密码，不能使用 Gmail 登录密码。

## 定时扫描

Vercel Hobby 计划只允许每日 Cron，因此本项目不使用 Vercel Cron。`.github/workflows/hengshi-scan.yml` 会在 UTC 每 4 小时后的第 5 分钟调用 `/api/cron`。

Vercel 项目与 GitHub 仓库必须配置相同的 `CRON_SECRET`。工作流通过 `Authorization: Bearer ...` 请求头调用受保护端点，不创建公开的扫描入口。

## 前瞻门槛

在以下条件同时达到前，`liveOrdersEnabled` 始终保持 `false`：

- 至少 180 个日历日；
- 至少 50 笔完成交易；
- 至少 30 笔多头交易；
- 压力成本利润因子不低于 1.15；
- 最大回撤不低于 -20%；
- 验证期间不修改策略规则。

任何规则修改都会重置独立前瞻计时。
