import asyncio
import logging

import pytest

from core import vault as vlt
from core import server


def test_spawn_background_logs_task_exceptions(caplog):
    async def run():
        caplog.set_level(logging.ERROR, logger="browserai.core")

        async def boom():
            raise RuntimeError("background exploded")

        server._spawn_background(boom(), name="pytest-boom")
        await asyncio.sleep(0)
        await asyncio.sleep(0)

    asyncio.run(run())
    assert "background task failed: pytest-boom" in caplog.text
    assert "background exploded" in caplog.text


def test_vault_setup_existing_requires_confirm_and_current_passphrase():
    if not vlt.is_available():
        pytest.skip("cryptography unavailable")
    user_id = "vault-setup-hardening"
    vlt.disable(user_id)

    vlt.setup(user_id, "old-passphrase", 30)
    vlt.lock(user_id)

    with pytest.raises(ValueError, match="vault_already_setup"):
        vlt.setup(user_id, "new-passphrase", 30)

    with pytest.raises(ValueError, match="current_passphrase_required"):
        vlt.setup(user_id, "new-passphrase", 30, confirm_overwrite=True)

    status = vlt.setup(
        user_id,
        "new-passphrase",
        15,
        confirm_overwrite=True,
        current_passphrase="old-passphrase",
    )
    assert status["enabled"] is True
    assert status["locked"] is False
    assert status["autolockMinutes"] == 15


def test_vault_restore_existing_requires_confirm_and_current_passphrase():
    if not vlt.is_available():
        pytest.skip("cryptography unavailable")
    source_user = "vault-restore-source"
    target_user = "vault-restore-target"
    vlt.disable(source_user)
    vlt.disable(target_user)

    vlt.setup(source_user, "source-passphrase", 30)
    backup = vlt.backup(source_user)

    vlt.setup(target_user, "target-passphrase", 30)
    vlt.lock(target_user)

    with pytest.raises(ValueError, match="vault_restore_overwrites_existing"):
        vlt.restore(target_user, backup)

    with pytest.raises(ValueError, match="current_passphrase_required"):
        vlt.restore(target_user, backup, confirm_overwrite=True)

    status = vlt.restore(
        target_user,
        backup,
        confirm_overwrite=True,
        current_passphrase="target-passphrase",
    )
    assert status["enabled"] is True
    assert status["locked"] is True


def test_vault_restore_rejects_malformed_backup():
    if not vlt.is_available():
        pytest.skip("cryptography unavailable")
    user_id = "vault-restore-malformed"
    vlt.disable(user_id)

    with pytest.raises(ValueError, match="invalid_backup"):
        vlt.restore(
            user_id,
            {"version": 1, "kdfSalt": "not-base64", "verifierHash": "also-bad"},
        )
