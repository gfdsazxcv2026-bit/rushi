# 运行与备份

Node.js 24+，无第三方npm运行依赖。Windows双击`start.cmd`或已安装的桌面入口；终端同样可运行`npm start`。默认只监听本机4317端口；停止使用`stop.cmd`或前台Ctrl+C。

`.env.example`是配置模板，真实`.env`只在本机保存。修改后重启；`check-model.cmd`只检查配置，真实探测须显式使用`-Live`，可能产生模型费用。模型设置见[QWEN-SETUP](QWEN-SETUP.md)。

## 持久化

默认`data/`，可通过`DATA_DIR`修改。SQLite保存匿名游客、阅读进度、消息与剧情分支。`session-secret`用于签名游客Cookie，必须与数据库配套保留。清除浏览器身份Cookie、更换浏览器或无痕访问会产生新游客；尚无跨设备找回。

```powershell
npm run backup
```

备份脚本通过SQLite一致性备份API导出数据库，同时复制匹配的`session-secret`与清单到`backups/时间/`；可用`BACKUP_DIR`修改目的地。备份包含私聊与身份密钥，禁止公开上传。

恢复时先停服，备份当前数据，再将同一备份中的`rushi.sqlite`与`session-secret`成对放入目标`DATA_DIR`。不要混用其他运行实例的WAL／SHM文件或在旧服务仍写入时替换文件；使用新目录并调整`DATA_DIR`可避免混用。重启后检查原浏览器身份、聊天和阅读进度。

## 部署边界

已提供`Dockerfile`与`compose.yaml`作为部署起点，本轮未运行Docker或公网验证。Compose尚未映射全部千问可选参数；正式部署前需对照`.env.example`补齐所需设置。容器数据卷必须持久保留，不能用重建容器代替备份。

正式外网服务还需完成域名／HTTPS、代理与Cookie设置、机密注入、成本限额、日志轮转、备份恢复演练和外网端到端验收。仓库上传与本机可访问都不表示已上线。
