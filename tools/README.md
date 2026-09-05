# 数据库备份与恢复

`tools/backup.py` 把 SQLite 数据库（`blog.db`）备份到与图片存储一致的 **WebDAV** 目录，远端只保留最新一份；也支持从 WebDAV 或本地文件恢复。

- 仅用 Python 标准库（`sqlite3` / `urllib` / `xml`），**无第三方依赖**
- 要求 **Python 3.9+**
- 备份使用 SQLite backup API 获取在线一致快照，不依赖手动 checkpoint

## 一、命令用法

在项目根目录执行（`DATA_DIR` 默认定位到项目根的 `data/`，与启动时所在目录无关）：

```bash
# 备份到 WebDAV，远端只保留最新一份 db
/usr/bin/python3 tools/backup.py

# 列出 WebDAV 上的备份
/usr/bin/python3 tools/backup.py list

# 从 WebDAV 恢复（默认最新；也可指定备份名）
/usr/bin/python3 tools/backup.py restore
/usr/bin/python3 tools/backup.py restore blog-backup-20260828-163000.db

# 直接用本地 db 文件恢复（无需 WebDAV 配置）
/usr/bin/python3 tools/backup.py restore /path/to/backup.db
```

> 恢复前请先停掉服务：Docker 用 `docker compose stop`，裸机停掉 `node server/index.js`。
> 恢复时现有数据会整体改名留底（`data.before-restore-<时间戳>`），不会直接删除。

## 二、WebDAV 配置来源

脚本读取 `settings` 表里的 `webdav_url / webdav_username / webdav_password / webdav_folder`（与站点「图片存储 WebDAV」共用同一套）。落库为空时回退到环境变量：

| 环境变量            | 说明                       | 默认            |
| ------------------- | -------------------------- | --------------- |
| `WEBDAV_URL`      | WebDAV 地址，以`/` 结尾  | —              |
| `WEBDAV_USERNAME` | 用户名                     | —              |
| `WEBDAV_PASSWORD` | 密码                       | —              |
| `WEBDAV_FOLDER`   | 备份目录（与图片存储一致） | `images`      |
| `DATA_DIR`        | 本地数据目录               | 项目根`data/` |

> 备份文件名形如 `blog-backup-20260828-163000.db`，与图片命名不冲突。每次备份后会自动删除远端更早的 db 备份。

## 三、定时任务

用 `crontab` 每天定时备份。先确认 Python 路径与版本（部署机为 `/usr/bin/python3`，要求 ≥3.9）：

```bash
/usr/bin/python3 --version
```

编辑定时任务：

```bash
crontab -e
```

加入一行（每天凌晨 3:30，日志追加到 `backups/cron.log`；首次运行会自动创建日志目录）：

```cron
30 3 * * * cd /data/LiteBlog && mkdir -p backups && /usr/bin/python3 tools/backup.py >> backups/cron.log 2>&1
```

> 把 `/data/LiteBlog` 换成实际部署路径。cron 环境变量精简，若配置未落库，建议在 crontab 顶部显式导出 WebDAV 凭据：
>
> ```cron
> WEBDAV_URL=https://dav.jianguoyun.com/dav/
> WEBDAV_USERNAME=你的账号
> WEBDAV_PASSWORD=你的密码
> WEBDAV_FOLDER=images
> 30 3 * * * cd /data/LiteBlog && mkdir -p backups && /usr/bin/python3 tools/backup.py >> backups/cron.log 2>&1
> ```

**Docker 部署**：在宿主机跑 cron，`DATA_DIR` 指向挂载卷路径即可：

```cron
30 3 * * * cd /data/LiteBlog && mkdir -p backups && DATA_DIR=/data/LiteBlog/data /usr/bin/python3 tools/backup.py >> backups/cron.log 2>&1
```

**systemd timer 替代方案**（可选，日志更规范）：

```ini
# /etc/systemd/system/blog-backup.service
[Unit]
Description=Couple blog database backup

[Service]
Type=oneshot
WorkingDirectory=/data/LiteBlog
ExecStart=/usr/bin/python3 tools/backup.py
```

```ini
# /etc/systemd/system/blog-backup.timer
[Unit]
Description=Run blog backup daily

[Timer]
OnCalendar=*-*-* 03:30:00
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
sudo systemctl enable --now blog-backup.timer
sudo systemctl list-timers blog-backup.timer
```

## 四、恢复场景速查

| 场景                              | 命令                                                                        |
| --------------------------------- | --------------------------------------------------------------------------- |
| 数据损坏，从 WebDAV 恢复最新      | 停服 →`/usr/bin/python3 tools/backup.py restore` → 启动                 |
| 恢复指定某次备份                  | 停服 →`/usr/bin/python3 tools/backup.py restore blog-backup-<时间戳>.db` |
| 手上有一份本地 db 备份            | 停服 →`/usr/bin/python3 tools/backup.py restore /path/backup.db`         |
| 原`data/` 已删除，且要读 WebDAV | 用环境变量`WEBDAV_*` 提供连接信息后 `restore`                           |

## 五、注意事项

1. **图片不随 db 备份**：图片本就在 WebDAV 同一目录（WebDAV 存储时），恢复时无需处理；若用本地存储，图片在 `data/uploads/`，请自行另行备份。
2. **恢复前必须停服**：运行中的进程会继续写旧库，可能把 WAL 写回导致恢复失效。
3. **先试跑验证**：首次使用建议手动跑一次 `/usr/bin/python3 tools/backup.py` 和 `list`，确认 WebDAV 连通与凭据正确，再挂定时任务。
4. **WebDAV 侧的可靠性**：远端只保留一份最新 db，若担心坚果云等自身的可靠性，可在网盘开启回收站/版本历史。
