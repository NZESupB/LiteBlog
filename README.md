# 双人共享博客

轻量自托管的多人共享博客:多账号发图文动态、时间轴、相册、天数计数,支持在线发布与编辑。

- 后端:Node 24 + Hono,SQLite 用 Node 内置模块,**全部依赖仅 2 个包,无原生编译**
- 前端:原生 HTML/CSS/JS,无构建步骤,支持 Markdown
- 图片:浏览器端自动压缩(最长边 1600px)后上传,按内容哈希去重存储
- 视频与实况图:视频原样上传(不转码),浏览器抽帧做封面;iPhone 实况图按文件名主干自动配对静帧与视频
- 外观:跟随系统 / 浅色 / 深色三档,只作用于当前浏览器
- 资源占用:内存约 40~60MB,适合最低配 VPS

## VPS 部署(Docker)

1. 把整个项目目录上传到 VPS(或 `git clone`)。
2. 在 VPS 上将 `docker-compose.yml.bak` 自行复制为 `docker-compose.yml`；如果已有本地配置,请不要覆盖。
3. 编辑 `docker-compose.yml` 中的 `environment` 配置，填写站点和会话的初始值，并执行 `chmod 600 docker-compose.yml`。Compose 只保留下面四项；图片存储、WebDAV 和 AI 配图配置在登录后的设置页保存到数据库。

常用配置项：

| 配置 | 说明 |
|---|---|
| `SITE_TITLE` | 站点名称 |
| `ANNIVERSARY` | 起始日期，格式 `YYYY-MM-DD` |
| `PRIVATE_MODE` | `true` 时访客必须登录 |
| `JWT_SECRET` | 登录会话密钥，必须替换 |

启动后登录站点，在「站点设置」中配置图片存储/WebDAV，在「AI 优化 → AI 配图」中配置图片接口地址和 API Key。这些配置会写入 `data/blog.db`，不需要放进 Compose 环境变量。

4. 启动:

   ```bash
   docker compose pull
   docker compose up -d
   ```

5. 访问 `http://VPS_IP:3000`,用初始账号登录(固定为 `user1 / pass1`、`user2 / pass2`,仅首次启动自动创建),并立即在「头像菜单 → 账号设置」中分别修改登录账号、显示名称和密码。

**注意:初始账号只在数据库为空的首次启动时创建。** 重建镜像不会重置已有数据;如需重新初始化,先删除 `./data` 目录再启动。

数据(数据库 + 图片)都在 `./data` 目录,备份该目录即可;升级时 `docker compose pull && docker compose up -d`,数据不受影响。

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

### 图片、视频与实况图

- 图片与视频都支持从相册选择。视频不压缩、不转码,单文件默认上限 200MB(可用 `MAX_VIDEO_BYTES` 调整),上传时先流式落到 `data/tmp` 再转存到当前存储后端。
- **实况图(Live Photo)** = 同名主干的一张静帧 + 一个配对视频,例如 `IMG_1234.HEIC` 配 `IMG_1234.MOV`,或 Google Takeout 导出的 `IMG_1234.jpg` 配 `IMG_1234.mp4`。**同一次选择里带上这两个文件即可自动配对**,不需要额外的配对步骤;没配上的视频就按普通视频发布。
- 列表和相册里只加载封面帧/静帧,视频显示播放角标与时长,实况图显示 LIVE 角标。**一律不会自动播放** —— 点开灯箱后视频停在封面,实况图要点 LIVE 角标才会播放动态部分(带原声)。
- 能否播放取决于浏览器编解码能力:iPhone 实况图的 HEVC 视频在 Safari 与支持 HEVC 的 Chrome 上可播,播不了时只显示静帧。

本地运行可直接设置上面的环境变量后执行 `npm start`，也可以使用可选的 `config.json`。其他设置登录后在设置页保存到数据库；AI 配图需要配置 WebDAV 存储，生成的图片会写入 WebDAV 子目录 `ai-generated/`。AI 配图地址和密钥只在服务端读取，普通页面和未登录接口不会收到这些配置。

### GHCR 自动发布

仓库内的 `.github/workflows/publish-image.yml` 会在推送版本 tag 时自动构建并发布镜像。版本 tag 使用 `v1.2.3` 格式，发布后会同时得到：

```text
ghcr.io/nzesupb/liteblog:1.2.3
ghcr.io/nzesupb/liteblog:latest
```

发布示例：

```bash
git tag v1.2.3
git push origin v1.2.3
```

也可以在 GitHub Actions 页面手动运行工作流并填写版本号。
