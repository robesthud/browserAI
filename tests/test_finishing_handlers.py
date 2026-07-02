"""Final pass: formerly-stubbed Step 8/9 support endpoints are real handlers."""


def test_mcp_config_lifecycle(auth_client):
    assert auth_client.get('/api/mcp/status').status_code == 200
    r = auth_client.put('/api/mcp/server/test-server', json={'command': 'uvx test', 'enabled': True})
    assert r.status_code == 200 and r.json()['ok'] is True
    status = auth_client.get('/api/mcp/status').json()
    assert any(s['name'] == 'test-server' for s in status['servers'])
    assert auth_client.delete('/api/mcp/server/test-server').json()['ok'] is True


def test_checkpoints_metadata(auth_client):
    r = auth_client.post('/api/checkpoints', json={'chatId': 'chat-x', 'label': 'manual', 'files': ['a.txt']})
    assert r.status_code == 200 and r.json()['ok'] is True
    items = auth_client.get('/api/checkpoints/chat-x').json()['checkpoints']
    assert items and items[0]['label'] == 'manual'
    restore = auth_client.post('/api/checkpoints/chat-x/restore', json={'step': items[0]['step']}).json()
    assert restore['ok'] is False and restore['error'] == 'restore_not_available'


def test_push_subscription_lifecycle(auth_client):
    sub = {'endpoint': 'https://push.example/sub/1', 'keys': {'p256dh': 'x', 'auth': 'y'}}
    assert auth_client.post('/api/push/subscribe', json=sub).json()['subscribed'] is True
    assert auth_client.post('/api/push/unsubscribe', json=sub).json()['ok'] is True


def test_admin_deepseek_and_ops_are_real(auth_client):
    assert 'stub' not in auth_client.get('/api/admin/deepseek/status').json()
    assert 'services' in auth_client.get('/api/ops/services').json()
    assert auth_client.get('/api/approval/policy').json()['ok'] is True
