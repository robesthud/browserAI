FROM python:3.10-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    git libgtk-3-0 libasound2 libnss3 libx11-xcb1 libxcomposite1 \
    libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxrender1 \
    libxtst6 libglib2.0-0 libpango-1.0-0 libpangocairo-1.0-0 \
    libstdc++6 libgcc-s1 libc6 libdbus-1-3 libxcb1 libxkbcommon0 \
    libgbm1 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxt6 libdbus-glib-1-2 libpci3 libegl1 libopus0 libevent-2.1-7 \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN git clone https://github.com/CloudWaddie/LMArenaBridge.git .
RUN pip install --no-cache-dir -r requirements.txt
# Ensure playwright browsers and deps are installed
RUN playwright install firefox
RUN playwright install-deps firefox
ENV PORT=8000
EXPOSE 8000
CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8000"]
