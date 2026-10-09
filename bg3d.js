// J.A.R.V.I.S. 3D 全息背景：流动网格地面 + 漂浮数据面板 + 上升数据光柱 + 纵深光尘 + 说话时的地面光波
import * as THREE from 'three';

const J = window.JARVIS;
const canvas = document.createElement('canvas');
canvas.id = 'bg3d';
document.body.appendChild(canvas);
let renderer;
try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false }); }
catch (e) { canvas.remove(); throw e; }
renderer.setClearColor(0x000000, 1);   // 黑底 + CSS 滤色混合
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
document.body.dataset.bg3d = '1';

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(52, 1, .1, 200);
const U = { uTime: { value: 0 }, uAmp: { value: 0 }, uColor: { value: new THREE.Color(0x4fe3ff) }, uFade: { value: 1 },
  uRip: { value: [-99, -99, -99, -99, -99, -99] } };
const add = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending };
const FLOOR_Y = -2.4;

/* ---------- 1. 网格地面 + 光波 ---------- */
function gridPlane(y, flip, strength) {
  const m = new THREE.ShaderMaterial({ uniforms: { ...U, uS: { value: strength } }, ...add, side: THREE.DoubleSide,
    vertexShader: `varying vec3 vW; void main(){ vec4 w = modelMatrix*vec4(position,1.); vW = w.xyz; gl_Position = projectionMatrix*viewMatrix*w; }`,
    fragmentShader: `uniform vec3 uColor; uniform float uTime, uAmp, uFade, uS; uniform float uRip[6]; varying vec3 vW;
      float line(vec2 p, float w){ vec2 g = abs(fract(p - .5) - .5) / fwidth(p); return 1. - min(min(g.x, g.y) / w, 1.); }
      void main(){
        vec2 p = vW.xz; p.y += uTime * .6;                       // 地面缓缓流向镜头
        float minor = line(p, 1.), major = line(p / 5., 1.4);
        float d = length(vW.xz - vec2(0., -1.));
        float fade = smoothstep(46., 4., d) * smoothstep(-2., 5., -vW.z + 6.);
        float rip = 0.;
        for (int i = 0; i < 6; i++) { float age = uTime - uRip[i]; float r = age * 5.;
          rip += smoothstep(.35, 0., abs(d - r)) * smoothstep(3.2, 0., age); }
        float glow = smoothstep(9., 0., d) * (.12 + uAmp * .35);   // 全息球正下方的光斑
        float a = (minor * .16 + major * .42 + rip * .9) * fade + glow * fade;
        gl_FragColor = vec4(mix(uColor, vec3(1.), rip * .4), a * uS * uFade);
      }` });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(120, 120), m);
  mesh.rotation.x = flip ? Math.PI / 2 : -Math.PI / 2; mesh.position.y = y; scene.add(mesh);
  return mesh;
}
gridPlane(FLOOR_Y, false, 1);
gridPlane(7.5, true, .22);   // 很淡的天花板网格，形成空间感

/* ---------- 2. 漂浮的全息数据面板 ---------- */
const panelMat = (seed, kind) => new THREE.ShaderMaterial({ uniforms: { ...U, uSeed: { value: seed }, uKind: { value: kind } }, ...add, side: THREE.DoubleSide,
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
  fragmentShader: `uniform vec3 uColor; uniform float uTime, uFade, uSeed, uKind, uAmp; varying vec2 vUv;
    float h(float x){ return fract(sin(x*91.17)*43758.5); }
    void main(){
      vec2 uv = vUv; float a = 0.;
      vec2 e = min(uv, 1. - uv);
      a += step(min(e.x, e.y), .012) * .55;                                              // 外框
      a += step(min(e.x, e.y), .03) * step(max(e.x, e.y), .14) * .7;                     // 四角括号（加粗）
      a += .035;                                                                          // 底色
      if (uKind < .5) {                                                                   // 柱状图
        float c = floor(uv.x * 18.); float hgt = .15 + .6 * h(c + floor(uTime * 1.5 + uSeed * 9.)) * (.6 + uAmp);
        a += step(.1, fract(uv.x * 18.)) * step(.08, uv.y) * step(uv.y, .08 + hgt) * step(.05, uv.x) * step(uv.x, .95) * .35;
      } else if (uKind < 1.5) {                                                           // 滚动文本行
        float row = floor((uv.y + uTime * .05) * 22.); float len = .25 + .6 * h(row + uSeed);
        a += step(.35, fract((uv.y + uTime * .05) * 22.)) * step(uv.x, .06 + len) * step(.06, uv.x) * step(uv.y, .86) * step(.06, uv.y) * .28;
        a += step(.88, uv.y) * step(uv.y, .93) * step(.06, uv.x) * step(uv.x, .5) * .5;   // 标题条
      } else {                                                                            // 波形
        float w = .5 + .22 * sin(uv.x * 30. + uTime * 3. + uSeed) * sin(uv.x * 7. - uTime) * (.5 + uAmp * 1.5);
        a += smoothstep(.02, 0., abs(uv.y - w)) * .8 + step(abs(uv.y - .5), .003) * .25;
      }
      a += smoothstep(.04, 0., abs(uv.y - fract(uTime * .25 + uSeed))) * .25;            // 扫描
      float flick = .8 + .2 * step(.08, h(floor(uTime * 8.) + uSeed));                    // 偶尔闪一下
      gl_FragColor = vec4(uColor, a * flick * .55 * uFade);
    }` });
const panels = [];
for (const [x, y, z, w, hgt, ry, kind, seed] of [
  [-6.2, 1.2, -4, 2.6, 1.6, .55, 0, 1], [-9.5, 4.6, -12, 2.4, 1.3, .4, 1, 2], [-4.2, 3.4, -11, 3, 1.5, .25, 2, 3],
  [6.4, 1.6, -5, 2.4, 1.5, -.55, 1, 4], [7.8, -.6, -9, 2.6, 1.4, -.45, 2, 5], [4.8, 3.6, -13, 3.2, 1.8, -.2, 0, 6],
  [0, 4.6, -16, 4.2, 1.2, 0, 1, 7]]) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, hgt), panelMat(seed, kind));
  m.position.set(x, y, z); m.rotation.y = ry; scene.add(m); panels.push({ m, y, seed });
}

/* ---------- 3. 远处上升的数据光柱 ---------- */
{
  const N = 2400, pos = new Float32Array(N * 3), sp = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const col = Math.floor(Math.random() * 60), ang = (col / 60) * Math.PI * 2, r = 18 + (col * 7.3 % 10);
    pos.set([Math.cos(ang) * r, Math.random() * 14 + FLOOR_Y, Math.sin(ang) * r - 6], i * 3); sp[i] = .6 + (col * 3.7 % 1.4);
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('aSp', new THREE.BufferAttribute(sp, 1));
  scene.add(new THREE.Points(g, new THREE.ShaderMaterial({ uniforms: U, ...add,
    vertexShader: `uniform float uTime; attribute float aSp; varying float vA;
      void main(){ vec3 p = position; p.y = ${FLOOR_Y.toFixed(1)} + mod(p.y - ${FLOOR_Y.toFixed(1)} + uTime * aSp, 14.);
        vA = smoothstep(0., 2., p.y + 2.4) * smoothstep(14., 8., p.y + 2.4);
        vec4 mv = modelViewMatrix*vec4(p,1.); gl_PointSize = 60. / -mv.z; gl_Position = projectionMatrix*mv; }`,
    fragmentShader: `uniform vec3 uColor; uniform float uFade; varying float vA;
      void main(){ float d = length(gl_PointCoord - .5); if (d > .5) discard; gl_FragColor = vec4(uColor, vA * .5 * uFade * (1. - d * 2.)); }` })));
}

/* ---------- 4. 有纵深的光尘 ---------- */
const dust = (() => {
  const N = 1400, pos = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) pos.set([(Math.random() - .5) * 30, (Math.random() - .5) * 12 + 1, -Math.random() * 30 + 6], i * 3);
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const p = new THREE.Points(g, new THREE.ShaderMaterial({ uniforms: U, ...add,
    vertexShader: `uniform float uTime; varying float vA;
      void main(){ vec3 p = position; p.y += sin(uTime * .3 + p.x) * .3; p.x += sin(uTime * .2 + p.z) * .3;
        vec4 mv = modelViewMatrix*vec4(p,1.); vA = smoothstep(32., 4., -mv.z) * smoothstep(.5, 2.5, -mv.z);
        gl_PointSize = 34. / -mv.z; gl_Position = projectionMatrix*mv; }`,
    fragmentShader: `uniform vec3 uColor; uniform float uFade; varying float vA;
      void main(){ float d = length(gl_PointCoord - .5); if (d > .5) discard; gl_FragColor = vec4(mix(uColor, vec3(1.), .4), vA * .45 * uFade * pow(1. - d * 2., 2.)); }` }));
  scene.add(p); return p;
})();

/* ---------- 尺寸：画面中心对准全息球 ---------- */
const anchor = document.querySelector('.holo');
function resize() {
  const W = innerWidth, H = innerHeight;
  renderer.setSize(W, H, false); camera.aspect = W / H;
  const r = anchor ? anchor.getBoundingClientRect() : { left: W / 2, top: H / 2, width: 0, height: 0 };
  camera.setViewOffset(W, H, W / 2 - (r.left + r.width / 2), H / 2 - (r.top + r.height / 2), W, H);
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize); resize();

/* ---------- 动画 ---------- */
const clock = new THREE.Clock(); let t = 0, amp = 0, lastRip = 0, ripIdx = 0, prevAmp = 0;
const tmp = new THREE.Color();
function frame() {
  requestAnimationFrame(frame);
  if (document.hidden) return;
  const dt = Math.min(clock.getDelta(), .05); t += dt;
  const a = J.amp || 0; amp += (a - amp) * .2;
  // 声音突然变大时从球下方发出一圈光波
  if (a > .18 && a - prevAmp > .05 && t - lastRip > .45) { U.uRip.value[ripIdx++ % 6] = t; lastRip = t; }
  if ((J.state === 'speaking' || J.state === 'thinking') && t - lastRip > 1.6) { U.uRip.value[ripIdx++ % 6] = t; lastRip = t; }
  prevAmp = a;
  U.uTime.value = t; U.uAmp.value = amp;
  const [r, g, b] = J.rgb.split(',').map(v => +v / 255); tmp.setRGB(r, g, b, THREE.SRGBColorSpace);
  U.uColor.value.lerp(tmp, .08);
  const themed = document.body.dataset.theme && document.body.dataset.theme !== 'grid';
  U.uFade.value += ((themed ? .35 : 1) - U.uFade.value) * .05;
  for (const p of panels) p.m.position.y = p.y + Math.sin(t * .4 + p.seed) * .15;
  dust.rotation.y = t * .01;
  const [px, py] = J.pm || [0, 0];
  camera.position.set(px * 1.6, .9 - py * .8, 9); camera.lookAt(px * .4, 0, 0);
  renderer.render(scene, camera);
}
frame();
