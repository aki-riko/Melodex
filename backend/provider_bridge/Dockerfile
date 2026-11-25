# 基础镜像前缀 IMAGE_PREFIX:默认走 Docker Hub 官方库。
#
# 旧注释写的是「NAS 上直连 docker.io 会拉不到, 用它可以切到国内镜像站」——
# 该说法已过时:NAS 的 dockerd 配好 mihomo 代理后官方源可直接拉,而第三方镜像站
# (docker.1ms.run)在 2026-11-26 实测已拉不动(EOF)。确需换源时用 build-arg 覆盖:
#   docker build --build-arg IMAGE_PREFIX=registry.example.com/library -f backend/provider_bridge/Dockerfile .
ARG IMAGE_PREFIX=docker.io/library

FROM ${IMAGE_PREFIX}/python:3.12-slim

# 安装系统与 Python 依赖的构建阶段必须显式使用 root；运行阶段仍会在末尾降权。
USER root

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/backend

COPY backend/third_party/charles-musicdl/requirements.txt /tmp/requirements.txt
RUN python -m pip install --no-cache-dir -r /tmp/requirements.txt

COPY backend/third_party/charles-musicdl/ ./third_party/charles-musicdl/
COPY backend/provider_bridge/ ./provider_bridge/

RUN id -u provider >/dev/null 2>&1 || useradd --create-home --uid 10001 provider
USER provider

CMD ["python", "-m", "provider_bridge.server"]
