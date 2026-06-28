"""
Per-chat workspace isolation for OpenHands runtimes.

Strategy:
  1. OH config.toml mounts an EMPTY directory (_sandbox) as /workspace.
     New runtimes can't see any chat data — safe by default.
  2. After OH creates a runtime, we stop it, recreate it with the per-chat
     bind mount, and start it again. OH reconnects automatically.
  3. For new conversations: create WITHOUT initial_user_msg, start, remount,
     THEN send the message. This ensures the agent only works in its
     per-chat directory.
  4. A threading.Lock serializes concurrent remounts to prevent race conditions.
"""

import asyncio
import json
import logging
import os
import subprocess
import threading
import time

log = logging.getLogger("browserai.isolation")

DATA_DIR = os.environ.get("DATA_DIR", "/opt/browserai-data")
WORKSPACE_ROOT = os.path.join(DATA_DIR, "workspace", "chats")
SANDBOX_DIR = os.path.join(DATA_DIR, "workspace", "_sandbox")

# Thread-level lock to serialize concurrent remounts — prevents
# the Beta bug where parallel remounts interfere with each other.
_remount_lock = threading.Lock()


def _safe_chat_id(chat_id: str) -> str:
    """Sanitize chat_id for use in filesystem paths."""
    raw = str(chat_id or "").strip()
    safe = "".join(ch if (ch.isalnum() or ch in "_-.") else "_" for ch in raw)
    return safe[:96] or "default"


def ensure_sandbox_dir() -> str:
    """Create the empty sandbox directory used as default /workspace mount.
    This is set in oh-config.toml so that new runtimes mount an empty
    directory instead of the full workspace.
    """
    os.makedirs(SANDBOX_DIR, exist_ok=True)
    return SANDBOX_DIR


def verify_runtime_mount(conversation_id: str, chat_id: str) -> bool:
    """Check if the runtime container already has the correct per-chat mount.
    Returns True if the mount is correct, False otherwise.
    """
    runtime_name = f"openhands-runtime-{conversation_id}"
    safe_id = _safe_chat_id(chat_id)
    expected_path = os.path.join(WORKSPACE_ROOT, safe_id)

    try:
        inspect = subprocess.run(
            ["docker", "inspect", runtime_name],
            capture_output=True, text=True, timeout=10,
        )
        if inspect.returncode != 0:
            return False
        cfg = json.loads(inspect.stdout)[0]
        mounts = cfg.get("Mounts", []) or []
        for m in mounts:
            if m.get("Destination") == "/workspace":
                src = m.get("Source", "")
                # Resolve both paths to handle symlinks
                if os.path.realpath(src) == os.path.realpath(expected_path):
                    return True
                return False
    except Exception as e:
        log.warning("verify_runtime_mount: inspect failed: %s", e)
    return False


def remount_runtime(conversation_id: str, chat_id: str) -> bool:
    """Recreate an OH runtime container with a per-chat /workspace mount.

    Thread-safe: uses a lock to serialize concurrent remounts.

    1. Find the runtime container for this conversation_id (short retries).
    2. Inspect it to capture the full container config.
    3. Stop + remove the container.
    4. Recreate it with the per-chat bind mount replacing /workspace.
    5. Start it again.

    Returns True if the remount succeeded, False otherwise.
    """
    with _remount_lock:
        return _remount_runtime_locked(conversation_id, chat_id)


def _remount_runtime_locked(conversation_id: str, chat_id: str) -> bool:
    runtime_name = f"openhands-runtime-{conversation_id}"

    # Quick check: if mount is already correct, skip remount
    if verify_runtime_mount(conversation_id, chat_id):
        log.info("remount: %s already has correct mount, skipping", runtime_name)
        return True

    # 1. Find container (short retries — /start should have created it)
    cfg = None
    for attempt in range(15):  # 15 × 2s = 30s max
        try:
            inspect = subprocess.run(
                ["docker", "inspect", runtime_name],
                capture_output=True, text=True, timeout=10,
            )
            if inspect.returncode == 0:
                cfg = json.loads(inspect.stdout)[0]
                break
        except Exception:
            pass
        log.debug("remount: waiting for %s (attempt %d/15)", runtime_name, attempt + 1)
        time.sleep(2)

    if cfg is None:
        log.warning("remount: container %s not found after 30s", runtime_name)
        return False

    log.info("remount: found container %s, proceeding", runtime_name)

    # 2. Extract config for recreation
    image = cfg["Config"]["Image"]
    env = cfg["Config"].get("Env", [])
    cmd = cfg["Config"].get("Cmd", [])
    working_dir = cfg["Config"].get("WorkingDir", "/workspace")
    labels = cfg["Config"].get("Labels", {}) or {}
    entrypoint = cfg["Config"].get("Entrypoint") or None
    host_config = cfg["HostConfig"]
    network_mode = host_config.get("NetworkMode", "default")
    port_bindings = host_config.get("PortBindings", {}) or {}
    extra_hosts = host_config.get("ExtraHosts", []) or []
    capabilities = host_config.get("CapAdd", []) or []

    # 3. Compute per-chat mount
    safe_id = _safe_chat_id(chat_id)
    chat_host_path = os.path.join(WORKSPACE_ROOT, safe_id)
    os.makedirs(chat_host_path, exist_ok=True)

    # 4. Stop + remove
    try:
        subprocess.run(["docker", "stop", runtime_name], capture_output=True, timeout=30)
        subprocess.run(["docker", "rm", runtime_name], capture_output=True, timeout=10)
    except Exception as e:
        log.warning("remount: stop/rm failed: %s", e)
        return False

    # 5. Build docker create command
    create_cmd = ["docker", "create", "--name", runtime_name]

    # Network
    if network_mode and network_mode != "default":
        create_cmd += ["--network", network_mode]

    # Environment
    for e in env:
        create_cmd += ["-e", e]

    # Port bindings
    for container_port, bindings in port_bindings.items():
        for b in bindings:
            host_ip = b.get("HostIp", "0.0.0.0")
            host_port = b.get("HostPort", "")
            if host_port:
                create_cmd += ["-p", f"{host_ip}:{host_port}:{container_port}"]

    # Extra hosts
    for eh in extra_hosts:
        create_cmd += ["--add-host", eh]

    # Capabilities
    for cap in capabilities:
        create_cmd += ["--cap-add", cap]

    # Volumes: replace /workspace mount with per-chat one
    mounts = cfg.get("Mounts", []) or []
    docker_sock_mounted = False
    for m in mounts:
        dst = m.get("Destination", "")
        src = m.get("Source", "")
        mode = m.get("Mode", "rw") or "rw"
        if dst == "/workspace":
            # Replace with per-chat mount
            create_cmd += ["-v", f"{chat_host_path}:/workspace:rw"]
        elif "docker.sock" in dst or "docker.sock" in src:
            create_cmd += ["-v", f"{src}:{dst}"]
            docker_sock_mounted = True
        else:
            create_cmd += ["-v", f"{src}:{dst}:{mode}"]

    # Ensure docker.sock is mounted (OH runtimes need it)
    if not docker_sock_mounted:
        create_cmd += ["-v", "/var/run/docker.sock:/var/run/docker.sock"]

    # Labels
    for k, v in labels.items():
        if v:
            create_cmd += ["--label", f"{k}={v}"]

    # Working dir
    if working_dir:
        create_cmd += ["-w", working_dir]

    # Entrypoint
    if entrypoint:
        create_cmd += ["--entrypoint",
                       json.dumps(entrypoint) if len(entrypoint) > 1
                       else entrypoint[0] if entrypoint else ""]

    # Image
    create_cmd.append(image)

    # Cmd
    if cmd:
        create_cmd += cmd

    # 6. Create
    try:
        result = subprocess.run(create_cmd, capture_output=True, text=True, timeout=30)
        if result.returncode != 0:
            log.error("remount: docker create failed: %s", result.stderr[:500])
            return False
    except Exception as e:
        log.error("remount: docker create error: %s", e)
        return False

    # 7. Start
    try:
        subprocess.run(["docker", "start", runtime_name], capture_output=True, timeout=30)
    except Exception as e:
        log.error("remount: docker start error: %s", e)
        return False

    log.info("remount: %s now mounts %s:/workspace ✓", runtime_name, chat_host_path)
    return True


async def remount_runtime_async(conversation_id: str, chat_id: str) -> bool:
    """Async wrapper for remount_runtime (runs in thread executor)."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, remount_runtime, conversation_id, chat_id)
