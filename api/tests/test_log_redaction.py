"""The access log keeps the path but never the query string."""
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.log_redaction import StripQueryString


def _access_record(path: str) -> logging.LogRecord:
    return logging.LogRecord(
        "uvicorn.access", logging.INFO, __file__, 0,
        '%s - "%s %s HTTP/%s" %d', ("127.0.0.1:5000", "GET", path, "1.1", 200), None,
    )


def test_query_string_is_dropped():
    record = _access_record("/lookup?description=Coffee+Shop")
    StripQueryString().filter(record)
    assert record.getMessage() == '127.0.0.1:5000 - "GET /lookup HTTP/1.1" 200'


def test_path_without_query_is_unchanged():
    record = _access_record("/health")
    StripQueryString().filter(record)
    assert record.getMessage() == '127.0.0.1:5000 - "GET /health HTTP/1.1" 200'


def test_unexpected_record_shape_passes_through():
    record = logging.LogRecord("uvicorn.access", logging.INFO, __file__, 0, "plain message", None, None)
    assert StripQueryString().filter(record) is True
    assert record.getMessage() == "plain message"
