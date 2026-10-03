/** GPU-перенос ряби по карте скорости; основной мир остаётся Canvas 2D. */
export class WaterFlowShader {
  readonly canvas = document.createElement('canvas');
  private gl: WebGLRenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private field: WebGLTexture | null = null;
  private ripple: WebGLTexture | null = null;
  private available = false;
  private viewKey = '';
  private fieldStep = -1;
  private builtAt = -Infinity;
  private velocityScale = 1;
  private bytes = new Uint8Array(0);
  private samples = new Float32Array(0);
  private uniform = new Map<string, WebGLUniformLocation>();

  constructor(source: HTMLCanvasElement) {
    this.canvas.addEventListener('webglcontextlost', (event) => { event.preventDefault(); this.available = false; });
    this.canvas.addEventListener('webglcontextrestored', () => this.init(source));
    this.init(source);
  }
  reset(): void { this.viewKey = ''; this.fieldStep = -1; this.builtAt = -Infinity; }

  private init(source: HTMLCanvasElement): void {
    this.available = false;
    try {
      const gl = this.canvas.getContext('webgl', { alpha: true, antialias: false, depth: false, stencil: false, premultipliedAlpha: false });
      if (!gl) return;
      this.gl = gl;
      const compile = (type: number, code: string) => {
        const shader = gl.createShader(type)!;
        gl.shaderSource(shader, code); gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
          const message = gl.getShaderInfoLog(shader); gl.deleteShader(shader);
          throw new Error(`Water flow shader compilation failed: ${message}`);
        }
        return shader;
      };
      const vertex = compile(gl.VERTEX_SHADER, `attribute vec2 position; varying vec2 uv;
        void main() { uv = vec2(position.x * .5 + .5, .5 - position.y * .5); gl_Position = vec4(position, 0., 1.); }`);
      const fragment = compile(gl.FRAGMENT_SHADER, `precision highp float;
        varying vec2 uv; uniform sampler2D field; uniform sampler2D ripple;
        uniform vec4 bounds; uniform float time; uniform float velocityScale;
        float pattern(vec2 p, vec2 velocity, float phase, float size) {
          float a = fract(phase), b = fract(phase + .5);
          float blend = abs(a * 2. - 1.);
          float first = texture2D(ripple, (p - velocity * (a - .5) * 8.) / size).a;
          float second = texture2D(ripple, (p - velocity * (b - .5) * 8.) / size).a;
          return mix(first, second, blend);
        }
        void main() {
          vec4 flow = texture2D(field, uv);
          vec2 encodedVelocity = vec2(flow.r * 65280. + flow.g * 255., flow.b * 65280. + flow.a * 255.);
          vec2 velocity = (encodedVelocity - 32768.) / 32767. * velocityScale;
          vec2 p = mix(bounds.xy, bounds.zw, uv);
          float phase = time / 8. + texture2D(ripple, p / 512.).a * .25;
          float lines = pattern(p, velocity, phase, 160.) * .7
            + pattern(p + vec2(37., 61.), velocity, phase + .27, 235.) * .3;
          float speed = length(velocity);
          float contrast = .45 + .55 * speed / (speed + 1.7);
          gl_FragColor = vec4(.78, .9, .89, lines * contrast);
        }`);
      const program = gl.createProgram()!;
      gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program);
      gl.deleteShader(vertex); gl.deleteShader(fragment);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { gl.deleteProgram(program); return; }
      this.program = program; gl.useProgram(program);
      const buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const position = gl.getAttribLocation(program, 'position');
      gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
      this.uniform.clear();
      for (const name of ['field', 'ripple', 'bounds', 'time', 'velocityScale']) {
        const location = gl.getUniformLocation(program, name);
        if (location !== null) this.uniform.set(name, location);
      }
      const texture = (unit: number, repeat: boolean) => {
        const tex = gl.createTexture()!; gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE);
        return tex;
      };
      this.field = texture(0, false); this.ripple = texture(1, true);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      gl.uniform1i(this.uniform.get('field')!, 0); gl.uniform1i(this.uniform.get('ripple')!, 1);
      gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
      this.reset(); this.available = true;
    } catch (error) { this.available = false; console.warn('Water flow uses Canvas 2D fallback', error); }
  }

  draw(width: number, height: number, bounds: readonly number[], step: number, worldStep: number, cell: number,
    sample: (x: number, y: number, out: Float32Array, offset: number) => void): boolean {
    if (!this.available || !this.gl || !this.program) return false;
    const gl = this.gl;
    const scale = Math.min(1, 1024 / Math.max(width, height));
    const rw = Math.max(1, Math.round(width * scale)), rh = Math.max(1, Math.round(height * scale));
    if (this.canvas.width !== rw || this.canvas.height !== rh) { this.canvas.width = rw; this.canvas.height = rh; }
    const cols = Math.max(2, Math.min(128, Math.ceil((bounds[2] - bounds[0]) / cell)));
    const rows = Math.max(2, Math.min(128, Math.ceil((bounds[3] - bounds[1]) / cell)));
    const viewKey = `${bounds.join(':')}:${cols}:${rows}`;
    const now = performance.now();
    if (viewKey !== this.viewKey || (worldStep !== this.fieldStep && now - this.builtAt >= 100)) {
      this.viewKey = viewKey; this.fieldStep = worldStep; this.builtAt = now;
      if (this.bytes.length !== cols * rows * 4) { this.bytes = new Uint8Array(cols * rows * 4); this.samples = new Float32Array(cols * rows * 2); }
      let max = 0.1;
      for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
        const wx = bounds[0] + (bounds[2] - bounds[0]) * (x + .5) / cols;
        const wy = bounds[1] + (bounds[3] - bounds[1]) * (y + .5) / rows;
        const k = (y * cols + x) * 2; sample(wx, wy, this.samples, k);
        max = Math.max(max, Math.abs(this.samples[k]), Math.abs(this.samples[k + 1]));
      }
      this.velocityScale = max;
      for (let k = 0, q = 0; k < this.bytes.length; k += 4, q += 2) {
        const vx = Math.round(this.samples[q] / max * 32767 + 32768);
        const vy = Math.round(this.samples[q + 1] / max * 32767 + 32768);
        this.bytes[k] = vx >> 8; this.bytes[k + 1] = vx & 255;
        this.bytes[k + 2] = vy >> 8; this.bytes[k + 3] = vy & 255;
      }
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.field);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, cols, rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, this.bytes);
    }
    gl.viewport(0, 0, rw, rh); gl.useProgram(this.program);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.field);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.ripple);
    gl.uniform4f(this.uniform.get('bounds')!, bounds[0], bounds[1], bounds[2], bounds[3]);
    gl.uniform1f(this.uniform.get('time')!, (step / 10) % 4096);
    gl.uniform1f(this.uniform.get('velocityScale')!, this.velocityScale);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return !gl.isContextLost();
  }
}
