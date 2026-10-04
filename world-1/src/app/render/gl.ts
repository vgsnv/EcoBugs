/** Небольшой слой над WebGL2: программы и текстуры с версиями. */

export interface Program {
  readonly program: WebGLProgram;
  readonly uniform: (name: string) => WebGLUniformLocation | null;
}

export function createProgram(gl: WebGL2RenderingContext, vertex: string, fragment: string): Program {
  const compile = (type: number, code: string) => {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, code);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS) && !gl.isContextLost()) {
      const message = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(`Шейдер не собрался: ${message}`);
    }
    return shader;
  };
  const vs = compile(gl.VERTEX_SHADER, vertex), fs = compile(gl.FRAGMENT_SHADER, fragment);
  const program = gl.createProgram()!;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  // Вершины прямоугольника — всегда в атрибуте 0, атрибуты спрайтов — в 1…3: программы
  // спрайтов и следов делят один набор атрибутов (VAO), номера у них должны совпадать.
  gl.bindAttribLocation(program, 0, 'a_pos');
  ['a_sprite', 'a_color', 'a_shape'].forEach((name, i) => gl.bindAttribLocation(program, i + 1, name));
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) throw new Error(`Программа не собралась: ${gl.getProgramInfoLog(program)}`);
  const locations = new Map<string, WebGLUniformLocation | null>();
  return {
    program,
    uniform: (name) => {
      if (!locations.has(name)) locations.set(name, gl.getUniformLocation(program, name));
      return locations.get(name)!;
    },
  };
}

/** Источник текстуры: холст, картинка, байты RGBA или сетка чисел (см. `format`). */
export type TextureSource = TexImageSource | { readonly data: Uint8Array | Uint8ClampedArray | Float32Array; readonly width: number; readonly height: number };

export interface TextureOptions {
  /** Повторять по краям (узоры) вместо обрезки. */
  readonly repeat?: boolean;
  /** Умножить цвет на альфу при загрузке — для смешивания и сглаживания как у Canvas. */
  readonly premultiply?: boolean;
  /** Без сглаживания (клетки видны как есть). */
  readonly nearest?: boolean;
  /** Сетка чисел: одно число на клетку (r16f — сглаживается, r8 — байт), два (rg32f — только точное чтение). */
  readonly format?: 'r16f' | 'rgba16f' | 'rg32f' | 'rgba32f' | 'r8';
}

/**
 * Текстуры по ключу-объекту: загружаются заново, только когда меняется версия
 * источника. Ключи, которые больше не нужны, освобождаются явно (`release`).
 * Загрузка идёт через отдельный блок UPLOAD_UNIT: иначе она подменила бы
 * текстуру, уже привязанную к активному блоку для шейдера.
 */
const UPLOAD_UNIT = 15;

export class Textures {
  private readonly entries = new Map<object, { texture: WebGLTexture; version: number }>();
  private readonly gl: WebGL2RenderingContext;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
  }

  get(key: object, source: TextureSource, version: number, options: TextureOptions = {}): WebGLTexture {
    const gl = this.gl;
    let entry = this.entries.get(key);
    if (entry && entry.version === version) return entry.texture;
    gl.activeTexture(gl.TEXTURE0 + UPLOAD_UNIT);
    if (!entry) {
      const texture = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      const filter = options.nearest ? gl.NEAREST : gl.LINEAR;
      const wrap = options.repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
      entry = { texture, version };
      this.entries.set(key, entry);
    }
    entry.version = version;
    gl.bindTexture(gl.TEXTURE_2D, entry.texture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, !!options.premultiply && !options.format);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if ('data' in source) {
      const { data, width, height } = source;
      if (options.format === 'r16f') gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, width, height, 0, gl.RED, gl.FLOAT, data as Float32Array);
      else if (options.format === 'rgba16f') gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.FLOAT, data as Float32Array);
      else if (options.format === 'rg32f') gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, width, height, 0, gl.RG, gl.FLOAT, data as Float32Array);
      else if (options.format === 'rgba32f') gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, data as Float32Array);
      else if (options.format === 'r8') gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, width, height, 0, gl.RED, gl.UNSIGNED_BYTE, data as Uint8Array);
      else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data instanceof Uint8Array ? data : new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    }
    return entry.texture;
  }

  release(key: object): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.gl.deleteTexture(entry.texture);
    this.entries.delete(key);
  }

  /** После потери контекста все текстуры недействительны. */
  forget(): void {
    this.entries.clear();
  }
}
