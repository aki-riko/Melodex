# TuneScout+ 一体化镜像:React 前端 + Go 后端 + ffmpeg,单容器同源部署。
# 构建上下文为仓库根(同时含 frontend/ 与 backend/):
#   docker build -t tunescout-plus -f Dockerfile .

# ===== 阶段1:构建 React 前端 =====
FROM node:20-alpine AS frontend
WORKDIR /fe
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
# 同源部署:不设 VITE_MUSICDL_API,API 走相对路径
RUN npm run build

# ===== 阶段2:构建 Go 后端(嵌入前端产物)=====
FROM --platform=$BUILDPLATFORM golang:1.25 AS builder
WORKDIR /app
ARG TARGETOS=linux
ARG TARGETARCH
# 可选 Go module 代理(国内构建可传 --build-arg GOPROXY=https://goproxy.cn,direct);
# 默认 direct,不影响境外/默认环境。
ARG GOPROXY=direct
ENV GOPROXY=$GOPROXY

COPY backend/go.mod backend/go.sum ./
# music-lib 以本地 replace 引入(backend/third_party/music-lib),go mod download
# 需在解析 replace 前就能读到它的 go.mod,故先 COPY third_party 再 download。
COPY backend/third_party/ ./third_party/
RUN go mod download

COPY backend/ .
# 把 React 产物拷进后端 embed 目录(覆盖占位),再编译嵌入二进制
RUN rm -rf internal/web/frontend_dist && mkdir -p internal/web/frontend_dist
COPY --from=frontend /fe/build/ ./internal/web/frontend_dist/
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=${TARGETARCH:-$(go env GOARCH)} go build -o music-dl ./cmd/music-dl

# ===== 阶段3:运行镜像(含 ffmpeg)=====
FROM alpine:3.22
RUN apk --no-cache add ca-certificates tzdata ffmpeg \
    && ffmpeg -version >/dev/null && ffprobe -version >/dev/null
ENV TZ=Asia/Shanghai
RUN adduser -D -s /bin/sh appuser
WORKDIR /home/appuser/
COPY --from=builder /app/music-dl .
RUN chown -R appuser:appuser /home/appuser/
USER appuser
EXPOSE 8329
CMD ["./music-dl", "web", "--port", "8329", "--no-browser"]
