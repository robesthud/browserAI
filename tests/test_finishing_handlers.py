"""Final pass: formerly-stubbed Step 8/9 support endpoints are real handlers."""


def test_mcp_config_lifecycle(client):
    assert client.get('/api/mcp/status').status_code == 200
    r = client.put('/api/mcp/server/test-server', json={'command': 'uvx test', 'enabled': True})
    assert r.status_code == 200 and r.json()['ok'] is True
    status = client.get('/api/mcp/status').json()
    assert any(s['name'] == 'test-server' for s in status['servers'])
    assert client.delete('/api/mcp/server/test-server').json()['ok'] is True


def test_checkpoints_metadata(client):
    r = client.post('/api/checkpoints', json={'chatId': 'chat-x', 'label': 'manual', 'files': ['a.txt']})
    assert r.status_code == 200 and r.json()['ok'] is True
    items = client.get('/api/checkpoints/chat-x').json()['checkpoints']
    assert items and items[0]['label'] == 'manual'
    restore = client.post('/api/checkpoints/chat-x/restore', json={'step': items[0]['step']}).json()
    assert restore['ok'] is False and restore['error'] == 'restore_not_available'


def test_push_subscription_lifecycle(client):
    sub = {'endpoint': 'https://push.example/sub/1', 'keys': {'p256dh': 'x', 'auth': 'y'}}
    assert client.post('/api/push/subscribe', json=sub).json()['subscribed'] is True
    assert client.post('/api/push/unsubscribe', json=sub).json()['ok'] is True


def test_admin_deepseek_and_ops_are_real(client):
    assert 'stub' not in client.get('/api/admin/deepseek/status').json()
    assert 'services' in client.get('/api/ops/services').json()
    assert client.get('/api/approval/policy').json()['ok'] is True
