# 固定 Node 补丁版本：Node 24.22.1 修复了 CVE-2026-105482/105483/106069/111497
# （dns.resolve NUL 截断、TLS hostname 绕过 ×2、Brotli 解码越界写 RCE）。
# 不要退回浮动的 node:24-alpine，否则构建会随上游漂移并可能落回受影响版本。
FROM node:24.22.1-alpine

WORKDIR /app
# 视频压缩使用系统 FFmpeg，不增加 Node 依赖；构建时确认所需编码器与滤镜。
RUN apk add --no-cache ffmpeg \
    && ffprobe -version > /dev/null \
    && ffmpeg -hide_banner -encoders 2>/dev/null | grep -q 'libx265' \
    && ffmpeg -hide_banner -encoders 2>/dev/null | grep -q ' aac ' \
    && ffmpeg -hide_banner -encoders 2>/dev/null | grep -q ' mjpeg ' \
    && ffmpeg -hide_banner -filters 2>/dev/null | grep -q ' zscale ' \
    && ffmpeg -hide_banner -filters 2>/dev/null | grep -q ' tonemap '


# 先装依赖以利用镜像层缓存
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-fund --no-audit

COPY server ./server
COPY public ./public

EXPOSE 3000

# 数据(SQLite + 上传图片)全部落在 /app/data,部署时挂载卷
VOLUME ["/app/data"]

CMD ["node", "server/index.js"]
