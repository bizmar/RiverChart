"""Tests for the phone alerts. Run: python -m unittest discover tests"""

import io
import json
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import alerts  # noqa: E402

NOW = datetime(2026, 11, 6, 12, 0, tzinfo=timezone.utc)
WEBHOOK = "https://push.getnotifyapp.com/notify/ABC12345?token=secret123"


def write_store(root: Path, level: float, rise: float = 0, gw_cm: float = -1448, flow_class="običajni pretok", age_h=0.5):
    """A store with the Ljubljanica at `level` cm, `rise` cm higher than 6 h ago."""
    t = NOW - timedelta(hours=age_h)
    iso = lambda x: x.strftime("%Y-%m-%dT%H:%MZ")  # noqa: E731
    (root / "5078" / "live").mkdir(parents=True, exist_ok=True)
    rows = [f"{iso(t - timedelta(hours=h))},{level - rise * h / 6:.0f},50,12" for h in range(12, -1, -1)]
    (root / "5078" / "live" / "2026-11.csv").write_text("time,level,flow,temp\n" + "\n".join(rows) + "\n")
    (root / "G85040" / "live").mkdir(parents=True, exist_ok=True)
    gw = [f"{iso(t - timedelta(hours=h))},{gw_cm:.0f},," for h in range(80, -1, -1)]
    (root / "G85040" / "live" / "2026-11.csv").write_text("time,level,flow,temp\n" + "\n".join(gw) + "\n")
    (root / "stations.json").write_text(json.dumps({
        "groundwater": {"id": "G85040", "datum": 287.40, "level": round(287.40 + gw_cm / 100, 2)},
        "stations": [
            {"id": "5078", "river": "Ljubljanica", "place": "Moste I", "time": iso(t), "level": level, "flow": 50.0,
             "flow_class": flow_class, "thresholds": {"flow": {"1": 230.0}}},
            {"id": "3570", "river": "Sava", "place": "Šentjakob", "time": iso(t), "level": 390.0, "flow": 208.0},
        ],
    }))


class FakeGateway:
    """Stands in for push.getnotifyapp.com and records every call."""

    def __init__(self):
        self.calls, self.fail_notify, self.gone = [], False, set()

    def __call__(self, req, timeout=None):
        u = urlparse(req.full_url)
        body = json.loads(req.data) if req.data else None
        self.calls.append((u.path, parse_qs(u.query), body))
        assert parse_qs(u.query)["token"] == ["secret123"]
        if u.path.startswith("/notify-json/") and self.fail_notify:
            raise HTTPError(req.full_url, 502, "Bad Gateway", {}, io.BytesIO(b'{"error":"down"}'))
        if u.path.rsplit("/", 1)[-1] in self.gone:
            raise HTTPError(req.full_url, 404, "Not Found", {}, io.BytesIO(b'{"error":"not found"}'))
        resp = {"success": True}
        if u.path.endswith("/ABC12345"):  # a create
            kind = u.path.split("/")[1]
            resp.update({"widgets": {"widgetId": "WG000001"}, "screenwidgets": {"screenWidgetId": "SW000001"},
                         "live-activity": {"activityId": "LA000001", "expiresAt": "2026-11-06T20:00:00.000Z"}}.get(kind, {}))
        r = mock.MagicMock()
        r.__enter__.return_value = r
        r.status, r.read.return_value = 200, json.dumps(resp).encode()
        return r

    def sent(self):
        return [b["title"] for p, q, b in self.calls if p.startswith("/notify-json/")]

    def paths(self, prefix):
        return [(p, q.get("new"), b) for p, q, b in self.calls if p.startswith(prefix)]


class AlertTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.gw = FakeGateway()
        patcher = mock.patch.object(alerts, "urlopen", self.gw)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.tmp.cleanup)

    def run_at(self, **store):
        write_store(self.root, **store)
        self.gw.calls.clear()
        return alerts.run(self.root, alerts.Notify(WEBHOOK, lambda *a: None), None, lambda *a: None, now=NOW)

    def test_quiet_day_only_refreshes_widgets(self):
        state = self.run_at(level=120)
        self.assertEqual(self.gw.sent(), [])
        self.assertEqual(state["level"], "normal")
        self.assertEqual(state["ids"], {"widget": "WG000001", "screen": "SW000001"})
        self.assertEqual(self.gw.paths("/live-activity"), [])
        self.run_at(level=121)  # next run updates the same widgets instead of creating new ones
        self.assertEqual([p for p, _, _ in self.gw.paths("/")], ["/widgets/WG000001", "/screenwidgets/SW000001"])

    def test_warning_once_then_all_clear_with_hysteresis(self):
        self.run_at(level=150)
        state = self.run_at(level=210, rise=20)
        self.assertEqual(self.gw.sent(), ["Ljubljanica high"])
        msg = next(b for p, _, b in self.gw.calls if p.startswith("/notify-json/"))
        self.assertTrue(msg["timeSensitive"])
        self.assertEqual(state["ids"]["activity"], "LA000001")
        live = self.gw.paths("/live-activity")
        self.assertEqual(live[0][0], "/live-activity/ABC12345")
        self.assertEqual(live[0][2]["title"], "Ljubljanica 210 cm")

        self.run_at(level=215)  # still high: no new message, the tile is updated in place
        self.assertEqual(self.gw.sent(), [])
        self.assertEqual(self.gw.paths("/live-activity")[0][0], "/live-activity/LA000001")
        self.run_at(level=190)  # below 200 but above 180: still on
        self.assertEqual(self.gw.sent(), [])
        state = self.run_at(level=175)
        self.assertEqual(self.gw.sent(), ["All clear"])
        end = self.gw.paths("/live-activity")[0]
        self.assertTrue(end[2]["end"])
        self.assertNotIn("activity", state["ids"])

    def test_flood_stage_is_urgent(self):
        state = self.run_at(level=260, flow_class="prvi visokovodni pretok")
        self.assertEqual(self.gw.sent(), ["Flood stage"])
        self.assertEqual(state["level"], "urgent")

    def test_fast_rise_and_groundwater_are_heads_ups(self):
        self.run_at(level=100)
        state = self.run_at(level=150, rise=45)
        self.assertEqual(self.gw.sent(), ["Ljubljanica rising fast"])
        self.assertEqual(state["level"], "heads-up")
        self.assertEqual(self.gw.paths("/live-activity"), [])  # no tile for a heads-up

    def test_failed_notification_is_retried(self):
        self.run_at(level=150)
        self.gw.fail_notify = True
        self.run_at(level=210)
        self.gw.fail_notify = False
        self.run_at(level=212)
        self.assertEqual(self.gw.sent(), ["Ljubljanica high"])

    def test_missing_widget_is_recreated(self):
        self.run_at(level=120)
        self.gw.gone.add("WG000001")
        self.run_at(level=120)
        self.assertEqual([(p, n) for p, n, _ in self.gw.paths("/widgets")], [("/widgets/WG000001", None), ("/widgets/ABC12345", ["1"])])

    def test_stale_data(self):
        self.run_at(level=120)
        self.run_at(level=120, age_h=7)
        self.assertEqual(self.gw.sent(), ["No new river data"])
        self.run_at(level=120)
        self.assertEqual(self.gw.sent(), ["River data is back"])

    def test_bad_webhook_address(self):
        with self.assertRaises(ValueError):
            alerts.Notify("https://push.getnotifyapp.com/notify/ABC12345", print)

    def test_without_notify_url_nothing_is_sent(self):
        write_store(self.root, level=250)
        state = alerts.run(self.root, None, None, lambda *a: None, now=NOW)
        self.assertEqual(self.gw.calls, [])
        self.assertTrue(state["active"]["high"])


if __name__ == "__main__":
    unittest.main()
