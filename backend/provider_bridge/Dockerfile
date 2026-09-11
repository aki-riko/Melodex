# 基础镜像前缀 IMAGE_PREFIX:NAS 上直连 docker.io 会拉不到, 用它可以切到国内镜像站:
#   docker build --build-arg IMAGE_PREFIX=docker.1ms.run/library -f backend/provider_bridge/Dockerfile .
ARG IMAGE_PREFIX=docker.io/library

FROM ${IMAGE_PREFIX}/python:3.12-slim

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

RUN useradd --create-home --uid 10001 provider
USER provider

CMD ["python", "-m", "provider_bridge.server"]
