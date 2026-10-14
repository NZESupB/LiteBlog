FROM node:24-alpine

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
