#!/bin/bash
# Wrapper: redirect micromamba calls to miniforge3 mamba
# Agent Server calls: micromamba run -n openhands poetry run python ...
# mamba needs: mamba run -n base <rest after "run -n openhands">
# Args: run -n openhands poetry run python -u -m openhands.runtime.action_execution_server ...
# We skip first 3 args (run -n openhands) and pass the rest to mamba run -n base
exec /openhands/miniforge3/bin/mamba run -n base "${@:3}"
