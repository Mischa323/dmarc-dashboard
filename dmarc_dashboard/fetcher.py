"""Fetch DMARC reports from Microsoft 365 and persist them to the database."""
import logging
from typing import Dict, Any

from dmarc_dashboard import db
from dmarc_dashboard.graph_client import GraphClient
from dmarc_dashboard.dmarc_parser import parse_report
from dmarc_dashboard.models import Report, Record

logger = logging.getLogger(__name__)


def fetch_and_store(config: Dict[str, Any]) -> int:
    client = GraphClient(
        tenant_id=config["TENANT_ID"],
        client_id=config["CLIENT_ID"],
        client_secret=config["CLIENT_SECRET"],
    )
    mailbox = config["MAILBOX"]
    folder = config.get("MAIL_FOLDER", "Inbox")

    messages = client.get_dmarc_messages(mailbox, folder)
    stored = 0

    for msg in messages:
        msg_id = msg["id"]
        if Report.query.filter_by(email_message_id=msg_id).first():
            continue

        xml_payloads = client.get_xml_attachments(mailbox, msg_id)
        for xml_bytes in xml_payloads:
            data = parse_report(xml_bytes)
            if not data:
                logger.warning("Failed to parse XML from message %s", msg_id)
                continue

            if Report.query.filter_by(report_id=data["report_id"]).first():
                logger.debug("Report %s already in DB, skipping", data["report_id"])
                continue

            report = Report(
                report_id=data["report_id"],
                org_name=data["org_name"],
                org_email=data["org_email"],
                domain=data["domain"],
                begin_date=data["begin_date"],
                end_date=data["end_date"],
                policy_p=data["policy_p"],
                policy_sp=data["policy_sp"],
                policy_pct=data["policy_pct"],
                adkim=data["adkim"],
                aspf=data["aspf"],
                email_message_id=msg_id,
            )
            db.session.add(report)
            db.session.flush()

            for rec in data["records"]:
                db.session.add(Record(report_id=report.id, **rec))

            db.session.commit()
            stored += 1
            logger.info("Stored report %s from %s", data["report_id"], data["org_name"])

    return stored
