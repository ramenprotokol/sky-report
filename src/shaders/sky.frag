#version 300 es
// sky-report: the sky over an airport, drawn from its METAR.
//
// One full-screen pass. For every pixel a ray leaves a camera 25 m above the airport and
//   1. integrates single scattering through a spherical atmosphere (Rayleigh + Mie + ozone),
//   2. ray-marches each reported cloud layer as a volume, with a short march toward the sun
//      for self-shadowing, a two-lobe phase function and a multiple-scattering approximation,
//   3. applies ground haze/fog whose extinction comes from the reported visibility
//      (Koschmieder: beta = 3.912 / V), decaying exponentially with height,
//   4. adds stars at night, the sun disc, precipitation streaks and the token highlight,
//   5. tone-maps, limits brightness behind text for contrast, and dithers.
// Scene values are computed in src/scene/mapping.ts; nothing here reads the METAR directly.
// The sky's diffuse light (uSkyAmbient) depends only on the sun, so src/scene/atmosphere.ts
// computes it once per scene with a TypeScript port of skyScatter below.
precision highp float;
precision highp int;
precision highp sampler3D;

in vec2 vUv;
out vec4 outColor;

// Frame and quality (renderer)
uniform vec2 uResolution;
uniform float uTime;
uniform mat3 uCamera;
uniform float uTanHalfFov;
uniform int uSteps;
uniform int uLightSteps;
uniform int uSkySteps;
uniform sampler3D uNoise;

// Scene (mapping.ts → sceneUniforms)
uniform int uLayerCount;
uniform vec4 uLayers[4];      // base m, thickness m, coverage 0..1, METAR layer index
uniform int uLayerKinds[4];   // 0 cumulus, 1 stratiform, 2 mid-level, 3 cirrus, 4 towering
uniform vec2 uDrift;          // m/s toward east, north
uniform float uGust;
uniform float uHazeBeta;      // 1/m at the ground
uniform float uHazeHeight;    // m
uniform vec3 uHazeTint;
uniform float uObscured;      // 1 when the report gives VV (sky obscured)
uniform vec2 uPrecip;         // kind (0 none, 1 rain, 2 snow), intensity
uniform vec3 uSunDir;         // x east, y up, z north
uniform float uSunKnown;
uniform float uExposure;
uniform vec3 uSkyAmbient;     // diffuse sky light for this sun (atmosphere.ts)

// Interaction and legibility (renderer)
uniform int uFocus;           // FOCUS in mapping.ts
uniform int uFocusIndex;
uniform float uFocusAmount;
uniform vec4 uTextBlocks[3];  // backing pixels, y up: centre x, y and radii x, y of each text block
uniform int uTextBlockCount;
uniform float uLumaLimit;     // max relative luminance behind text
uniform int uProbe;           // test hook: 1 = look straight up from below, write cloud opacity
uniform float uProbeSpan;     // width of the ground square the probe covers, m

const float PI = 3.14159265359;
const float R_EARTH = 6371000.0;
const float ATMOSPHERE = 100000.0;
const float EYE = 25.0;                          // eye height: roughly a control-tower cab
const vec3 BETA_R = vec3(5.802e-6, 13.558e-6, 33.1e-6);
const float BETA_M_S = 3.996e-6;
const float BETA_M_E = 4.40e-6;
const float H_R = 8000.0;
const float H_M = 1200.0;
const vec3 OZONE = vec3(0.016, 0.027, 0.0008);   // vertical optical depth, ~300 Dobson units
const float SUN_E = 20.0;
const float SUN_COS_RADIUS = 0.99998918;          // cos(0.2665°): the real angular radius
const vec3 AMBER = vec3(1.0, 0.58, 0.10);
const vec3 NIGHT_SKY = vec3(0.00016, 0.00026, 0.00056); // airglow + starlight, artistic
// Assumed, not reported: airports are lit at night, so low cloud and fog pick up a faint warm glow from below.
const vec3 GROUND_GLOW = vec3(0.0011, 0.0008, 0.00055);

// ---------------------------------------------------------------- helpers

uvec3 pcg3d(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}
vec3 hash3(vec3 p) {
  return vec3(pcg3d(uvec3(ivec3(floor(p)) + ivec3(1 << 20)))) * (1.0 / 4294967295.0);
}
float remap(float v, float a, float b, float c, float d) {
  return c + (v - a) * (d - c) / (b - a);
}
float saturate(float v) { return clamp(v, 0.0, 1.0); }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

float hg(float c, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(max(1e-4, 1.0 + g2 - 2.0 * g * c), 1.5));
}
float miePhase(float c) {
  const float g = 0.76;
  float g2 = g * g;
  return 3.0 / (8.0 * PI) * ((1.0 - g2) * (1.0 + c * c)) / ((2.0 + g2) * pow(1.0 + g2 - 2.0 * g * c, 1.5));
}

// Altitude at distance t along a ray that starts at altitude h0 with vertical cosine mu,
// written to avoid cancellation with the Earth's radius in 32-bit floats.
float altAt(float h0, float mu, float t) {
  float x = h0 * (2.0 * R_EARTH + h0) + 2.0 * (R_EARTH + h0) * mu * t + t * t;
  float h = x / (2.0 * R_EARTH);
  return x / (2.0 * R_EARTH + h);
}

// Near and far distances where a ray from altitude h0 crosses the sphere at altitude hs.
vec2 shell(float h0, float mu, float hs) {
  float b = (R_EARTH + h0) * mu;
  float c = (h0 - hs) * (2.0 * R_EARTH + h0 + hs);
  float disc = b * b - c;
  if (disc < 0.0) return vec2(-1.0);
  float q = -b - (b >= 0.0 ? 1.0 : -1.0) * sqrt(disc);
  float t1 = q;
  float t2 = abs(q) > 1e-6 ? c / q : 0.0;
  return vec2(min(t1, t2), max(t1, t2));
}

// Column optical depth of an exponential layer (scale height H) from altitude h along a direction
// with vertical cosine mu, using a Chapman-style airmass. Below the horizon the path is reflected
// about its tangent point; if that point is underground, the Earth blocks the path.
float columnOD(float h, float mu, float H) {
  float r = R_EARTH + h;
  float ch0 = sqrt(0.5 * PI * r / H);
  if (mu >= 0.0) return H * exp(-h / H) / (mu + 1.0 / ch0);
  float ht = r * sqrt(max(0.0, 1.0 - mu * mu)) - R_EARTH;
  if (ht <= 0.0) return 1e7;
  float chT = sqrt(0.5 * PI * (R_EARTH + ht) / H);
  return 2.0 * H * exp(-ht / H) * chT - H * exp(-h / H) / (-mu + 1.0 / ch0);
}

vec3 transmittance(float h, float mu) {
  float r = R_EARTH + h;
  float ro = R_EARTH + 25000.0;
  float ozoneAirmass = 1.0 / sqrt(max(2e-3, 1.0 - (r * r) / (ro * ro) * (1.0 - mu * mu)));
  vec3 od = BETA_R * columnOD(h, mu, H_R) + BETA_M_E * columnOD(h, mu, H_M) + OZONE * ozoneAirmass;
  return exp(-od);
}

// Sunlight arriving at altitude h (before clouds and fog).
vec3 sunlightAt(float h) {
  return SUN_E * transmittance(h, uSunDir.y);
}

// ---------------------------------------------------------------- clear sky

vec3 skyScatter(vec3 rd, int steps, float jitter) {
  float mu = rd.y;
  vec2 g = shell(EYE, mu, 0.0);
  float tMax = (mu < 0.0 && g.x > 0.0) ? g.x : shell(EYE, mu, ATMOSPHERE).y;
  float cosT = dot(rd, uSunDir);
  float pR = 3.0 / (16.0 * PI) * (1.0 + cosT * cosT);
  float pM = miePhase(cosT);
  vec3 sum = vec3(0.0);
  vec3 odView = vec3(0.0);
  float n = float(steps);
  for (int i = 0; i < 16; i++) {
    if (i >= steps) break;
    float f0 = float(i) / n;
    float f1 = float(i + 1) / n;
    float t0 = tMax * f0 * f0;
    float t1 = tMax * f1 * f1;
    float dt = t1 - t0;
    float t = mix(t0, t1, jitter);
    float h = max(0.0, altAt(EYE, mu, t));
    vec3 up = normalize(vec3(rd.x * t, R_EARTH + EYE + rd.y * t, rd.z * t));
    float dR = exp(-h / H_R);
    float dM = exp(-h / H_M);
    vec3 ext = BETA_R * dR + vec3(BETA_M_E * dM);
    vec3 tv = exp(-(odView + ext * (t - t0)));
    vec3 ts = transmittance(h, dot(up, uSunDir));
    sum += tv * ts * (BETA_R * dR * pR + BETA_M_S * dM * pM) * dt;
    odView += ext * dt;
  }
  // A small isotropic term stands in for multiple scattering (keeps twilight from going black too early).
  vec3 ms = SUN_E * (BETA_R * H_R) * 0.018 * transmittance(3000.0, uSunDir.y);
  return sum * SUN_E + ms * (1.0 - exp(-odView));
}

// ---------------------------------------------------------------- clouds

float trapCdf(float s) {
  const float a = 0.7;
  const float b = 0.3;
  if (s < b) return s * s / (2.0 * a * b);
  if (s < a) return (s - 0.5 * b) / a;
  return 1.0 - (1.0 - s) * (1.0 - s) / (2.0 * a * b);
}

float heightShape(float hf, int kind) {
  if (kind == 1) return smoothstep(0.0, 0.12, hf) * smoothstep(1.0, 0.7, hf);          // stratiform
  if (kind == 2) return smoothstep(0.0, 0.2, hf) * smoothstep(1.0, 0.55, hf);          // mid-level
  if (kind == 3) return smoothstep(0.0, 0.3, hf) * smoothstep(1.0, 0.6, hf);           // cirrus
  if (kind == 4) return smoothstep(0.0, 0.05, hf) * smoothstep(1.0, 0.45, hf);         // towering
  return smoothstep(0.0, 0.07, hf) * smoothstep(1.0, 0.3, hf);                         // cumulus
}

// Horizontal feature size (m) of the base noise per kind: cumulus cells, stratocumulus rolls, wisps.
float cellSize(int kind) {
  if (kind == 1) return 7000.0;
  if (kind == 2) return 3500.0;
  if (kind == 3) return 16000.0;
  if (kind == 4) return 6500.0;
  return 5200.0;
}

float extinctionPerM(int kind) {
  if (kind == 1) return 0.030;
  if (kind == 2) return 0.018;
  if (kind == 3) return 0.0025;
  return 0.040;
}

vec2 windAt(float h) {
  // Gusts modulate the drift slowly; reduced motion freezes uTime so this is static too.
  float g = 1.0 + uGust * 0.25 * sin(uTime * 0.21) * sin(uTime * 0.057 + 1.3);
  return uDrift * uTime * g * (1.0 + h * 0.00008);
}

float cloudDensity(vec2 xz, float h, int layer, bool cheap, float lod) {
  vec4 L = uLayers[layer];
  int kind = uLayerKinds[layer];
  float hf = (h - L.x) / L.y;
  if (hf <= 0.0 || hf >= 1.0) return 0.0;
  float cover = L.z;
  vec2 p = xz - windAt(h);
  float cs = cellSize(kind);
  if (kind == 3) {
    // Cirrus: stretch the noise along the drift so it streaks with the wind.
    vec2 w = length(uDrift) > 0.01 ? normalize(uDrift) : vec2(1.0, 0.0);
    p = vec2(dot(p, w) * 0.25, dot(p, vec2(-w.y, w.x)));
  }
  // Each layer reads its own part of the (tileable) noise, shifted sideways, not up: every layer of
  // a style then samples the same range of heights, so one calibration per style holds whatever
  // the layer's altitude or position in the report (see DRAWN_COVERAGE in mapping.ts).
  vec2 off = vec2(0.37, 0.61) * float(layer);
  // How much the noise changes from the layer's base to its top, as a fraction of its period.
  // Fixed per style (not per metre), so column coverage does not depend on the drawn thickness.
  float zSpan = kind == 4 ? 0.3 : (kind == 3 ? 0.2 : (kind == 1 ? 0.12 : (kind == 2 ? 0.22 : 0.25)));
  vec3 q = vec3(p / cs + off, 0.11 + hf * zSpan);
  lod = min(lod, 2.5); // deeper mips average the noise toward 0.5 and would change the coverage
  vec4 base = textureLod(uNoise, q, lod);
  float big = textureLod(uNoise, vec3(p / (cs * 4.7) + off.yx, 0.34), max(0.0, lod - 2.0)).b;
  // The noise channels are equalised slice by slice (uniform on [0,1] in every horizontal plane);
  // 0.7·R + 0.3·B has a trapezoidal distribution, and trapCdf maps it back to uniform. So keeping
  // u > 1 − c covers a fraction c of any one plane through the layer. Seen from below, a thick
  // layer shows the union of its planes, so mapping.ts passes a calibrated c (DRAWN_COVERAGE)
  // that makes the whole column cover the reported amount: FEW 1.5/8, SCT 3.5/8, BKN 6/8, OVC all.
  float u = trapCdf(0.7 * base.r + 0.3 * big);
  float w = 0.12 + 0.3 * cover; // edge softness
  float d = saturate((u - (1.0 - cover)) / w);
  float hs = heightShape(hf, kind);
  d = saturate(remap(d, 1.0 - hs, 1.0, 0.0, 1.0)); // round the tops, flatten the bases
  // Overcast: a continuous sheet under the texture (a thicker veil for thin cirrostratus).
  if (cover >= 0.999) d = max(d, (kind == 3 ? 0.6 : 0.3) * hs * (0.6 + 0.4 * base.g));
  if (d <= 0.0 || cheap) return d;
  // Detail erosion keeps its own, roughly isotropic, 3D coordinates so the edges billow in every
  // direction (it only ever removes density, so it cannot add cover).
  float detail = textureLod(uNoise, vec3(p / cs + off, h * 1.3 / cs) * 5.3, lod + 2.4).a;
  float erode = mix(detail, 1.0 - detail, saturate(hf * 3.0)) * 0.35 * saturate(1.2 - lod * 0.35);
  return saturate(remap(d, erode, 1.0, 0.0, 1.0));
}

// Optical depth toward the sun from a point inside a layer.
float lightOD(vec2 xz, float h, int layer, int kind, float lod) {
  vec4 L = uLayers[layer];
  float sigma = extinctionPerM(kind);
  vec3 dir = uSunDir.y > 0.02 ? uSunDir : normalize(vec3(uSunDir.x, 0.02, uSunDir.z));
  float od = 0.0;
  float stepLen = L.y * 0.08;
  float t = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= uLightSteps) break;
    float dt = stepLen * float(i + 1);
    t += dt;
    vec3 p = vec3(xz.x, h, xz.y) + dir * t;
    if (p.y > L.x + L.y) break;
    od += cloudDensity(p.xz, p.y, layer, i > 1, lod + float(i) * 0.5) * sigma * dt;
  }
  return od;
}

struct Clouds { vec3 light; float trans; float depth; };

// roXZ shifts the ray's start sideways (only the coverage probe uses it; the camera is at 0).
Clouds marchClouds(vec2 roXZ, vec3 rd, vec3 ambient, vec3 ambientBelow, vec3 glow, float jitter, float pixelAngle) {
  Clouds res = Clouds(vec3(0.0), 1.0, 0.0);
  if (rd.y <= 0.0) return res;
  float cosT = dot(rd, uSunDir);
  float phaseFwd = hg(cosT, 0.75);
  float phaseBack = hg(cosT, -0.25);
  float depthW = 0.0;
  for (int li = 0; li < 4; li++) {
    if (li >= uLayerCount) break;
    vec4 L = uLayers[li];
    int kind = uLayerKinds[li];
    float t0 = shell(EYE, rd.y, L.x).y;
    float t1 = shell(EYE, rd.y, L.x + L.y).y;
    if (t0 <= 0.0 || t1 <= t0) continue;
    if (t0 > 90000.0) continue;
    t1 = min(t1, t0 + 30000.0);
    float sigmaK = extinctionPerM(kind);
    float texelM = cellSize(kind) / 64.0;
    vec3 sunTop = sunlightAt(L.x + L.y * 0.5);
    // Is the sun above this layer's own horizon? (clouds stay lit after ground sunset)
    float dip = sqrt(2.0 * (L.x + L.y * 0.5) / R_EARTH);
    float sunUp = smoothstep(-dip - 0.01, -dip + 0.01, uSunDir.y);
    // Layers above cast a mean shadow on this one, in proportion to their coverage.
    for (int j = 0; j < 4; j++) {
      if (j >= uLayerCount) break;
      if (uLayers[j].x > L.x) sunTop *= 1.0 - 0.7 * uLayers[j].z;
    }
    bool focusThis = uFocus == 1 && int(L.w + 0.5) == uFocusIndex;
    bool focusOther = uFocus == 1 && !focusThis;
    // Coarse steps through empty air; on touching cloud, back up and continue with fine steps.
    int n = uSteps;
    float dtCoarse = (t1 - t0) / float(n);
    float dtFine = dtCoarse * 0.3;
    float t = t0 + dtCoarse * jitter;
    bool fine = false;
    int empty = 0;
    for (int i = 0; i < 256; i++) {
      if (i >= n * 3 || t > t1 || res.trans < 0.01) break;
      float dt = fine ? dtFine : dtCoarse;
      vec3 pos = rd * t;
      float h = altAt(EYE, rd.y, t);
      vec2 xz = roXZ + pos.xz;
      float lod = log2(max(1.0, max(t * pixelAngle, dt * 0.5) / texelM));
      if (!fine) {
        if (cloudDensity(xz, h, li, true, lod) > 0.0) {
          fine = true;
          empty = 0;
          t = max(t0, t - dtCoarse * 0.8);
        } else {
          t += dtCoarse;
        }
        continue;
      }
      float d = cloudDensity(xz, h, li, false, lod);
      if (d <= 0.001) {
        empty += 1;
        if (empty > 5) fine = false;
      } else {
        empty = 0;
        float sigma = d * sigmaK;
        float hf = saturate((h - L.x) / L.y);
        float od = lightOD(xz, h, li, kind, lod);
        // Multiple scattering approximation: sum of octaves with weaker extinction and flatter phase.
        vec3 sun = vec3(0.0);
        float a = 1.0, b = 1.0, c = 1.0;
        for (int o = 0; o < 3; o++) {
          float ph = mix(phaseBack, phaseFwd, 0.7) * c + (1.0 - c) / (4.0 * PI);
          sun += a * exp(-od * b) * ph;
          a *= 0.5; b *= 0.4; c *= 0.5;
        }
        float powder = 1.0 - exp(-sigma * 120.0);
        vec3 amb = mix(ambientBelow, ambient, hf) * (0.35 + 0.65 * hf) + glow * (1.0 - hf) * exp(-h / 1500.0);
        vec3 S = (sunTop * sunUp * sun * mix(1.0, powder, 0.5) + amb) * sigma;
        if (focusThis) S = mix(S, AMBER * luma(S) * 1.6, 0.5 * uFocusAmount);
        if (focusOther) S *= 1.0 - 0.45 * uFocusAmount;
        float tr = exp(-sigma * dt);
        vec3 Sint = (S - S * tr) / max(sigma, 1e-8);
        res.light += res.trans * Sint;
        depthW += res.trans * (1.0 - tr);
        res.depth += t * res.trans * (1.0 - tr);
        res.trans *= tr;
      }
      t += dt;
    }
  }
  res.depth = depthW > 1e-4 ? res.depth / depthW : 0.0;
  return res;
}

// ---------------------------------------------------------------- haze and fog

// Optical depth of the ground haze along a ray, height-exponential (flat-Earth form).
float hazeOD(vec3 rd, float t) {
  float H = uHazeHeight;
  float base = uHazeBeta * exp(-EYE / H);
  float k = rd.y / H;
  if (abs(k * t) < 1e-4) return base * t;
  return base * (1.0 - exp(-k * t)) / k;
}

// ---------------------------------------------------------------- stars (decorative)

vec3 stars(vec3 rd, float pixelAngle) {
  vec3 col = vec3(0.0);
  for (int s = 0; s < 2; s++) {
    float scale = s == 0 ? 60.0 : 150.0;
    vec3 p = rd * scale;
    vec3 cell = floor(p);
    vec3 h = hash3(cell + float(s) * 131.0);
    float density = s == 0 ? 0.05 : 0.07;
    if (h.x > density) continue;
    vec3 center = normalize(cell + 0.25 + 0.5 * hash3(cell + 17.0));
    float ang = acos(clamp(dot(rd, center), -1.0, 1.0));
    float sigma = pixelAngle * 0.75;
    float mag = s == 0 ? pow(h.y, 10.0) * 1.2 + 0.04 : pow(h.y, 6.0) * 0.12 + 0.012;
    float twinkle = 1.0 + 0.2 * sin(uTime * (1.3 + h.z * 3.0) + h.y * 40.0);
    vec3 tint = h.z < 0.75 ? mix(vec3(0.82, 0.88, 1.0), vec3(1.0), h.z / 0.75) : mix(vec3(1.0), vec3(1.0, 0.82, 0.62), (h.z - 0.75) / 0.25);
    col += tint * mag * twinkle * exp(-0.5 * (ang * ang) / (sigma * sigma));
  }
  return col * 0.02;
}

// ---------------------------------------------------------------- precipitation (screen space)

float streaks(vec2 frag, float intensity, int kind) {
  float acc = 0.0;
  vec2 res = uResolution;
  float slant = clamp(dot(uDrift, vec2(uCamera[0][0], uCamera[0][2])) * 0.02, -0.5, 0.5);
  for (int k = 0; k < 3; k++) {
    float fk = float(k);
    vec2 uv = frag / res.y;
    if (kind == 2) {
      // Snow: soft flakes drifting down.
      vec2 g = uv * (14.0 + fk * 10.0);
      g.y += uTime * (0.35 + fk * 0.2);
      g.x += sin(uTime * 0.5 + g.y * 0.8 + fk) * 0.3 + g.y * slant;
      vec2 cell = floor(g);
      vec3 h = hash3(vec3(cell, fk + 5.0));
      if (h.x < intensity * 0.55) {
        vec2 f = fract(g) - (0.2 + 0.6 * h.yz);
        acc += smoothstep(0.09 - fk * 0.02, 0.0, length(f)) * (0.6 - fk * 0.15);
      }
    } else {
      // Rain: thin, fast streaks, slanted by the wind across the view.
      vec2 g = uv * vec2(55.0 + fk * 30.0, 3.0 + fk * 1.5);
      g.y += uTime * (5.5 + fk * 2.0);
      g.x += g.y * slant;
      vec2 cell = floor(g);
      vec3 h = hash3(vec3(cell, fk + 1.0));
      if (h.x < intensity * 0.28) {
        vec2 f = fract(g);
        float x = abs(f.x - (0.2 + 0.6 * h.y));
        float len = 0.18 + 0.25 * h.z;
        float y = f.y - (1.0 - len) * h.z;
        acc += smoothstep(0.06, 0.0, x) * smoothstep(0.0, 0.1, y) * smoothstep(len, len - 0.2, y) * (0.5 - fk * 0.12);
      }
    }
  }
  return acc;
}

// ---------------------------------------------------------------- output

// Exponential tone curve with a slight shoulder: linear in the darks (night stays readable),
// soft roll-off in the highlights (the sun and bright cloud tops).
vec3 tonemap(vec3 x) {
  return 1.0 - exp(-x);
}

// One broad falloff per text block: a squircle (|x|³ + |y|³ = 1) centred on a screen corner or
// edge, sized (in scrim.ts) so the whole block sits inside its full-strength part, then fading
// out by twice that radius. Anchored to the frame, it reads as a window's vignette, not a card.
float blockMask(vec2 frag, vec4 b) {
  vec3 d = vec3(abs(frag - b.xy) / max(b.zw, vec2(1.0)), 0.0);
  float r = pow(d.x * d.x * d.x + d.y * d.y * d.y, 1.0 / 3.0);
  return 1.0 - smoothstep(1.0, 2.0, r);
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 ndc = (frag / uResolution) * 2.0 - 1.0;
  float aspect = uResolution.x / uResolution.y;
  vec3 rd = normalize(uCamera * vec3(ndc.x * uTanHalfFov * aspect, ndc.y * uTanHalfFov, 1.0));
  float pixelAngle = 2.0 * uTanHalfFov / uResolution.y;
  float jitter = hash3(vec3(frag, 11.0)).x;

  if (uProbe == 1) {
    // Test hook (?probe=below): an orthographic view straight up from under a square uProbeSpan
    // wide, writing cloud opacity. The smoke test uses it to measure the cover each report gives.
    vec2 off = (frag / uResolution - 0.5) * uProbeSpan;
    Clouds cp = marchClouds(off, vec3(0.0, 1.0, 0.0), vec3(0.0), vec3(0.0), vec3(0.0), jitter, 0.0);
    outColor = vec4(vec3(1.0 - cp.trans), 1.0);
    return;
  }

  float cosT = dot(rd, uSunDir);
  vec3 ambient = uSkyAmbient;

  // Mean-field cloud shading of the world below the clouds: more cover, less direct sun.
  // VV (sky obscured) counts as a full deck: the fog hides the sky and lights everything grey.
  float shade = 1.0;
  float maxCover = uObscured;
  for (int i = 0; i < 4; i++) {
    if (i >= uLayerCount) break;
    float c = uLayers[i].z;
    shade *= 1.0 - 0.75 * c;
    maxCover = max(maxCover, c);
  }
  vec3 sunGround = sunlightAt(0.0) * shade * smoothstep(-0.01, 0.02, uSunDir.y);
  // Under a deck, diffuse light is grey cloud-base light rather than blue sky.
  vec3 deckLight = vec3(luma(sunlightAt(1500.0)) * max(uSunDir.y, 0.0) * 0.09 + luma(ambient) * 0.55);
  vec3 ambientBelow = mix(ambient, deckLight, maxCover * 0.85);
  float night = smoothstep(-0.02, -0.12, uSunDir.y);
  vec3 glow = GROUND_GLOW * night;

  // Vertical optical depth of the haze or fog column (β·H). Deep fog hides the sun's direct beam.
  float fogTau = uHazeBeta * uHazeHeight;
  float fogSun = exp(-fogTau / max(uSunDir.y, 0.05));
  // How much of the light in the haze has been scattered more than once: with scattering events
  // Poisson-distributed along optical depth τ, P(two or more) = 1 − (1 + τ)e^−τ. About 0 in clear
  // air, 0.1 in a 4.5 km haze, 0.98 in VV fog. Multiply scattered light has lost the sky's blue
  // (droplets scatter every colour alike), so sky light fades toward its own grey as fog deepens.
  float multi = 1.0 - (1.0 + fogTau) * exp(-fogTau);
  vec3 fogAmbient = mix(ambientBelow, vec3(luma(ambientBelow)), multi);
  // Sunlight that diffuses down through the fog: the two-stream transmission of a non-absorbing,
  // forward-scattering layer (g ≈ 0.85), 1 / (1 + ¾(1 − g)τ). Spread over all directions and
  // with about half lost into the dark ground, its radiance is E·T / 2π. This keeps daytime fog
  // bright white-grey instead of dark or sky-blue.
  vec3 sunTopOfFog = sunlightAt(uHazeHeight) * shade * smoothstep(-0.01, 0.02, uSunDir.y);
  vec3 sunDiffuse = sunTopOfFog * max(uSunDir.y, 0.0) / (1.0 + 0.1125 * fogTau) / (2.0 * PI);
  // Haze light: direct sun through a forward-peaked phase function, sky light, and the diffuse sun.
  vec3 fogLight = uHazeTint * (sunGround * fogSun * hg(cosT, 0.6) + fogAmbient * 0.85 + sunDiffuse * multi) + glow * 0.8;

  vec3 col;
  float tHit;
  vec2 ground = shell(EYE, rd.y, 0.0);
  bool hitsGround = rd.y < 0.0 && ground.x > 0.0;

  vec3 skyTrans = vec3(1.0);
  if (hitsGround) {
    tHit = ground.x;
    // Plain dark ground; albedo varies a little so distance reads. Not the real terrain.
    vec3 gp = rd * tHit;
    float v = textureLod(uNoise, vec3(gp.xz / 9000.0, 0.73), log2(max(1.0, tHit * pixelAngle / 140.0))).b;
    vec3 albedo = mix(vec3(0.02, 0.023, 0.022), vec3(0.036, 0.037, 0.033), v);
    col = albedo / PI * (sunGround * fogSun * max(uSunDir.y, 0.0) + ambientBelow * PI * 0.8);
    col *= exp(-(BETA_R + BETA_M_E) * tHit);
    col += skyScatter(rd, max(3, uSkySteps / 2), 0.5);
  } else {
    tHit = 1e9;
    col = skyScatter(rd, uSkySteps, 0.5);
    // Airglow is brighter toward the horizon.
    col += NIGHT_SKY * (1.0 + 2.5 * pow(1.0 - max(rd.y, 0.0), 4.0));
    vec3 viewT = transmittance(EYE, rd.y);
    col += stars(rd, pixelAngle) * smoothstep(-0.05, -0.2, uSunDir.y) * viewT;
    // Sun disc with limb darkening, only when the position is really known.
    if (uSunKnown > 0.5 && cosT > SUN_COS_RADIUS - 2e-6) {
      float r = sqrt(max(0.0, 1.0 - cosT * cosT)) / sqrt(1.0 - SUN_COS_RADIUS * SUN_COS_RADIUS);
      float edge = smoothstep(1.0 + pixelAngle / 0.00465, 1.0 - pixelAngle / 0.00465, r);
      float limb = 1.0 - 0.6 * (1.0 - sqrt(max(0.0, 1.0 - min(r, 1.0) * min(r, 1.0))));
      col += SUN_E * 1800.0 * viewT * limb * edge;
    }
    skyTrans = viewT;
  }

  // Clouds in front of the sky.
  Clouds cl = marchClouds(vec2(0.0), rd, ambient, ambientBelow, glow, jitter, pixelAngle);
  float cloudAlpha = 1.0 - cl.trans;

  // Haze between the camera and whatever the ray reaches.
  float odAll = hazeOD(rd, min(tHit, 400000.0));
  float tAll = exp(-odAll);
  vec3 lit = col * tAll + fogLight * (1.0 - tAll);
  if (cloudAlpha > 0.0) {
    float tc = exp(-hazeOD(rd, cl.depth));
    vec3 cloudCol = cl.light * tc + fogLight * (1.0 - tc) * cloudAlpha;
    lit = cloudCol + cl.trans * lit;
  }
  if (uFocus == 2 || uFocus == 5) {
    float haze = uFocus == 5 ? 1.0 : 1.0 - tAll;
    lit = mix(lit, AMBER * max(luma(lit), 0.02) * 1.7, haze * 0.75 * uFocusAmount);
  }

  // Precipitation below the clouds.
  if (uPrecip.x > 0.5 && uPrecip.y > 0.0) {
    float s = streaks(frag, uPrecip.y, int(uPrecip.x + 0.5));
    vec3 pc = (ambientBelow * 0.9 + sunGround * 0.05 + glow * 4.0) * (uFocus == 6 ? mix(vec3(1.0), AMBER * 2.0, uFocusAmount) : vec3(1.0));
    lit += pc * s * 0.22;
  }

  // Wind highlight: tracer dashes on a plane 800 m up, moving with the drift.
  if (uFocus == 3 && rd.y > 0.02) {
    float t = shell(EYE, rd.y, 800.0).y;
    vec2 xz = (rd * t).xz;
    vec2 w = length(uDrift) > 0.01 ? normalize(uDrift) : vec2(0.0);
    float along = dot(xz, w) / 900.0 - uTime * max(length(uDrift), 0.5) / 900.0 * 6.0;
    float across = dot(xz, vec2(-w.y, w.x)) / 900.0;
    float lane = smoothstep(0.06, 0.0, abs(fract(across) - 0.5));
    float dash = smoothstep(0.35, 0.5, fract(along)) * smoothstep(1.0, 0.8, fract(along));
    float fade = exp(-t / 15000.0) * (length(uDrift) > 0.01 ? 1.0 : 0.0);
    lit += AMBER * lane * dash * fade * uFocusAmount * 0.6 * max(luma(ambient), 0.05) * 6.0;
  }
  // Sun / time highlight: a ring around the sun's true position.
  if ((uFocus == 4) && uSunKnown > 0.5) {
    float ang = acos(clamp(cosT, -1.0, 1.0));
    float ring = smoothstep(pixelAngle * 1.5, 0.0, abs(ang - 0.035));
    lit += AMBER * ring * uFocusAmount * 3.0 * max(luma(ambient), 0.03);
  }
  if (uFocus == 7) {
    lit = mix(lit, lit * vec3(1.15, 1.02, 0.8), 0.5 * uFocusAmount * (hitsGround ? 0.0 : 1.0));
  }

  // A gentle vignette, like the edge of a window; it also makes the text dimming below less obvious.
  vec2 vq = frag / uResolution - 0.5;
  float vig = 1.0 - 0.32 * smoothstep(0.2, 0.85, dot(vq * vec2(aspect, 1.0), vq * vec2(aspect, 1.0)) / (0.25 * aspect * aspect + 0.25) * 1.6);
  vec3 mapped = tonemap(lit * uExposure * vig);
  // A touch of saturation back after the tone curve (it desaturates bright colours).
  mapped = clamp(mix(vec3(luma(mapped)), mapped, 1.12), 0.0, 1.0);

  // Legibility: behind text, compress relative luminance so it never exceeds uLumaLimit
  // (WCAG contrast is computed on these linear values). The compression is smooth and fades
  // out over a wide margin from the frame's edge, so it reads as a vignette rather than a box.
  float m = 0.0;
  for (int i = 0; i < 3; i++) {
    if (i >= uTextBlockCount) break;
    m = max(m, blockMask(frag, uTextBlocks[i]));
  }
  float Y = luma(mapped);
  if (m > 0.0 && Y > 1e-5) {
    // Inside a block (m = 1) this is ≤ uLumaLimit for any Y; outside it fades to no change. The
    // fade is in stops (log luminance), like a lens vignette, so no edge shows.
    float Yc = min(Y, uLumaLimit * (1.0 - exp(-Y / uLumaLimit)));
    mapped *= pow(Yc / Y, m);
  }

  // Exact sRGB encoding, so the displayed luminance equals `mapped` (what the limit above assumes).
  vec3 srgb = mix(mapped * 12.92, 1.055 * pow(mapped, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, mapped));
  // Dither to hide banding in smooth gradients (below 1/255 per channel).
  vec3 dn = hash3(vec3(frag, 3.0)) - 0.5;
  srgb += dn / 255.0;
  outColor = vec4(srgb, 1.0);
}
