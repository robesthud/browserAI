"""
Per-chat workspace isolation for OpenHands runtimes.

OpenHands creates one runtime container per sandbox and reuses it across
conversations, always mounting whatever WORKSPACE_MOUNT_PATH / sandbox.volumes
was set at startup.  That means every chat sees the same /workspace.

Fix: after OH creates a runtime, we stop it, recreate it with the correct
per-chat bind mount, and start it again.  OH reconnects automatically.
"""

import asyncio
import json
import logging
import os
import subprocess

log = logging.getLogger("browserai.isolation")

DATA_DIR = os.environ.get("DATA_DIR", "/opt/browserai-data")
WORKSPACE_ROOT = os.path.join(DATA_DIR, "workspace", "chats")


def remount_runtime(conversation_id: str, chat_id: str) -> bool:
    """Recreate an OH runtime container with a per-chat /workspace mount.

    1. Find the running runtime container for this conversation_id.
    2. Inspect it to capture the full container config.
    3. Stop + remove the container.
    4. Recreate it with the per-chat bind mount replacing /workspace.
    5. Start it again.

    Returns True if the remount succeeded, False otherwise.
    """
    runtime_name = f"openhands-runtime-{conversation_id}"

    # 1. Find container (retry up to 60s — OH creates it asynchronously)
    cfg = None
    for attempt in range(30):
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
        import time
        time.sleep(2)
    
    if cfg is None:
        log.warning("remount: container %s not found after 60s", runtime_name)
        return False

    # 2. Extract config for recreation
    image = cfg["Config"]["Image"]
    env = cfg["Config"].get("Env", [])
    cmd = cfg["Config"].get("Cmd", [])
    hostname = cfg["Config"].get("Hostname", "")
    working_dir = cfg["Config"].get("WorkingDir", "/workspace")
    labels = cfg["Config"].get("Labels", {}) or {}
    entrypoint = cfg["Config"].get("Entrypoint") or None
    exposed_ports = cfg["Config"].get("ExposedPorts", {}) or {}
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
        create_cmd += ["--entrypoint", json.dumps(entrypoint) if len(entrypoint) > 1 else entrypoint[0] if entrypoint else ""]

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

    log.info("remount: %s now mounts %s:/workspace", runtime_name, chat_host_path)
    return True


def _safe_chat_id(chat_id: str) -> str:
    raw = str(chat_id or "").strip()
    safe = "".join(ch if (ch.isalnum() or ch in "_-.") else "_" for ch in raw)
    return safe[:96] or "default"


async def remount_runtime_async(conversation_id: str, chat_id: str) -> bool:
    """Async wrapper for remount_runtime."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, remount_runtime, conversation_id, chat_id)
