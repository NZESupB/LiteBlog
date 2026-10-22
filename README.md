# 双人共享博客

轻量自托管的多人共享博客:多账号发图文动态、时间轴、相册、天数计数,支持在线发布与编辑。

- 后端：Node 24.22.1 + Hono，SQLite 使用 Node 内置模块；生产 npm 依赖仅 Hono 与 Node 适配器，视频使用系统 FFmpeg。
- 前端：React + TypeScript + Vite，React Router hash 路由，支持 Markdown；生产产物由同一个 Hono 服务提供。
- 图片:浏览器端自动压缩(最长边 1600px)后上传,按内容哈希去重存储
- 视频与实况图：原件先保存、后台压缩、两版指标对比与发布前选择；支持分片续传和处理检查点，实况照片在压缩前解析内嵌视频或按内容标识配对
- 外观:跟随系统 / 浅色 / 深色三档,只作用于当前浏览器
- 构建与运行分离：前端工具只参与开发和镜像构建；视频转码仍额外使用 CPU、内存和临时磁盘，默认单任务，线程按 CPU/内存限额适配。

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

数据（数据库、本地图片/视频和头像）都在 `./data` 目录。在线数据库备份请使用「设置 → 备份与恢复」；如需完整文件备份，应先停服再复制整个目录。升级时 `docker compose pull && docker compose up -d`，数据不受影响。

### 建议:HTTPS 反向代理

生产环境建议用 Caddy/Nginx 套一层 HTTPS。Caddy 示例(自动签发证书):

```
blog.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

### 数据库备份与恢复

登录后进入「设置 → 备份与恢复」，可立即备份或设置每天自动备份，默认北京时间 03:30。备份共用图片存储中配置的 WebDAV 连接和目录，包含 SQLite WAL 中已提交的数据；新备份上传成功后清理旧备份，远端只保留最新一份。未配置 WebDAV 时不影响启动，页面会提示先配置连接。

恢复时直接选择并上传本站 `.db` 文件，确认后整体替换账号、密码、动态、评论及所有数据库设置。服务校验文件并保留恢复前数据库副本，在短暂维护期间安全切换；成功后使用导入库中的账号重新登录，无需手动重启。上传、视频压缩或 AI 配图任务未结束时会提示先完成或取消。

`.db` 不包含媒体文件；本地与 WebDAV 媒体保留原位，缺失文件需另行恢复。默认导入上限 256MiB，可通过 `backup.maxImportBytes` / `BACKUP_MAX_IMPORT_BYTES` 调整，反向代理也需允许对应大小的请求。

独立备份脚本已移除。升级时请删除原调用 `tools/backup.py` 的 cron 条目，或停用原 `blog-backup.timer`。接口、恢复副本和迁移细节见 `tools/README.md`。

## 本地开发

需要 Node **24.22.1 或更高版本**，使用锁文件安装：

```bash
npm ci
npm run dev       # Vite 开发页面，终端显示地址；API 在 localhost:3000
```

本地生产模式：

```bash
npm run build     # 生成 dist/，包含所有懒加载 chunk、Worker 与离线缓存清单
npm start         # http://localhost:3000，服务 dist/ 与同源 API
```

构建不读取数据库和站点密钥；运行配置、原数据库与上传文件仍沿用 `data/`。初始账号为 `user1/pass1`、`user2/pass2`，只在空数据库创建。开发模式会注销本机该站点的 Service Worker；离线及升级验证应使用生产构建。

本地视频功能需要 `ffmpeg` 和 `ffprobe` 在 PATH 中，并包含 `libx265`、AAC、MJPEG 编码器与 `zscale`、`tonemap` 滤镜。工具缺失时图文服务仍可启动，视频入口会明确提示。Dockerfile 使用多阶段构建：构建阶段安装前端工具，运行阶段仅保留生产依赖、`server/`、`dist/` 与系统 FFmpeg。

### 检查与回归

```bash
npm run check     # JavaScript 语法、类型、lint、格式、构建、六项回归和发布器单元测试
npx playwright install chromium   # 没有本机 Chrome 的开发环境安装一次
npm run test:e2e  # 生产产物上的真实 Chromium 交互、视频、恢复与 PWA 升级
```

回归只使用 `data/` 下独立测试目录，不读取或覆盖真实 `config.json`。临时数据库与媒体由测试服务退出时清理；失败 trace 位于 `data/e2e-results/`。GitHub Actions 执行相同检查并构建镜像。

前端业务在 `frontend/src/features/`；媒体协议、灯箱和动效适配在 `frontend/src/native/`，由 Vite 统一打包。后端由 `server/app.js` 构造应用、`server/routes/` 注册领域 API、`server/bootstrap.js` 管理初始化与停机。`public/` 只保留样式、图标、图片、主题预初始化和必须独立加载的 vendor。

PWA 只缓存静态应用壳，不缓存 API、私人图片、视频或头像。更新安装完成后显示提示，点击「更新并重新加载」才接管；写作面板打开时先关闭以保留草稿。单标签页激活时保留上一版缓存，多标签页保留仍可能使用的旧缓存；其他标签页不会被强制重载。离线可打开应用壳，但动态数据仍需要联网。

### 图片、视频与实况图

- 视频先按 8MiB 分片流式写入 `data/tmp/vjob-<任务ID>/source`，每片 SHA-256 校验并同步落盘后确认。原件完整后先保存到本地/WebDAV 后端并登记草稿归属，随后由服务器自动异步压缩；关闭页面不影响已完成上传的处理。原文件默认上限 2GiB。
- 固定 HEVC Main10 档位：1080p 30/60fps 为 25/35MB 每分钟，4K 30/60fps 为 85/120MB；MB 使用十进制，包含 AAC 128kbps 音轨和封装余量。软件编码采用 CRF21（≤1080p）/22（更高分辨率）、fast 与 VBV；中间尺寸按像素量插值，实际体积随内容变化，预算不保证精确大小或视觉无损。
- 保留原分辨率、SAR 和旋转后的画面，奇数边长只补一像素；保留 ≤60fps（包括 59.94），高于 60fps 降至 60，不补低帧率。选择首条音轨转为双声道 AAC，无音轨保持无声。PQ/HLG HDR 转 SDR，Dolby Vision 或不完整色彩信息明确报错，已保存原件仍保留。
- 原件符合 HEVC、4:2:0 8/10bit、SDR、无待处理旋转、偶数尺寸、≤60fps、预算和音轨规则时，优先免转码；符合 MP4/hvc1/faststart 且无额外轨道时直接复用原件，否则仅重封装。
- 完成后展示原件与压缩版大小、节省比例（可为负）、编码、分辨率、帧率、位深、HDR/SDR 变化及有损处理说明，不虚构画质分数。经过验证的压缩版更小，或原件不符合本站播放规则时推荐压缩版；原件适合播放且更小或相同时推荐原件。HEVC 播放仍依赖设备解码支持。
- 推荐版本自动采用，发布前可反复切换两版。两份候选都保持本人草稿归属，发布/丢弃草稿时回收未引用版本；已发布视频拒绝改选或取消。压缩失败保留原件并说明原因，用户可采用已探测验证的原件。
- 浏览器草稿保存任务 ID、客户端初始化 ID 和文件指纹，不缓存大视频。刷新后可恢复后台进度；上传未完成时重新选择同一文件，从已确认偏移续传。约 60 秒视频段检查点按真实帧边界划分，音频只编码一次，重启后校验并复用已完成段；未完整接收任务保留 24 小时。
- 上传/压缩/保存均异步，单次请求上限需允许 8MiB（代理建议至少 10MiB）。WebDAV 通用 PUT 中断可能重传该输出文件，但不重复完成的编码检查点；恢复按实际目标 SHA-256 对账，未知冲突文件不删除。
- **实况图（Live Photo / Motion Photo）**支持双文件和单文件：iPhone/iCloud 同时选择照片与 MOV/MP4，优先用 Apple 内容标识配对，标识缺失时仅合并唯一的同名候选；Android 选择实况原件，可从标准 XMP、HEIF `mpvd` 及已覆盖的厂商结构提取视频。解析在 HEIC 转换和图片压缩之前进行，发布后只占一项媒体。
- 实况标记存在但动态缺失、解析损坏或上传失败时会明确提示并阻止发布，可重选原件/续传，或在封面就绪后选择「仅保留静态图」。系统或分享渠道只交付普通静态图时，网页无法恢复已移除的视频。歧义或标识冲突不自动合并；详细兼容矩阵、接口、测试证据与真机验证限制见 `docs/live-photos.md`。
- 列表和相册里只加载封面帧/静帧,视频显示播放角标与时长,实况图显示 LIVE 角标。**一律不会自动播放** —— 视频点一下封面就在原来的格子里播起来(内嵌 ArtPlayer:全屏、画中画、倍速与画面比例设置、键盘快捷键;多列布局里会占满整行),点右上角 × 收回封面;实况图走灯箱,点 LIVE 角标才播放动态部分(带原声)。
- HEVC 播放取决于浏览器和设备的解码能力；不支持时显示明确提示，可以换用支持 HEVC 的浏览器或设备。视频和实况图仍保留原有播放方式，不自动播放。

### WebDAV 日期归档

在「设置 → 站点设置 → 图片存储」选择 WebDAV 并填写地址、用户名、密码和根目录后，新上传的图片、视频及视频封面自动按以下层级存放：

```text
<根目录>/YYYY/MM/<文件名>
images/2026/10/20261013-093000-a1b2c3d4.jpg
images/2026/10/20261013-093001-e5f6a7b8.mp4
```

- 年为四位，月补齐两位；目录只分年、月，不再创建日目录，文件名仍保留完整日期。统一采用 `Asia/Shanghai`（上海时区）。图片以服务端开始处理上传请求的时间归档，视频及其封面以任务创建时间归档；跨月上传或转码不会改变该视频的目录。
- 不要求文件携带拍摄时间、EXIF 或客户端时间。内部任务时间缺失或无效时，使用一次服务端当前时间并固定下来；历史文件按已记录路径读取，不重新计算或迁移。
- 上传沿用现有校验和处理：图片内容去重后保存；视频分片先落到 `data/tmp`，后台按当前设置处理。服务端依次创建根目录、年、月目录，再上传文件，成功后记录实际路径并返回原有上传结果。
- 同名原文件不直接作为保存名。逻辑文件名沿用日期、哈希或随机段格式，分配时检查数据库和正在上传的占用，最多尝试三次。图片命中本人可复用的去重记录时，沿用原文件及原路径。
- 新 WebDAV 文件用 `If-None-Match: *` 条件 PUT 防止覆盖。远端同名返回 `412` 时，仅在实际保存名的扩展名前增加随机后缀重试，最多三次；对外 `filename` 和 `/uploads/:name` URL 不受影响。连续冲突或认证、权限、空间错误会按现有方式报错，不自动转存本地。
- 视频原件、压缩版与封面保存意图均持久化；断网或登记失败后可重试并按实际内容校验。取消或草稿结束时只回收本任务确认保存且无引用的文件，冲突目标不会被删除。
- `/api/uploads`、视频初始化/分片/完成/查询/取消接口、发布参数和视频 Range/206 行为保持一致，无需客户端新增时间或目录字段。本地目录与历史平铺、年/月/日 WebDAV 文件保持原位并按记录读取；AI 配图仍使用 `ai-generated/`，头像仍使用独立存储。

本地运行可直接设置上面的环境变量后执行 `npm start`，也可以使用可选的 `config.json`。其他设置登录后在设置页保存到数据库；AI 配图需要配置 WebDAV 存储，生成的图片会写入 WebDAV 子目录 `ai-generated/`。AI 配图地址和密钥只在服务端读取，普通页面和未登录接口不会收到这些配置。

视频配置读取顺序：后台压缩开关 → `config.json` → 环境变量 → 默认值。固定策略与编码器参数在任务创建/首次探测时保存快照；新设置只影响后续上传。

| 环境变量 | config.json 的 media 字段 | 默认值 / 说明 |
|---|---|---|
| `MAX_VIDEO_BYTES` | `maxVideoBytes` | `2147483648`，原文件接收上限（字节） |
| `VIDEO_COMPRESSION` | `videoCompression` | `true`，自动压缩 |
| `VIDEO_ENCODER` | `videoEncoder` | `auto`；可选 `libx265` / `hevc_videotoolbox`，硬件需真实 Main10 编码探测通过 |
| `VIDEO_THREADS` | `videoThreads` | `16`，运维线程上限（1–16）；实际取 CPU、内存与 Linux cgroup 限额的较小值 |
| `VIDEO_MAX_JOBS` | `videoMaxJobs` | `8`，接收、排队与处理中任务总数上限（1–32） |
| `FFMPEG_PATH` | `ffmpegPath` | `ffmpeg`，程序路径 |
| `FFPROBE_PATH` | `ffprobePath` | `ffprobe`，程序路径 |

1MiB = 1024² 字节，1GiB = 1024³ 字节。临时产物与最终本地文件均位于 DATA_DIR，处理中需要容纳原件、检查点和压缩输出。原件与压缩版在发布前同时保留，会临时增加磁盘或 WebDAV 用量。旧的每分钟体积、CRF、预设和确认等待时间配置不再使用。

视频接口沿用 `/api/uploads/video/config`、`/init`、`/:id/chunk?offset=`、`/:id/complete`、`/:id` 与删除入口；新增 `POST /:id/resume` 验证文件身份/恢复处理，`POST /:id/select` 接收 `{ "variant": "original" | "compressed" }`。查询返回 `variants`、`comparison`、`recommendedVariant`、`selectedVariant` 与各阶段进度。状态为 `receiving → queued → saving（saving_original）→ compressing → saving（saving_compressed）→ comparing → done`；失败保留原件，暂停可从检查点恢复。

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

### React 开发版镜像

推送 `dev_react` 分支会先执行完整源码、浏览器与镜像冒烟检查，通过后自动发布独立开发镜像包：

```text
ghcr.io/nzesupb/liteblog-dev:latest
ghcr.io/nzesupb/liteblog-dev:sha-<提交短哈希>
```

测试部署时，将部署者自己的 Compose `image` 改为 `ghcr.io/nzesupb/liteblog-dev:latest`。开发版与稳定版 `ghcr.io/nzesupb/liteblog` 分开发布；稳定版分支、版本标签和 `latest` 不受此流程影响。
