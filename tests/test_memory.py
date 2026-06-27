"""Step 7 / 10.3 — memory fact extraction unit test (LLM-free heuristic)."""
import uuid

from core.memory_kb import extract_facts, list_facts


def test_extract_facts_ru():
    uid = f"u-{uuid.uuid4().hex[:6]}"
    extract_facts(uid, "Меня зовут Иван, я работаю программистом. Предпочитаю тёмную тему.")
    facts = {f["key"]: f["value"] for f in list_facts(uid)}
    # The heuristic extractor should pull at least a name or occupation.
    assert any(k in facts for k in ("name", "occupation", "preference")), facts
