from flask import Flask
from flask_sqlalchemy import SQLAlchemy
from config import Config

db = SQLAlchemy()


def create_app(config_class=Config):
    app = Flask(__name__)
    app.config.from_object(config_class)

    db.init_app(app)

    from dmarc_dashboard.routes import bp
    app.register_blueprint(bp)

    with app.app_context():
        db.create_all()

    if app.config.get("FETCH_INTERVAL_MINUTES") and app.config.get("CLIENT_ID"):
        from dmarc_dashboard.scheduler import start_scheduler
        start_scheduler(app)

    return app
