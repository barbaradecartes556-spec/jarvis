// J.A.R.V.I.S. 3D 全息核心（Three.js + 泛光）
// 读取 index.html 里 window.JARVIS 暴露的状态：音量 amp、状态 state、主题色 rgb、鼠标视差 pm
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

const J = window.JARVIS;
const canvas = document.createElement('canvas');
canvas.id = 'gl';
document.body.appendChild(canvas);

let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
} catch (e) {
  canvas.remove();
  throw e;                       // 没有 WebGL 时保留原来的 2D 效果
}
renderer.setClearColor(0x000000, 1);  // 黑底 + CSS 滤色混合 = 只留下发光部分
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
const holo = new THREE.Group();
scene.add(holo);

const uniforms = {
  uTime: { value: 0 }, uAmp: { value: 0 }, uColor: { value: new THREE.Color(0x4fe3ff) },
  uColor2: { value: new THREE.Color(0xffffff) }, uPixelRatio: { value: renderer.getPixelRatio() },
  uBoost: { value: 1 },
};
const additive = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending };

/* ---------- 1. 粒子球：随声音起伏 ---------- */
{
  const N = 5000, pos = new Float32Array(N * 3), rnd = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const y = 1 - (i / (N - 1)) * 2, r = Math.sqrt(1 - y * y), th = i * Math.PI * (3 - Math.sqrt(5));
    pos.set([Math.cos(th) * r, y, Math.sin(th) * r], i * 3); rnd[i] = Math.random();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aRand', new THREE.BufferAttribute(rnd, 1));
  const m = new THREE.ShaderMaterial({ uniforms, ...additive,
    vertexShader: `
      uniform float uTime, uAmp, uPixelRatio, uBoost; attribute float aRand; varying float vA;
      void main() {
        float n = sin(aRand * 6.283 + uTime * 2.6 + position.y * 5.0) * .5 + .5;
        float wave = sin(position.y * 9.0 - uTime * 4.0) * .5 + .5;
        vec3 p = position * (1.0 + uAmp * (.12 + .35 * n * wave));
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = (2.2 + n * 2.0) * uPixelRatio * (4.5 / -mv.z);
        vA = (.1 + .35 * n) * uBoost;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform vec3 uColor; varying float vA;
      void main() {
        float d = length(gl_PointCoord - .5); if (d > .5) discard;
        gl_FragColor = vec4(uColor, smoothstep(.5, .0, d) * vA);
      }`,
  });
  const pts = new THREE.Points(g, m); pts.name = 'particles'; holo.add(pts);
}

/* ---------- 2. 全息外壳：边缘亮、中间透、扫描线、偶尔闪烁 ---------- */
const shellMat = new THREE.ShaderMaterial({ uniforms: { ...uniforms, uOpacity: { value: 1 } }, ...additive, side: THREE.DoubleSide,
  vertexShader: `
    varying vec3 vN, vV; varying float vY; varying vec3 vP;
    void main() {
      vP = position;
      vN = normalize(normalMatrix * normal);
      vec4 mv = modelViewMatrix * vec4(position, 1.0); vV = normalize(-mv.xyz);
      vY = (modelMatrix * vec4(position, 1.0)).y;
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: `
    uniform vec3 uColor; uniform float uTime, uOpacity, uAmp, uBoost; varying vec3 vN, vV; varying float vY; varying vec3 vP;
    float h(float x) { return fract(sin(x) * 43758.5453); }
    float h2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    // 六边形蜂窝：返回到格子边缘的距离和格子编号
    vec3 hex(vec2 p) {
      vec2 r = vec2(1., 1.732), hr = r * .5;
      vec2 a = mod(p, r) - hr, b = mod(p - hr, r) - hr;
      vec2 g = dot(a, a) < dot(b, b) ? a : b;
      vec2 id = p - g;
      vec2 q = abs(g); float e = .5 - max(dot(q, normalize(r)), q.x);
      return vec3(e, id);
    }
    void main() {
      float f = pow(1.0 - abs(dot(vN, vV)), 4.0);
      float scan = .55 + .45 * smoothstep(.35, .5, fract(vY * 22.0 - uTime * 1.2));
      float glitch = step(.94, h(floor(uTime * 9.0))) * .5;
      // 能量护盾：球面坐标上铺蜂窝，格子随机点亮，说话时从赤道向两极一圈圈扩散
      vec3 n = normalize(vP);
      vec2 uv = vec2(atan(n.z, n.x) * 3.0, asin(n.y) * 6.0);
      vec3 hx = hex(uv * 2.2);
      float edge = smoothstep(.06, .0, hx.x);
      float cell = h2(hx.yz);
      float blink = smoothstep(.75, 1., sin(uTime * (1. + cell * 2.) + cell * 40.));
      float ripple = smoothstep(.15, .0, abs(fract(abs(n.y) * 1.5 - uTime * .9) - .5)) * uAmp * .7;
      float front = step(0., dot(vN, vV));               // 只在朝向镜头的一面画蜂窝，避免前后叠加发白
      float hexA = front * (edge * (.06 + .3 * f + ripple * .3) + blink * edge * .12) + ripple * .03;
      float a = (f * .9 + .004 + uAmp * .06 + hexA) * scan * (1.0 - glitch) * uOpacity * uBoost;
      gl_FragColor = vec4(mix(uColor, vec3(1.), ripple * .3), a);
    }`,
});
const shell = new THREE.Mesh(new THREE.IcosahedronGeometry(1.28, 6), shellMat);
holo.add(shell);
// 外壳上的经纬网格
const wire = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(1.3, 1)),
  new THREE.LineBasicMaterial({ color: 0xffffff, opacity: .04, ...additive }));
holo.add(wire);

/* ---------- 3. 内核发光 ---------- */
const coreMat = new THREE.ShaderMaterial({ uniforms, ...additive,
  vertexShader: `varying vec3 vN, vV; void main(){ vN = normalize(normalMatrix*normal); vec4 mv = modelViewMatrix*vec4(position,1.); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }`,
  fragmentShader: `uniform vec3 uColor; uniform float uAmp, uTime; varying vec3 vN, vV;
    void main(){ float f = pow(abs(dot(vN, vV)), 3.0); gl_FragColor = vec4(mix(uColor, vec3(1.), .25), f * (.22 + uAmp * .5 + sin(uTime*2.)*.04)); }`,
});
const core = new THREE.Mesh(new THREE.SphereGeometry(.2, 32, 32), coreMat);
holo.add(core);

/* ---------- 3b. 经纬线地球仪：正面亮背面暗，扫描带从下往上扫 ---------- */
const globeMat = new THREE.ShaderMaterial({ uniforms: { ...uniforms }, ...additive,
  vertexShader: `varying float vF, vY; void main(){ vec4 mv = modelViewMatrix*vec4(position,1.); vec3 n = normalize(normalMatrix*position);
    vF = dot(n, normalize(-mv.xyz)); vY = position.y; gl_Position = projectionMatrix*mv; }`,
  fragmentShader: `uniform vec3 uColor; uniform float uTime, uAmp, uBoost; varying float vF, vY;
    void main(){ float front = smoothstep(-.35, .6, vF); float band = smoothstep(.12, 0., abs(vY - (fract(uTime*.18)*2.4-1.2)));
      float a = (.08 + .32 * front + band * .55 + uAmp * .06) * uBoost; gl_FragColor = vec4(mix(uColor, vec3(1.), band*.35), a); }`,
});
{
  const R = 1.04, pts = [];
  for (let lat = -75; lat <= 75; lat += 15) {           // 纬线
    const y = Math.sin(lat * Math.PI / 180) * R, r = Math.cos(lat * Math.PI / 180) * R;
    for (let i = 0; i < 96; i++) { const a1 = i / 96 * 6.2832, a2 = (i + 1) / 96 * 6.2832; pts.push(Math.cos(a1)*r, y, Math.sin(a1)*r, Math.cos(a2)*r, y, Math.sin(a2)*r); }
  }
  for (let lon = 0; lon < 180; lon += 15) {              // 经线
    const c = Math.cos(lon * Math.PI / 180), sn = Math.sin(lon * Math.PI / 180);
    for (let i = 0; i < 96; i++) { const a1 = i / 96 * 6.2832, a2 = (i + 1) / 96 * 6.2832;
      pts.push(Math.cos(a1)*R*c, Math.sin(a1)*R, Math.cos(a1)*R*sn, Math.cos(a2)*R*c, Math.sin(a2)*R, Math.cos(a2)*R*sn); }
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  holo.add(new THREE.LineSegments(g, globeMat));
}

/* ---------- 3c. 声波环：贾维斯说话/你说话时跳动 ---------- */
const WAVE_N = 256, waveGeo = new THREE.BufferGeometry(), wavePos = new Float32Array(WAVE_N * 3);
waveGeo.setAttribute('position', new THREE.BufferAttribute(wavePos, 3));
const waveMat = new THREE.LineBasicMaterial({ color: 0xffffff, opacity: .85, ...additive });
const wave = new THREE.LineLoop(waveGeo, waveMat);
const wave2 = new THREE.LineLoop(waveGeo, new THREE.LineBasicMaterial({ color: 0xffffff, opacity: .3, ...additive }));
wave2.scale.setScalar(1.04);
const wavePivot = new THREE.Group(); wavePivot.rotation.x = Math.PI / 2 - .12; wavePivot.add(wave, wave2); holo.add(wavePivot);
function updateWave(t, amp) {
  for (let i = 0; i < WAVE_N; i++) {
    const a = i / WAVE_N * Math.PI * 2;
    const k = Math.sin(a * 7 + t * 5) * .5 + Math.sin(a * 13 - t * 8) * .3 + Math.sin(a * 29 + t * 11) * .2;
    const r = 1.42 + k * (.015 + amp * .28);
    wavePos.set([Math.cos(a) * r, Math.sin(a) * r, 0], i * 3);
  }
  waveGeo.attributes.position.needsUpdate = true;
}

/* ---------- 3d. 数据弧：几段粗细不同的弧线绕球转 ---------- */
const arcs = [];
for (const [r, tube, len, rx, ry, sp, op] of [[1.22, .012, 1.3, .3, 0, .6, .7], [1.3, .006, 2.4, -.5, .8, -.4, .5], [1.75, .018, .6, 1.2, -.3, .9, .6], [1.62, .004, 3.6, .9, .5, -.25, .45]]) {
  const m = new THREE.Mesh(new THREE.TorusGeometry(r, tube, 6, 96, len), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: op, depthWrite: false, blending: THREE.AdditiveBlending }));
  const pv = new THREE.Group(); pv.rotation.set(rx, ry, 0); pv.add(m); holo.add(pv); arcs.push({ m, sp });
}

/* ---------- 4. 虚线光环 ---------- */
function dashedRing(r, w, seg, duty, opacity) {
  const m = new THREE.ShaderMaterial({ uniforms: { ...uniforms, uSeg: { value: seg }, uDuty: { value: duty }, uOp: { value: opacity } }, ...additive, side: THREE.DoubleSide,
    vertexShader: `varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
    fragmentShader: `uniform vec3 uColor; uniform float uSeg, uDuty, uOp; varying vec2 vP;
      void main(){ float a = atan(vP.y, vP.x) / 6.2831853 + .5; if (fract(a * uSeg) > uDuty) discard; gl_FragColor = vec4(uColor, uOp); }`,
  });
  return new THREE.Mesh(new THREE.RingGeometry(r, r + w, 256), m);
}
const rings = [
  { mesh: dashedRing(1.55, .012, 1, 1, .55), axis: new THREE.Euler(1.25, 0, 0), speed: .15 },
  { mesh: dashedRing(1.68, .03, 90, .55, .45), axis: new THREE.Euler(1.35, .2, 0), speed: -.08 },
  { mesh: dashedRing(1.85, .008, 6, .7, .5), axis: new THREE.Euler(.4, 1.1, 0), speed: .35 },
  { mesh: dashedRing(2.05, .02, 3, .22, .8), axis: new THREE.Euler(1.9, -.5, .3), speed: -.5 },
  { mesh: dashedRing(2.3, .006, 160, .3, .35), axis: new THREE.Euler(1.45, 0, 0), speed: .05 },
];
for (const r of rings) {
  const pivot = new THREE.Group(); pivot.rotation.copy(r.axis); pivot.add(r.mesh); holo.add(pivot); r.pivot = pivot;
}
// 刻度环
{
  const pts = [];
  for (let i = 0; i < 120; i++) {
    const a = i / 120 * Math.PI * 2, r1 = 1.95, r2 = r1 + (i % 10 === 0 ? .14 : .05);
    pts.push(Math.cos(a) * r1, Math.sin(a) * r1, 0, Math.cos(a) * r2, Math.sin(a) * r2, 0);
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const ticks = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xffffff, opacity: .45, ...additive }));
  const pivot = new THREE.Group(); pivot.rotation.x = 1.3; pivot.add(ticks); holo.add(pivot);
  rings.push({ mesh: ticks, pivot, speed: .1 });
}

/* ---------- 5. 投影底座 + 光柱 + 上升光点 ---------- */
const BASE_Y = -2.15;
const base = new THREE.Group(); base.position.y = BASE_Y; scene.add(base);
for (const [r, w, seg, duty, op] of [[.55, .02, 1, 1, .9], [.75, .05, 48, .6, .6], [.95, .01, 1, 1, .5], [1.2, .03, 4, .8, .4]]) {
  const m = dashedRing(r, w, seg, duty, op); m.rotation.x = -Math.PI / 2; base.add(m);
}
const padMat = new THREE.ShaderMaterial({ uniforms, ...additive,
  vertexShader: `varying vec2 vU; void main(){ vU = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
  fragmentShader: `uniform vec3 uColor; uniform float uTime; varying vec2 vU;
    void main(){ float d = length(vU - .5) * 2.; float a = smoothstep(1., .0, d) * .22 + smoothstep(.06,.0,abs(fract(d*4. - uTime*.6)-.5)) * .25 * (1.-d);
      gl_FragColor = vec4(uColor, a); }`,
});
const pad = new THREE.Mesh(new THREE.CircleGeometry(1.25, 64), padMat); pad.rotation.x = -Math.PI / 2; base.add(pad);

const beamMat = new THREE.ShaderMaterial({ uniforms, ...additive, side: THREE.DoubleSide,
  vertexShader: `varying vec2 vU; void main(){ vU = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
  fragmentShader: `uniform vec3 uColor; uniform float uTime, uAmp; varying vec2 vU;
    float h(float x){ return fract(sin(x * 91.7) * 43758.5453); }
    void main(){
      float col = floor(vU.x * 140.);
      float streak = smoothstep(.55, 1., h(col)) * (.5 + .5 * sin(vU.y * 9. - uTime * (2. + h(col + 3.) * 4.) + h(col) * 30.));
      float flow = .75 + .25 * sin(vU.x * 70. + uTime * 3.);
      float a = pow(1. - vU.y, 1.4) * (.13 * flow + .22 * streak) * (.85 + uAmp * .8);
      gl_FragColor = vec4(mix(uColor, vec3(1.), streak * .25), a); }`,
});
const BEAM_H = 1.5;
const beam = new THREE.Mesh(new THREE.CylinderGeometry(1.25, .5, BEAM_H, 96, 1, true), beamMat);
beam.position.y = BASE_Y + BEAM_H / 2; scene.add(beam);

{
  const N = 380, pos = new Float32Array(N * 3), rnd = new Float32Array(N);
  for (let i = 0; i < N; i++) { const a = Math.random() * 6.283, r = Math.sqrt(Math.random()) * 1.1; pos.set([Math.cos(a) * r, Math.random(), Math.sin(a) * r], i * 3); rnd[i] = Math.random(); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('aRand', new THREE.BufferAttribute(rnd, 1));
  const m = new THREE.ShaderMaterial({ uniforms: { ...uniforms, uBase: { value: BASE_Y } }, ...additive,
    vertexShader: `uniform float uTime, uBase, uPixelRatio; attribute float aRand; varying float vA;
      void main(){ float t = fract(position.y + uTime * (.08 + aRand * .12)); vec3 p = vec3(position.x * (.5 + t * .7), uBase + t * 3.6, position.z * (.5 + t * .7));
        vec4 mv = modelViewMatrix * vec4(p, 1.); gl_PointSize = (1.5 + aRand * 2.5) * uPixelRatio * (4.5 / -mv.z); vA = sin(t * 3.1416) * (.3 + aRand * .7); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform vec3 uColor; varying float vA; void main(){ float d = length(gl_PointCoord-.5); if (d > .5) discard; gl_FragColor = vec4(uColor, smoothstep(.5,0.,d) * vA); }`,
  });
  scene.add(new THREE.Points(g, m));
}

/* ---------- 6. 激光扫描面：一片光从下往上扫过球体，切面处亮一圈 ---------- */
const sweepMat = new THREE.ShaderMaterial({ uniforms: { ...uniforms, uR: { value: 1 } }, ...additive, side: THREE.DoubleSide,
  vertexShader: `varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
  fragmentShader: `uniform vec3 uColor; uniform float uR, uBoost; varying vec2 vP;
    void main(){ float d = length(vP);
      float rim = smoothstep(.035, .0, abs(d - uR)) * .9;
      float fill = smoothstep(uR, uR * .2, d) * .02;
      float grid = step(.92, fract(vP.x * 6.)) + step(.92, fract(vP.y * 6.));
      float a = (rim * .8 + fill + grid * .02 * step(d, uR)) * uBoost;
      gl_FragColor = vec4(mix(uColor, vec3(1.), rim * .5), a); }`,
});
const sweep = new THREE.Mesh(new THREE.CircleGeometry(1.35, 96), sweepMat);
sweep.rotation.x = -Math.PI / 2; holo.add(sweep);
function updateSweep(t) {
  const k = (t * .22) % 1, y = (k < .5 ? k * 2 : 2 - k * 2) * 2.3 - 1.15;   // 上下往返
  sweep.position.y = y;
  sweepMat.uniforms.uR.value = Math.sqrt(Math.max(0, 1.28 * 1.28 - y * y));
  sweep.visible = Math.abs(y) < 1.27;
}

/* ---------- 7. 环绕卫星：带拖尾的光点沿轨道飞 ---------- */
const sats = [];
for (const [r, rx, rz, sp, len] of [[1.55, 1.25, 0, .9, 60], [1.85, .4, .6, -.7, 50], [2.05, 1.9, .3, .55, 70], [1.7, -.8, -.4, -1.1, 40]]) {
  const N = len, geo = new THREE.BufferGeometry(), pos = new Float32Array(N * 3), al = new Float32Array(N);
  for (let i = 0; i < N; i++) al[i] = Math.pow(1 - i / N, 2);
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('aA', new THREE.BufferAttribute(al, 1));
  const mat = new THREE.ShaderMaterial({ uniforms, ...additive,
    vertexShader: `attribute float aA; varying float vA; void main(){ vA = aA; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
    fragmentShader: `uniform vec3 uColor; uniform float uBoost; varying float vA; void main(){ gl_FragColor = vec4(mix(uColor, vec3(1.), vA*.5), vA * .9 * uBoost); }` });
  const line = new THREE.Line(geo, mat);
  const head = new THREE.Mesh(new THREE.SphereGeometry(.028, 12, 12), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  const pv = new THREE.Group(); pv.rotation.set(rx, 0, rz); pv.add(line, head); holo.add(pv);
  sats.push({ r, sp, N, pos, geo, head, ph: Math.random() * 6.28 });
}
function updateSats(t, k) {
  for (const s of sats) {
    const a0 = s.ph + t * s.sp * k;
    for (let i = 0; i < s.N; i++) { const a = a0 - i * .018 * Math.sign(s.sp); s.pos.set([Math.cos(a) * s.r, Math.sin(a) * s.r, 0], i * 3); }
    s.geo.attributes.position.needsUpdate = true;
    s.head.position.set(Math.cos(a0) * s.r, Math.sin(a0) * s.r, 0);
  }
}

/* ---------- 8. 环绕文字带：一圈滚动的系统数据，像钢铁侠头盔里的 HUD ---------- */
function textBand(lines, r, h, y, tilt, speed, op) {
  const c = document.createElement('canvas'); c.width = 4096; c.height = 64;
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.font = '600 34px "SF Mono", Menlo, Consolas, monospace'; g.textBaseline = 'middle';
  let x = 10; const s = lines.join('   //   ') + '   //   ';
  while (x < c.width) { g.fillText(s, x, 32); x += g.measureText(s).width; }
  const tex = new THREE.CanvasTexture(c); tex.wrapS = THREE.RepeatWrapping; tex.anisotropy = 4;
  const mat = new THREE.ShaderMaterial({ uniforms: { ...uniforms, uTex: { value: tex }, uOp: { value: op } }, ...additive, side: THREE.DoubleSide,
    vertexShader: `varying vec2 vU; varying float vF; void main(){ vU = uv; vec4 mv = modelViewMatrix*vec4(position,1.);
      vF = dot(normalize(normalMatrix*vec3(position.x,0.,position.z)), normalize(-mv.xyz)); gl_Position = projectionMatrix*mv; }`,
    fragmentShader: `uniform sampler2D uTex; uniform vec3 uColor; uniform float uOp, uBoost; varying vec2 vU; varying float vF;
      void main(){ float t = texture2D(uTex, vU).a; float front = smoothstep(-.2, .5, vF);
        gl_FragColor = vec4(uColor, t * uOp * (.25 + .75 * front) * uBoost); }`,
  });
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 160, 1, true), mat);
  const pv = new THREE.Group(); pv.position.y = y; pv.rotation.set(tilt, 0, tilt * .3); pv.add(m); holo.add(pv);
  return { mesh: m, speed };
}
const bands = [
  textBand(['J.A.R.V.I.S. ONLINE', 'NEURAL LINK 98.7%', 'ARC OUTPUT 3.2 GJ/s', 'VOICE CHANNEL SECURE', 'SAT UPLINK OK', 'THREAT LEVEL: MINIMAL'], 1.5, .11, .5, .18, .12, 1.6),
  textBand(['SYS.CORE 0x7F3A', 'MEM 64.2 / 128 TB', 'LAT 12ms', 'TEMP 36.4C', 'PROTOCOL: HOUSE PARTY', 'STARK INDUSTRIES'], 1.62, .09, -.55, -.14, -.08, 1.2),
];

/* ---------- 9. 频谱环：说话时一圈竖条随声音跳 ---------- */
const BARS = 96, barGeo = new THREE.BufferGeometry(), barPos = new Float32Array(BARS * 6);
barGeo.setAttribute('position', new THREE.BufferAttribute(barPos, 3));
const barMat = new THREE.LineBasicMaterial({ color: 0xffffff, opacity: .8, ...additive });
const barPivot = new THREE.Group(); barPivot.position.y = -1.32; barPivot.add(new THREE.LineSegments(barGeo, barMat)); holo.add(barPivot);
function updateBars(t, amp) {
  for (let i = 0; i < BARS; i++) {
    const a = i / BARS * Math.PI * 2, r = 1.1;
    const k = Math.abs(Math.sin(i * 1.7 + t * 9) * Math.sin(i * .37 - t * 5) + .3 * Math.sin(i * 4.1 + t * 13));
    const hgt = .02 + amp * k * .55;
    barPos.set([Math.cos(a) * r, 0, Math.sin(a) * r, Math.cos(a) * r, hgt, Math.sin(a) * r], i * 6);
  }
  barGeo.attributes.position.needsUpdate = true;
}

/* ---------- 后期：泛光 ---------- */
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), .55, .5, .05);
composer.addPass(bloom);
const holoPass = new ShaderPass({
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uAmp: { value: 0 }, uRes: { value: new THREE.Vector2(1, 1) } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
  fragmentShader: `uniform sampler2D tDiffuse; uniform float uTime, uAmp; uniform vec2 uRes; varying vec2 vUv;
    float h(float x){ return fract(sin(x*12.9898)*43758.5453); }
    void main(){
      vec2 uv = vUv;
      float slice = floor(uv.y * 48.); float tg = floor(uTime * 12.);
      float g = step(.965, h(tg + slice * .37)) * step(.75, h(tg * 1.7));          // 偶发信号干扰
      uv.x += g * (h(slice + tg) - .5) * .03;
      float ca = .0016 + g * .006 + uAmp * .001;                                  // 红蓝色散
      vec3 c = vec3(texture2D(tDiffuse, uv + vec2(ca, 0.)).r, texture2D(tDiffuse, uv).g, texture2D(tDiffuse, uv - vec2(ca, 0.)).b);
      float scan = .78 + .22 * sin(vUv.y * uRes.y * 1.6);                         // 扫描线
      float roll = .9 + .1 * smoothstep(.0, .04, abs(fract(vUv.y * .5 - uTime * .12) - .5));
      float flick = .94 + .06 * sin(uTime * 37.) * sin(uTime * 13.);              // 投影闪烁
      gl_FragColor = vec4(c * scan * roll * flick, 1.);
    }`,
});
composer.addPass(holoPass);
composer.addPass(new OutputPass());

/* ---------- 尺寸：让全息球对准原来 .holo 的位置 ---------- */
const anchor = document.querySelector('.holo');
const lens = document.createElement('div'); lens.id = 'lens'; document.body.appendChild(lens);  // 照片主题下压暗全息球背后
function resize() {
  const W = innerWidth, H = innerHeight;
  renderer.setSize(W, H, false); composer.setSize(W, H); bloom.setSize(W, H);
  holoPass.uniforms.uRes.value.set(W * renderer.getPixelRatio(), H * renderer.getPixelRatio());
  uniforms.uPixelRatio.value = renderer.getPixelRatio();
  const r = anchor.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const pxPerUnit = r.width * .34;                      // 球半径 1 对应的像素
  Object.assign(lens.style, { left: cx + 'px', top: (cy + pxPerUnit * .5) + 'px', width: pxPerUnit * 5.2 + 'px', height: pxPerUnit * 6.2 + 'px' });
  const visH = H / pxPerUnit;
  camera.aspect = W / H;
  camera.userData.dist = visH / 2 / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  camera.setViewOffset(W, H, W / 2 - cx, H / 2 - cy, W, H);
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize); resize();

/* ---------- 动画 ---------- */
const amber = new THREE.Color(255 / 255, 181 / 255, 71 / 255), target = new THREE.Color();
const clock = new THREE.Clock();
let spin = 0;
function tick() {
  const dt = Math.min(clock.getDelta(), .05), t = clock.elapsedTime;
  const state = J.state, amp = J.amp, [pmx, pmy] = J.pm;
  uniforms.uTime.value = t; uniforms.uAmp.value = amp;
  const [r, g, b] = J.rgb.split(',').map(v => +v / 255);
  target.setRGB(r, g, b, THREE.SRGBColorSpace);
  uniforms.uColor.value.lerp(target, .08);
  // 视角随鼠标转动
  const d = camera.userData.dist;
  camera.position.set(Math.sin(pmx * .9) * d, -pmy * d * .45 + d * .05, Math.cos(pmx * .9) * d);
  camera.lookAt(0, 0, 0);
  // 旋转：思考时加速
  const speedK = state === 'thinking' ? 4 : state === 'speaking' ? 1.6 : 1;
  spin += dt * .25 * speedK;
  holo.rotation.y = spin; holo.position.y = Math.sin(t * 1.2) * .06;
  core.scale.setScalar(1 + amp * .35);
  shell.scale.setScalar(1 + amp * .12);
  for (const ring of rings) ring.mesh.rotation.z += dt * ring.speed * speedK;
  const themed = document.body.dataset.theme && document.body.dataset.theme !== 'grid';
  uniforms.uBoost.value += ((themed ? 1.7 : 1) - uniforms.uBoost.value) * .1;
  bloom.strength = (themed ? .7 : .45) + amp * .25;
  updateWave(t, amp); updateSweep(t); updateSats(t, speedK); updateBars(t, amp);
  for (const b of bands) b.mesh.rotation.y += dt * b.speed * speedK;
  barMat.color.copy(uniforms.uColor.value).lerp(new THREE.Color(1, 1, 1), .4);
  waveMat.color.copy(uniforms.uColor.value).lerp(new THREE.Color(1, 1, 1), .3);
  wave2.material.color.copy(uniforms.uColor.value);
  for (const a of arcs) { a.m.rotation.z += dt * a.sp * speedK; a.m.material.color.copy(uniforms.uColor.value); }
  holoPass.uniforms.uTime.value = t; holoPass.uniforms.uAmp.value = amp;
  composer.render();
  requestAnimationFrame(tick);
}
document.body.dataset.gl = '1';
tick();
