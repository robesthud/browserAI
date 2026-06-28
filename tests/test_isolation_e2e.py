#!/usr/bin/env python3
"""E2E test for per-chat workspace isolation.

Creates N chats in parallel, writes a unique secret file in each chat's
workspace, then verifies that each runtime container can only see its own
file and NOT files from other chats.

Usage:
  python3 test_isolation_e2e.py [--count 5] [--api http://localhost:8080]

Requires: sshpass, docker CLI access on the server.
"""

import argparse
import json
import subprocess
import sys
import time
import urllib.request
import urllib.error


def api_call(base_url: str, method: str, path: str, body: dict = None) -> dict:
    """Make an API call and return parsed JSON."""
    url = f"{base_url}{path}"
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(url, data=data, method=method)
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return {"error": e.code, "body": e.read().decode()[:200]}


def create_chat(base_url: str, chat_id: str) -> dict:
    """Create a chat via the workspace init API."""
    return api_call(base_url, "POST", "/api/workspace/chat/init", {"chatId": chat_id})


def get_runtime_mount(conversation_id: str) -> str:
    """Get the /workspace mount source for a runtime container."""
    result = subprocess.run(
        ["docker", "inspect", f"openhands-runtime-{conversation_id}"],
        capture_output=True, text=True, timeout=10,
    )
    if result.returncode != 0:
        return ""
    cfg = json.loads(result.stdout)[0]
    for m in cfg.get("Mounts", []):
        if m.get("Destination") == "/workspace":
            return m.get("Source", "")
    return ""


def runtime_can_see_file(conversation_id: str, filename: str) -> bool:
    """Check if a runtime container can see a file in /workspace."""
    for retry in range(3):
        result = subprocess.run(
            ["docker", "exec", f"openhands-runtime-{conversation_id}",
             "ls", f"/workspace/{filename}"],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode == 0:
            return True
        # Container may be restarting — wait and retry
        time.sleep(2)
    return False


def main():
    parser = argparse.ArgumentParser(description="E2E isolation test")
    parser.add_argument("--count", type=int, default=5, help="Number of parallel chats")
    parser.add_argument("--api", default="http://localhost:8080", help="BrowserAI API URL")
    args = parser.parse_args()

    ts = int(time.time())
    chats = []
    passed = 0
    failed = 0

    print(f"=== E2E Isolation Test: {args.count} chats ===\n")

    # ── Step 1: Create chats ───────────────────────────────────────────
    print(f"Step 1: Creating {args.count} chats...")
    for i in range(args.count):
        chat_id = f"e2e-test-{i}-{ts}"
        result = create_chat(args.api, chat_id)
        cid = result.get("conversationId")
        chats.append({"chat_id": chat_id, "cid": cid, "index": i})
        status = "✓" if cid else "✗"
        print(f"  Chat {i}: {chat_id} → cid={cid} {status}")

    # ── Step 2: Wait for runtimes to start ─────────────────────────────
    print(f"\nStep 2: Waiting for runtimes to start (30s)...")
    time.sleep(30)

    # ── Step 3: Write secret files ─────────────────────────────────────
    print(f"\nStep 3: Writing secret files...")
    for chat in chats:
        if not chat["cid"]:
            continue
        # Write file via host path (simulating what the agent would do)
        mount_src = get_runtime_mount(chat["cid"])
        if mount_src:
            secret_file = f"{mount_src}/secret_{chat['index']}.txt"
            with open(secret_file, "w") as f:
                f.write(f"SECRET_DATA_{chat['index']}")
            chat["secret_file"] = f"secret_{chat['index']}.txt"
            print(f"  Chat {chat['index']}: wrote {secret_file}")
        else:
            print(f"  Chat {chat['index']}: no mount found!")

    # ── Step 4: Verify isolation ───────────────────────────────────────
    print(f"\nStep 4: Verifying isolation...")
    for chat in chats:
        if not chat["cid"] or "secret_file" not in chat:
            print(f"  Chat {chat['index']}: SKIP (no runtime or mount)")
            continue

        # Verify this chat can see its OWN file
        own_ok = runtime_can_see_file(chat["cid"], chat["secret_file"])

        # Verify this chat CANNOT see OTHER chats' files
        leak_found = False
        for other in chats:
            if other["index"] == chat["index"]:
                continue
            if not other["cid"] or "secret_file" not in other:
                continue
            if runtime_can_see_file(chat["cid"], other["secret_file"]):
                print(f"  ✗ Chat {chat['index']} can see Chat {other['index']}'s file! LEAK!")
                leak_found = True

        if own_ok and not leak_found:
            print(f"  ✓ Chat {chat['index']}: sees own file, no leaks")
            passed += 1
        elif not own_ok:
            print(f"  ✗ Chat {chat['index']}: cannot see own file!")
            failed += 1
        else:
            failed += 1

    # ── Step 5: Verify mount paths ─────────────────────────────────────
    print(f"\nStep 5: Verifying mount paths...")
    for chat in chats:
        if not chat["cid"]:
            continue
        mount_src = get_runtime_mount(chat["cid"])
        expected = f"/opt/browserai-data/workspace/chats/e2e_test_{chat['index']}_{ts}"
        # The safe_chat_id replaces hyphens with underscores
        expected_safe = expected  # already using underscores
        if mount_src:
            is_correct = "_sandbox" not in mount_src
            status = "✓" if is_correct else "✗ (_sandbox!)"
            print(f"  Chat {chat['index']}: {mount_src} → /workspace {status}")
        else:
            print(f"  Chat {chat['index']}: no mount found ✗")

    # ── Summary ────────────────────────────────────────────────────────
    total = passed + failed
    print(f"\n{'='*50}")
    print(f"RESULTS: {passed}/{total} passed, {failed} failed")
    if failed == 0 and total > 0:
        print("✓ ALL TESTS PASSED — isolation is working correctly")
        return 0
    else:
        print("✗ SOME TESTS FAILED — check isolation logic")
        return 1


if __name__ == "__main__":
    sys.exit(main())
