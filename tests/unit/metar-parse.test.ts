import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseMetar, M_PER_SM, MAX_METAR_CHARS, type Metar } from '../../src/metar/parse.ts';

function ok(raw: string): Metar {
  const m = parseMetar(raw);
  assert.equal(m.ok, true, `expected ok for "${raw}", got error: ${m.error}`);
  return m;
}

function tokenOf(m: Metar, text: string) {
  const t = m.tokens.find((x) => x.text === text);
  assert.ok(t, `token "${text}" not found in [${m.tokens.map((x) => x.text).join(' | ')}]`);
  return t;
}

function assertSpans(m: Metar) {
  let last = -1;
  for (const t of m.tokens) {
    assert.ok(t.start >= last, `tokens out of order at "${t.text}"`);
    assert.ok(t.end > t.start, `empty span at "${t.text}"`);
    assert.equal(m.raw.slice(t.start, t.end), t.text, 'span must match raw text');
    last = t.end;
  }
}

describe('real reports (aviationweather.gov, 2026-09-26)', () => {
  test('Heathrow: AUTO, variable wind, 9999, NCD', () => {
    const m = ok('METAR EGLL 260650Z AUTO VRB02KT 9999 NCD 12/10 Q1023');
    assert.equal(m.reportType, 'METAR');
    assert.equal(m.station, 'EGLL');
    assert.deepEqual([m.day, m.hour, m.minute], [26, 6, 50]);
    assert.equal(m.auto, true);
    assert.equal(m.wind?.variable, true);
    assert.equal(m.wind?.directionDeg, null);
    assert.equal(m.wind?.speedKt, 2);
    assert.deepEqual(m.visibility, { meters: 10000, orMore: true, lessThan: false, unit: 'm' });
    assert.equal(m.sky, 'ncd');
    assert.equal(m.clouds.length, 0);
    assert.equal(m.temperatureC, 12);
    assert.equal(m.dewpointC, 10);
    assert.equal(m.altimeterHpa, 1023);
    assert.deepEqual(m.unparsed, []);
    assertSpans(m);
  });

  test('JFK: gusts, statute miles, rain, three layers, remarks kept whole', () => {
    const raw =
      'METAR KJFK 260651Z 02027G44KT 5SM -RA FEW029 BKN050 OVC070 14/11 A2983 RMK AO2 PK WND 04046/0552 RAB0557 SLP102 P0004 T01390106 $';
    const m = ok(raw);
    assert.equal(m.wind?.directionDeg, 20);
    assert.equal(m.wind?.speedKt, 27);
    assert.equal(m.wind?.gustKt, 44);
    assert.ok(Math.abs((m.visibility?.meters ?? 0) - 5 * M_PER_SM) < 1e-6);
    assert.equal(m.visibility?.orMore, false);
    assert.equal(m.weather.length, 1);
    assert.equal(m.weather[0]?.intensity, 'light');
    assert.deepEqual(m.weather[0]?.phenomena, ['RA']);
    assert.deepEqual(
      m.clouds.map((c) => [c.cover, c.baseFt]),
      [['FEW', 2900], ['BKN', 5000], ['OVC', 7000]],
    );
    // A2983 = 29.83 inHg × 33.8639 hPa/inHg
    assert.ok(Math.abs((m.altimeterHpa ?? 0) - 1010.16) < 0.01);
    const rmk = m.tokens[m.tokens.length - 1]!;
    assert.equal(rmk.kind, 'remarks');
    assert.ok(rmk.text.startsWith('RMK AO2') && rmk.text.endsWith('$'));
    // Remarks mention RA-like codes; none may leak into current weather.
    assert.equal(m.weather.length, 1);
    assertSpans(m);
  });

  test('Zurich: CAVOK means no layers and 10 km or more', () => {
    const m = ok('METAR LSZH 260650Z 30004KT CAVOK 09/07 Q1023 NOSIG');
    assert.equal(m.cavok, true);
    assert.equal(m.sky, 'cavok');
    assert.equal(m.clouds.length, 0);
    assert.equal(m.visibility?.meters, 10000);
    assert.equal(m.visibility?.orMore, true);
    assert.equal(tokenOf(m, 'CAVOK').drives.kind, 'clear');
    assert.equal(tokenOf(m, 'NOSIG').section, 'trend');
  });

  test('Beijing: metres per second, variable sector', () => {
    const m = ok('METAR ZBAA 260630Z 21003MPS 120V270 CAVOK 27/17 Q1009 NOSIG');
    assert.equal(m.wind?.unit, 'MPS');
    assert.ok(Math.abs((m.wind?.speedKt ?? 0) - 5.83) < 0.01);
    assert.deepEqual(m.wind?.rangeDeg, [120, 270]);
    assert.match(tokenOf(m, '21003MPS').meaning, /3 m\/s \(6 knots\)/);
  });

  test('Beijing: variable with gusts in MPS', () => {
    const m = ok('METAR ZBAA 260530Z VRB02G10MPS CAVOK 26/16 Q1009 NOSIG');
    assert.equal(m.wind?.variable, true);
    assert.ok(Math.abs((m.wind?.gustKt ?? 0) - 19.44) < 0.01);
  });

  test('Auckland: AUTO layers with /// cloud type', () => {
    const m = ok('METAR NZAA 260630Z AUTO 23005KT 9999 BKN016/// BKN025/// OVC100/// 13/12 Q1023');
    assert.deepEqual(
      m.clouds.map((c) => [c.cover, c.baseFt, c.convective]),
      [['BKN', 1600, null], ['BKN', 2500, null], ['OVC', 10000, null]],
    );
    assert.deepEqual(m.unparsed, []);
  });

  test('Singapore: haze, TCU and a high layer', () => {
    const m = ok('METAR WSSS 260630Z 19008KT 160V220 4500 HZ FEW018 FEW020TCU BKN300 34/23 Q1009 NOSIG');
    assert.equal(m.visibility?.meters, 4500);
    assert.deepEqual(m.weather.map((w) => w.phenomena), [['HZ']]);
    assert.equal(m.clouds[1]?.convective, 'TCU');
    assert.equal(m.clouds[2]?.baseFt, 30000);
    assert.equal(tokenOf(m, 'HZ').drives.kind, 'haze');
  });

  test('Sydney SPECI: heavy showers and gusts', () => {
    const m = ok('SPECI YSSY 260653Z AUTO 33025G46KT 320V030 6000 +SHRA SCT057 BKN089 BKN120 27/09 Q1020');
    assert.equal(m.reportType, 'SPECI');
    assert.equal(m.weather[0]?.intensity, 'heavy');
    assert.equal(m.weather[0]?.descriptor, 'SH');
    assert.equal(tokenOf(m, '+SHRA').drives.kind, 'precip');
    assert.match(tokenOf(m, 'SPECI').meaning, /special report/);
  });

  test('Helsinki: minimum visibility with direction', () => {
    const m = ok('METAR EFHK 260550Z 17011KT 6000 2900S -DZRA FEW004 BKN005 13/13 Q1010 BECMG 8000');
    assert.equal(m.visibility?.meters, 6000);
    const t = tokenOf(m, '2900S');
    assert.equal(t.kind, 'minVisibility');
    assert.match(t.meaning, /toward the south/);
    assert.deepEqual(m.weather[0]?.phenomena, ['DZ', 'RA']);
  });

  test('Schiphol: runway visual range, partial fog, trend with cloud', () => {
    const m = ok(
      'METAR EHAM 260325Z 01004KT 320V050 3500 R18C/1900N R27/P2000N R18R/0750U R06/P2000N BR PRFG FEW001 15/14 Q1017 TEMPO 2500 SCT003',
    );
    assert.equal(m.visibility?.meters, 3500);
    assert.equal(tokenOf(m, 'R18C/1900N').kind, 'rvr');
    assert.match(tokenOf(m, 'R18R/0750U').meaning, /improving/);
    assert.match(tokenOf(m, 'R27/P2000N').meaning, /more than 2,000 m/);
    assert.deepEqual(
      m.weather.map((w) => [w.descriptor, w.phenomena]),
      [[null, ['BR']], ['PR', ['FG']]],
    );
    // TEMPO 2500 SCT003 is a forecast: current visibility and layers are unchanged.
    assert.equal(m.clouds.length, 1);
    const trend = tokenOf(m, 'TEMPO 2500 SCT003');
    assert.equal(trend.kind, 'trend');
    assert.match(trend.meaning, /temporarily: visibility 2,500 m, scattered cloud at 300 ft/);
  });

  test('Mexico City: calm wind', () => {
    const m = ok('METAR MMMX 260546Z 00000KT 10SM BKN020 BKN080 18/11 A3035 NOSIG RMK SLP101 52013 952 8/530 HZY');
    assert.equal(m.wind?.calm, true);
    assert.equal(m.wind?.speedKt, 0);
    assert.equal(m.visibility?.orMore, true);
    assert.match(tokenOf(m, '00000KT').meaning, /calm/);
  });

  test('Vancouver: 12SM is a measured value, not a floor', () => {
    const m = ok('SPECI CYVR 260636Z 18008KT 150V220 12SM FEW013 FEW032 BKN054 OVC074 12/12 A3003 RMK SF1SC1SC5AC2 SF TR SLP173');
    assert.equal(m.visibility?.orMore, false);
    assert.equal(m.clouds.length, 4);
  });
});

describe('formats not in the sample', () => {
  test('vertical visibility: fog with the sky hidden', () => {
    const m = ok('METAR KSFO 260556Z 00000KT 1/4SM FG VV002 12/12 A2996');
    assert.equal(m.sky, 'obscured');
    assert.equal(m.verticalVisibilityFt, 200);
    assert.ok(Math.abs((m.visibility?.meters ?? 0) - 0.25 * M_PER_SM) < 1e-6);
    assert.equal(tokenOf(m, 'VV002').drives.kind, 'fog');
    assert.match(tokenOf(m, '1/4SM').meaning, /¼ mile/);
  });

  test('VV/// — obscured, height unknown', () => {
    const m = ok('METAR EGLL 010550Z AUTO 00000KT 0100 FG VV/// 05/05 Q1020');
    assert.equal(m.sky, 'obscured');
    assert.equal(m.verticalVisibilityFt, null);
    assert.equal(m.visibility?.meters, 100);
  });

  test('0000 visibility is "less than 50 m"', () => {
    const m = ok('METAR LFPG 010550Z 00000KT 0000 FG VV001 05/05 Q1020');
    assert.equal(m.visibility?.lessThan, true);
    assert.equal(m.visibility?.meters, 50);
  });

  test('mixed-number statute miles are one token spanning both groups', () => {
    const raw = 'METAR KORD 010651Z 27010KT 1 1/2SM BR OVC004 08/07 A2992';
    const m = ok(raw);
    const t = tokenOf(m, '1 1/2SM');
    assert.equal(t.kind, 'visibility');
    assert.equal(raw.slice(t.start, t.end), '1 1/2SM');
    assert.ok(Math.abs((m.visibility?.meters ?? 0) - 1.5 * M_PER_SM) < 1e-6);
    assert.match(t.meaning, /1½ miles/);
    assertSpans(m);
  });

  test('M1/4SM is "less than", P6SM is "more than"', () => {
    const a = ok('METAR KBOS 010651Z 00000KT M1/4SM FG VV001 08/08 A2992');
    assert.equal(a.visibility?.lessThan, true);
    assert.match(tokenOf(a, 'M1/4SM').meaning, /less than ¼ mile/);
    const b = ok('METAR KSFO 010651Z 27010KT P6SM FEW200 18/08 A2992');
    assert.equal(b.visibility?.orMore, true);
    assert.ok(Math.abs((b.visibility?.meters ?? 0) - 6 * M_PER_SM) < 1e-6);
  });

  test('other fractions: 3/4SM, 1/16SM, 2 1/2SM', () => {
    assert.ok(Math.abs((ok('METAR KDEN 010651Z 36010KT 3/4SM -SN BR OVC005 M02/M03 A3001').visibility?.meters ?? 0) - 0.75 * M_PER_SM) < 1e-6);
    assert.ok(Math.abs((ok('METAR KDEN 010651Z 36010KT 1/16SM FG VV001 M02/M03 A3001').visibility?.meters ?? 0) - M_PER_SM / 16) < 1e-6);
    assert.ok(Math.abs((ok('METAR KDEN 010651Z 36010KT 2 1/2SM -RA OVC010 M02/M03 A3001').visibility?.meters ?? 0) - 2.5 * M_PER_SM) < 1e-6);
  });

  test('negative temperatures and missing dew point', () => {
    const m = ok('METAR ENGM 010650Z 35004KT 9999 FEW018 M05/M07 Q1009');
    assert.equal(m.temperatureC, -5);
    assert.equal(m.dewpointC, -7);
    const n = ok('METAR ENGM 010650Z 35004KT 9999 FEW018 12/ Q1009');
    assert.equal(n.temperatureC, 12);
    assert.equal(n.dewpointC, null);
  });

  test('wind in km/h and 3-digit gusts', () => {
    const m = ok('METAR UUEE 010630Z 27020G110KMH 9999 SCT030 10/05 Q1010');
    assert.ok(Math.abs((m.wind?.speedKt ?? 0) - 10.8) < 0.01);
    assert.ok(Math.abs((m.wind?.gustKt ?? 0) - 59.4) < 0.01);
  });

  test('P-prefixed wind speed ("more than")', () => {
    const m = ok('METAR KXYZ 010651Z 270P99KT 1/2SM +TSRA OVC005CB 20/18 A2950');
    assert.equal(m.wind?.aboveReported, true);
    assert.equal(m.wind?.speedKt, 99);
    assert.equal(m.clouds[0]?.convective, 'CB');
    assert.match(tokenOf(m, 'OVC005CB').meaning, /cumulonimbus/);
  });

  test('missing groups from automatic stations', () => {
    // Everything missing: every group is recognised as "missing", and there is nothing to draw.
    const m = parseMetar('METAR EGXX 010650Z AUTO /////KT //// // ////// ///// Q////');
    assert.equal(m.ok, false);
    assert.match(m.error ?? '', /no weather groups/);
    assert.equal(m.wind, null);
    assert.equal(m.visibility, null);
    assert.equal(m.altimeterHpa, null);
    assert.deepEqual(m.unparsed, []);
    assert.equal(m.tokens.filter((t) => t.kind === 'missing').length, 6);
    // Some groups missing: the rest still draws.
    const n = ok('METAR EGXX 010650Z AUTO /////KT 9999 ////// 12/10 Q1010');
    assert.equal(n.wind, null);
    assert.equal(n.visibility?.meters, 10000);
    assert.match(tokenOf(n, '/////KT').meaning, /do not drift/);
  });

  test('cloud with unmeasured base', () => {
    const m = ok('METAR EGXX 010650Z AUTO 24010KT 9999 BKN/// 10/08 Q1010');
    assert.equal(m.clouds[0]?.baseFt, null);
    assert.match(tokenOf(m, 'BKN///').meaning, /unmeasured height/);
  });

  test('CLR, SKC and NSC mean no layers', () => {
    assert.equal(ok('METAR KDEN 010653Z 23010KT 10SM CLR 13/10 A3004').sky, 'clear');
    assert.equal(ok('METAR KDEN 010653Z 23010KT 10SM SKC 13/10 A3004').sky, 'clear');
    assert.equal(ok('METAR OMDB 260630Z VRB04KT 6000 NSC 35/26 Q1006 BECMG 31010KT').sky, 'nsc');
  });

  test('recent weather and wind shear are kept but not drawn', () => {
    const m = ok('METAR VTBS 260530Z 22013KT 8000 -RA FEW010 BKN020 BKN070 26/24 Q1007 RERA WS R19L NOSIG');
    assert.equal(tokenOf(m, 'RERA').kind, 'recentWeather');
    assert.equal(tokenOf(m, 'WS R19L').kind, 'windShear');
    assert.equal(m.weather.length, 1);
    const n = ok('METAR LXYZ 010650Z 27015KT 9999 FEW030 10/05 Q1010 WS ALL RWY');
    assert.equal(tokenOf(n, 'WS ALL RWY').kind, 'windShear');
  });

  test('vicinity showers are described but not drawn', () => {
    const m = ok('METAR KMIA 010653Z 34005KT 10SM VCSH FEW025 25/22 A2989');
    const t = tokenOf(m, 'VCSH');
    assert.equal(t.drives.kind, 'none');
    assert.match(t.meaning, /nearby/);
  });

  test('thunderstorm alone and freezing fog', () => {
    const m = ok('METAR EDDF 010650Z 27010KT 3000 TS FZFG SCT030CB 01/00 Q1010');
    assert.deepEqual(m.weather.map((w) => [w.descriptor, w.phenomena]), [['TS', []], ['FZ', ['FG']]]);
    assert.match(tokenOf(m, 'FZFG').meaning, /freezing fog/);
  });

  test('BECMG with FM/TL times is one trend group', () => {
    const m = ok('METAR EGLL 010650Z 27010KT 9999 SCT030 10/05 Q1010 BECMG FM1000 TL1200 4000 -RA BKN010');
    const t = tokenOf(m, 'BECMG FM1000 TL1200 4000 -RA BKN010');
    assert.match(t.meaning, /becoming: from 10:00 UTC, until 12:00 UTC, visibility 4,000 m, light rain, broken cloud at 1,000 ft/);
    assert.equal(m.visibility?.meters, 10000);
    assert.equal(m.weather.length, 0);
    assert.equal(m.clouds.length, 1);
  });

  test('no METAR prefix, lower case and trailing "=" are accepted', () => {
    const m = ok('egll 260650z auto vrb02kt 9999 ncd 12/10 q1023=');
    assert.equal(m.station, 'EGLL');
    assert.equal(m.altimeterHpa, 1023);
    assertSpans(m);
    assert.equal(m.tokens[m.tokens.length - 1]?.text, 'q1023');
  });

  test('COR and CCA mark corrections', () => {
    assert.equal(ok('METAR COR EGLL 260650Z 27010KT 9999 FEW030 12/10 Q1023').corrected, true);
    assert.equal(ok('METAR EGLL 260650Z CCA 27010KT 9999 FEW030 12/10 Q1023').corrected, true);
  });

  test('more than four layers are all parsed', () => {
    const m = ok('METAR CYVR 260500Z 21007KT 6SM -SHRA FEW011 FEW027 SCT042 BKN057 OVC068 12/12 A3001');
    assert.equal(m.clouds.length, 5);
    assert.deepEqual(m.clouds.map((c) => c.tokenIndex >= 0), [true, true, true, true, true]);
  });

  test('cloud tokens point to their layer index', () => {
    const m = ok('METAR RJTT 260630Z 02011KT 9999 -SHRA FEW008 BKN010 20/18 Q1012 NOSIG');
    assert.deepEqual(tokenOf(m, 'FEW008').drives, { kind: 'layer', index: 0 });
    assert.deepEqual(tokenOf(m, 'BKN010').drives, { kind: 'layer', index: 1 });
    assert.match(tokenOf(m, 'BKN010').meaning, /^broken cloud at 1,000 ft above the airport, 5–7 eighths of the sky/);
  });

  test('unknown groups are listed and never crash', () => {
    const m = ok('METAR EGLL 260650Z 27010KT 9999 XYZZY FEW030 12/10 Q1023');
    assert.deepEqual(m.unparsed, ['XYZZY']);
    assert.equal(tokenOf(m, 'XYZZY').kind, 'unknown');
  });
});

describe('bad input fails gracefully', () => {
  for (const input of ['', '   ', 'hello world', '12345', 'EGLL', 'KSFO 260556Z', '🌧️ rain', '////']) {
    test(`"${input}" → ok:false with a message`, () => {
      const m = parseMetar(input);
      assert.equal(m.ok, false);
      assert.equal(typeof m.error, 'string');
      assert.ok((m.error ?? '').length > 10);
    });
  }

  test('non-string input', () => {
    for (const v of [null, undefined, 42, {}, []]) {
      const m = parseMetar(v);
      assert.equal(m.ok, false);
    }
  });

  test('oversized input is refused without parsing', () => {
    const m = parseMetar('METAR EGLL 260650Z 27010KT 9999 FEW030 12/10 Q1023 ' + 'X '.repeat(10000));
    assert.equal(m.ok, false);
    assert.match(m.error ?? '', /too long/);
    assert.equal(m.tokens.length, 0);
    assert.ok(m.raw.length <= MAX_METAR_CHARS);
  });

  test('NIL report', () => {
    const m = parseMetar('METAR EGLL 260650Z NIL');
    assert.equal(m.ok, false);
    assert.equal(m.nil, true);
    assert.match(m.error ?? '', /NIL/);
  });

  test('fuzz: random token soup never throws and spans stay valid', () => {
    const parts = [
      'METAR', 'SPECI', 'EGLL', '260650Z', 'AUTO', 'VRB02KT', '27015G25KT', '/////KT', '9999', '0800', '1', '1/2SM', 'M1/4SM',
      'P6SM', 'R27L/0600N', '-RA', '+TSRA', 'VCSH', 'FG', 'BKN025', 'OVC///', 'VV002', 'CAVOK', 'NSC', '12/10', 'M01/M02',
      'Q1013', 'A2992', 'TEMPO', 'BECMG', 'NOSIG', 'RMK', 'WS', 'ALL', 'RWY', '=', '//', '////', '240V300', 'XX', 'é', 'SM',
      '1/0SM', '999SM', '9/99SM', 'R/', 'VV', 'G', 'KT',
    ];
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    for (let n = 0; n < 3000; n++) {
      const len = Math.floor(rnd() * 14);
      const words: string[] = [];
      for (let k = 0; k < len; k++) words.push(parts[Math.floor(rnd() * parts.length)]!);
      const raw = words.join(rnd() < 0.2 ? '  ' : ' ');
      const m = parseMetar(raw);
      assertSpans(m);
      assert.equal(typeof m.ok, 'boolean');
    }
  });
});

describe('cross-check against the Aviation Weather Center decoder (400 real reports)', () => {
  const fixture = JSON.parse(readFileSync(new URL('../fixtures/awc-metars-2026-09-26.json', import.meta.url), 'utf8')) as {
    reports: Array<{
      rawOb: string;
      wdir?: number | string;
      wspd?: number;
      wgst?: number;
      visib?: number | string;
      temp?: number;
      dewp?: number;
      altim?: number;
      clouds?: Array<{ cover: string; base: number | null }>;
    }>;
  };

  test('fixture has 400 reports', () => {
    assert.equal(fixture.reports.length, 400);
  });

  test('every report parses with valid spans and nothing undecoded in the body', () => {
    for (const r of fixture.reports) {
      const m = parseMetar(r.rawOb);
      assert.equal(m.ok, true, `${r.rawOb}: ${m.error}`);
      assert.deepEqual(m.unparsed, [], r.rawOb);
      assertSpans(m);
    }
  });

  test('wind direction, speed and gust agree', () => {
    for (const r of fixture.reports) {
      const m = parseMetar(r.rawOb);
      if (r.wdir === undefined || r.wspd === undefined) continue;
      assert.ok(m.wind, r.rawOb);
      if (r.wdir === 'VRB') assert.equal(m.wind.variable, true, r.rawOb);
      else assert.equal(m.wind.directionDeg, r.wdir, r.rawOb);
      assert.ok(Math.abs(Math.round(m.wind.speedKt) - r.wspd) <= 1, `${r.rawOb}: speed ${m.wind.speedKt} vs ${r.wspd}`);
      if (r.wgst !== undefined && r.wgst !== null) {
        assert.ok(Math.abs(Math.round(m.wind.gustKt ?? -99) - r.wgst) <= 1, `${r.rawOb}: gust`);
      }
    }
  });

  test('visibility agrees (AWC gives statute miles; "6+" means at least 6)', () => {
    for (const r of fixture.reports) {
      const m = parseMetar(r.rawOb);
      if (r.visib === undefined || r.visib === null) continue;
      assert.ok(m.visibility, r.rawOb);
      const miles = m.visibility.meters / M_PER_SM;
      if (typeof r.visib === 'string' && r.visib.endsWith('+')) {
        assert.ok(miles >= Number(r.visib.slice(0, -1)) - 0.01, `${r.rawOb}: ${miles} vs ${r.visib}`);
      } else {
        assert.ok(Math.abs(miles - Number(r.visib)) < 0.02, `${r.rawOb}: ${miles} vs ${r.visib}`);
      }
    }
  });

  test('cloud layers agree', () => {
    for (const r of fixture.reports) {
      const m = parseMetar(r.rawOb);
      const theirs = (r.clouds ?? []).map((c) => [c.cover, c.base]);
      // AWC's JSON keeps at most four layers; the parser keeps all of them.
      const ours = m.clouds.slice(0, 4).map((c) => [c.cover, c.baseFt]);
      assert.deepEqual(ours, theirs, r.rawOb);
    }
  });

  test('temperature, dew point and pressure agree', () => {
    for (const r of fixture.reports) {
      const m = parseMetar(r.rawOb);
      // AWC uses the tenths from the US remarks T-group when present, so allow 0.6 °C.
      if (typeof r.temp === 'number') assert.ok(Math.abs((m.temperatureC ?? 99) - r.temp) <= 0.6, `${r.rawOb}: temp`);
      if (typeof r.dewp === 'number') assert.ok(Math.abs((m.dewpointC ?? 99) - r.dewp) <= 0.6, `${r.rawOb}: dewp`);
      if (typeof r.altim === 'number') assert.ok(Math.abs((m.altimeterHpa ?? 0) - r.altim) <= 0.6, `${r.rawOb}: altim`);
    }
  });
});
