/**
 * Bundled sample reports, so the page works offline and without the Worker.
 * These are real METARs recorded from the aviationweather.gov Data API on 2026-09-26
 * (public US-government data from NOAA / NWS Aviation Weather Center), with the station
 * name and position that the same API returned. The page labels them SAMPLE, never LIVE.
 */
import type { ReportSource } from './report.ts';

export const SAMPLES_RECORDED = '2026-09-26';

export const SAMPLES: ReportSource[] = [
  { id: 'EGLL', raw: "METAR EGLL 260650Z AUTO VRB02KT 9999 NCD 12/10 Q1023", obsTime: 1790405400, station: { name: "London/Heathrow Intl, EN, GB", lat: 51.477, lon: -0.461, elevM: 26 } },
  { id: 'KSFO', raw: "METAR KSFO 260556Z 27012KT 10SM FEW009 FEW200 15/12 A2996 RMK AO2 SLP144 T01500117 10200 20150 50010", obsTime: 1790402160, station: { name: "San Francisco Intl, CA, US", lat: 37.6196, lon: -122.3656, elevM: 2 } },
  { id: 'RJTT', raw: "METAR RJTT 260630Z 02011KT 9999 -SHRA FEW008 BKN010 20/18 Q1012 NOSIG", obsTime: 1790404200, station: { name: "Tokyo/Haneda Intl, 13, JP", lat: 35.553, lon: 139.781, elevM: 5 } },
  { id: 'VHHH', raw: "METAR VHHH 260630Z 26008KT 9999 FEW020 31/22 Q1009 NOSIG", obsTime: 1790404200, station: { name: "Hong Kong Intl, HK, HK", lat: 22.309, lon: 113.922, elevM: 9 } },
  { id: 'WSSS', raw: "METAR WSSS 260630Z 19008KT 160V220 4500 HZ FEW018 FEW020TCU BKN300 34/23 Q1009 NOSIG", obsTime: 1790404200, station: { name: "Singapore/Changi Intl, 4, SG", lat: 1.368, lon: 103.982, elevM: 17 } },
  { id: 'LFPG', raw: "METAR LFPG 260630Z 28004KT 2000 BR OVC002 15/14 Q1020 TEMPO 1200 BR BKN002", obsTime: 1790404200, station: { name: "Paris/De Gaulle Arpt, ID, FR", lat: 49.015, lon: 2.534, elevM: 107 } },
  { id: 'YSSY', raw: "SPECI YSSY 260653Z AUTO 33025G46KT 320V030 6000 +SHRA SCT057 BKN089 BKN120 27/09 Q1020", obsTime: 1790405580, station: { name: "Sydney Intl, NS, AU", lat: -33.946, lon: 151.173, elevM: 3 } },
  { id: 'NZAA', raw: "METAR NZAA 260630Z AUTO 23005KT 9999 BKN016/// BKN025/// OVC100/// 13/12 Q1023", obsTime: 1790404200, station: { name: "Auckland Intl, AU, NZ", lat: -37.008, lon: 174.792, elevM: 7 } },
  { id: 'KDEN', raw: "METAR KDEN 260653Z 23010KT 10SM FEW200 13/10 A3004 RMK AO2 SLP110 T01330100 402440106", obsTime: 1790405580, station: { name: "Denver Intl, CO, US", lat: 39.8466, lon: -104.6562, elevM: 1656 } },
  { id: 'PHNL', raw: "METAR PHNL 260653Z 08013G24KT 10SM FEW026 SCT035 BKN045 27/21 A2990 RMK AO2 PK WND 04030/0639 SLP126 T02720211 $", obsTime: 1790405580, station: { name: "Honolulu Intl, HI, US", lat: 21.315, lon: -157.924, elevM: 2 } },
  { id: 'KJFK', raw: "METAR KJFK 260651Z 02027G44KT 5SM -RA FEW029 BKN050 OVC070 14/11 A2983 RMK AO2 PK WND 04046/0552 RAB0557 SLP102 P0004 T01390106 $", obsTime: 1790405460, station: { name: "New York/JF Kennedy Intl, NY, US", lat: 40.6392, lon: -73.7639, elevM: 3 } },
  { id: 'LSZH', raw: "METAR LSZH 260650Z 30004KT CAVOK 09/07 Q1023 NOSIG", obsTime: 1790405400, station: { name: "Z\u00fcrich Intl Arpt, ZH, CH", lat: 47.48, lon: 8.536, elevM: 424 } },
];
