# 双人共享博客

轻量自托管的多人共享博客:多账号发图文动态、时间轴、相册、天数计数,支持在线发布与编辑。

- 后端:Node 24 + Hono,SQLite 用 Node 内置模块,**全部依赖仅 2 个包,无原生编译**
- 前端:原生 HTML/CSS/JS,无构建步骤,支持 Markdown
- 图片:浏览器端自动压缩(最长边 1600px)后上传,按内容哈希去重存储
- 资源占用:内存约 40~60MB,适合最低配 VPS

## VPS 部署(Docker)

1. 把整个项目目录上传到 VPS(或 `git clone`)。
2. 在 VPS 上将 `docker-compose.yml.bak` 自行复制为 `docker-compose.yml`；如果已有本地配置,请不要覆盖。
3. 编辑 `docker-compose.yml` 中的环境变量:

   | 变量 | 说明 |
   |---|---|
   | `SITE_TITLE` | 站点名称 |
   | `ANNIVERSARY` | 起始日期(YYYY-MM-DD),顶栏显示「第 N 天」,留空则不显示 |
   | `PRIVATE_MODE` | `true` 时访客必须登录才能浏览 |
   | `JWT_SECRET` | **必改**,登录会话签名密钥,`openssl rand -hex 32` 生成 |

4. 启动:

   ```bash
   docker compose up -d --build
   ```

4. 访问 `http://VPS_IP:3000`,用初始账号登录(固定为 `user1 / pass1`、`user2 / pass2`,仅首次启动自动创建),并立即在「头像菜单 → 账号设置」中分别修改登录账号、显示名称和密码。

**注意:初始账号只在数据库为空的首次启动时创建。** 重建镜像不会重置已有数据;如需重新初始化,先删除 `./data` 目录再启动。

数据(数据库 + 图片)都在 `./data` 目录,备份该目录即可;升级时 `git pull && docker compose up -d --build`,数据不受影响。

### 建议:HTTPS 反向代理

生产环境建议用 Caddy/Nginx 套一层 HTTPS。Caddy 示例(自动签发证书):

```
blog.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

## 本地开发

```bash
npm install
npm start          # http://localhost:3000,默认账号 user1/pass1、user2/pass2
```

环境变量与容器一致,可通过 `SITE_TITLE=xx PORT=3000 npm start` 方式覆盖。
