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
  5. On startup: clean orphan OH conversations, verify all existing runtime
     mounts and remount if needed (graceful OH restart recovery).
"""

import asyncio
import json
import logging
import os
import subprocess
import threading
import time

from core.utils import safe_chat_id, CHAT_WORKSPACE_ROOT, SANDBOX_DIR

log = logging.getLogger("browserai.isolation")

# Backward-compatible aliases for other modules that imported these
WORKSPACE_ROOT = CHAT_WORKSPACE_ROOT
_safe_chat_id = safe_chat_id

# Thread-level lock to serialize concurrent remounts — prevents
# the Beta bug where parallel remounts interfere with each other.
_remount_lock = threading.Lock()

# Monitoring counters
_stats = {
    "remount_success": 0,
    "remount_fail": 0,
    "remount_skip": 0,
    "orphan_conversations_cleaned": 0,
    "orphan_runtimes_removed": 0,
    "startup_mount_fixes": 0,
}


def get_isolation_stats() -> dict:
    """Return isolation monitoring counters (for /api/health or admin)."""
    return dict(_stats)


def ensure_sandbox_dir() -> str:
    """Create the empty sandbox directory used as default /workspace mount."""
    os.makedirs(SANDBOX_DIR, exist_ok=True)
    return SANDBOX_DIR


def verify_runtime_mount(conversation_id: str, chat_id: str) -> bool:
    """Check if the runtime container already has the correct per-chat mount.
    Returns True if the mount is correct, False otherwise.
    """
    runtime_name = f"openhands-runtime-{conversation_id}"
    expected_path = os.path.join(CHAT_WORKSPACE_ROOT, safe_chat_id(chat_id))

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
                if os.path.realpath(src) == os.path.realpath(expected_path):
                    return True
                return False
    except Exception as e:
        log.warning("verify_runtime_mount: inspect failed: %s", e)
    return False


def remove_runtime_container(conversation_id: str) -> bool:
    """Stop and remove a runtime container. Used for cleanup."""
    runtime_name = f"openhands-runtime-{conversation_id}"
    try:
        subprocess.run(["docker", "stop", runtime_name], capture_output=True, timeout=15)
        subprocess.run(["docker", "rm", runtime_name], capture_output=True, timeout=10)
        log.info("remove_runtime_container: removed %s", runtime_name)
        return True
    except Exception as e:
        log.debug("remove_runtime_container: %s not found or already removed: %s", runtime_name, e)
        return False


def remount_runtime(conversation_id: str, chat_id: str) -> bool:
    """Recreate an OH runtime container with a per-chat /workspace mount.

    Thread-safe: uses a lock to serialize concurrent remounts.
    Returns True if the remount succeeded, False otherwise.
    """
    with _remount_lock:
        return _remount_runtime_locked(conversation_id, chat_id)


def _remount_runtime_locked(conversation_id: str, chat_id: str) -> bool:
    runtime_name = f"openhands-runtime-{conversation_id}"

    # Quick check: if mount is already correct, skip remount
    if verify_runtime_mount(conversation_id, chat_id):
        log.info("remount: %s already has correct mount, skipping", runtime_name)
        _stats["remount_skip"] += 1
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
        _stats["remount_fail"] += 1
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
    safe_id = safe_chat_id(chat_id)
    chat_host_path = os.path.join(CHAT_WORKSPACE_ROOT, safe_id)
    os.makedirs(chat_host_path, exist_ok=True)

    # 4. Stop + remove
    try:
        subprocess.run(["docker", "stop", runtime_name], capture_output=True, timeout=30)
        subprocess.run(["docker", "rm", runtime_name], capture_output=True, timeout=10)
    except Exception as e:
        log.warning("remount: stop/rm failed: %s", e)
        _stats["remount_fail"] += 1
        return False

    # 5. Build docker create command
    create_cmd = ["docker", "create", "--name", runtime_name]

    if network_mode and network_mode != "default":
        create_cmd += ["--network", network_mode]

    for e in env:
        create_cmd += ["-e", e]

    for container_port, bindings in port_bindings.items():
        for b in bindings:
            host_ip = b.get("HostIp", "0.0.0.0")
            host_port = b.get("HostPort", "")
            if host_port:
                create_cmd += ["-p", f"{host_ip}:{host_port}:{container_port}"]

    for eh in extra_hosts:
        create_cmd += ["--add-host", eh]

    for cap in capabilities:
        create_cmd += ["--cap-add", cap]

    mounts = cfg.get("Mounts", []) or []
    docker_sock_mounted = False
    for m in mounts:
        dst = m.get("Destination", "")
        src = m.get("Source", "")
        mode = m.get("Mode", "rw") or "rw"
        if dst == "/workspace":
            create_cmd += ["-v", f"{chat_host_path}:/workspace:rw"]
        elif "docker.sock" in dst or "docker.sock" in src:
            create_cmd += ["-v", f"{src}:{dst}"]
            docker_sock_mounted = True
        else:
            create_cmd += ["-v", f"{src}:{dst}:{mode}"]

    if not docker_sock_mounted:
        create_cmd += ["-v", "/var/run/docker.sock:/var/run/docker.sock"]

    for k, v in labels.items():
        if v:
            create_cmd += ["--label", f"{k}={v}"]

    if working_dir:
        create_cmd += ["-w", working_dir]

    if entrypoint:
        create_cmd += ["--entrypoint",
                       json.dumps(entrypoint) if len(entrypoint) > 1
                       else entrypoint[0] if entrypoint else ""]

    create_cmd.append(image)

    if cmd:
        create_cmd += cmd

    # 6. Create
    try:
        result = subprocess.run(create_cmd, capture_output=True, text=True, timeout=30)
        if result.returncode != 0:
            log.error("remount: docker create failed: %s", result.stderr[:500])
            _stats["remount_fail"] += 1
            return False
    except Exception as e:
        log.error("remount: docker create error: %s", e)
        _stats["remount_fail"] += 1
        return False

    # 7. Start
    try:
        subprocess.run(["docker", "start", runtime_name], capture_output=True, timeout=30)
    except Exception as e:
        log.error("remount: docker start error: %s", e)
        _stats["remount_fail"] += 1
        return False

    log.info("remount: %s now mounts %s:/workspace ✓", runtime_name, chat_host_path)
    _stats["remount_success"] += 1
    return True


async def remount_runtime_async(conversation_id: str, chat_id: str) -> bool:
    """Async wrapper for remount_runtime (runs in thread executor)."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, remount_runtime, conversation_id, chat_id)


# ─────────────────────────────────────────────────────────────────────────────
# Startup maintenance: orphan cleanup + mount verification
# ─────────────────────────────────────────────────────────────────────────────

async def startup_cleanup(oh_url: str) -> dict:
    """Run at BrowserAI startup to clean up orphaned resources and verify
    existing runtime mounts. Returns a summary dict.

    Does three things:
    1. Clean orphan OH conversations (no DB mapping) — frees RAM
    2. Remove stopped/orphan runtime containers — frees disk
    3. Verify all mapped runtime mounts — fix after OH restart
    """
    import httpx
    from core.conversations import get_all_mappings

    result = {"orphans_deleted": 0, "runtimes_removed": 0, "mounts_fixed": 0, "errors": []}

    # ── 1. Clean orphan OH conversations ───────────────────────────────
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            r = await client.get(f"{oh_url}/api/conversations?limit=100", timeout=10.0)
            if r.status_code == 200:
                body = r.json()
                oh_convs = body if isinstance(body, list) else (
                    body.get("conversations") or body.get("results") or []
                )
                # Build set of mapped conversation_ids
                mappings = get_all_mappings()
                mapped_cids = {m["conversation_id"] for m in mappings}

                for conv in oh_convs:
                    cid = conv.get("conversation_id") or conv.get("id")
                    if cid and cid not in mapped_cids:
                        # This OH conversation has no BrowserAI mapping — orphan
                        try:
                            await client.delete(f"{oh_url}/api/conversations/{cid}", timeout=10.0)
                            result["orphans_deleted"] += 1
                            log.info("startup_cleanup: deleted orphan OH conversation %s", cid)
                        except Exception as e:
                            result["errors"].append(f"delete_orphan_conv_{cid}: {e}")
    except Exception as e:
        result["errors"].append(f"list_oh_conversations: {e}")
        log.warning("startup_cleanup: failed to list OH conversations: %s", e)

    _stats["orphan_conversations_cleaned"] += result["orphans_deleted"]

    # ── 2. Remove stopped/orphan runtime containers ────────────────────
    try:
        ps = subprocess.run(
            ["docker", "ps", "-a", "--filter", "name=openhands-runtime-",
             "--format", "{{.Names}} {{.Status}}"],
            capture_output=True, text=True, timeout=10,
        )
        if ps.returncode == 0:
            mappings = get_all_mappings()
            mapped_cids = {m["conversation_id"] for m in mappings}

            for line in ps.stdout.strip().split("\n"):
                if not line:
                    continue
                parts = line.split()
                name = parts[0] if parts else ""
                status = parts[1] if len(parts) > 1 else ""

                # Extract conversation_id from container name
                # openhands-runtime-{cid}
                cid = name.replace("openhands-runtime-", "") if name.startswith("openhands-runtime-") else ""

                # Remove if stopped OR if no mapping exists
                should_remove = False
                if status in ("Exited", "Dead", "Created"):
                    should_remove = True
                elif cid and cid not in mapped_cids:
                    should_remove = True

                if should_remove:
                    try:
                        subprocess.run(["docker", "rm", "-f", name], capture_output=True, timeout=10)
                        result["runtimes_removed"] += 1
                        log.info("startup_cleanup: removed runtime container %s (status=%s)", name, status)
                    except Exception as e:
                        result["errors"].append(f"rm_runtime_{name}: {e}")
    except Exception as e:
        result["errors"].append(f"list_runtimes: {e}")

    _stats["orphan_runtimes_removed"] += result["runtimes_removed"]

    # ── 3. Verify all mapped runtime mounts ────────────────────────────
    mappings = get_all_mappings()
    for m in mappings:
        cid = m["conversation_id"]
        chat_id = m["chat_id"]
        try:
            if not verify_runtime_mount(cid, chat_id):
                log.info("startup_cleanup: fixing mount for chat_id=%s cid=%s", chat_id, cid)
                ok = await remount_runtime_async(cid, chat_id)
                if ok:
                    result["mounts_fixed"] += 1
                else:
                    result["errors"].append(f"remount_{cid}: failed")
        except Exception as e:
            result["errors"].append(f"verify_mount_{cid}: {e}")

    _stats["startup_mount_fixes"] += result["mounts_fixed"]

    log.info(
        "startup_cleanup: orphans_deleted=%d runtimes_removed=%d mounts_fixed=%d errors=%d",
        result["orphans_deleted"], result["runtimes_removed"],
        result["mounts_fixed"], len(result["errors"]),
    )
    return result
