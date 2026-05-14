from datetime import datetime, timedelta
from collections import defaultdict

from flask import Blueprint, jsonify, render_template, request, current_app
from sqlalchemy import func

from dmarc_dashboard import db
from dmarc_dashboard.models import Report, Record

bp = Blueprint("main", __name__)


@bp.route("/")
def dashboard():
    return render_template("dashboard.html")


@bp.route("/reports")
def reports():
    page = request.args.get("page", 1, type=int)
    domain = request.args.get("domain", "")
    query = Report.query.order_by(Report.end_date.desc())
    if domain:
        query = query.filter(Report.domain.ilike(f"%{domain}%"))
    pagination = query.paginate(page=page, per_page=25, error_out=False)
    domains = [r[0] for r in db.session.query(Report.domain).distinct().all()]
    return render_template("reports.html", pagination=pagination, domains=domains, selected_domain=domain)


@bp.route("/reports/<int:report_id>")
def report_detail(report_id):
    report = Report.query.get_or_404(report_id)
    return render_template("report_detail.html", report=report)


@bp.route("/fetch", methods=["POST"])
def manual_fetch():
    cfg = current_app.config
    if not cfg.get("CLIENT_ID"):
        return jsonify({"error": "Graph API not configured"}), 400
    try:
        from dmarc_dashboard.fetcher import fetch_and_store
        count = fetch_and_store(cfg)
        return jsonify({"stored": count})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@bp.route("/api/stats")
def api_stats():
    days = request.args.get("days", 30, type=int)
    since = datetime.utcnow() - timedelta(days=days)

    records = (
        db.session.query(Record)
        .join(Report)
        .filter(Report.end_date >= since)
        .all()
    )

    total = sum(r.count for r in records)
    passed = sum(r.count for r in records if r.dmarc_pass)
    failed = total - passed

    # Daily trend
    daily: dict = defaultdict(lambda: {"pass": 0, "fail": 0})
    for rec in records:
        date_key = rec.report.end_date.strftime("%Y-%m-%d") if rec.report.end_date else "unknown"
        if rec.dmarc_pass:
            daily[date_key]["pass"] += rec.count
        else:
            daily[date_key]["fail"] += rec.count

    sorted_days = sorted(daily.items())
    daily_trend = [{"date": d, **v} for d, v in sorted_days]

    # Failure reasons
    failure_reasons = {"dkim_and_spf": 0, "dkim_only": 0, "spf_only": 0}
    for rec in records:
        if not rec.dmarc_pass and rec.failure_reason:
            failure_reasons[rec.failure_reason] = (
                failure_reasons.get(rec.failure_reason, 0) + rec.count
            )

    # Top source IPs
    ip_stats: dict = defaultdict(lambda: {"pass": 0, "fail": 0})
    for rec in records:
        ip = rec.source_ip or "unknown"
        if rec.dmarc_pass:
            ip_stats[ip]["pass"] += rec.count
        else:
            ip_stats[ip]["fail"] += rec.count

    top_sources = sorted(
        [{"ip": ip, **v, "total": v["pass"] + v["fail"]} for ip, v in ip_stats.items()],
        key=lambda x: x["total"],
        reverse=True,
    )[:15]

    # Top reporting organisations
    org_stats: dict = defaultdict(lambda: {"pass": 0, "fail": 0})
    for rec in records:
        org = rec.report.org_name or "Unknown"
        if rec.dmarc_pass:
            org_stats[org]["pass"] += rec.count
        else:
            org_stats[org]["fail"] += rec.count

    top_orgs = sorted(
        [{"org": o, **v, "total": v["pass"] + v["fail"]} for o, v in org_stats.items()],
        key=lambda x: x["total"],
        reverse=True,
    )[:10]

    return jsonify(
        {
            "summary": {
                "total_reports": Report.query.filter(Report.end_date >= since).count(),
                "total_messages": total,
                "pass_count": passed,
                "fail_count": failed,
                "pass_rate": round(passed / total * 100, 1) if total > 0 else 0,
                "unique_ips": len(ip_stats),
            },
            "daily_trend": daily_trend,
            "failure_reasons": failure_reasons,
            "top_sources": top_sources,
            "top_orgs": top_orgs,
        }
    )
