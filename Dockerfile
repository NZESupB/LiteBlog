FROM node:24-alpine

WORKDIR /app

# 先装依赖以利用镜像层缓存
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-fund --no-audit

COPY server ./server
COPY public ./public

ENV NODE_ENV=production
EXPOSE 3000

# 数据(SQLite + 上传图片)全部落在 /app/data,部署时挂载卷
VOLUME ["/app/data"]

CMD ["node", "server/index.js"]
