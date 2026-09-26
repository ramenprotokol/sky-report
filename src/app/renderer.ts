/**
 * WebGL2 host for the sky shader: builds the 3D noise texture on the GPU, keeps the
 * uniforms, sizes the canvas for the quality tier, and runs (or pauses) the frame loop.
 */
import vertSrc from '../shaders/fullscreen.vert';
import skySrc from '../shaders/sky.frag';
import noiseSrc from '../shaders/noise.frag';
import { TIERS, TierController, backingSize, type Tier } from '../scene/quality.ts';
import type { UniformValue } from '../scene/mapping.ts';

const NOISE_SIZE = 64;
export const MAX_TEXT_RECTS = 12;
/**
 * Relative luminance cap for the sky behind text. With --ink (L≈0.86) that is ≥ 6:1 and with
 * --ink-2 (L≈0.67) ≥ 4.7:1, so body and caption text meet WCAG AA whatever the sky does.
 */
export const LUMA_LIMIT = 0.1;

/** In-place histogram equalisation of each RGBA channel. */
export function equalise(data: Uint8Array): void {
  const n = data.length / 4;
  for (let c = 0; c < 4; c++) {
    const hist = new Uint32Array(256);
    for (let i = c; i < data.length; i += 4) hist[data[i]!]! += 1;
    const lut = new Uint8Array(256);
    let acc = 0;
    for (let v = 0; v < 256; v++) {
      const h = hist[v]!;
      // Map each value to the middle of its rank range.
      lut[v] = Math.min(255, Math.round(((acc + h / 2) / n) * 255));
      acc += h;
    }
    for (let i = c; i < data.length; i += 4) data[i] = lut[data[i]!]!;
  }
}

interface UniformSlot {
  loc: WebGLUniformLocation;
  type: number;
}

export interface RendererOptions {
  /** Freeze drift and render only on change (prefers-reduced-motion, or still mode). */
  still: boolean;
  startTier: number;
  lockedTier: boolean;
  onTierChange?: (tier: Tier, index: number) => void;
  onFrame?: (ms: number) => void;
  onDraw?: () => void;
}

export class SkyRenderer {
  private gl: WebGL2RenderingContext;
  private canvas: HTMLCanvasElement;
  private sky: WebGLProgram;
  private uniforms = new Map<string, UniformSlot>();
  private values = new Map<string, UniformValue>();
  private noise: WebGLTexture;
  private vao: WebGLVertexArrayObject;
  private raf = 0;
  private lastFrame = 0;
  private time = 0;
  private still: boolean;
  private dirty = true;
  private focusTarget = 0;
  private focusAmount = 0;
  private cssW = 1;
  private cssH = 1;
  private textRects: DOMRect[] = [];
  readonly controller: TierController;
  private opts: RendererOptions;
  private camera: number[] = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  private disposed = false;

  constructor(canvas: HTMLCanvasElement, opts: RendererOptions) {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: 'default' });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;
    this.canvas = canvas;
    this.opts = opts;
    this.still = opts.still;
    this.controller = new TierController(opts.startTier);
    if (opts.lockedTier) this.controller.lock(opts.startTier);

    this.vao = gl.createVertexArray()!;
    this.sky = this.program(vertSrc, skySrc);
    this.noise = this.buildNoise();
    this.collectUniforms();
  }

  private compile(type: number, src: string): WebGLShader {
    const gl = this.gl;
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s) ?? '';
      gl.deleteShader(s);
      throw new Error(`Shader failed to compile: ${log.slice(0, 400)}`);
    }
    return s;
  }

  private program(vs: string, fs: string): WebGLProgram {
    const gl = this.gl;
    const p = gl.createProgram()!;
    gl.attachShader(p, this.compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, this.compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error(`Shader failed to link: ${(gl.getProgramInfoLog(p) ?? '').slice(0, 400)}`);
    }
    return p;
  }

  /** Render the tileable noise volume slice by slice (64 small draws, once). */
  private buildNoise(): WebGLTexture {
    const gl = this.gl;
    const prog = this.program(vertSrc, noiseSrc);
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_3D, tex);
    gl.texStorage3D(gl.TEXTURE_3D, 1 + Math.log2(NOISE_SIZE), gl.RGBA8, NOISE_SIZE, NOISE_SIZE, NOISE_SIZE);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.useProgram(prog);
    gl.bindVertexArray(this.vao);
    gl.viewport(0, 0, NOISE_SIZE, NOISE_SIZE);
    gl.uniform1f(gl.getUniformLocation(prog, 'uSize'), NOISE_SIZE);
    const sliceLoc = gl.getUniformLocation(prog, 'uSlice');
    const slice = NOISE_SIZE * NOISE_SIZE * 4;
    const voxels = new Uint8Array(slice * NOISE_SIZE);
    for (let z = 0; z < NOISE_SIZE; z++) {
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, tex, 0, z);
      gl.uniform1f(sliceLoc, z);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.readPixels(0, 0, NOISE_SIZE, NOISE_SIZE, gl.RGBA, gl.UNSIGNED_BYTE, voxels.subarray(z * slice, (z + 1) * slice));
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    gl.deleteProgram(prog);
    // Histogram-equalise each channel so its values are uniform on [0, 1]. Then "keep the top
    // c of the noise" covers a fraction c of the sky, which is how coverage is applied.
    equalise(voxels);
    gl.texSubImage3D(gl.TEXTURE_3D, 0, 0, 0, 0, NOISE_SIZE, NOISE_SIZE, NOISE_SIZE, gl.RGBA, gl.UNSIGNED_BYTE, voxels);
    gl.generateMipmap(gl.TEXTURE_3D);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    for (const w of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, w, gl.REPEAT);
    return tex;
  }

  private collectUniforms(): void {
    const gl = this.gl;
    const n = gl.getProgramParameter(this.sky, gl.ACTIVE_UNIFORMS) as number;
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(this.sky, i);
      if (!info) continue;
      const name = info.name.replace(/\[0\]$/, '');
      const loc = gl.getUniformLocation(this.sky, info.name);
      if (loc) this.uniforms.set(name, { loc, type: info.type });
    }
  }

  private apply(name: string, value: UniformValue): void {
    const gl = this.gl;
    const slot = this.uniforms.get(name);
    if (!slot) return;
    const arr = Array.isArray(value) ? value : [value];
    switch (slot.type) {
      case gl.FLOAT:
        gl.uniform1fv(slot.loc, arr);
        break;
      case gl.FLOAT_VEC2:
        gl.uniform2fv(slot.loc, arr);
        break;
      case gl.FLOAT_VEC3:
        gl.uniform3fv(slot.loc, arr);
        break;
      case gl.FLOAT_VEC4:
        gl.uniform4fv(slot.loc, arr);
        break;
      case gl.FLOAT_MAT3:
        gl.uniformMatrix3fv(slot.loc, false, arr);
        break;
      case gl.INT:
      case gl.SAMPLER_3D:
        gl.uniform1iv(slot.loc, arr.map((x) => Math.round(x)));
        break;
      default:
        break;
    }
  }

  setScene(values: Record<string, UniformValue>, camera: number[]): void {
    for (const [k, v] of Object.entries(values)) this.values.set(k, v);
    this.camera = camera;
    this.invalidate();
  }

  setFocus(kind: number, index: number): void {
    const prevKind = this.values.get('uFocus');
    if (kind === 0) {
      this.focusTarget = 0;
    } else {
      if (prevKind !== kind || this.values.get('uFocusIndex') !== index) this.focusAmount = this.still ? 1 : Math.min(this.focusAmount, 0.2);
      this.values.set('uFocus', kind);
      this.values.set('uFocusIndex', index);
      this.focusTarget = 1;
    }
    if (this.still) this.focusAmount = this.focusTarget;
    if (kind === 0 && this.still) this.values.set('uFocus', 0);
    this.invalidate();
  }

  setTextRects(rects: DOMRect[]): void {
    this.textRects = rects.slice(0, MAX_TEXT_RECTS);
    this.invalidate();
  }

  setStill(still: boolean): void {
    this.still = still;
    this.invalidate();
  }

  setTier(index: number): void {
    this.controller.lock(index);
    this.resize();
  }

  get tier(): Tier {
    return this.controller.tier;
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.cssW = Math.max(1, rect.width);
    this.cssH = Math.max(1, rect.height);
    const { w, h } = backingSize(this.cssW, this.cssH, window.devicePixelRatio || 1, this.tier);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.controller.reset();
    this.invalidate();
  }

  invalidate(): void {
    this.dirty = true;
    this.schedule();
  }

  private schedule(): void {
    if (this.raf || this.disposed) return;
    this.raf = requestAnimationFrame((ts) => this.frame(ts));
  }

  private frame(ts: number): void {
    this.raf = 0;
    const dt = this.lastFrame ? ts - this.lastFrame : 0;
    this.lastFrame = ts;
    if (!this.still) {
      this.time += Math.min(dt, 100) / 1000;
      // Ease the highlight in and out.
      const k = 1 - Math.exp(-Math.min(dt, 100) / 90);
      this.focusAmount += (this.focusTarget - this.focusAmount) * k;
      if (this.focusTarget === 0 && this.focusAmount < 0.01) {
        this.focusAmount = 0;
        this.values.set('uFocus', 0);
      }
      if (dt > 0) {
        this.opts.onFrame?.(dt);
        const change = this.controller.sample(dt);
        if (change !== null) {
          this.resize();
          this.opts.onTierChange?.(TIERS[change]!, change);
        }
      }
    }
    if (this.still && !this.dirty) return;
    this.draw();
    this.dirty = false;
    if (!this.still) this.schedule();
    else this.lastFrame = 0;
  }

  private draw(): void {
    const gl = this.gl;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const tier = this.tier;
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.sky);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_3D, this.noise);

    const aspect = w / h;
    // Landscape: 58° vertical field of view. Portrait: widen so the view is not a slot.
    const tanHalf = Math.min(Math.tan((40 * Math.PI) / 180), Math.max(Math.tan((29 * Math.PI) / 180), Math.tan((22 * Math.PI) / 180) / aspect));

    const sx = w / this.cssW;
    const sy = h / this.cssH;
    const rects: number[] = [];
    for (const r of this.textRects) rects.push(r.left * sx, h - r.bottom * sy, r.right * sx, h - r.top * sy);
    while (rects.length < MAX_TEXT_RECTS * 4) rects.push(0, 0, 0, 0);

    const frameValues: Record<string, UniformValue> = {
      uResolution: [w, h],
      uTime: this.time,
      uCamera: this.camera,
      uTanHalfFov: tanHalf,
      uSteps: tier.steps,
      uLightSteps: tier.lightSteps,
      uSkySteps: tier.skySteps,
      uNoise: 0,
      uFocusAmount: this.focusAmount,
      uTextRects: rects,
      uTextRectCount: this.textRects.length,
      uLumaLimit: LUMA_LIMIT,
    };
    if (!this.values.has('uFocus')) this.values.set('uFocus', 0);
    if (!this.values.has('uFocusIndex')) this.values.set('uFocusIndex', -1);
    for (const [k, v] of this.values) this.apply(k, v);
    for (const [k, v] of Object.entries(frameValues)) this.apply(k, v);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.opts.onDraw?.();
  }

  get isStill(): boolean {
    return this.still;
  }

  /** Current backing-store size, for the status line. */
  get backing(): { w: number; h: number } {
    return { w: this.canvas.width, h: this.canvas.height };
  }

  dispose(): void {
    this.disposed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }
}
