import os
from dotenv import load_dotenv

load_dotenv()


class Config:
    SECRET_KEY = os.environ.get("SECRET_KEY", "dev-key-change-in-production")
    SQLALCHEMY_DATABASE_URI = os.environ.get("DATABASE_URL", "sqlite:///dmarc.db")
    SQLALCHEMY_TRACK_MODIFICATIONS = False

    TENANT_ID = os.environ.get("TENANT_ID", "")
    CLIENT_ID = os.environ.get("CLIENT_ID", "")
    CLIENT_SECRET = os.environ.get("CLIENT_SECRET", "")
    MAILBOX = os.environ.get("MAILBOX", "")
    MAIL_FOLDER = os.environ.get("MAIL_FOLDER", "Inbox")

    FETCH_INTERVAL_MINUTES = int(os.environ.get("FETCH_INTERVAL_MINUTES", "60"))
