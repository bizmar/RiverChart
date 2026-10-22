"""Read JP VOKA SNAGA's groundwater-level records for Ljubljansko polje, published on Zenodo.

Dataset: "Groundwater-Level Monitoring Data from the Ljubljansko Barje and Ljubljansko Polje
Piezometer Networks, Slovenia (2015-2026)", https://zenodo.org/records/21789430 (CC BY 4.0).
It is one zip of Excel workbooks, one per piezometer, with a daily groundwater level in metres
above sea level. It is a fixed release (no live updates), so it is imported once.

Standard library only: an .xlsx file is a zip of XML parts, and these workbooks are simple tables.
"""

from __future__ import annotations

import io
import re
import xml.etree.ElementTree as ET
import zipfile
from datetime import date

import arso

ZIP_URL = "https://zenodo.org/api/records/21789430/files/data.zip/content"
NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}


def read_xlsx_rows(data: bytes) -> list[list[str]]:
    """Every row of the first worksheet as cell texts (column gaps kept as "")."""
    z = zipfile.ZipFile(io.BytesIO(data))
    shared = []
    if "xl/sharedStrings.xml" in z.namelist():
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", NS):
            shared.append("".join(t.text or "" for t in si.iter(f"{{{NS['m']}}}t")))
    sheet = sorted(n for n in z.namelist() if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", n))[0]
    rows = []
    for row in ET.fromstring(z.read(sheet)).iter(f"{{{NS['m']}}}row"):
        cells: dict[int, str] = {}
        for c in row.findall("m:c", NS):
            col = 0
            for ch in re.match(r"[A-Z]+", c.get("r", "A")).group(0):
                col = col * 26 + ord(ch) - 64
            kind, v = c.get("t"), c.find("m:v", NS)
            if kind == "s" and v is not None:
                cells[col - 1] = shared[int(v.text)]
            elif kind == "inlineStr":
                cells[col - 1] = "".join(t.text or "" for t in c.iter(f"{{{NS['m']}}}t"))
            elif v is not None:
                cells[col - 1] = v.text or ""
        if cells:
            rows.append([cells.get(i, "") for i in range(max(cells) + 1)])
    return rows


def parse_levels(rows: list[list[str]]) -> list[tuple[date, float]]:
    """(day, groundwater level in m a.s.l.) from a workbook with columns date, measured data, groundwater level, ..."""
    out = []
    for r in rows[1:]:
        d = arso.local_date(r[0].split(" ")[0]) if r else None
        v = arso.number(r[2]) if len(r) > 2 else None
        if d and v is not None:
            out.append((d, round(v, 2)))
    return out


def fetch_well(member: str) -> list[tuple[date, float]]:
    """Download the dataset and return one piezometer's daily levels (member = path inside the zip)."""
    z = zipfile.ZipFile(io.BytesIO(arso.fetch(ZIP_URL, timeout=300)))
    return parse_levels(read_xlsx_rows(z.read(member)))
