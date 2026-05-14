import base64
import gzip
import io
import zipfile
from typing import List, Optional

import msal
import requests


class GraphClient:
    GRAPH_URL = "https://graph.microsoft.com/v1.0"

    def __init__(self, tenant_id: str, client_id: str, client_secret: str):
        self._app = msal.ConfidentialClientApplication(
            client_id,
            authority=f"https://login.microsoftonline.com/{tenant_id}",
            client_credential=client_secret,
        )

    def _token(self) -> str:
        result = self._app.acquire_token_silent(
            ["https://graph.microsoft.com/.default"], account=None
        )
        if not result:
            result = self._app.acquire_token_for_client(
                scopes=["https://graph.microsoft.com/.default"]
            )
        if "access_token" not in result:
            raise RuntimeError(
                f"Token acquisition failed: {result.get('error_description', result.get('error'))}"
            )
        return result["access_token"]

    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self._token()}"}

    def get_dmarc_messages(
        self, mailbox: str, folder: str = "Inbox", limit: int = 100
    ) -> List[dict]:
        """Return emails that are likely DMARC aggregate reports."""
        url = f"{self.GRAPH_URL}/users/{mailbox}/mailFolders/{folder}/messages"
        params = {
            "$top": limit,
            "$select": "id,subject,receivedDateTime,from,hasAttachments",
            "$filter": "hasAttachments eq true",
            "$orderby": "receivedDateTime desc",
        }
        resp = requests.get(url, headers=self._headers(), params=params, timeout=30)
        resp.raise_for_status()

        messages = resp.json().get("value", [])
        return [
            m
            for m in messages
            if _is_dmarc_subject(m.get("subject", ""))
        ]

    def get_xml_attachments(self, mailbox: str, message_id: str) -> List[bytes]:
        """Download and decompress all XML DMARC report attachments from a message."""
        url = f"{self.GRAPH_URL}/users/{mailbox}/messages/{message_id}/attachments"
        resp = requests.get(url, headers=self._headers(), timeout=30)
        resp.raise_for_status()

        xml_payloads: List[bytes] = []
        for att in resp.json().get("value", []):
            name: str = att.get("name", "").lower()
            raw = base64.b64decode(att.get("contentBytes", ""))
            if name.endswith(".xml"):
                xml_payloads.append(raw)
            elif name.endswith(".gz"):
                xml_payloads.append(gzip.decompress(raw))
            elif name.endswith(".zip"):
                with zipfile.ZipFile(io.BytesIO(raw)) as zf:
                    for zname in zf.namelist():
                        if zname.lower().endswith(".xml"):
                            xml_payloads.append(zf.read(zname))
        return xml_payloads


def _is_dmarc_subject(subject: str) -> bool:
    subject_lower = subject.lower()
    keywords = ["dmarc", "report domain:", "aggregate report"]
    return any(kw in subject_lower for kw in keywords)
