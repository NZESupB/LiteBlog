# 前端构建依赖只存在于构建阶段。
FROM node:24.22.1-alpine AS frontend
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-fund --no-audit
COPY frontend ./frontend
COPY public ./public
COPY scripts/generate-sw-assets.mjs ./scripts/generate-sw-assets.mjs
RUN npm run build

# 生产服务仍只安装 Hono 与 Node 适配器，视频使用系统 FFmpeg。
FROM node:24.22.1-alpine
WORKDIR /app
RUN apk add --no-cache ffmpeg \
    && ffprobe -version > /dev/null \
    && ffmpeg -hide_banner -encoders 2>/dev/null | grep -q 'libx265' \
    && ffmpeg -hide_banner -encoders 2>/dev/null | grep -q ' aac ' \
    && ffmpeg -hide_banner -encoders 2>/dev/null | grep -q ' mjpeg ' \
    && ffmpeg -hide_banner -filters 2>/dev/null | grep -q ' zscale ' \
    && ffmpeg -hide_banner -filters 2>/dev/null | grep -q ' tonemap '
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-fund --no-audit
COPY server ./server
COPY --from=frontend /app/dist ./dist
EXPOSE 3000
VOLUME ["/app/data"]
CMD ["node", "server/index.js"]
