"""Parse DMARC aggregate report XML (RFC 7489) into dict structures."""
import xml.etree.ElementTree as ET
from datetime import datetime
from typing import Any, Dict, List, Optional


def parse_report(xml_bytes: bytes) -> Optional[Dict[str, Any]]:
    """Parse raw XML bytes and return a report dict, or None on failure."""
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError:
        return None

    metadata = root.find("report_metadata")
    policy = root.find("policy_published")
    if metadata is None or policy is None:
        return None

    begin_ts = _int(metadata, "date_range/begin")
    end_ts = _int(metadata, "date_range/end")

    report = {
        "report_id": _text(metadata, "report_id") or "",
        "org_name": _text(metadata, "org_name") or "",
        "org_email": _text(metadata, "email") or "",
        "domain": _text(policy, "domain") or "",
        "begin_date": datetime.utcfromtimestamp(begin_ts) if begin_ts else None,
        "end_date": datetime.utcfromtimestamp(end_ts) if end_ts else None,
        "policy_p": _text(policy, "p") or "none",
        "policy_sp": _text(policy, "sp") or "",
        "policy_pct": _int(policy, "pct") or 100,
        "adkim": _text(policy, "adkim") or "r",
        "aspf": _text(policy, "aspf") or "r",
        "records": [],
    }

    for rec_el in root.findall("record"):
        report["records"].append(_parse_record(rec_el))

    return report


def _parse_record(rec_el: ET.Element) -> Dict[str, Any]:
    row = rec_el.find("row")
    identifiers = rec_el.find("identifiers")
    auth = rec_el.find("auth_results")

    policy_eval = row.find("policy_evaluated") if row is not None else None

    dkim_auth = auth.find("dkim") if auth is not None else None
    spf_auth = auth.find("spf") if auth is not None else None

    return {
        "source_ip": _text(row, "source_ip") if row is not None else None,
        "count": _int(row, "count") or 1,
        "disposition": _text(policy_eval, "disposition") if policy_eval is not None else "none",
        "dkim_aligned": _text(policy_eval, "dkim") if policy_eval is not None else "fail",
        "spf_aligned": _text(policy_eval, "spf") if policy_eval is not None else "fail",
        "header_from": _text(identifiers, "header_from") if identifiers is not None else None,
        "envelope_from": _text(identifiers, "envelope_from") if identifiers is not None else None,
        "dkim_domain": _text(dkim_auth, "domain") if dkim_auth is not None else None,
        "dkim_selector": _text(dkim_auth, "selector") if dkim_auth is not None else None,
        "dkim_auth_result": _text(dkim_auth, "result") if dkim_auth is not None else None,
        "spf_domain": _text(spf_auth, "domain") if spf_auth is not None else None,
        "spf_auth_result": _text(spf_auth, "result") if spf_auth is not None else None,
    }


def _text(el: Optional[ET.Element], path: str) -> Optional[str]:
    if el is None:
        return None
    found = el.find(path)
    return found.text.strip() if found is not None and found.text else None


def _int(el: Optional[ET.Element], path: str) -> Optional[int]:
    val = _text(el, path)
    try:
        return int(val) if val is not None else None
    except ValueError:
        return None
