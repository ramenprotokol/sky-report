"""Independent reference values for tests/unit/solar.test.ts.

Computes the Sun's apparent (airless: no refraction) altitude and azimuth with astropy,
which uses the IAU SOFA routines and JPL-quality ephemerides; this is a completely
different method from the NOAA/Meeus equations in src/sun/solar.ts.

Run:  uv run --with astropy tools/sun-reference.py
The printed JSON is pasted into the test file.
"""
import json

from astropy import units as u
from astropy.coordinates import AltAz, EarthLocation, get_sun
from astropy.time import Time

CASES = [
    # label, UTC time, lat, lon (east +)
    ("EGLL sunrise-ish", "2026-09-26T06:50:00", 51.477, -0.461),
    ("KSFO night", "2026-09-26T05:56:00", 37.6196, -122.3656),
    ("RJTT afternoon", "2026-09-26T06:30:00", 35.553, 139.781),
    ("WSSS near noon", "2026-09-26T04:30:00", 1.368, 103.982),
    ("YSSY late afternoon", "2026-09-26T06:53:00", -33.946, 151.173),
    ("NZAA dusk", "2026-09-26T06:30:00", -37.008, 174.792),
    ("KDEN night", "2026-09-26T06:53:00", 39.8466, -104.6562),
    ("BIKF summer midnight", "2026-06-21T00:00:00", 63.987, -22.614),
    ("PANC winter noon", "2026-12-21T21:40:00", 61.1691, -150.0277),
    ("FAOR equinox morning", "2026-03-20T06:00:00", -26.139, 28.246),
    ("EGLL 2000 J2000 epoch", "2000-01-01T12:00:00", 51.477, -0.461),
    ("SCEL 2031 winter", "2031-07-15T15:00:00", -33.393, -70.786),
]

out = []
for label, iso, lat, lon in CASES:
    t = Time(iso, scale="utc")
    loc = EarthLocation(lat=lat * u.deg, lon=lon * u.deg, height=0 * u.m)
    aa = get_sun(t).transform_to(AltAz(obstime=t, location=loc, pressure=0 * u.hPa))
    out.append({"label": label, "iso": iso + "Z", "lat": lat, "lon": lon,
                "alt": round(aa.alt.deg, 4), "az": round(aa.az.deg, 4)})
print(json.dumps(out, indent=2))
