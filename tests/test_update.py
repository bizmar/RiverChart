"""Tests for the ARSO parsers and the data store. Run: python -m unittest discover tests"""

import csv
import json
import sys
import tempfile
import unittest
from datetime import date, datetime, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import arso  # noqa: E402
import update  # noqa: E402

XML = """<?xml version="1.0" encoding="UTF-8"?>
<arsopodatki verzija="1.4">
 <vir>Agencija RS za okolje</vir>
 <postaja sifra="5078" wgs84_dolzina="14.5583" wgs84_sirina="46.0569" kota_0="279.11">
  <reka>Ljubljanica</reka><merilno_mesto>Moste I</merilno_mesto><ime_kratko>Ljubljanica - Moste I</ime_kratko>
  <datum>2026-10-06 20:00</datum>
  <vodostaj>152</vodostaj><pretok>41,3</pretok><pretok_znacilni>srednji pretok</pretok_znacilni>
  <temp_vode>14.2</temp_vode><prvi_vv_pretok>220</prvi_vv_pretok>
 </postaja>
 <postaja sifra="3570" wgs84_dolzina="14.6131" wgs84_sirina="46.0789" kota_0="261.0">
  <reka>Sava</reka><merilno_mesto>Šentjakob</merilno_mesto><ime_kratko>Sava - Šentjakob</ime_kratko>
  <datum>2026-10-06 20:00</datum><vodostaj>98</vodostaj><pretok>75.2</pretok>
 </postaja>
 <postaja sifra="1060" wgs84_dolzina="16.0003" wgs84_sirina="46.6815" kota_0="202.18">
  <reka>Mura</reka><merilno_mesto>Gornja Radgona</merilno_mesto>
  <datum>2026-10-06 20:00</datum><pretok>150</pretok>
 </postaja>
</arsopodatki>""".encode()

TABLE = """<html><body><table>
<tr><th>Datum</th><th>Vodostaj (cm)</th><th>Pretok (m<sup>3</sup>/s)</th><th>Temp. vode (&deg;C)</th></tr>
<tr><td>06.10.2026 20:00</td><td>152</td><td>41,3</td><td>14,2</td></tr>
<tr><td>06.10.2026 19:30</td><td>151</td><td>40,9</td><td>-</td></tr>
<tr><td>05.10.2026 23:30</td><td>140</td><td>35</td><td>14</td></tr>
</table></body></html>"""

ARCHIVE = "Datum;vodostaj (cm);pretok (m3/s);temp. vode (°C)\n01.01.2023;114;127.238;7.1\n02.01.2023;110;;7.0\n"


class ParserTests(unittest.TestCase):
    def test_xml(self):
        st = {s["id"]: s for s in arso.parse_latest_xml(XML)}
        self.assertEqual(set(st), {"5078", "3570", "1060"})
        m = st["5078"]
        self.assertEqual((m["river"], m["place"]), ("Ljubljanica", "Moste I"))
        self.assertEqual(m["values"], {"level": 152, "flow": 41.3, "temp": 14.2})
        self.assertEqual(m["classes"], {"flow_class": "srednji pretok"})
        self.assertEqual(m["thresholds"], {"flow": {"1": 220}})
        # 20:00 local summer time is 18:00 UTC
        self.assertEqual(m["time"], datetime(2026, 10, 6, 18, 0, tzinfo=timezone.utc))
        self.assertNotIn("level", st["1060"]["values"])

    def test_table(self):
        rows = arso.parse_station_table(TABLE)
        self.assertEqual(len(rows), 3)
        self.assertEqual(rows[0], (datetime(2026, 10, 6, 18, 0, tzinfo=timezone.utc),
                                   {"level": 152, "flow": 41.3, "temp": 14.2}))
        self.assertEqual(rows[1][1], {"level": 151, "flow": 40.9})

    def test_winter_time(self):
        self.assertEqual(arso.local_time("15.01.2026 12:00"), datetime(2026, 1, 15, 11, 0, tzinfo=timezone.utc))

    def test_archive(self):
        rows = arso.parse_archive(ARCHIVE)
        self.assertEqual(rows, [(date(2023, 1, 1), {"level": 114, "flow": 127.238, "temp": 7.1}),
                                (date(2023, 1, 2), {"level": 110, "temp": 7.0})])


EMPTY_STATION = b"""<postaja sifra="9999" wgs84_dolzina="14.0" wgs84_sirina="46.0" kota_0="1.0">
  <reka>Nikjer</reka><merilno_mesto>Brez podatkov</merilno_mesto></postaja>"""


class EndToEndTests(unittest.TestCase):
    def fake_fetch(self, url, params=None, **kw):
        if url == arso.XML_URL:
            return XML.replace(b"</arsopodatki>", EMPTY_STATION + b"</arsopodatki>")
        if "H9999_" in url:
            return b"<html><body></body></html>"
        if "_t_" in url:
            return TABLE.encode()
        if url == arso.ARCHIVE_URL:
            if params["p_postaja"] == "9999":
                return b"Datum;vodostaj (cm)\n"
            return ARCHIVE.encode() if params["p_leto"] == 2023 else b"Datum;vodostaj (cm)\n"
        raise AssertionError(url)

    def run_update(self, tmp, *extra):
        with mock.patch.object(arso, "fetch", self.fake_fetch), \
                mock.patch.object(update.time, "sleep"), \
                mock.patch.object(sys, "argv", ["update.py", "--store", tmp, *extra]):
            return update.main()

    def test_update(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(self.run_update(tmp), 0)
            self.assertEqual(self.run_update(tmp), 0)  # second run is idempotent
            root = Path(tmp)

            stations = json.loads((root / "stations.json").read_text())["stations"]
            self.assertEqual([s["id"] for s in stations][:2], ["3570", "5078"])  # nearest to home first
            tracked = {s["id"]: s["tracked"] for s in stations}
            # Every station with any data is tracked, however far from home; one without data is not.
            self.assertEqual(tracked, {"3570": True, "5078": True, "1060": True, "9999": False})

            with (root / "5078" / "live" / "2026-10.csv").open() as f:
                live = list(csv.DictReader(f))
            self.assertEqual([r["time"] for r in live], ["2026-10-05T21:30Z", "2026-10-06T17:30Z", "2026-10-06T18:00Z"])

            with (root / "5078" / "daily.csv").open() as f:
                daily = {r["date"]: r for r in csv.DictReader(f)}
            self.assertEqual(daily["2023-01-01"]["src"], "a")
            self.assertEqual(daily["2026-10-06"]["level"], "151.5")
            self.assertEqual(daily["2026-10-05"]["level"], "140")

            meta = json.loads((root / "5078" / "meta.json").read_text())
            self.assertEqual(meta["live_months"], ["2026-10"])
            self.assertEqual(meta["archive_to"], "2023-01-02")
            self.assertTrue(meta["archive_done"])
            self.assertTrue(json.loads((root / "9999" / "meta.json").read_text())["archive_done"])

    def test_time_budget(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            # No time for the long daily archive: stations still get their live data right away.
            self.assertEqual(self.run_update(tmp, "--budget", "0"), 0)
            meta = json.loads((root / "5078" / "meta.json").read_text())
            self.assertFalse(meta["archive_done"])
            self.assertIsNone(meta["archive_to"])
            self.assertTrue({s["id"]: s["tracked"] for s in json.loads((root / "stations.json").read_text())["stations"]}["5078"])
            # The next run with time left picks the archive up.
            self.assertEqual(self.run_update(tmp), 0)
            meta = json.loads((root / "5078" / "meta.json").read_text())
            self.assertTrue(meta["archive_done"])
            self.assertEqual(meta["archive_to"], "2023-01-02")


class ThinningTests(unittest.TestCase):
    def test_thin(self):
        now = datetime(2026, 10, 20, 12, 0, tzinfo=timezone.utc)
        with tempfile.TemporaryDirectory() as tmp:
            store = update.StationStore(Path(tmp), "1")

            def tenmin(day, hours=(0, 1)):
                return [(datetime(2026, 10, day, h, m, tzinfo=timezone.utc), {"level": float(h * 60 + m)})
                        for h in hours for m in range(0, 60, 10)]

            store.add_live(tenmin(5) + tenmin(19))  # 15 days old, and yesterday
            store.add_live([(datetime(2026, 10, 6, 3, 30, tzinfo=timezone.utc), {"level": 1.0})])  # an hourly station at :30
            store.thin(now)
            keys = sorted(store.month("2026-10"))
            # Old days keep one reading per hour (the one nearest the full hour); recent days are untouched.
            self.assertEqual([k for k in keys if k.startswith("2026-10-05")], ["2026-10-05T00:00Z", "2026-10-05T01:00Z"])
            self.assertEqual(len([k for k in keys if k.startswith("2026-10-19")]), 12)
            self.assertIn("2026-10-06T03:30Z", keys)  # a lone reading is never dropped
            store.save({"river": "r", "place": "p"}, archive_done=True)
            with (Path(tmp) / "1" / "live" / "2026-10.csv").open() as f:
                self.assertEqual(next(csv.DictReader(f))["time"], "2026-10-05T00:00Z")


if __name__ == "__main__":
    unittest.main()
