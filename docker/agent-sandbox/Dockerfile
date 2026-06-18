# agent-sandbox — изолированный раннер для LLM-команд.
# Полноценный toolset для работы с любыми проектами и серверами.
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV LANG=C.UTF-8

# ── 1. Системные пакеты (apt) ────────────────────────────────────────────────
# Базовые утилиты, SSH, архивы, сеть, медиа, базы данных, рантаймы.
RUN apt-get update -y && apt-get install -y --no-install-recommends \
    # base
    curl wget ca-certificates xz-utils gnupg lsb-release \
    git grep bash jq file less vim nano sudo \
    # ssh + sync
    openssh-client sshpass rsync \
    # archives
    zip unzip tar gzip bzip2 \
    # network diagnostics
    netcat-openbsd dnsutils iputils-ping traceroute telnet \
    # media
    ffmpeg imagemagick \
    # databases
    postgresql-client mysql-client sqlite3 redis-tools \
    # build tools
    build-essential cmake pkg-config \
    # languages (runtimes via apt)
    golang-go ruby-full php-cli default-jdk \
    # rust (apt version, stable enough for most projects)
    rustc cargo \
    # python
    python3 python3-pip python3-venv \
    >/dev/null 2>&1 \
    && rm -rf /var/lib/apt/lists/*

# ── 2. Node.js 22 LTS ───────────────────────────────────────────────────────
RUN curl -fsSL https://nodejs.org/dist/v22.13.0/node-v22.13.0-linux-x64.tar.xz \
    | tar -xJ -C /usr/local --strip-components=1

# ── 3. Docker CLI (только клиент, не демон) ──────────────────────────────────
# Позволяет агенту управлять контейнерами хоста через смонтированный docker.sock.
RUN curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
    > /etc/apt/sources.list.d/docker.list \
    && apt-get update -y \
    && apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin \
    >/dev/null 2>&1 \
    && rm -rf /var/lib/apt/lists/*

# ── 4. DevOps CLI (бинарники) ───────────────────────────────────────────────
# kubectl
RUN KUBECTL_VER=$(curl -sL https://dl.k8s.io/release/stable.txt) \
    && curl -fsSL "https://dl.k8s.io/release/${KUBECTL_VER}/bin/linux/amd64/kubectl" \
       -o /usr/local/bin/kubectl \
    && chmod +x /usr/local/bin/kubectl

# terraform
RUN TF_VER=$(curl -sL https://api.github.com/repos/hashicorp/terraform/releases/latest \
       | grep -oP '"tag_name":\s*"\K[^"]+' | head -1) \
    && curl -fsSL "https://releases.hashicorp.com/terraform/${TF_VER#v}/terraform_${TF_VER#v}_linux_amd64.zip" \
       -o /tmp/tf.zip \
    && unzip -o /tmp/tf.zip -d /usr/local/bin/ \
    && rm /tmp/tf.zip

# gh (GitHub CLI)
RUN GH_VER=$(curl -sL https://api.github.com/repos/cli/cli/releases/latest \
       | grep -oP '"tag_name":\s*"v\K[^"]+' | head -1) \
    && curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VER}/gh_${GH_VER}_linux_amd64.tar.gz" \
       -o /tmp/gh.tgz \
    && tar xzf /tmp/gh.tgz -C /tmp \
    && cp /tmp/gh_${GH_VER}_linux_amd64/bin/gh /usr/local/bin/gh \
    && rm -rf /tmp/gh*

# helm
RUN HELM_VER=$(curl -sL https://api.github.com/repos/helm/helm/releases/latest \
       | grep -oP '"tag_name":\s*"v\K[^"]+' | head -1) \
    && curl -fsSL "https://get.helm.sh/helm-v${HELM_VER}-linux-amd64.tar.gz" \
       -o /tmp/helm.tgz \
    && tar xzf /tmp/helm.tgz -C /tmp \
    && cp /tmp/linux-amd64/helm /usr/local/bin/helm \
    && rm -rf /tmp/helm* /tmp/linux-amd64

# ── 5. Python DevOps-инструменты (pip) ───────────────────────────────────────
RUN pip3 install --no-cache-dir --break-system-packages \
    ansible awscli httpie yq

# ── 6. Пользователь для запуска команд ───────────────────────────────────────
RUN useradd -m -u 1000 agent

WORKDIR /workspace

# Держим контейнер живым
CMD ["tail", "-f", "/dev/null"]
