import logging
from flask import Flask
from apscheduler.schedulers.background import BackgroundScheduler

logger = logging.getLogger(__name__)


def start_scheduler(app: Flask) -> None:
    scheduler = BackgroundScheduler(daemon=True)
    interval = app.config["FETCH_INTERVAL_MINUTES"]
    scheduler.add_job(
        func=lambda: _fetch_job(app),
        trigger="interval",
        minutes=interval,
        id="dmarc_fetch",
        replace_existing=True,
    )
    scheduler.start()
    logger.info("DMARC fetch scheduler started (every %d minutes)", interval)


def _fetch_job(app: Flask) -> None:
    with app.app_context():
        from dmarc_dashboard.fetcher import fetch_and_store
        try:
            count = fetch_and_store(app.config)
            logger.info("Scheduler: stored %d new reports", count)
        except Exception:
            logger.exception("Scheduler: fetch failed")
