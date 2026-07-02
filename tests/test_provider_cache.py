"""Provider model-cache eviction tests."""


def test_models_cache_prunes_expired(monkeypatch):
    from core import providers

    monkeypatch.setattr(providers, "_MODELS_TTL", 10)
    providers._MODELS_CACHE.clear()
    providers._MODELS_CACHE.update({
        "fresh": {"ts": 95.0, "models": ["a"]},
        "old": {"ts": 50.0, "models": ["b"]},
    })
    providers._prune_models_cache(now=100.0)
    assert "fresh" in providers._MODELS_CACHE
    assert "old" not in providers._MODELS_CACHE


def test_models_cache_caps_size(monkeypatch):
    from core import providers

    monkeypatch.setattr(providers, "_MODELS_TTL", 10_000)
    monkeypatch.setattr(providers, "_MODELS_CACHE_MAX", 2)
    providers._MODELS_CACHE.clear()
    providers._MODELS_CACHE.update({
        "oldest": {"ts": 1.0, "models": []},
        "middle": {"ts": 2.0, "models": []},
        "newest": {"ts": 3.0, "models": []},
    })
    providers._prune_models_cache(now=4.0)
    assert set(providers._MODELS_CACHE) == {"middle", "newest"}
