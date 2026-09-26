# sky-report

**Type an airport code; see the real current sky, ray-marched from the live weather report.**

![The sky over Hong Kong International, drawn from a recorded METAR, with the FEW020 group highlighted](docs/screenshot.png)

sky-report takes a METAR, the standard weather report every airport publishes about twice an hour, and draws the sky it describes. The cloud layers sit at the reported heights and amounts, the haze comes from the reported visibility, the clouds drift with the reported wind, and the sun sits where it really was for that airport at the time of the observation. The raw report stays at the bottom of the screen like a cockpit readout. Point at any group in it and it tells you what the group means and lights up what it drives in the picture.

It is an honest approximation, not a photograph. The page says which parts are data and which are style.

## The 30-second experience

1. Open the page. It shows a recorded sample straight away, then swaps in the live report for the last airport you looked at (Heathrow the first time).
2. Start typing an ICAO code (`KSFO`, `RJTT`, `YSSY` …) anywhere, or tap the sky on a phone. A minimal bar appears. Press Enter.
3. The sky redraws from that airport's latest METAR. The label in the top-left corner, set like an aeronautical chart label, gives the station, its position and elevation, the observation time, and where the sun is.
4. Hover over or tab to a group such as `BKN025` or `27015KT`. A one-line meaning appears ("broken cloud at 2,500 ft above the airport, 5–7 eighths of the sky — drawn as cloud layer 1"), and that layer, the haze or the wind is highlighted in amber in the sky.
5. "How this is drawn" lists, for the current report, every visible element and the group or calculation behind it.

You can also paste a whole METAR into the bar. Twelve recorded reports (from 26 Sep 2026) are bundled, so the page works offline and without the Worker. They are always labelled RECORDED SAMPLE, never LIVE.

## What is data and what is drawn

| In the sky | Comes from | How |
| --- | --- | --- |
| Cloud layers | `FEW/SCT/BKN/OVC` + base, e.g. `BKN025` | Coverage = the middle of each okta range (1.5, 3.5, 6, 8 eighths). The base is the reported height above the airport. Up to four layers are drawn. |
| Cloud style and thickness | height of the base, `CB`/`TCU` | **Style choice.** A METAR does not give thickness or shape. Low FEW/SCT are drawn as heaped cells, low BKN/OVC as a flatter deck, mid-level as a thin layer, high as streaks along the wind, and CB/TCU as tall towers. |
| Haze and fog | visibility (`9999`, `4500`, `1/2SM`, `CAVOK`), `BR`/`HZ`/`FG`/`FU`/…, `VV` | Koschmieder: extinction β = 3.912 ÷ visibility, fading exponentially with height. "10 km or more" style reports are drawn for 3× the floor (30 km). `VV` makes the fog deep enough to hide the sky. Haze and smoke get a warmer tint. |
| Cloud drift | wind (`27015G25KT`, `VRB03KT`, `240V300`, MPS/KMH) | Clouds move toward where the wind blows, at the reported surface speed, in real time. Gusts make the speed pulse. `VRB` uses the middle of a reported sector, or an arbitrary westerly, and says so. |
| Sun | station position + observation time | NOAA's solar position equations (after Meeus). The station position comes from the same upstream API. If the position is unknown, the light is a neutral daylight and no sun disc is drawn. |
| Rain / snow streaks | `-RA`, `+SHRA`, `DZ`, `SN`, … | Intensity from `-`/none/`+`. Vicinity (`VC`) weather is described but not drawn. |
| Stars, ground, view direction, night glow | nothing | **Style choices**, listed on the page: stars are decorative (not a star map), the ground is a plain dark plane seen from about 25 m up, the view faces a low sun or turns away from a high one, and at night low cloud gets a faint warm glow standing in for airport lights. |

Temperature, pressure, runway visual range, trends (`TEMPO`, `BECMG`, `NOSIG`) and remarks (`RMK`) are decoded and explained, but they do not change the picture.

## Why GLSL

The product is a fragment shader (`src/shaders/sky.frag`, WebGL2 / GLSL ES 3.00). For every pixel it:

- integrates **single scattering through a spherical atmosphere** (Rayleigh, Mie and ozone), with a Chapman-style airmass so twilight and the Earth's shadow behave;
- **ray-marches each cloud layer as a volume**, using coarse steps through empty air and fine steps once it touches cloud. At each sample it marches toward the sun for self-shadowing, then applies a two-lobe Henyey–Greenstein phase function, a three-octave multiple-scattering approximation, "powder" darkening, and sky and ground ambient light. Layers above shade the layers below. Clouds stay lit after ground sunset if the sun is still above *their* horizon;
- applies **height-exponential haze** from the visibility, lit by the sun through a forward-scattering phase function;
- adds **stars, the sun disc** (its real 0.53° size, with limb darkening), **precipitation streaks** and the token **highlight**;
- **tone-maps** the result, then limits brightness behind text so words stay readable, and dithers.

A second shader (`noise.frag`) builds the 64³ tileable Perlin–Worley noise volume on the GPU, one slice at a time. The TypeScript then histogram-equalises each channel. That is what makes coverage honest. Once the noise is uniform, "keep the top *c* of it" covers a fraction *c* of the layer, and a closed-form CDF maps the blend of two noise channels back to uniform.

TypeScript is the thin shell: the METAR parser, the sun calculation, the METAR → uniforms mapping, the quality controller and the UI. Every number the shader receives is decided in `src/scene/mapping.ts`, which is unit-tested.

## Quality tiers

| Tier | Render scale | DPR cap | Cloud steps | Light steps | Sky steps |
| --- | --- | --- | --- | --- | --- |
| high | 1.0 | 2 | 64 | 6 | 12 |
| medium | 0.75 | 1.5 | 44 | 5 | 10 |
| low | 0.55 | 1.5 | 30 | 4 | 8 |
| minimal | 0.4 | 1 | 20 | 3 | 6 |

Desktops start on *medium*, and phones and large screens on *low*. With Save-Data on, it starts on *minimal*. The page watches frame times, drops a tier when the median frame over 30 frames is slower than 24 ms, and climbs back only into tiers that have never been too slow, so it cannot oscillate. The "Quality" button at the bottom shows the tier and the median frame time **measured on your device**, and clicking it fixes a tier. `?q=high` does the same from the URL. `prefers-reduced-motion` freezes the drift and renders only when something changes.

## Build, run, test

Needs **Node ≥ 22.18** (TypeScript runs directly under Node's type stripping for tests). The smoke tests need Google Chrome or Chromium (set `CHROME_PATH` if it is not in a standard place). Wrangler 4 is only needed for `npm run dev`.

```sh
npm ci
npm run build      # → dist/ (index.html, content-hashed JS and CSS, _headers, favicon)
npm test           # typecheck, unit tests, build, then the headless-Chrome smoke tests
npm run dev        # build + wrangler dev: the full app with the live Worker on :8787
npm run serve      # static dist/ only, with the production headers; live lookups fall back to samples
npm run shots -- --out /tmp/sky-shots   # screenshots of every sample, desktop and 400 px phone
```

Useful URLs: `?id=KSFO` (live), `?sample=YSSY` (recorded), `?metar=METAR%20…` (your own), `&still=1` (freeze, for screenshots), `&q=low` (fix a tier), `&focus=7` (highlight a token).

### Tests

- **METAR parser** (`tests/unit/metar-parse.test.ts`, 51 tests):
  - real reports, including CAVOK, VV and VV///, variable wind and sectors, gusts, MPS/KMH, statute miles (`1 1/2SM`, `M1/4SM`, `P6SM`, `10SM`), RVR, minimum visibility, missing `///` groups, NIL, trends, remarks and wind shear;
  - graceful failure on junk and oversized input;
  - a fuzz test of 3,000 random token soups;
  - a **cross-check against the Aviation Weather Center's own decoder** on 400 real reports (wind, gusts, visibility, cloud layers, temperature, dew point, pressure).
- **Sun** (`tests/unit/solar.test.ts`, 22 tests):
  - Meeus' *Astronomical Algorithms* worked examples 25.a and 28.b;
  - 12 airport/time cases against **astropy** (IAU SOFA/ERFA), a completely different method, within 0.03° in elevation. The reference script is `tools/sun-reference.py`.
- **Mapping and quality** (`tests/unit/mapping.test.ts`): layers, coverage, drift direction and units, Koschmieder, VV depth, precipitation, time resolution, view, exposure, and uniforms matching the shader's declarations. Every one of the 400 real reports maps without a NaN. The tier controller is tested against synthetic frame times.
- **Worker** (`tests/unit/worker.test.ts`, 26 tests), with mocked upstream and an in-memory Cache API:
  - validation;
  - cache hit/miss/expiry ("100 views in 5 minutes cost one upstream request");
  - unknown station, upstream 500/429, network failure, malformed and oversized bodies, and timeout.
- **Report/labels/API client** (`tests/unit/report.test.ts`).
- **Smoke** (`tests/smoke/dist.test.mjs`, headless Chrome over the DevTools protocol):
  - `dist/` loads and draws with WebGL2, with no console errors;
  - hover and keyboard flows, and the offline fallback;
  - reduced motion;
  - a true **400 px** viewport through device emulation, with no horizontal scroll;
  - a **measured WCAG check**: with the text hidden, it screenshots five bright skies and reads the pixels behind every text box. The dimmer text colour must reach 4.5:1 against the brightest one.

## The Worker and the Cloudflare free plan

`worker/` is one endpoint, `GET /api/metar?id=XXXX`. It proxies the public [aviationweather.gov Data API](https://aviationweather.gov/data/api/) (`/api/data/metar?ids=XXXX&format=json`).

- **Validation:** exactly four letters or digits, starting with a letter. Anything else gets a 400 and never reaches upstream.
- **Cache:** responses are stored with the Workers Cache API for **5 minutes**, keyed by the normalised station code. So one upstream request serves every view of that station in that data centre for five minutes. "No report for that code" is cached too, so a typo can't hammer upstream.
- **Timeout and errors:** upstream gets 6 s. Errors come back as clear JSON: `invalid_id` (400), `upstream_error` (502, for upstream 5xx/429, bad or oversized bodies, or network failure) and `upstream_timeout` (504). An unknown station is an ordinary answer, `{"error":"unknown_station"}` with status 200, much as upstream itself answers 204 for "no data". That keeps a typo from showing as a failed request in the browser console.
- **Upstream etiquette:** a descriptive User-Agent, as the API docs ask. The API allows 100 requests a minute.

**How it fits the free plan.**

- Static files in `dist/` are served by Workers static assets, which is free and does not count as Worker requests. Only `/api/*` runs the Worker (`run_worker_first` in `wrangler.toml`).
- The free plan allows 100,000 Worker requests a day. A page view makes one API call, plus one per station typed, so that is roughly 50,000–100,000 views a day.
- Upstream traffic is bounded by the cache, not by visitors: at most one request per station per 5 minutes per data centre (288 a day per busy station per data centre), far inside the upstream's 100 a minute.
- The 10 ms CPU limit counts CPU, not waiting. Per request the Worker does a regex check, one cache lookup and one `fetch`, then parses and re-serialises about 1 KB of JSON; waiting on aviationweather.gov is I/O time. I have not measured CPU time on Cloudflare itself, because the app is not deployed yet. Locally, under `wrangler dev`, a cached answer took 2 ms of wall time.
- Caveat: the Cache API is per data centre. Cloudflare documents working cache operations for Workers on a custom domain, so attach the Worker to a route or custom domain to get the caching.

**Deploying.** `npm run build`, then `npx wrangler deploy` deploys the Worker and `dist/` together. The owner deploys through a guarded script that pins the right Cloudflare account, so the repo deliberately has no deploy script. `dist/` on its own is also a valid static site (`wrangler pages deploy dist`): without the Worker, the page falls back to the recorded samples and says so.

## Privacy

There are no cookies, analytics or accounts. `localStorage` keeps only the last station code, so you come back to it. The browser talks to this site and to Google Fonts (for the B612 typefaces). The Worker talks only to aviationweather.gov.

## Honest limitations

- **Cloud shapes are procedural.** A METAR gives amount and base only; everything about shape, thickness and texture is a model. Coverage is calibrated (equalised noise), but the look of a layer at the horizon is perspective plus noise, not data.
- **The wind is surface wind.** Real clouds move with the wind at their height, which is usually stronger and often from a different direction.
- **The sun is placed for the observation time**, not for "now". A report can be up to an hour old, and the label shows its time.
- **Only four layers are drawn.** Extra layers are listed as not drawn.
- **CB/TCU are tall cumulus.** There are no anvils, lightning or hail shafts.
- **The stars are decorative** and there is no moon, so moonlit nights are drawn dark.
- **Night glow under cloud is assumed** (airport and city lights), not reported.
- **The atmosphere is single scattering plus a rough multiple-scattering term**, so deep twilight colours are approximate.
- **Phones start on a low tier.** A slow GPU gets a softer, lower-resolution sky rather than a stutter.
- **Browser needs:** the sky needs WebGL2. Without it, the report and explanations still work over a plain gradient.

## Next

- A real star map (a public-domain bright-star catalogue placed by sidereal time) and the Moon, with its phase and light.
- Anvils and lightning for CB and TS, and virga under showers.
- Winds aloft from a public forecast model for the drift, clearly labelled as a forecast.
- Blue-noise jitter plus temporal accumulation, for cleaner clouds at the same cost.
- A trend preview: show `TEMPO`/`BECMG` groups as "what might come next".

## Credits

- Weather data: [Aviation Weather Center](https://aviationweather.gov/), NOAA / National Weather Service. Public US-government data. The recorded samples and the test fixture are real reports from that API, fetched on 26 Sep 2026.
- Sun: NOAA Global Monitoring Laboratory's solar position equations, after Jean Meeus, *Astronomical Algorithms*.
- Type: [B612 and B612 Mono](https://fonts.google.com/specimen/B612), the typefaces originally designed for Airbus cockpit displays, loaded from Google Fonts.

Built with AI assistance (Claude).

## License

MIT, see [LICENSE](LICENSE).
