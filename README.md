# 我们的日常 · 情侣双人博客

轻量自托管的情侣日常记录博客:双人账号发图文动态、时间轴、相册、恋爱天数,支持在线发布与编辑。

- 后端:Node 24 + Hono,SQLite 用 Node 内置模块,**全部依赖仅 2 个包,无原生编译**
- 前端:原生 HTML/CSS/JS,无构建步骤,支持 Markdown
- 图片:浏览器端自动压缩(最长边 1600px)后上传,按内容哈希去重存储
- 资源占用:内存约 40~60MB,适合最低配 VPS

## VPS 部署(Docker)

1. 把整个项目目录上传到 VPS(或 `git clone`)。
2. 编辑 `docker-compose.yml` 中的环境变量:

   | 变量 | 说明 |
   |---|---|
   | `SITE_TITLE` | 站点名称 |
   | `ANNIVERSARY` | 在一起的日期(YYYY-MM-DD),顶栏显示"在一起 N 天" |
   | `PRIVATE_MODE` | `true` 时访客必须登录才能浏览 |
   | `JWT_SECRET` | **必改**,登录会话签名密钥,`openssl rand -hex 32` 生成 |
   | `USERS` | 初始账号,`昵称:密码` 逗号分隔,仅数据库为空时生效 |

3. 启动:

   ```bash
   docker compose up -d --build
   ```

4. 访问 `http://VPS_IP:3000`,用初始账号登录。登录后建议立即通过顶栏"改密码"修改密码。

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
npm start          # http://localhost:3000,默认账号 小A/123456、小B/123456
```

环境变量与容器一致,可通过 `SITE_TITLE=xx PORT=3000 npm start` 方式覆盖。
