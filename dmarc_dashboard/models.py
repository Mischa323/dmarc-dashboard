from datetime import datetime
from dmarc_dashboard import db


class Report(db.Model):
    __tablename__ = "reports"

    id = db.Column(db.Integer, primary_key=True)
    report_id = db.Column(db.String(255), unique=True, nullable=False)
    org_name = db.Column(db.String(255))
    org_email = db.Column(db.String(255))
    domain = db.Column(db.String(255), index=True)
    begin_date = db.Column(db.DateTime)
    end_date = db.Column(db.DateTime)
    policy_p = db.Column(db.String(20))
    policy_sp = db.Column(db.String(20))
    policy_pct = db.Column(db.Integer)
    adkim = db.Column(db.String(1))
    aspf = db.Column(db.String(1))
    email_message_id = db.Column(db.String(255))
    fetched_at = db.Column(db.DateTime, default=datetime.utcnow)

    records = db.relationship("Record", back_populates="report", cascade="all, delete-orphan")

    @property
    def total_messages(self):
        return sum(r.count for r in self.records)

    @property
    def passed_messages(self):
        return sum(r.count for r in self.records if r.dmarc_pass)

    @property
    def failed_messages(self):
        return self.total_messages - self.passed_messages

    @property
    def pass_rate(self):
        total = self.total_messages
        return round(self.passed_messages / total * 100, 1) if total > 0 else 0.0


class Record(db.Model):
    __tablename__ = "records"

    id = db.Column(db.Integer, primary_key=True)
    report_id = db.Column(db.Integer, db.ForeignKey("reports.id"), nullable=False)
    source_ip = db.Column(db.String(45))
    count = db.Column(db.Integer, default=1)
    disposition = db.Column(db.String(20))
    dkim_aligned = db.Column(db.String(10))
    spf_aligned = db.Column(db.String(10))
    header_from = db.Column(db.String(255))
    envelope_from = db.Column(db.String(255))
    dkim_domain = db.Column(db.String(255))
    dkim_selector = db.Column(db.String(255))
    dkim_auth_result = db.Column(db.String(20))
    spf_domain = db.Column(db.String(255))
    spf_auth_result = db.Column(db.String(20))

    report = db.relationship("Report", back_populates="records")

    @property
    def dmarc_pass(self):
        return self.dkim_aligned == "pass" or self.spf_aligned == "pass"

    @property
    def failure_reason(self):
        if self.dmarc_pass:
            return None
        dkim_ok = self.dkim_aligned == "pass"
        spf_ok = self.spf_aligned == "pass"
        if not dkim_ok and not spf_ok:
            return "dkim_and_spf"
        if not dkim_ok:
            return "dkim_only"
        return "spf_only"
