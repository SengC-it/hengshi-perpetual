# Binance 4小时中频系统

这是一个研究型回测器，不连接账户，也不自动下单。

运行顺序：

```powershell
node run.js download
node run.js develop
node run.js freeze
node run.js preflight
node run.js final
```

`develop` 只能读取截至2025-06-30的数据；`freeze` 只允许创建一次参数文件；`final` 在读取最终区间前创建锁文件并拒绝第二次运行。基准往返成本为0.16%，压力成本为0.24%，资金费率按历史结算记录计入。完整方法见设计规范和实施计划。
