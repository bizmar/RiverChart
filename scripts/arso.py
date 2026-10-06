"""Download and parse hydrological data published by ARSO (Slovenian Environment Agency).

Three sources are used:

* ``hidro_podatki_zadnji.xml`` - the latest reading of every automatic station,
  with coordinates. Used as the station catalogue.
* ``H<id>_t_<days>.html`` - a table of half-hourly readings for the last 1 or
  30 days (the same data behind the static graph on the ARSO station pages).
* ``hidarhiv/pov_arhiv_tab.php`` - the validated daily archive, one year per
  request, going back decades.

Everything here uses the Python standard library only.
"""

from __future__ import annotations

import re
import time
import xml.etree.ElementTree as ET
from datetime import date, datetime, timezone
from html.parser import HTMLParser
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

XML_URL = "https://www.arso.gov.si/xml/vode/hidro_podatki_zadnji.xml"
TABLE_URL = "https://www.arso.gov.si/vode/podatki/amp/H{id}_t_{days}.html"
ARCHIVE_URL = "https://vode.arso.gov.si/hidarhiv/pov_arhiv_tab.php"
USER_AGENT = "RiverChart/1.0 (river level dashboard; +https://github.com/bizmar/RiverChart)"

# ARSO publishes times as local Slovenian wall-clock time.
LOCAL_TZ = ZoneInfo("Europe/Ljubljana")

FIELDS = ("level", "flow", "temp")


# --------------------------------------------------------------------------- fetching

def fetch(url: str, params: dict | None = None, retries: int = 3, timeout: int = 40) -> bytes:
    if params:
        url = f"{url}?{urlencode(params)}"
    last_error: Exception | None = None
    for attempt in range(retries):
        try:
            with urlopen(Request(url, headers={"User-Agent": USER_AGENT}), timeout=timeout) as resp:
                return resp.read()
        except HTTPError as e:
            if e.code == 404:
                raise
            last_error = e
        except (URLError, TimeoutError, ConnectionError) as e:
            last_error = e
        time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"Could not fetch {url}: {last_error}")


def decode(raw: bytes) -> str:
    for enc in ("utf-8", "cp1250"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            pass
    return raw.decode("latin-1")


# --------------------------------------------------------------------------- value helpers

def number(text: str | None) -> float | None:
    if text is None:
        return None
    text = text.strip().replace("\xa0", "").replace(" ", "").replace(",", ".")
    if not text or text in {"-", "--", "/", "n/a"}:
        return None
    try:
        return float(text)
    except ValueError:
        return None


_TIME_FORMATS = (
    "%Y-%m-%d %H:%M",
    "%Y-%m-%d %H:%M:%S",
    "%d.%m.%Y %H:%M",
    "%d.%m.%Y %H:%M:%S",
    "%d. %m. %Y %H:%M",
)


def local_time(text: str) -> datetime | None:
    """Parse an ARSO local timestamp and return it as an aware UTC datetime."""
    text = re.sub(r"\s+", " ", text.strip())
    for fmt in _TIME_FORMATS:
        try:
            naive = datetime.strptime(text, fmt)
        except ValueError:
            continue
        return naive.replace(tzinfo=LOCAL_TZ).astimezone(timezone.utc)
    return None


def local_date(text: str) -> date | None:
    text = text.strip()
    for fmt in ("%d.%m.%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(text, fmt).date()
        except ValueError:
            pass
    return None


def column_field(header: str) -> str | None:
    h = header.lower()
    if "vodostaj" in h or "water level" in h:
        return "level"
    if "pretok" in h or "discharge" in h:
        return "flow"
    if "temp" in h:
        return "temp"
    return None


# --------------------------------------------------------------------------- latest XML

_CLASS_FIELDS = {"vodostaj_znacilni": "level_class", "pretok_znacilni": "flow_class"}
_VALUE_FIELDS = {"vodostaj": "level", "pretok": "flow", "temp_vode": "temp"}


def parse_latest_xml(raw: bytes) -> list[dict]:
    """Parse hidro_podatki_zadnji.xml into a list of station dicts."""
    root = ET.fromstring(raw)
    stations = []
    for el in root.iter("postaja"):
        a = el.attrib
        children = {c.tag: (c.text or "").strip() for c in el}
        lat = number(a.get("wgs84_sirina") or a.get("ge_sirina"))
        lon = number(a.get("wgs84_dolzina") or a.get("ge_dolzina"))
        st = {
            "id": a.get("sifra", "").strip(),
            "river": children.get("reka", ""),
            "place": children.get("merilno_mesto", ""),
            "name": children.get("ime_kratko", ""),
            "lat": lat,
            "lon": lon,
            "datum_zero": number(a.get("kota_0")),
            "time": None,
            "values": {},
            "classes": {},
            "thresholds": {},
        }
        t = local_time(children.get("datum", ""))
        st["time"] = t
        for tag, key in _VALUE_FIELDS.items():
            v = number(children.get(tag))
            if v is not None:
                st["values"][key] = v
        for tag, key in _CLASS_FIELDS.items():
            if children.get(tag):
                st["classes"][key] = children[tag]
        # Flood thresholds, e.g. prvi_vv_pretok / drugi_vv_vodostaj (first/second/third flood stage).
        for tag, text in children.items():
            m = re.fullmatch(r"(prvi|drugi|tretji)_vv_(vodostaj|pretok)", tag)
            if m and number(text) is not None:
                stage = {"prvi": 1, "drugi": 2, "tretji": 3}[m.group(1)]
                field = "level" if m.group(2) == "vodostaj" else "flow"
                st["thresholds"].setdefault(field, {})[str(stage)] = number(text)
        if st["id"]:
            stations.append(st)
    return stations


# --------------------------------------------------------------------------- station tables

class _TableParser(HTMLParser):
    """Collect the text of every table row as a list of cell strings."""

    def __init__(self):
        super().__init__()
        self.rows: list[list[str]] = []
        self._row: list[str] | None = None
        self._cell: list[str] | None = None

    def handle_starttag(self, tag, attrs):
        if tag == "tr":
            self._row = []
        elif tag in ("td", "th") and self._row is not None:
            self._cell = []
        elif tag == "br" and self._cell is not None:
            self._cell.append(" ")

    def handle_endtag(self, tag):
        if tag in ("td", "th") and self._row is not None and self._cell is not None:
            self._row.append(re.sub(r"\s+", " ", "".join(self._cell)).strip())
            self._cell = None
        elif tag == "tr" and self._row is not None:
            if self._row:
                self.rows.append(self._row)
            self._row = None

    def handle_data(self, data):
        if self._cell is not None:
            self._cell.append(data)


def table_rows(html: str) -> list[list[str]]:
    p = _TableParser()
    p.feed(html)
    return p.rows


def parse_station_table(html: str) -> list[tuple[datetime, dict]]:
    """Parse an H<id>_t_<days>.html page into (utc_time, {level, flow, temp}) tuples."""
    columns: dict[int, str] | None = None
    out = []
    for row in table_rows(html):
        t = local_time(row[0])
        if t is None:
            # Not a data row - remember it as the header if it names our quantities.
            header = {i: f for i, c in enumerate(row) if (f := column_field(c))}
            if header:
                columns = header
            continue
        if columns is None:
            continue
        values = {}
        for i, field in columns.items():
            if i < len(row):
                v = number(row[i])
                if v is not None:
                    values[field] = v
        if values:
            out.append((t, values))
    return out


def fetch_station_table(station_id: str, days: int) -> list[tuple[datetime, dict]]:
    html = decode(fetch(TABLE_URL.format(id=station_id, days=days)))
    return parse_station_table(html)


# --------------------------------------------------------------------------- daily archive

def parse_archive(text: str) -> list[tuple[date, dict]]:
    """Parse the semicolon separated text export of the ARSO daily archive.

    Example::

        Datum;vodostaj (cm);pretok (m3/s);temp. vode (°C)
        01.01.2012;114;127.238;7.1
    """
    columns: dict[int, str] | None = None
    out = []
    for line in text.splitlines():
        cells = [c.strip() for c in line.split(";")]
        if len(cells) < 2:
            continue
        if cells[0].lower().startswith("datum"):
            columns = {i: f for i, c in enumerate(cells) if (f := column_field(c))}
            continue
        if columns is None:
            continue
        d = local_date(cells[0])
        if d is None:
            continue
        values = {}
        for i, field in columns.items():
            if i < len(cells):
                v = number(cells[i])
                if v is not None:
                    values[field] = v
        if values:
            out.append((d, values))
    return out


def fetch_archive_year(river: str, station_id: str, year: int) -> list[tuple[date, dict]]:
    params = {
        "p_vodotok": river,
        "p_postaja": station_id,
        "p_leto": year,
        "b_arhiv": "Prikaži",
        "p_export": "txt",
    }
    return parse_archive(decode(fetch(ARCHIVE_URL, params)))
