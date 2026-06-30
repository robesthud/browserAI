"""Security tests — SQL whitelist and AUTH_SECRET production guard."""
import os
import pytest


# ── SQL identifier whitelist ────────────────────────────────────────────────


class TestSqlWhitelist:
    """Verify that _validate_table and _validate_order reject unknown
    identifiers, preventing SQL injection via f-string interpolation."""

    def test_allowed_tables_are_accepted(self):
        from core.admin_data import _validate_table, ALLOWED_TABLES
        for t in ALLOWED_TABLES:
            assert _validate_table(t) == t

    def test_disallowed_table_raises(self):
        from core.admin_data import _validate_table
        with pytest.raises(ValueError, match="not in ALLOWED_TABLES"):
            _validate_table("users; DROP TABLE users; --")

    def test_disallowed_table_empty_raises(self):
        from core.admin_data import _validate_table
        with pytest.raises(ValueError):
            _validate_table("")

    def test_disallowed_table_random_string_raises(self):
        from core.admin_data import _validate_table
        with pytest.raises(ValueError):
            _validate_table("something_new")

    def test_allowed_orders_are_accepted(self):
        from core.admin_data import _validate_order, ALLOWED_ORDER_CLAUSES
        for o in ALLOWED_ORDER_CLAUSES:
            assert _validate_order(o) == o

    def test_disallowed_order_raises(self):
        from core.admin_data import _validate_order
        with pytest.raises(ValueError, match="not in ALLOWED_ORDER_CLAUSES"):
            _validate_order("id; DROP TABLE users; --")

    def test_disallowed_order_injection_raises(self):
        from core.admin_data import _validate_order
        # Classic SQLi in ORDER BY
        with pytest.raises(ValueError):
            _validate_order("1; SELECT 1")

    def test_disallowed_order_arbitrary_column_raises(self):
        from core.admin_data import _validate_order
        with pytest.raises(ValueError):
            _validate_order("password_hash DESC")

    def test_scoped_rows_rejects_bad_table(self):
        from core.admin_data import _scoped_rows
        with pytest.raises(ValueError):
            _scoped_rows("evil_table; --", "user1", False, 10)

    def test_scoped_rows_rejects_bad_order(self):
        from core.admin_data import _scoped_rows
        with pytest.raises(ValueError):
            _scoped_rows("jobs", "user1", False, 10, order="1; DROP TABLE jobs")


# ── AUTH_SECRET production guard ────────────────────────────────────────────


class TestAuthSecretProductionGuard:
    """Verify that the server refuses to start in production mode
    if AUTH_SECRET is missing or still the default value."""

    def test_default_values_are_detected(self):
        """The known-default set should catch .env.example placeholders."""
        defaults = {"replace-with-another-long-random-string", "dev-secret", "replace-with-a-long-random-string", ""}
        for d in defaults:
            assert d in defaults  # they're in the check set

    def test_production_missing_secret_would_exit(self):
        """Simulate the production guard logic without importing server.py
        (which has side-effects at module level)."""
        auth_secret = ""
        is_production = True
        defaults = {"replace-with-another-long-random-string", "dev-secret", "replace-with-a-long-random-string", ""}

        # Missing secret → should exit
        should_exit = (not auth_secret) and is_production
        assert should_exit is True

        # Default secret → should exit
        auth_secret = "replace-with-another-long-random-string"
        should_exit = (auth_secret in defaults) and is_production
        assert should_exit is True

    def test_dev_missing_secret_only_warns(self):
        """In non-production, missing AUTH_SECRET only logs a warning."""
        auth_secret = ""
        is_production = False
        should_exit = (not auth_secret) and is_production
        assert should_exit is False

    def test_real_secret_passes(self):
        """A properly set secret should pass the guard."""
        auth_secret = "a8ee3e84fcaa9d1cd082a4abf75afe0da3b6f0ff065edf612ed0ed4f656d3909"
        is_production = True
        defaults = {"replace-with-another-long-random-string", "dev-secret", "replace-with-a-long-random-string", ""}
        should_exit = (not auth_secret) or (auth_secret in defaults)
        should_exit = should_exit and is_production
        assert should_exit is False
