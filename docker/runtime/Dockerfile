FROM ghcr.io/all-hands-ai/runtime:main

RUN mkdir -p /openhands/micromamba/bin
COPY micromamba-wrapper.sh /openhands/micromamba/bin/micromamba
RUN chmod +x /openhands/micromamba/bin/micromamba

ENV POETRY_VIRTUALENVS_PATH=/openhands/poetry
ENV MAMBA_ROOT_PREFIX=/openhands/miniforge3
