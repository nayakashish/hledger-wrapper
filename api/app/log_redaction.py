"""Keep query strings out of the uvicorn access log.

`/lookup?description=…` and `/search?q=…` carry payees and search terms, and
uvicorn logs the full request line. The filter keeps the line (method, path,
status) and drops everything after the `?`.
"""
import logging


class StripQueryString(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        # uvicorn.access args: (client_addr, method, full_path, http_version, status_code)
        args = record.args
        if isinstance(args, tuple) and len(args) >= 3 and isinstance(args[2], str):
            record.args = args[:2] + (args[2].split("?", 1)[0],) + args[3:]
        return True


def install() -> None:
    logger = logging.getLogger("uvicorn.access")
    if not any(isinstance(f, StripQueryString) for f in logger.filters):
        logger.addFilter(StripQueryString())
