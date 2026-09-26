#version 300 es
// Builds one z-slice of the tileable 3D noise texture the clouds are carved from.
// R: Perlin-Worley (billowy base shapes)   G: Worley fbm (erosion detail)
// B: Perlin fbm (large-scale variation)     A: fine Worley fbm (edge detail)
precision highp float;
precision highp int;

uniform float uSize;   // texture edge, texels
uniform float uSlice;  // z index being rendered
out vec4 outColor;

uvec3 pcg3d(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}

vec3 hash3(ivec3 c, int seed) {
  uvec3 h = pcg3d(uvec3(c + ivec3(4096)) + uvec3(uint(seed) * 7919u));
  return vec3(h) * (1.0 / 4294967295.0);
}

ivec3 wrap(ivec3 c, int period) {
  return ((c % period) + period) % period;
}

// Tileable gradient noise with integer period, in [-1, 1] roughly.
float perlin(vec3 p, int period, int seed) {
  ivec3 i = ivec3(floor(p));
  vec3 f = fract(p);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float n[8];
  for (int k = 0; k < 8; k++) {
    ivec3 o = ivec3(k & 1, (k >> 1) & 1, (k >> 2) & 1);
    vec3 g = normalize(hash3(wrap(i + o, period), seed) * 2.0 - 1.0 + 1e-4);
    n[k] = dot(g, f - vec3(o));
  }
  float x00 = mix(n[0], n[1], u.x), x10 = mix(n[2], n[3], u.x);
  float x01 = mix(n[4], n[5], u.x), x11 = mix(n[6], n[7], u.x);
  return mix(mix(x00, x10, u.y), mix(x01, x11, u.y), u.z) * 1.15;
}

// Tileable cellular noise: 1 at feature points, falling to 0 between them.
float worley(vec3 p, int period, int seed) {
  ivec3 i = ivec3(floor(p));
  vec3 f = fract(p);
  float d = 1e9;
  for (int z = -1; z <= 1; z++)
    for (int y = -1; y <= 1; y++)
      for (int x = -1; x <= 1; x++) {
        ivec3 o = ivec3(x, y, z);
        vec3 fp = vec3(o) + hash3(wrap(i + o, period), seed);
        vec3 r = fp - f;
        d = min(d, dot(r, r));
      }
  return 1.0 - clamp(sqrt(d), 0.0, 1.0);
}

float perlinFbm(vec3 p, int period, int seed) {
  float s = 0.0, a = 0.5, norm = 0.0;
  for (int o = 0; o < 4; o++) {
    s += a * perlin(p, period, seed + o);
    norm += a;
    p *= 2.0; period *= 2; a *= 0.5;
  }
  return s / norm;
}

float worleyFbm(vec3 p, int period, int seed) {
  return worley(p, period, seed) * 0.625
       + worley(p * 2.0, period * 2, seed + 1) * 0.25
       + worley(p * 4.0, period * 4, seed + 2) * 0.125;
}

float remap(float v, float a, float b, float c, float d) {
  return c + (v - a) * (d - c) / (b - a);
}

void main() {
  vec3 uvw = vec3(gl_FragCoord.xy, uSlice + 0.5) / uSize;

  float pf = perlinFbm(uvw * 4.0, 4, 11) * 0.5 + 0.5;
  float wf = worleyFbm(uvw * 4.0, 4, 23);
  // Perlin-Worley: Perlin fbm pushed up where Worley cells are dense (billows).
  float pw = clamp(remap(pf, wf - 1.0, 1.0, 0.0, 1.0), 0.0, 1.0);

  float g = worleyFbm(uvw * 8.0, 8, 37);
  float b = perlinFbm(uvw * 2.0, 2, 53) * 0.5 + 0.5;
  float a = worleyFbm(uvw * 16.0, 16, 71);

  outColor = vec4(pw, g, clamp(b, 0.0, 1.0), a);
}
