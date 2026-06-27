#!/bin/bash
# Compatibility wrapper for OpenHands runtime image.
#
# OpenHands main server invokes:
#   micromamba run -n openhands poetry run python -u -m openhands.runtime.action_execution_server <args...>
#
# Stock image ghcr.io/all-hands-ai/runtime:main uses miniforge3 with env "base"
# and has no micromamba binary. We translate the call into a direct invocation
# of the openhands poetry virtualenv python.
#
# Recognised pattern (drop these 6 leading args): run -n openhands poetry run python
# Anything after that (-u -m openhands.runtime.action_execution_server <args>)
# is passed verbatim to the venv python.
set -e

OH_VENV_PY="$(ls -1 /openhands/poetry/openhands-*-py*/bin/python 2>/dev/null | head -1)"
OH_CODE_DIR="/openhands/code"

if [[ "$1" == "run" && "$2" == "-n" && "$3" == "openhands" && "$4" == "poetry" && "$5" == "run" && "$6" == "python" ]]; then
    shift 6
    if [[ -x "$OH_VENV_PY" ]]; then
        cd "$OH_CODE_DIR"
        exec "$OH_VENV_PY" "$@"
    fi
fi

# Fallback for unexpected invocations
exec /openhands/miniforge3/bin/mamba run -n base "$@"
