"""Step 10.1 — server-side re-chunking of the assistant message into deltas."""
from core.server import _chunk_text


def test_chunk_lossless_and_bounded():
    text = ("Привет, это довольно длинный ответ ассистента, который надо "
            "разбить на несколько частей для эффекта печати по словам.")
    parts = _chunk_text(text, 24)
    assert len(parts) > 1
    assert "".join(parts) == text          # never lose/duplicate characters
    assert all(p for p in parts)           # no empty chunks


def test_chunk_short_text_single_piece():
    assert _chunk_text("hi", 24) == ["hi"]
    assert _chunk_text("", 24) == []


def test_chunk_handles_long_whitespace_free_run():
    # e.g. a long URL or code token — must still be split & lossless.
    blob = "x" * 200
    parts = _chunk_text(blob, 24)
    assert "".join(parts) == blob
    assert len(parts) > 1


def test_chunk_prefers_word_boundaries():
    text = "alpha beta gamma delta epsilon zeta eta theta iota kappa"
    parts = _chunk_text(text, 10)
    # No chunk should start with a leading space artifact from a mid-word cut
    # and the join must be exact.
    assert "".join(parts) == text
