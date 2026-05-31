# ============================================
# AI CODE STUDIO - CODE RUNNER DOCKERFILE
# ============================================

FROM python:3.11-slim

WORKDIR /app

# Install docker CLI client inside container (for Docker-in-Docker communications)
RUN apt-get update && apt-get install -y \
    curl \
    && curl -fsSL https://get.docker.com | sh \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY code_runner.py ./

EXPOSE 8000

CMD ["uvicorn", "code_runner:app", "--host", "0.0.0.0", "--port", "8000"]
