from src.value import value


def test_value_remains_callable():
    assert callable(value)
