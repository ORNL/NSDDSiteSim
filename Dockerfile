FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    SITE_TZ=America/New_York \
    INSTALL_DIR=/opt/lanesim \
    MEDIAMTX_VERSION=v1.9.0

WORKDIR $INSTALL_DIR

RUN apt-get update -qq && \
    apt-get install -y --no-install-recommends \
    ffmpeg \
    wget \
    tar \
    tzdata && \
    rm -rf /var/lib/apt/lists/*

RUN mkdir -p $INSTALL_DIR/bin $INSTALL_DIR/data $INSTALL_DIR/logs $INSTALL_DIR/videos $INSTALL_DIR/static $INSTALL_DIR/routers && \
    DPKG_ARCH="$(dpkg --print-architecture)" && \
    case "$DPKG_ARCH" in \
      amd64) MTX_ARCH="amd64" ;; \
      arm64) MTX_ARCH="arm64v8" ;; \
      armhf) MTX_ARCH="armv7" ;; \
      *) echo "Unsupported architecture: $DPKG_ARCH" >&2; exit 1 ;; \
    esac && \
    wget -q "https://github.com/bluenviron/mediamtx/releases/download/${MEDIAMTX_VERSION}/mediamtx_${MEDIAMTX_VERSION}_linux_${MTX_ARCH}.tar.gz" -O /tmp/mediamtx.tar.gz && \
    tar -xzf /tmp/mediamtx.tar.gz -C $INSTALL_DIR/bin/ mediamtx && \
    rm /tmp/mediamtx.tar.gz && \
    chmod +x $INSTALL_DIR/bin/mediamtx

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY *.py $INSTALL_DIR/
COPY routers/ $INSTALL_DIR/routers/
COPY static/ $INSTALL_DIR/static/

EXPOSE 8000
EXPOSE 9001-9050
EXPOSE 10001-10050

CMD ["python", "main.py"]
