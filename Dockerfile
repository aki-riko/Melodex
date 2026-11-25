# Melodex 一体化镜像:React 前端 + Go 后端 + ffmpeg,单容器同源部署。
# 构建上下文为仓库根(同时含 frontend/ 与 backend/):
#   docker build -t melodex -f Dockerfile .
#
# 基础镜像前缀 IMAGE_PREFIX。
#
# 默认走 **Docker Hub 官方库**。历史上这里默认是第三方镜像站 `docker.1ms.run/library`
# (当时 NAS 直连 docker.io 会拉不到),但 2026-11-26 实测该站已拉不动基础镜像:
#   failed to resolve source metadata for docker.1ms.run/library/node:20-alpine: EOF
# 而 NAS 的 dockerd 早已配好 mihomo 代理(docker info 可见 HTTP Proxy=127.0.0.1:7890,
# 192.168.1.0/24 在 No Proxy 内),官方源可直接拉 —— 项目纪律也明确要求
# 「基础镜像直接 docker pull 官方镜像名,禁止第三方镜像站前缀」。
# 所以默认值改为官方库;确需换源的境外/特殊环境再用 build-arg 覆盖:
#   docker build --build-arg IMAGE_PREFIX=registry.example.com/library -t melodex -f Dockerfile .
ARG IMAGE_PREFIX=docker.io/library

# ===== 阶段1:构建 React 前端 =====
FROM ${IMAGE_PREFIX}/node:20-alpine AS frontend
WORKDIR /fe
# npm registry 可覆盖:默认官方源(境外/CI 用),国内环境传
#   --build-arg NPM_REGISTRY=https://registry.npmmirror.com
# 否则 npm ci 会卡在直连 registry.npmjs.org 上(实测 NAS 上 20 分钟仍未装完,
# CPU 时间几乎不涨 —— 是在等网络,不是真在装包)。
ARG NPM_REGISTRY=https://registry.npmjs.org
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --registry=${NPM_REGISTRY}
COPY frontend/ ./
# 同源部署:不设 VITE_MUSICDL_API,API 走相对路径
RUN npm run build

# ===== 阶段2:构建 Go 后端(嵌入前端产物)=====
FROM --platform=$BUILDPLATFORM ${IMAGE_PREFIX}/golang:1.25 AS builder
WORKDIR /app
ARG TARGETOS=linux
ARG TARGETARCH
# 可选 Go module 代理(国内构建可传 --build-arg GOPROXY=https://goproxy.cn,direct);
# 默认 direct,不影响境外/默认环境。
ARG GOPROXY=direct
ENV GOPROXY=$GOPROXY

COPY backend/go.mod backend/go.sum ./
RUN go mod download

COPY backend/ .
# 把 React 产物拷进后端 embed 目录(覆盖占位),再编译嵌入二进制
RUN rm -rf internal/web/frontend_dist && mkdir -p internal/web/frontend_dist
COPY --from=frontend /fe/build/ ./internal/web/frontend_dist/
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=${TARGETARCH:-$(go env GOARCH)} go build -o melodex ./cmd/melodex

# ===== 阶段3:运行镜像(含 ffmpeg)=====
FROM ${IMAGE_PREFIX}/alpine:3.22
RUN apk --no-cache add ca-certificates tzdata ffmpeg \
    && ffmpeg -version >/dev/null && ffprobe -version >/dev/null
ENV TZ=Asia/Shanghai
RUN adduser -D -s /bin/sh appuser
WORKDIR /home/appuser/
COPY --from=builder /app/melodex .
RUN chown -R appuser:appuser /home/appuser/
USER appuser
EXPOSE 8329
CMD ["./melodex", "web", "--port", "8329", "--no-browser"]
