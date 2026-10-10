// J.A.R.V.I.S. 3D 全息背景 v2「全息实验室」
// 分三层：远景（体积雾、巨型全息环、线框城市、远处星尘，单独渲染到低分辨率再轻微模糊 = 景深）
//        中景（拱形光廊、玻璃盒数据面板 + 数据连线、地面光流和刻度投影阵、线框几何体、螺旋粒子流）
//        近景（近处面板、前景虚化光斑、带拖尾的大光点）
// 联动：每帧读取 window.JARVIS 的 state / amp / rgb / pm，状态切换全部做平滑过渡
// 调参：改下面的 CFG；也可以在页面加载前设置 window.JARVIS_BG_CFG = { ... } 覆盖，
//      或在控制台里用 JARVIS_BG.CFG 实时调整（标了「实时」的参数立即生效）
import * as THREE from 'three';

const J = window.JARVIS;

/* ==================== 0. 可调参数 ==================== */
const CFG = Object.assign({
  maxPixelRatio: 1.5,       // 像素比上限
  autoQuality: true,        // 帧率持续低于 50 时自动降分辨率（只降不升）
  // 景深：远景层单独渲染到低分辨率纹理，再模糊叠回来
  dof: true,                // 关掉后远景直接和中近景一起渲染（不模糊）
  farScale: .5,             // 远景层分辨率比例，越小越糊也越省
  farBlur: 1.4,             // 实时｜远景模糊半径（远景纹理像素）
  farGain: 1.05,            // 实时｜远景层整体亮度
  // 雾
  fogNear: 9,               // 实时｜从多远开始起雾（世界单位）
  fogDensity: 1 / 34,       // 实时｜雾浓度，越大远处越快隐去
  fogFloor: .14,            // 实时｜最远处物体保留的亮度比例
  fogGlow: .42,             // 实时｜体积雾本身的亮度
  fogHeight: .3,            // 实时｜雾随高度变稀的速度，越大越贴地
  // 色彩与构图
  saturation: .8,           // 实时｜背景饱和度（相对主题色），比全息球低
  centerDim: .3,            // 实时｜全息球背后区域的亮度比例，越小中心越干净
  breath: .07,              // 实时｜待机呼吸幅度
  // 地面
  gridScroll: 0,            // 实时｜网格整体流向镜头的速度（v1.9.1 是 .6；现在改由光流表现流动）
  flowSpeed: 4.5,           // 实时｜光流速度（单位/秒）
  flowDensity: .5,          // 实时｜有光流的主网格线比例 0~1
  // 粒子（改数量需刷新）
  stardust: 1700,           // 近中景细小星尘
  farDust: 900,             // 远景星尘
  bokeh: 34,                // 前景虚化光斑
  motes: 44,                // 带拖尾的大光点
  moteTrail: 14,            // 每个大光点的拖尾节数
  spiral: 2400,             // 全息球周围的螺旋粒子流
  columns: 1600,            // 远处上升的数据光柱
  // 数据面板
  panelRefresh: [14, 26],   // 实时｜面板刷新（收起→换内容→展开）间隔，秒
  panelFace: .7,            // 实时｜面板朝向：0 = 面向全息球，1 = 正对镜头
  linkEvery: { idle: 2.6, listening: 1.6, thinking: .12, speaking: 1 },   // 实时｜各状态下数据连线的发射间隔，秒
  // 巨型全息环
  ringSpin: .03,            // 实时｜待机转速（弧度/秒）
  ringThink: 5,             // 实时｜思考时转速倍数
  // 扫描光
  sweepEvery: [5, 9],       // 实时｜说话时横扫扫描光的间隔，秒
  sweepTime: 2.4,           // 实时｜一次横扫用时，秒
  // 镜头
  parallax: [1.2, .6],      // 实时｜鼠标视差幅度 x / y
  drift: [.6, .3],          // 实时｜自动漂移幅度 x / y
  pushIn: 1.4,              // 实时｜聆听时镜头推近距离
  stateBlend: 2.2,          // 实时｜状态过渡速度，越大切换越快
}, window.JARVIS_BG_CFG || {});

/* ==================== 1. 渲染器、镜头、公共 uniform ==================== */
const canvas = document.createElement('canvas');
canvas.id = 'bg3d';
document.body.appendChild(canvas);
let renderer;
try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false }); }
catch (e) { canvas.remove(); throw e; }
renderer.setClearColor(0x000000, 1);   // 黑底 + CSS 滤色混合 = 只留下发光部分
renderer.autoClear = false;
let prCap = CFG.maxPixelRatio, pixelRatio = Math.min(devicePixelRatio, prCap);   // prCap：自动降画质时会调低
renderer.setPixelRatio(pixelRatio);
document.body.dataset.bg3d = '1';

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(52, 1, .1, 240);
const FLOOR_Y = -2.4;
const ORB = new THREE.Vector3(0, .2, -1);   // 全息球在背景世界里的位置：镜头始终对准它，视差以它为支点
const PAD = new THREE.Vector3(0, FLOOR_Y, .3);   // 地面投影中心：刻度阵、光波、光流都以它为圆心（屏幕上和全息球底座对齐）
const FAR = 1;                              // 远景层的 layer 编号
const f = v => (Number.isInteger(v) ? v.toFixed(1) : String(v));   // 数字转 GLSL 浮点字面量

const U = {
  uTime: { value: 0 }, uAmp: { value: 0 }, uColor: { value: new THREE.Color(0x4fe3ff) },
  uFade: { value: 1 },                                   // 照片主题下 0.65
  uPhoto: { value: 0 },                                  // 照片主题 0→1 平滑过渡
  uBreath: { value: 1 },                                 // 待机呼吸
  uState: { value: new THREE.Vector4(1, 0, 0, 0) },      // idle / listening / thinking / speaking 的平滑权重
  uFlow: { value: 0 }, uScan: { value: 0 }, uSpin: { value: 0 }, uSpiral: { value: 0 }, uMote: { value: 0 }, uGrid: { value: 0 },  // 积分相位：变速时不跳变
  uSweep: { value: new THREE.Vector2(-99, 0) },          // 横扫扫描光：位置 / 强度
  uRes: { value: new THREE.Vector2(1, 1) }, uCenter: { value: new THREE.Vector3(.5, .5, .2) }, uAspect: { value: 1 }, uPR: { value: 1 },
  uFogNear: { value: CFG.fogNear }, uFogDen: { value: CFG.fogDensity }, uFogFloor: { value: CFG.fogFloor },
  uSat: { value: CFG.saturation }, uCenterDim: { value: CFG.centerDim },
};

// 所有着色器共用的声明和工具函数
const HEAD = `
#define FLOOR_Y ${f(FLOOR_Y)}
#define ORB vec3(${f(ORB.x)}, ${f(ORB.y)}, ${f(ORB.z)})
#define PAD vec2(${f(PAD.x)}, ${f(PAD.z)})
#define SWEEP_DIR vec2(.8, .6)
uniform vec3 uColor, uCenter; uniform vec4 uState; uniform vec2 uSweep, uRes;
uniform float uTime, uAmp, uFade, uPhoto, uBreath, uFlow, uScan, uSpin, uSpiral, uMote, uGrid, uAspect, uPR;
uniform float uFogNear, uFogDen, uFogFloor, uSat, uCenterDim;
float hash11(float p){ p = fract(p * .1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash21(vec2 p){ vec3 q = fract(vec3(p.xyx) * .1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
float vnoise(vec2 p){ vec2 i = floor(p), u = fract(p); u = u * u * (3. - 2. * u);
  return mix(mix(hash21(i), hash21(i + vec2(1., 0.)), u.x), mix(hash21(i + vec2(0., 1.)), hash21(i + vec2(1., 1.)), u.x), u.y); }
// 横扫扫描光经过时的高亮
float sweepHit(vec3 w){ return uSweep.y * smoothstep(2.2, 0., abs(dot(w.xz, SWEEP_DIR) - uSweep.x)); }
`;
const FRAG = `
// 降饱和：背景颜色比全息球素一些
vec3 grade(vec3 c){ return mix(vec3(dot(c, vec3(.2126, .7152, .0722))), c, uSat); }
// 深度雾：返回可见度 1（近）→ 0（远）
float fogVis(float d){ return exp(-pow(max(d - uFogNear, 0.) * uFogDen, 1.35)); }
// 中心留白：全息球背后的东西压暗，给球留出视觉空间
float centerMask(){ vec2 q = (gl_FragCoord.xy / uRes - uCenter.xy) * vec2(uAspect, 1.);
  return mix(uCenterDim, 1., smoothstep(uCenter.z * .85, uCenter.z * 1.7, length(q))); }
// 统一出口：雾（远处变暗并偏向主题色暗调）+ 中心留白 + 呼吸 + 照片主题衰减
vec4 finish(vec3 col, float a, float d){
  float v = fogVis(d);
  return vec4(mix(grade(uColor) * .45, grade(col), v), a * mix(uFogFloor, 1., v) * centerMask() * uBreath * uFade);
}
`;
const add = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending };
function mat(vs, fs, extra = {}, opts = {}) {
  return new THREE.ShaderMaterial({ uniforms: { ...U, ...extra }, ...add, ...opts, extensions: { derivatives: true },
    vertexShader: HEAD + vs, fragmentShader: HEAD + FRAG + fs });
}
const toFar = o => { o.traverse(c => c.layers.set(FAR)); return o; };   // 放进远景层（会被模糊）
// 常用顶点着色器：输出世界坐标 vW、视深 vD（以及 uv / 局部坐标）
const VS_WORLD = `varying vec3 vW; varying float vD;
  void main(){ vec4 w = modelMatrix * vec4(position, 1.); vW = w.xyz; vec4 mv = viewMatrix * w; vD = -mv.z; gl_Position = projectionMatrix * mv; }`;
const VS_UV = `varying vec2 vUv; varying vec3 vW; varying float vD;
  void main(){ vUv = uv; vec4 w = modelMatrix * vec4(position, 1.); vW = w.xyz; vec4 mv = viewMatrix * w; vD = -mv.z; gl_Position = projectionMatrix * mv; }`;
const VS_LOCAL = `varying vec2 vP; varying vec3 vW; varying float vD;
  void main(){ vP = position.xy; vec4 w = modelMatrix * vec4(position, 1.); vW = w.xyz; vec4 mv = viewMatrix * w; vD = -mv.z; gl_Position = projectionMatrix * mv; }`;
const rand = (a, b) => a + Math.random() * (b - a);

/* ==================== 2. 体积雾（远景层）：解析高度雾 ====================
   每个像素沿视线积分一个「越贴地越浓」的雾场，视线碰到地面就停：地平线最浓、头顶最稀、近处地面几乎没雾。
   雾团噪声贴在世界坐标上，镜头移动时雾团有正确的视差。整屏只算一次，而且在低分辨率的远景层里算。 */
const fogU = { uInvVP: { value: new THREE.Matrix4() }, uCam: { value: new THREE.Vector3() }, uGlow: { value: CFG.fogGlow }, uHK: { value: CFG.fogHeight } };
{
  const m = mat(`uniform mat4 uInvVP; uniform vec3 uCam; varying vec3 vDir;
    void main(){ vec4 w = uInvVP * vec4(position.xy, 1., 1.); vDir = w.xyz / w.w - uCam; gl_Position = vec4(position.xy, 0., 1.); }`,
  `uniform vec3 uCam; uniform float uGlow, uHK; varying vec3 vDir;
    // 视线穿过竖直光墙（厚 2w、高 H，法线 SWEEP_DIR，位置 X）的长度，越贴地越亮
    float slab(vec3 c, vec3 d, float S, float X, float w, float H){
      float a = dot(c.xz, SWEEP_DIR), b = dot(d.xz, SWEEP_DIR), s0 = 0., s1 = S;
      if (abs(b) > 1e-4) { float t1 = (X - w - a) / b, t2 = (X + w - a) / b; s0 = max(s0, min(t1, t2)); s1 = min(s1, max(t1, t2)); }
      else if (abs(a - X) > w) return 0.;
      if (abs(d.y) > 1e-4) { float t1 = (FLOOR_Y - c.y) / d.y, t2 = (FLOOR_Y + H - c.y) / d.y; s0 = max(s0, min(t1, t2)); s1 = min(s1, max(t1, t2)); }
      float L = max(s1 - s0, 0.), hm = c.y + d.y * (s0 + s1) * .5 - FLOOR_Y;
      return L * exp(-max(hm, 0.) * .22);
    }
    void main(){
      vec3 d = normalize(vDir);
      float h0 = max(uCam.y - FLOOR_Y, .05);
      float S = d.y < -.002 ? min(h0 / -d.y, 150.) : 150.;                          // 视线走到地面（或最远处）的距离
      float kd = uHK * d.y;
      float od = exp(-uHK * h0) * (abs(kd) > 1e-4 ? (1. - exp(-kd * S)) / kd : S);  // ∫exp(-k·离地高度)ds
      vec3 hit = uCam + d * min(S, 80.);
      float n = vnoise(hit.xz * .07 + vec2(uTime * .025, 0.)) * .65 + vnoise(hit.xz * .19 - vec2(0., uTime * .04)) * .35;
      float fog = 1. - exp(-od * .018 * (.55 + .9 * n));
      float horizon = exp(-abs(d.y + .02) * 10.) * .15;                               // 地平线上更亮的一条雾带
      float a = fog * (1. + horizon) * uGlow * (1. + uState.z * .2 + uAmp * uState.w * .3) * mix(1., .4, uPhoto);
      vec3 col = grade(uColor) * (.5 + .3 * n) * a;
      if (uSweep.y > .001) {                                                          // 横扫扫描光：体积光墙 = 亮芯 + 柔和光晕
        float sv = (1. - exp(-slab(uCam, d, S, uSweep.x, .4, 11.) * .35)) + (1. - exp(-slab(uCam, d, S, uSweep.x, 1.8, 11.) * .07)) * .5;
        col += grade(mix(uColor, vec3(1.), .45)) * sv * uSweep.y * .55 * mix(1., .5, uPhoto);
      }
      gl_FragColor = vec4(col * centerMask() * uBreath * uFade, 1.);
    }`, fogU, { depthTest: false });
  const q = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), m);
  q.frustumCulled = false; q.renderOrder = -10; scene.add(toFar(q));
}

/* ==================== 3. 巨型全息环（远景层）：立在长廊尽头、略微侧转，缓慢自转，思考时加速 ==================== */
const ringMat = (kind, rIn, rOut) => mat(VS_LOCAL, `uniform float uKind, uIn, uOut; varying vec2 vP; varying vec3 vW; varying float vD;
  float band(float x, float c, float w, float fw){ return 1. - smoothstep(w, w + fw, abs(x - c)); }
  void main(){
    float r = length(vP), A = atan(vP.y, vP.x) / 6.2831853 + .5;
    float fa = min(fwidth(A), fwidth(fract(A + .5)));            // 避开 atan 接缝处的导数跳变
    float u = (r - uIn) / (uOut - uIn), fu = fwidth(u), a = 0.;
    if (uKind < .5) {                                             // 主环：内外边线 + 闪烁的数据格 + 外沿刻度
      a += (band(u, .03, .015, fu) + band(u, .97, .015, fu)) * .55;
      float c = floor(A * 96.), cf = fract(A * 96.);
      float blink = .55 + .45 * sin(uTime * (.6 + hash11(c) * 2.) + c);
      a += step(.38, hash11(c * 1.7 + 3.)) * step(.1, cf) * step(cf, .9) * step(.3, u) * step(u, .66) * (.16 + .24 * blink);
      float major = 1. - step(.5, mod(floor(A * 360.), 10.));
      a += (1. - smoothstep(.16, .16 + fa * 360., fract(A * 360.))) * step(1. - (.14 + major * .14), u) * .5;
    } else if (uKind < 1.5) {                                     // 细刻度环
      a += (1. - smoothstep(.2, .2 + fa * 180., fract(A * 180.))) * step(.45, u) * .5 + band(u, .12, .06, fu) * .45;
    } else {                                                      // 长虚线环
      a += step(.42, fract(A * 7.)) * band(u, .5, .3, fu) * .55;
    }
    a *= smoothstep(FLOOR_Y + .1, FLOOR_Y + 4., vW.y);            // 下半截沉进地平线
    a *= 1. + uState.z * .5 + uAmp * uState.w * .5 + sweepHit(vW) * 2.;
    gl_FragColor = finish(uColor, a * .5, vD);
  }`, { uKind: { value: kind }, uIn: { value: rIn }, uOut: { value: rOut } }, { side: THREE.DoubleSide });
const ringRig = new THREE.Group();
ringRig.position.set(0, -3.3, -52); ringRig.rotation.set(-.08, .5, 0); scene.add(ringRig);
const giantRings = [];   // sp：相对转速（正负 = 方向）
for (const [kind, rIn, rOut, sp] of [[0, 23, 24.6, 1], [1, 25.4, 26.3, -.6], [2, 21.2, 21.5, 1.7], [1, 19.6, 20.1, -1.2]]) {
  const m = new THREE.Mesh(new THREE.RingGeometry(rIn, rOut, 256, 1), ringMat(kind, rIn, rOut));
  ringRig.add(m); giantRings.push({ m, sp });
}
const gyro = new THREE.Group(); gyro.rotation.y = -1.1; ringRig.add(gyro);   // 斜插的陀螺环：和主环交叉、缓慢进动
{ const m = new THREE.Mesh(new THREE.RingGeometry(24.9, 25.15, 256, 1), ringMat(2, 24.9, 25.15)); gyro.add(m); giantRings.push({ m, sp: -.8 }); }
toFar(ringRig);

/* ==================== 4. 线框城市（远景层）：地平线上的全息城市模型，扫描带自下而上 ==================== */
{
  const cityMat = mat(VS_WORLD, `varying vec3 vW; varying float vD;
    void main(){
      float scan = smoothstep(.45, 0., abs(vW.y - (FLOOR_Y + mod(uTime * 1.5, 13.))));
      float a = (.24 + scan * .6 + sweepHit(vW) * .9);
      gl_FragColor = finish(mix(uColor, vec3(1.), scan * .35), a, vD);
    }`);
  const pts = [], rnd = (i) => (Math.sin(i * 127.1) * 43758.5) % 1;
  for (let i = 0; i < 70; i++) {
    const x = (i - 35) * 1.6 + Math.abs(rnd(i)) * .8, z = -42 - Math.abs(rnd(i + 9)) * 14;
    if (Math.abs(x) < 6 && z > -46) continue;
    const w = .6 + Math.abs(rnd(i + 3)) * 1.2, d = .6 + Math.abs(rnd(i + 5)) * 1.2, h = 1.5 + Math.pow(Math.abs(rnd(i + 7)), 2) * 11;
    const b = new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, d)); const arr = b.attributes.position.array;
    for (let k = 0; k < arr.length; k += 3) pts.push(arr[k] + x, arr[k + 1] + FLOOR_Y + h / 2, arr[k + 2] + z);
    for (let fl = 1; fl < h / 1.2; fl++) { const yy = FLOOR_Y + fl * 1.2;     // 楼层线
      pts.push(x - w / 2, yy, z + d / 2, x + w / 2, yy, z + d / 2); }
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  scene.add(toFar(new THREE.LineSegments(g, cityMat)));
}

/* ==================== 5. 数据光柱：场地外圈一列列光点往上冒（中远景，带雾） ==================== */
{
  const N = CFG.columns, pos = new Float32Array(N * 3), sp = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const col = Math.floor(Math.random() * 60), ang = (col / 60) * Math.PI * 2, r = 18 + (col * 7.3 % 10);
    pos.set([Math.cos(ang) * r, Math.random() * 14 + FLOOR_Y, Math.sin(ang) * r - 6], i * 3); sp[i] = .6 + (col * 3.7 % 1.4);
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('aSp', new THREE.BufferAttribute(sp, 1));
  scene.add(new THREE.Points(g, mat(`attribute float aSp; varying float vA, vD;
    void main(){ vec3 p = position; float h = mod(p.y - FLOOR_Y + uMote * aSp, 14.); p.y = FLOOR_Y + h;
      vA = smoothstep(0., 2., h) * smoothstep(14., 8., h);
      vec4 mv = modelViewMatrix * vec4(p, 1.); vD = -mv.z; gl_PointSize = 40. * uPR / vD; gl_Position = projectionMatrix * mv; }`,
  `varying float vA, vD;
    void main(){ float d = length(gl_PointCoord - .5); if (d > .5) discard; gl_FragColor = finish(uColor, vA * .5 * (1. - d * 2.), vD); }`)));
}

/* ==================== 6. 地面：网格 + 沿网格线跑向全息球的光流 + 说话时的光波 ==================== */
const ripU = { uRip: { value: [-99, -99, -99, -99, -99, -99] }, uRipK: { value: [0, 0, 0, 0, 0, 0] }, uFlowD: { value: CFG.flowDensity } };
const RIP = `uniform float uRip[6], uRipK[6];
  float ripple(float d){ float s = 0.; for (int i = 0; i < 6; i++) { float age = uTime - uRip[i];
    s += smoothstep(.35, 0., abs(d - age * 5.)) * smoothstep(3.2, 0., age) * uRipK[i]; } return s; }
  float gline(float x, float w){ float fw = fwidth(x), g = abs(fract(x - .5) - .5) / fw; return (1. - min(g / w, 1.)) * (1. - smoothstep(.15, .5, fw)); }   // 线太密时淡出，防摩尔纹
`;
{
  const m = mat(VS_WORLD, RIP + `uniform float uFlowD; varying vec3 vW; varying float vD;
    // 一条主网格线上的光流：s = 沿线到投影中心（全息球正下方）的距离，越来越小 = 跑向球；id = 线编号
    float flow(float s, float id){
      float on = step(hash11(id * 3.1 + 7.), uFlowD);
      float spd = .7 + .6 * hash11(id + 1.3), P = 12. + 10. * hash11(id + 5.7);
      float x = fract((s + uFlow * spd) / P + hash11(id + 9.1)) * P;       // 到光点头部的距离（头在前，尾在后）
      return on * (exp(-x / 2.4) * .7 + exp(-x / .3) + exp(-(P - x) / .2)) * smoothstep(2.6, 5., s) * smoothstep(42., 18., s);
    }
    void main(){
      vec2 p = vec2(vW.x, vW.z + uGrid);
      float d = length(vW.xz - PAD);
      float minor = min(gline(p.x, 1.) + gline(p.y, 1.), 1.) * smoothstep(30., 6., d);
      float major = min(gline(p.x / 5., 1.4) + gline(p.y / 5., 1.4), 1.);
      float kx = floor(p.x / 5. + .5), kz = floor(p.y / 5. + .5);
      float onZ = (1. - min(abs(p.x - kx * 5.) / (fwidth(p.x) * 2.), 1.)) * (1. - smoothstep(.8, 2.5, fwidth(p.x)));   // 纵向主线（透视方向）
      float onX = (1. - min(abs(p.y - kz * 5.) / (fwidth(p.y) * 2.), 1.)) * (1. - smoothstep(.8, 2.5, fwidth(p.y)));   // 横向主线
      float fl = onZ * flow(abs(vW.z - PAD.y), kx) + onX * flow(abs(vW.x - PAD.x), kz + 40.) * smoothstep(22., 6., abs(vW.z - PAD.y));
      fl *= 1. + uAmp * uState.w * 1.5;
      float rip = ripple(d);
      float glow = smoothstep(4.5, 0., d) * (.04 + uAmp * .16);
      float sw = sweepHit(vW), swLine = uSweep.y * smoothstep(.3, 0., abs(dot(vW.xz, SWEEP_DIR) - uSweep.x));   // 光墙扫过地面的那条亮线
      float a = ((minor * .1 + major * .3) * (1. + sw * 4.) + fl * .85 + rip * .9 + glow + sw * .15 + swLine * .9) * smoothstep(50., 6., d);
      gl_FragColor = finish(mix(uColor, vec3(1.), min(rip * .4 + fl * .45 + sw * .3 + swLine * .5, .8)), a, vD);
    }`, ripU, { side: THREE.DoubleSide });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(140, 140), m);
  floor.rotation.x = -Math.PI / 2; floor.position.set(0, FLOOR_Y, -20); scene.add(floor);
  // 很淡的天花板网格，让空间有上下边界
  const cm = mat(VS_WORLD, `varying vec3 vW; varying float vD;
    float gl2(vec2 p, float w){ vec2 fw = fwidth(p), g = abs(fract(p - .5) - .5) / fw; return (1. - min(min(g.x, g.y) / w, 1.)) * (1. - smoothstep(.15, .5, max(fw.x, fw.y))); }
    void main(){ vec2 p = vec2(vW.x, vW.z + uGrid);
      float a = (gl2(p, 1.) * .1 * smoothstep(30., 8., vD) + gl2(p / 5., 1.4) * .3) * (1. + sweepHit(vW) * 2.) * .22;
      gl_FragColor = finish(uColor, a, vD); }`, {}, { side: THREE.DoubleSide });
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(140, 140), cm);
  ceil.rotation.x = Math.PI / 2; ceil.position.set(0, 9, -20); scene.add(ceil);
}

/* ==================== 7. 全息球正下方的同心圆刻度投影阵：多层刻度环各自缓慢旋转，雷达式扫掠点亮刻度 ==================== */
{
  const m = mat(VS_LOCAL, RIP + `varying vec2 vP; varying vec3 vW; varying float vD;
    float ring(float r, float c, float w, float fr){ return 1. - smoothstep(w, w + fr * 1.2, abs(r - c)); }
    float ticks(float A, float n, float duty, float fa){ return 1. - smoothstep(duty, duty + fa * n * 1.2, fract(A * n)); }
    void main(){
      float r = length(vP), fr = fwidth(r);
      float A0 = atan(vP.y, vP.x) / 6.2831853 + .5;
      float fa = min(fwidth(A0), fwidth(fract(A0 + .5)));
      float s = uSpin, v = 0.;
      v += ring(r, 1.95, .008, fr) * .6;
      float A1 = fract(A0 + s * .05);                                              // 刻度环：顺时针
      float big = 1. - step(.5, mod(floor(A1 * 120.), 10.));
      v += ticks(A1, 120., .14, fa) * step(2.04, r) * step(r, 2.17 + big * .14) * (.4 + big * .3);
      v += step(.18, fract(fract(A0 - s * .03) * 6.)) * ring(r, 2.5, .018, fr) * .45;  // 六段弧：逆时针
      v += ticks(fract(A0 + s * .015), 360., .25, fa) * step(2.82, r) * step(r, 2.94) * .25 + ring(r, 2.79, .007, fr) * .35;   // 细密刻度带
      float seg = fract(fract(A0 - s * .07) * 3.);                                  // 三段粗弧，前端亮
      v += step(seg, .55) * ring(r, 3.25, .028, fr) * (.3 + .45 * smoothstep(.45, .55, seg));
      v += step(fract(A0 * 90.), .3) * ring(r, 3.58, .018, fr) * .3;               // 点状环
      v += ring(r, 3.85, .008, fr) * .25;
      float sw = fract(A0 - s * .12);                                               // 雷达式扫掠
      v *= 1. + smoothstep(.12, 0., sw) * 1.5;
      v += smoothstep(.06, 0., sw) * step(1.95, r) * step(r, 3.85) * .05;
      float rip = ripple(r);
      v *= (1. + rip * 1.2 + uAmp * uState.w * .8 + uState.z * .4) * smoothstep(4., 3.9, r) * (1. + sweepHit(vW));
      gl_FragColor = finish(mix(uColor, vec3(1.), rip * .3), v * .4, vD);
    }`, ripU, { side: THREE.DoubleSide });
  const arr = new THREE.Mesh(new THREE.CircleGeometry(4.1, 128), m);
  arr.rotation.x = -Math.PI / 2; arr.position.set(PAD.x, FLOOR_Y + .02, PAD.z); scene.add(arr);
}

/* ==================== 8. 拱形光廊：一道道拱门从远处推向镜头（思考时加速） ==================== */
const archMat = mat(VS_UV, `varying vec2 vUv; varying vec3 vW; varying float vD;
  void main(){ float seg = step(.3, fract(vUv.x * 24. - uTime * .2));
    float a = (.3 + .22 * seg) * smoothstep(3., 9., vD) * (1. + sweepHit(vW) * 2.);
    gl_FragColor = finish(uColor, a * .45, vD); }`, {}, { side: THREE.DoubleSide });
const arches = [];
const ARCH_N = 9, ARCH_GAP = 6;
for (let i = 0; i < ARCH_N; i++) {
  const a = new THREE.Mesh(new THREE.RingGeometry(12.5, 12.65, 96, 1, 0, Math.PI), archMat);
  a.position.y = FLOOR_Y; scene.add(a); arches.push(a);
  const ticks = [];   // 拱门外沿的刻度
  for (let k = 0; k <= 16; k++) { const ang = k / 16 * Math.PI, r1 = 12.65, r2 = 13.1 + (k % 4 === 0 ? .4 : 0);
    ticks.push(Math.cos(ang) * r1, Math.sin(ang) * r1, 0, Math.cos(ang) * r2, Math.sin(ang) * r2, 0); }
  const tg = new THREE.BufferGeometry(); tg.setAttribute('position', new THREE.Float32BufferAttribute(ticks, 3));
  a.add(new THREE.LineSegments(tg, archMat));
}

/* ==================== 9. 漂浮的线框几何体：分布在不同深度慢慢自转（远的放进远景层被虚化） ==================== */
const solids = [];
{
  const geos = [new THREE.IcosahedronGeometry(1, 0), new THREE.OctahedronGeometry(1, 0), new THREE.DodecahedronGeometry(1, 0), new THREE.BoxGeometry(1.3, 1.3, 1.3)];
  const sm = mat(VS_WORLD, `varying vec3 vW; varying float vD; void main(){ gl_FragColor = finish(uColor, .4 * (1. + sweepHit(vW) * 2.), vD); }`);
  for (const [gi, x, y, z, s] of [[0, -11, 2.5, -7, .7], [1, 10.5, 4, -10, .8], [2, 13, 0, -20, 1.1], [3, -6, 6, -22, .9], [0, -22, 2, -40, 1.6]]) {
    const geo = new THREE.EdgesGeometry(geos[gi]);
    const o = new THREE.LineSegments(geo, sm); o.position.set(x, y, z); o.scale.setScalar(s); scene.add(z < -21 ? toFar(o) : o);
    solids.push({ o, y, sp: .1 + Math.abs(Math.sin(x)) * .25 });
  }
}

/* ==================== 10. 全息数据面板 ====================
   每块面板是有厚度的「玻璃盒」：正面内容层 + 后面一层暗网格 + 盒子棱线。
   内容 6 种：0 柱状图 / 1 十六进制滚动 / 2 示波器 / 3 雷达扫描 / 4 地图等高线 / 5 进度环（带可读的百分比数字）。
   每隔一段时间「收起 → 换内容 → 展开」，展开时带故障闪烁；平时轻微呼吸起伏，并慢慢转向镜头。 */
const GLYPHS = '0123456789ABCDEF%.:-/ ';   // 字形图集第一行（序号即字形编号）
const LABELS = ['RADAR // SECTOR 7G', 'TOPOGRAPHY // GRID 42', 'MEM DUMP // 0x7F3A', 'ARC REACTOR OUTPUT', 'SIGNAL // VOICE LINK', 'NEURAL NET LOAD'];
const KIND_LABEL = [5, 2, 4, 0, 1, 3];      // 每种内容对应的标题
const atlas = (() => {
  const c = document.createElement('canvas'); c.width = 1024; c.height = 512;
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.textBaseline = 'middle';
  g.textAlign = 'center'; g.font = '600 50px "SF Mono", Menlo, Consolas, monospace';
  for (let i = 0; i < GLYPHS.length; i++) g.fillText(GLYPHS[i], i * 44 + 22, 34);     // 字格 44×64
  g.textAlign = 'left'; g.font = '600 27px "SF Mono", Menlo, Consolas, monospace';
  LABELS.forEach((s, i) => g.fillText(s, 4, 64 + i * 40 + 21));                      // 标题行，每行 40 像素高
  const t = new THREE.CanvasTexture(c); t.anisotropy = 4; return t;
})();
const PANEL_FS = `uniform sampler2D uAtlas; uniform float uSeed, uKind, uLabel, uLabelW, uAsp, uOpen, uGlitch, uPulse;
varying vec2 vUv; varying vec3 vW; varying float vD;
vec2 dcx, dcy;   // 内容区坐标的屏幕导数：字格坐标是跳变的，用它算采样梯度，字格边缘才不会出细线
float atlasA(vec2 uv, vec2 gx, vec2 gy){
#ifdef GRAD
  return textureGrad(uAtlas, uv, gx, gy).a;
#else
  return texture2D(uAtlas, uv).a;
#endif
}
float glyph(vec2 q, float gi, vec2 sc){      // q = 字格内坐标 [0,1]²，gi = 字形序号，sc = 内容区→图集的缩放
  float inside = step(0., q.x) * step(q.x, 1.) * step(0., q.y) * step(q.y, 1.);
  q = clamp(q, 0., 1.);
  return atlasA(vec2((gi * 44. + 6. + q.x * 32.) / 1024., (448. + q.y * 64.) / 512.), dcx * sc, dcy * sc) * inside;
}
float number(vec2 cu, vec2 o, float ch, float val){   // 在 o 处写「两位数 + %」，字高 ch
  float cw = ch * .55 / uAsp, k = floor((cu.x - o.x) / cw);
  float gi = k < .5 ? floor(val / 10.) : (k < 1.5 ? mod(val, 10.) : 16.);
  return glyph(vec2(fract((cu.x - o.x) / cw), (cu.y - o.y) / ch), gi, vec2(32. / 1024. / cw, 64. / 512. / ch)) * step(0., k) * step(k, 2.);
}
void main(){
  vec2 uv = vUv;
  dcx = dFdx(vUv) / vec2(.9, .76); dcy = dFdy(vUv) / vec2(.9, .76);
  vec2 lsc = vec2(600. / 1024. / uLabelW, 40. / 512. / .07), lgx = dFdx(vUv) * lsc, lgy = dFdy(vUv) * lsc;
  float tg = floor(uTime * 24.), sl = floor(uv.y * 16.);                          // 故障：按横条随机错位
  float gl = uGlitch * step(.5, hash21(vec2(sl, tg)));
  uv.x += (hash21(vec2(sl + 7., tg)) - .5) * .14 * gl;
  vec2 e = min(uv, 1. - uv); float m = min(e.x, e.y);
  float front = step(-.5, uKind);
  float a = .03 + (1. - smoothstep(.005, .012, m)) * .5;                          // 玻璃底色 + 外框
  a += step(m, .025) * step(max(e.x, e.y), .12) * .6 * front;                     // 四角括号
  vec2 lu = vec2((uv.x - .05) / uLabelW, (uv.y - .875) / .07);                    // 标题文字
  float lin = step(0., lu.x) * step(lu.x, 1.) * step(0., lu.y) * step(lu.y, 1.) * front;
  lu = clamp(lu, 0., 1.);
  a += atlasA(vec2((4. + lu.x * 600.) / 1024., 1. - (104. + uLabel * 40. - lu.y * 40.) / 512.), lgx, lgy) * lin * .7;
  a += step(.925, uv.x) * step(uv.x, .95) * step(.885, uv.y) * step(uv.y, .935) * step(.5, fract(uTime * 1.3 + uSeed)) * .6 * front;   // 状态灯
  a += step(abs(uv.y - .855), .0025) * step(.05, uv.x) * step(uv.x, .95) * .28 * front;                                              // 分隔线
  vec2 cu = (uv - vec2(.05, .08)) / vec2(.9, .76);                                // 内容区坐标 0~1
  float inC = step(0., cu.x) * step(cu.x, 1.) * step(0., cu.y) * step(cu.y, 1.);
  float c = 0.;
  if (uKind < -.5) {                                                              // 背板：暗网格
    vec2 g = abs(fract(cu * vec2(12., 6.)) - .5); c = step(.46, max(g.x, g.y)) * .22;
  } else if (uKind < .5) {                                                        // 0 柱状图：高度平滑换值，说话时更高
    float x = cu.x * 20., ci = floor(x), k = uScan * 1.2 + uSeed * 9.;
    float hh = mix(hash11(ci + floor(k) * 7.), hash11(ci + floor(k + 1.) * 7.), smoothstep(0., 1., fract(k)));
    hh = .08 + .8 * hh * (.65 + uAmp * .7);
    float bar = step(.2, fract(x)) * step(fract(x), .8);
    c += bar * step(cu.y, hh) * (.18 + .3 * cu.y / max(hh, .01)) + bar * step(abs(cu.y - hh), .012) * .5;
    c += step(fract(cu.y * 4. + .001), .015) * .1;
  } else if (uKind < 1.5) {                                                       // 1 十六进制滚动：地址 + 8 字节
    float R = 7., ry = (1. - cu.y) * R + uScan * .9 + uSeed * 13., ri = floor(ry), fy = fract(ry);
    float cx = cu.x * 30., ci = floor(cx), gi = 21.;
    if (ci < 3.5) gi = mod(floor(mod(ri * 8. + uSeed * 4096., 65536.) / exp2((3. - ci) * 4.)), 16.);
    else if (ci < 4.5) gi = 18.;
    else if (ci > 5.5) { float j = ci - 6., w = mod(j, 3.), v = floor(hash21(vec2(ri, floor(j / 3.) + uSeed * 17.)) * 256.);
      gi = w < .5 ? floor(v / 16.) : (w < 1.5 ? mod(v, 16.) : 21.); }
    float hi = step(.86, hash21(vec2(ri * 1.3, floor((ci - 6.) / 3.) + uSeed))) * step(5.5, ci);
    float g = glyph(vec2(fract(cx), 1. - (fy - .12) / .76), gi, vec2(30. * 32. / 1024., R / .76 * 64. / 512.));
    c += g * (.42 + hi * .45) * smoothstep(0., .08, cu.y) * smoothstep(1., .9, cu.y) + step(abs(cu.x - .155), .002) * .15;
  } else if (uKind < 2.5) {                                                       // 2 示波器：两条波形 + 跑动的亮点
    vec2 gq = abs(fract(cu * vec2(8., 4.)) - .5); c += step(.48, max(gq.x, gq.y)) * .1;
    float ph = uScan * 2.4 + uSeed, k1 = .45 + uAmp * 1.6;
    float w1 = .5 + .25 * sin(cu.x * 26. + ph * 1.3) * sin(cu.x * 6. - ph * .5) * k1;
    float w2 = .5 + .18 * sin(cu.x * 13. - ph * .9 + 2.) * (.4 + uAmp);
    c += (1. - smoothstep(.006, .02, abs(cu.y - w1))) * .75 + (1. - smoothstep(.004, .014, abs(cu.y - w2))) * .3;
    float sx = fract(uScan * .3 + uSeed), sy = .5 + .25 * sin(sx * 26. + ph * 1.3) * sin(sx * 6. - ph * .5) * k1;
    c += smoothstep(.045, 0., length((cu - vec2(sx, sy)) * vec2(uAsp, 1.))) * .8;
  } else if (uKind < 3.5) {                                                       // 3 雷达：距离环 + 十字 + 扫描余辉 + 目标点
    vec2 p = (cu - .5) * vec2(uAsp, 1.); float r = length(p), ang = atan(p.y, p.x), R = .46, fr = fwidth(r);
    c += (1. - smoothstep(0., fr * 1.5, abs(fract(r / (R * .25) + .5) - .5) * R * .25)) * step(r, R + .01) * .25;
    c += (step(abs(p.x), .002) + step(abs(p.y), .002)) * step(r, R) * .18;
    float sa = uScan * 1.6 + uSeed * 6.;
    c += exp(-mod(sa - ang, 6.2831853) * 2.2) * step(r, R) * .35;
    for (int i = 0; i < 6; i++) {
      float fi = float(i); vec2 bp = (vec2(hash11(fi + uSeed * 3.), hash11(fi * 7. + uSeed)) - .5) * R * 1.3;
      c += smoothstep(.022, 0., length(p - bp)) * (.2 + exp(-mod(sa - atan(bp.y, bp.x), 6.2831853) * 1.2)) * step(length(bp), R);
    }
  } else if (uKind < 4.5) {                                                       // 4 地图等高线：缓慢变形 + 移动的锁定框
    vec2 p = cu * vec2(uAsp, 1.) * 2.4 + uSeed * 3.7;
    float n = vnoise(p + uTime * .02) * .6 + vnoise(p * 2.1 - uTime * .03 + 5.) * .28 + vnoise(p * 4.3 - 2.) * .12;
    float lv = n * 11., dd = abs(fract(lv + .5) - .5);
    c += (1. - smoothstep(0., fwidth(lv) * 1.3, dd)) * (.2 + step(mod(floor(lv + .5), 4.), .5) * .25);
    vec2 gq = abs(fract(cu * vec2(10., 6.)) - .5); c += step(.485, max(gq.x, gq.y)) * .06;
    float tk = floor(uScan * .15 + uSeed);
    vec2 tp = vec2(hash11(tk + uSeed), hash11(tk * 3. + uSeed)) * .7 + .15, dq = abs((cu - tp) * vec2(uAsp, 1.));
    c += step(max(dq.x, dq.y), .07) * step(.058, max(dq.x, dq.y)) * (.4 + .3 * step(.5, fract(uTime * 2.)));
    c += (step(abs(cu.x - tp.x), .0015) + step(abs(cu.y - tp.y), .002)) * .12;
  } else {                                                                        // 5 进度环 + 百分比读数
    vec2 p = (cu - vec2(.25, .5)) * vec2(uAsp, 1.); float r = length(p), A = fract(atan(p.x, p.y) / 6.2831853 + 1.);
    for (int i = 0; i < 3; i++) {
      float fi = float(i), k = uScan * .2 + uSeed * 5. + fi * 1.7;
      float v = .2 + .78 * mix(hash11(floor(k) + fi * 9.), hash11(floor(k + 1.) + fi * 9.), smoothstep(0., 1., fract(k)));
      c += (1. - smoothstep(.022, .03, abs(r - (.42 - fi * .11)))) * (.08 + step(A, v) * .5);
      float y0 = .66 - fi * .26;
      c += number(cu, vec2(.6, y0), .18, floor(v * 100.)) * .7;
      c += step(abs(cu.y - (y0 - .04)), .012) * step(.6, cu.x) * step(cu.x, .6 + .35 * v) * .35;
    }
  }
  a += c * inC;
  a += smoothstep(.035, 0., abs(uv.y - fract(uScan * .25 + uSeed))) * .2 * inC * front;   // 扫描线（聆听时加快）
  float flick = .85 + .15 * step(.08, hash11(floor(uTime * 8.) + uSeed * 13.));            // 偶尔闪一下
  a *= flick * (1. + uPulse * 1.2 + gl * .8);
  a += (1. - smoothstep(.006, .02, m)) * (1. - uOpen) * .9;                                // 展开时边框更亮
  gl_FragColor = finish(mix(uColor, vec3(1.), .12 + uPulse * .35 + gl * .3), a * .5 * (1. + sweepHit(vW) * 2.5), vD);
}`;
const GRAD = renderer.capabilities.isWebGL2 ? { GRAD: 1 } : {};
const panelMat = (pu, kind, seed, w, h) => mat(VS_UV, PANEL_FS, { ...pu, uAtlas: { value: atlas }, uSeed: { value: seed }, uKind: { value: kind },
  uLabel: { value: KIND_LABEL[Math.max(kind, 0)] }, uLabelW: { value: Math.min(.8, 1.05 * h / w) }, uAsp: { value: (w * .9) / (h * .76) } },
  { side: THREE.DoubleSide, defines: GRAD });
const panelEdge = mat(VS_WORLD, `varying vec3 vW; varying float vD;
  void main(){ gl_FragColor = finish(mix(uColor, vec3(1.), .3), .3 * (1. + sweepHit(vW) * 2.), vD); }`);
const panels = [];
// [x, y, z, 宽, 高, 依次轮换的内容, 种子, 是否放进远景层]：按屏幕上避开全息球、字幕框和右侧对话栏来摆
[[-4.15, 2.55, -1.64, 2.6, 1.6, [3, 0], 1], [4.77, 2.04, -2.11, 2.6, 1.6, [1, 5], 2],          // 近：左上 / 右上
 [7.8, -1.25, -8.9, 2.8, 1.6, [2, 4], 3], [-4.05, 5.6, -13.5, 3, 1.5, [4, 1], 4], [6.7, 5.5, -14.5, 3.2, 1.7, [0, 3], 5],   // 中
 [-17.3, 2.57, -25.2, 3.4, 1.9, [5, 2], 6, true], [18.2, .4, -26, 3.4, 1.9, [3, 1], 7, true],   // 远（会被虚化）
].forEach(([x, y, z, w, h, kinds, seed, far], i) => {
  const pu = { uOpen: { value: 0 }, uGlitch: { value: 0 }, uPulse: { value: 0 } };
  const grp = new THREE.Group(), front = panelMat(pu, kinds[0], seed, w, h);
  grp.add(new THREE.Mesh(new THREE.PlaneGeometry(w, h), front));
  const box = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(w * 1.04, h * 1.06, .35)), panelEdge);
  box.position.z = -.12; grp.add(box);
  const back = new THREE.Mesh(new THREE.PlaneGeometry(w * .86, h * .84), panelMat(pu, -1, seed + 11, w, h));
  back.position.z = -.3; grp.add(back);
  grp.position.set(x, y, z); grp.visible = false; scene.add(far ? toFar(grp) : grp);
  panels.push({ grp, front, pu, w, h, kinds, ki: 0, seed, y, phase: 'wait', ot: 0, wait: .4 + i * .3, next: 0, fresh: true });
});
const dummy = new THREE.Object3D(), qTmp = new THREE.Quaternion();
const easeOut = x => 1 - Math.pow(1 - x, 3);
function updatePanels(t, dt) {
  for (const p of panels) {
    // 生命周期：等待 → 展开（故障闪烁）→ 显示 → 收起 → 换内容 → 展开 …
    if (p.phase === 'wait') { p.wait -= dt; if (p.wait <= 0) { p.phase = 'opening'; p.pu.uGlitch.value = 1; } }
    else if (p.phase === 'opening') { p.ot = Math.min(1, p.ot + dt / .75); if (p.ot >= 1) { p.phase = 'open'; p.next = t + rand(...CFG.panelRefresh); } }
    else if (p.phase === 'open') { if (t > p.next) p.phase = 'closing'; else if (Math.random() < dt * .05) p.pu.uGlitch.value = Math.max(p.pu.uGlitch.value, .5); }
    else if (p.phase === 'closing') {
      p.ot = Math.max(0, p.ot - dt / .35);
      if (p.ot <= 0) { p.ki = (p.ki + 1) % p.kinds.length; const k = p.kinds[p.ki];
        p.front.uniforms.uKind.value = k; p.front.uniforms.uLabel.value = KIND_LABEL[k]; p.phase = 'opening'; p.pu.uGlitch.value = 1; }
    }
    p.pu.uGlitch.value = Math.max(0, p.pu.uGlitch.value - dt * 1.6);
    p.pu.uPulse.value = Math.max(0, p.pu.uPulse.value - dt * 2.5);
    p.pu.uOpen.value = p.ot;
    // 展开：先横向拉出一道线，再上下展开；平时轻微呼吸
    const br = 1 + Math.sin(t * .9 + p.seed) * .012;
    p.grp.scale.set(easeOut(Math.min(1, p.ot / .35)) * br, Math.max(.02, easeOut(Math.max(0, (p.ot - .3) / .7))) * br, 1);
    p.grp.visible = p.ot > .001;
    p.grp.position.y = p.y + Math.sin(t * .4 + p.seed) * .13;
    // 朝向：在「面向全息球」和「面向镜头」之间按 panelFace 混合，再慢慢转过去
    dummy.position.copy(p.grp.position); dummy.lookAt(ORB); qTmp.copy(dummy.quaternion);
    dummy.lookAt(camera.position); qTmp.slerp(dummy.quaternion, CFG.panelFace);
    if (p.fresh) { p.grp.quaternion.copy(qTmp); p.fresh = false; } else p.grp.quaternion.slerp(qTmp, 1 - Math.exp(-dt * .9));
  }
}

/* ==================== 11. 数据连线：面板之间（思考/说话时也和全息球之间）拉出光束，数据包沿光束飞过去 ==================== */
const LINK_N = 16, LINK_SEG = 40;
const links = [], headPos = new Float32Array(LINK_N * 3), headA = new Float32Array(LINK_N);
{
  const sArr = new Float32Array(LINK_SEG + 1); for (let i = 0; i <= LINK_SEG; i++) sArr[i] = i / LINK_SEG;
  for (let i = 0; i < LINK_N; i++) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array((LINK_SEG + 1) * 3), 3));
    g.setAttribute('aS', new THREE.BufferAttribute(sArr, 1));
    const lu = { uHead: { value: 0 }, uLife: { value: 0 } };
    const line = new THREE.Line(g, mat(`attribute float aS; varying float vS, vD; varying vec3 vW;
        void main(){ vS = aS; vec4 w = modelMatrix * vec4(position, 1.); vW = w.xyz; vec4 mv = viewMatrix * w; vD = -mv.z; gl_Position = projectionMatrix * mv; }`,
      `uniform float uHead, uLife; varying float vS, vD; varying vec3 vW;
        void main(){
          float trail = smoothstep(uHead - .3, uHead, vS) * step(vS, uHead), head = exp(-pow((vS - uHead) * 22., 2.));
          float a = (.2 * smoothstep(0., .08, vS) * smoothstep(1., .92, vS) + trail * .6 + head) * uLife;
          gl_FragColor = finish(mix(uColor, vec3(1.), head * .6), a * .8 * (1. + uState.z * .6), vD);
        }`, lu));
    line.frustumCulled = false; line.visible = false; scene.add(line);
    const glow = new THREE.Points(g, mat(`attribute float aS; uniform float uHead, uLife; varying float vA, vD;
        void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.); vD = -mv.z;
          float tr = smoothstep(uHead - .28, uHead, aS) * step(aS, uHead);           // 只在数据包身后发光
          vA = tr * tr * uLife; gl_PointSize = vA > .01 ? (2. + 5. * tr) * uPR * 7. / max(vD, 1.) : 0.; gl_Position = projectionMatrix * mv; }`,
      `varying float vA, vD; void main(){ float d = length(gl_PointCoord - .5); if (d > .5) discard;
        gl_FragColor = finish(mix(uColor, vec3(1.), .4), vA * .35 * pow(1. - d * 2., 2.), vD); }`, lu));
    glow.frustumCulled = false; line.add(glow);   // 跟着连线一起显示/隐藏
    links.push({ i, line, g, lu, on: false, a: null, b: null, t: 0, dur: 1, arrived: false, pa: new THREE.Vector3(), pb: new THREE.Vector3() });
  }
}
const headGeo = new THREE.BufferGeometry();   // 所有数据包的光点共用一个 Points
headGeo.setAttribute('position', new THREE.BufferAttribute(headPos, 3)); headGeo.setAttribute('aA', new THREE.BufferAttribute(headA, 1));
{
  const heads = new THREE.Points(headGeo, mat(`attribute float aA; varying float vA, vD;
      void main(){ vA = aA; vec4 mv = modelViewMatrix * vec4(position, 1.); vD = -mv.z; gl_PointSize = aA > 0. ? 90. * uPR / max(vD, 1.) : 0.; gl_Position = projectionMatrix * mv; }`,
    `varying float vA, vD; void main(){ float d = length(gl_PointCoord - .5); if (d > .5) discard;
      gl_FragColor = finish(mix(uColor, vec3(1.), .7), vA * (pow(1. - d * 2., 3.) * .8 + smoothstep(.12, 0., d)), vD); }`));
  heads.frustumCulled = false; scene.add(heads);
}
const ctrl = new THREE.Vector3(), tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3();
function endPoint(node, toward, out) {   // 端点：面板取朝向对方那一侧的边缘中点，全息球取外沿
  if (node === 'orb') return out.copy(toward).sub(ORB).normalize().multiplyScalar(1.7).add(ORB);
  out.set(node.w * .5, 0, 0).applyMatrix4(node.grp.matrixWorld); tmpB.set(-node.w * .5, 0, 0).applyMatrix4(node.grp.matrixWorld);
  return out.distanceToSquared(toward) < tmpB.distanceToSquared(toward) ? out : out.copy(tmpB);
}
function spawnLink(S) {
  const k = links.find(l => !l.on), open = panels.filter(p => p.phase === 'open');
  if (!k || !open.length) return;
  const pick = () => open[Math.floor(Math.random() * open.length)];
  let a = pick(), b; const r = Math.random();
  if (S.thinking > .5 && r < .45) b = 'orb';                   // 思考：数据流进核心
  else if (S.speaking > .5 && r < .4) { b = a; a = 'orb'; }    // 说话：核心把结果发出去
  else { if (open.length < 2) return; do b = pick(); while (b === a); }
  Object.assign(k, { on: true, a, b, t: 0, arrived: false, dur: rand(.7, 1.3) * (S.thinking > .5 ? .7 : 1) });
  k.line.visible = true;
}
function updateLinks(dt) {
  for (const k of links) {
    if (!k.on) { headA[k.i] = 0; continue; }
    k.t += dt / k.dur;                                          // 0→1 数据包飞行，之后 0.4 秒淡出
    if (k.t >= 1 && !k.arrived) { k.arrived = true; if (k.b !== 'orb') k.b.pu.uPulse.value = 1; }   // 到达：目标面板闪一下
    if (k.t > 1.4) { k.on = false; k.line.visible = false; headA[k.i] = 0; continue; }
    const life = k.t < .15 ? k.t / .15 : k.t > 1 ? Math.max(0, 1 - (k.t - 1) / .4) : 1, s = Math.min(k.t, 1);
    endPoint(k.a, k.b === 'orb' ? ORB : k.b.grp.position, k.pa); endPoint(k.b, k.a === 'orb' ? ORB : k.a.grp.position, k.pb);
    ctrl.addVectors(k.pa, k.pb).multiplyScalar(.5); ctrl.y += k.pa.distanceTo(k.pb) * .22;   // 光束往上拱成弧线
    const arr = k.g.attributes.position.array;
    for (let i = 0; i <= LINK_SEG; i++) {
      const q = i / LINK_SEG, u = 1 - q;
      tmpA.copy(k.pa).multiplyScalar(u * u).addScaledVector(ctrl, 2 * u * q).addScaledVector(k.pb, q * q);
      arr[i * 3] = tmpA.x; arr[i * 3 + 1] = tmpA.y; arr[i * 3 + 2] = tmpA.z;
    }
    k.g.attributes.position.needsUpdate = true;
    k.lu.uHead.value = s * 1.02; k.lu.uLife.value = life;
    tmpA.copy(k.pa).multiplyScalar((1 - s) * (1 - s)).addScaledVector(ctrl, 2 * (1 - s) * s).addScaledVector(k.pb, s * s);
    headPos[k.i * 3] = tmpA.x; headPos[k.i * 3 + 1] = tmpA.y; headPos[k.i * 3 + 2] = tmpA.z;
    headA[k.i] = k.t < 1 ? life : 0;
  }
  headGeo.attributes.position.needsUpdate = true; headGeo.attributes.aA.needsUpdate = true;
}

/* ==================== 12. 粒子 ==================== */
// 12a 细小星尘：缓慢上升、各自闪烁；近处的大而淡，远处的放进远景层被虚化
function dustCloud(N, zNear, zFar, far) {
  const pos = new Float32Array(N * 3), rnd = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const z = zNear + (zFar - zNear) * Math.random(), spread = 6 + (9 - z) * .6;   // 越远铺得越宽，跟着视锥张开
    pos.set([(Math.random() - .5) * 2 * spread, FLOOR_Y + Math.random() * 13, z], i * 3); rnd[i] = Math.random();
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('aR', new THREE.BufferAttribute(rnd, 1));
  const p = new THREE.Points(g, mat(`attribute float aR; varying float vA, vD;
    void main(){ vec3 p = position;
      float h = mod(p.y - FLOOR_Y + uMote * (.12 + aR * .18), 13.); p.y = FLOOR_Y + h;
      p.x += sin(uTime * .21 + p.z * .7 + aR * 6.) * .35; p.z += cos(uTime * .17 + p.x * .5) * .25;
      vec4 mv = modelViewMatrix * vec4(p, 1.); vD = -mv.z;
      float tw = .5 + .5 * sin(uTime * (1.2 + aR * 2.6) + aR * 40.);
      vA = (.35 + .65 * tw * tw) * smoothstep(0., 1.2, h) * smoothstep(13., 10., h) * smoothstep(.6, 2.2, vD) * (1. + uAmp * uState.w * 1.4);
      gl_PointSize = min((1.3 + aR * 1.4) * uPR * 7. / vD + 1., 7. * uPR); gl_Position = projectionMatrix * mv; }`,
  `varying float vA, vD; void main(){ float d = length(gl_PointCoord - .5); if (d > .5) discard;
    gl_FragColor = finish(mix(uColor, vec3(1.), .45), vA * .55 * pow(1. - d * 2., 1.5), vD); }`));
  scene.add(far ? toFar(p) : p);
}
dustCloud(CFG.stardust, 7, -24, false);
dustCloud(CFG.farDust, -24, -75, true);

// 12b 前景虚化光斑：离镜头很近、很大很淡，镜头一动视差最明显
{
  const N = CFG.bokeh, pos = new Float32Array(N * 3), rnd = new Float32Array(N);
  for (let i = 0; i < N; i++) { pos.set([(Math.random() - .5) * 13, (Math.random() - .5) * 6 + .8, 1.5 + Math.random() * 4.5], i * 3); rnd[i] = Math.random(); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('aR', new THREE.BufferAttribute(rnd, 1));
  scene.add(new THREE.Points(g, mat(`attribute float aR; varying float vA, vD;
    void main(){ vec3 p = position; p.x += sin(uTime * .07 + aR * 20.) * .6; p.y += sin(uTime * .05 + aR * 11.) * .4;
      vec4 mv = modelViewMatrix * vec4(p, 1.); vD = -mv.z;
      vA = (.6 + .4 * sin(uTime * (.3 + aR * .5) + aR * 30.)) * smoothstep(1.2, 2.5, vD) * (1. + uAmp * uState.w);
      gl_PointSize = (60. + aR * 90.) * uPR * 3. / max(vD, .5); gl_Position = projectionMatrix * mv; }`,
  `varying float vA, vD; void main(){ float d = length(gl_PointCoord - .5); if (d > .5) discard;
    float disc = smoothstep(.5, .43, d), rim = disc - smoothstep(.45, .3, d);              // 圆盘 + 稍亮的边，像镜头光斑
    gl_FragColor = finish(mix(uColor, vec3(1.), .3), vA * (disc * .035 + rim * .05), vD); }`)));
}

// 12c 带拖尾的大光点：每个 = 头 + 若干节拖尾，拖尾在顶点着色器里用「过去的时刻」算位置，CPU 不用每帧更新
{
  const M = CFG.motes, T = CFG.moteTrail, N = M * T;
  const seed = new Float32Array(N * 4), kk = new Float32Array(N);
  for (let i = 0; i < M; i++) {
    const x0 = (Math.random() - .5) * 26, z0 = 4 - Math.random() * 30, spd = .35 + Math.random() * .5, ph = Math.random() * 100;
    for (let j = 0; j < T; j++) { seed.set([x0, z0, spd, ph], (i * T + j) * 4); kk[i * T + j] = j; }
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
  g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4)); g.setAttribute('aK', new THREE.BufferAttribute(kk, 1));
  const p = new THREE.Points(g, mat(`attribute vec4 aSeed; attribute float aK; varying float vA, vD, vHead;
    void main(){
      float T = uMote - aK * .12, H = 13.;                                  // 这一节拖尾对应的时刻
      float yy = T * aSeed.z + aSeed.w, loopK = floor(yy / H), h = yy - loopK * H;
      float loopH = floor((uMote * aSeed.z + aSeed.w) / H);                  // 拖尾跨过循环接缝时隐藏
      vec3 p = vec3(aSeed.x + sin(T * .35 + aSeed.w) * 1.2 + sin(T * .13 + aSeed.w * 2.) * 1.5, FLOOR_Y + h, aSeed.y + cos(T * .27 + aSeed.w));
      vec4 mv = modelViewMatrix * vec4(p, 1.); vD = -mv.z;
      float tail = 1. - aK / ${f(T)}; vHead = step(aK, .5);
      vA = tail * tail * step(loopH - .5, loopK) * smoothstep(0., 1.5, h) * smoothstep(H, H - 2.5, h) * smoothstep(.8, 2.5, vD) * (1. + uAmp * uState.w * 1.5);
      gl_PointSize = (vHead > .5 ? 7.5 : 4.5 * tail + 1.) * uPR * 9. / max(vD, 1.); gl_Position = projectionMatrix * mv; }`,
  `varying float vA, vD, vHead; void main(){ float d = length(gl_PointCoord - .5); if (d > .5) discard;
    gl_FragColor = finish(mix(uColor, vec3(1.), .35 + vHead * .4), vA * (pow(1. - d * 2., 2.) * .6 + vHead * smoothstep(.15, 0., d)), vD); }`));
  p.frustumCulled = false; scene.add(p);
}

// 12d 螺旋粒子流：5 条旋臂在不同倾角的平面里，绕着全息球越转越快地被「吸」进去
{
  const N = CFG.spiral, ARMS = 5, aU = new Float32Array(N * 3), aV = new Float32Array(N * 3), aP = new Float32Array(N * 4), arms = [];
  for (let k = 0; k < ARMS; k++) {
    // 旋臂平面的法线大致朝向镜头（最多偏 60° 左右），避免侧对镜头时变成一条穿过球心的直线
    const n = new THREE.Vector3(rand(-1, 1), rand(-.9, .9), rand(.55, 1)).normalize();
    const u = new THREE.Vector3(1, 0, 0).cross(n).normalize(), v = new THREE.Vector3().crossVectors(n, u).multiplyScalar(k % 2 ? 1 : -1);
    arms.push([u, v, rand(0, Math.PI * 2)]);
  }
  for (let i = 0; i < N; i++) {
    const [u, v, a0] = arms[i % ARMS];
    aU.set([u.x, u.y, u.z], i * 3); aV.set([v.x, v.y, v.z], i * 3);
    aP.set([Math.random(), a0 + rand(-.07, .07), rand(5.6, 6.4), rand(.06, .08)], i * 4);   // 起始相位、起始角、起始半径、速度
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
  g.setAttribute('aU', new THREE.BufferAttribute(aU, 3)); g.setAttribute('aV', new THREE.BufferAttribute(aV, 3)); g.setAttribute('aP', new THREE.BufferAttribute(aP, 4));
  const p = new THREE.Points(g, mat(`attribute vec3 aU, aV; attribute vec4 aP; varying float vA, vD;
    void main(){
      float f = fract(aP.x + uSpiral * aP.w);                                // 生命周期 0→1
      float r = mix(aP.z, 2.4, pow(f, 1.3)), ang = aP.y + f * 4.6 + pow(f, 3.) * 4.;   // 半径收缩、越近转得越快
      vec3 p = ORB + (aU * cos(ang) + aV * sin(ang)) * r;
      p += vec3(sin(f * 40. + aP.x * 50.), cos(f * 33. + aP.x * 70.), sin(f * 27. + aP.x * 90.)) * .07 * (1. - f);
      vec4 mv = modelViewMatrix * vec4(p, 1.); vD = -mv.z;
      vA = smoothstep(0., .2, f) * smoothstep(1., .75, f) * (.75 + uAmp * uState.w * 1.6 + uState.z * .5);
      gl_PointSize = (2.2 + 2. * f) * uPR * 8. / vD + .6; gl_Position = projectionMatrix * mv; }`,
  `varying float vA, vD; void main(){ float d = length(gl_PointCoord - .5); if (d > .5) discard;
    gl_FragColor = finish(mix(uColor, vec3(1.), .35), vA * .7 * pow(1. - d * 2., 1.5), vD); }`));
  p.frustumCulled = false; p.name = 'spiral'; scene.add(p);
}

/* ==================== 13. 横扫扫描光：说话时偶尔有一面体积光墙横扫全场，经过的网格/面板/城市都被点亮 ==================== */
// 光墙本身画在第 2 节体积雾着色器里（按视线穿过光墙的长度算亮度 = 体积光）；各物体用 sweepHit() 在被扫到时点亮；
// 何时扫、扫到哪里由第 16 节的 updateSweep() 驱动（uSweep = 位置 / 强度）。光墙朝向改 HEAD 里的 SWEEP_DIR。

/* ==================== 14. 景深：远景层渲染到低分辨率纹理，3×3 模糊后叠回画面 ==================== */
const farU = { tFar: { value: null }, uTexel: { value: new THREE.Vector2() }, uBlur: { value: CFG.farBlur }, uGain: { value: CFG.farGain } };
const compScene = new THREE.Scene();
{
  const q = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({ uniforms: farU, ...add, depthTest: false,
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }`,
    fragmentShader: `uniform sampler2D tFar; uniform vec2 uTexel; uniform float uBlur, uGain; varying vec2 vUv;
      vec3 tap(vec2 o){ return texture2D(tFar, vUv + o * uTexel * uBlur).rgb; }
      void main(){
        vec3 c = tap(vec2(0.)) * .25 + (tap(vec2(1., 0.)) + tap(vec2(-1., 0.)) + tap(vec2(0., 1.)) + tap(vec2(0., -1.))) * .125
               + (tap(vec2(1.)) + tap(vec2(-1.)) + tap(vec2(1., -1.)) + tap(vec2(-1., 1.))) * .0625;
        float dither = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) / 255.;   // 抖动，防止暗部出现色带
        gl_FragColor = vec4(c * uGain + dither, 1.);
      }` }));
  q.frustumCulled = false; compScene.add(q);
}
let farRT = null, dofOn = CFG.dof, farScale = CFG.farScale;
function makeFarRT() {
  const gl2 = renderer.capabilities.isWebGL2, half = gl2 && renderer.extensions.has('EXT_color_buffer_float');
  farRT = new THREE.WebGLRenderTarget(1, 1, { type: half ? THREE.HalfFloatType : THREE.UnsignedByteType, samples: gl2 ? 4 : 0, depthBuffer: false });
  farU.tFar.value = farRT.texture;
}

/* ==================== 15. 尺寸：画面中心对准全息球（沿用 setViewOffset 对齐 .holo） ==================== */
const anchor = document.querySelector('.holo');
const mainRes = new THREE.Vector2(1, 1);
function resize() {
  const W = innerWidth, H = innerHeight;
  pixelRatio = Math.min(devicePixelRatio, prCap);   // 窗口在 Retina 和外接屏之间拖动时像素比会变
  renderer.setPixelRatio(pixelRatio); renderer.setSize(W, H, false); camera.aspect = W / H;
  const r = anchor ? anchor.getBoundingClientRect() : { left: W / 2, top: H / 2, width: 0, height: 0 };
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  camera.setViewOffset(W, H, W / 2 - cx, H / 2 - cy, W, H);
  camera.updateProjectionMatrix();
  U.uCenter.value.set(cx / W, 1 - cy / H, Math.max(.08, r.width * .34 * 1.28 / H));   // 全息球外壳的屏幕半径（屏幕高 = 1）
  U.uAspect.value = W / H;
  renderer.getDrawingBufferSize(mainRes);
  if (dofOn) {
    if (!farRT) makeFarRT();
    farRT.setSize(Math.max(1, Math.round(mainRes.x * farScale)), Math.max(1, Math.round(mainRes.y * farScale)));
    farU.uTexel.value.set(1 / farRT.width, 1 / farRT.height);
  }
}
addEventListener('resize', resize); resize();

/* ==================== 16. 状态联动 + 动画循环 ====================
   idle：安静、缓慢呼吸 ｜ listening：镜头推近、面板扫描线加快、颜色跟 J.rgb ｜
   thinking：巨型环加速、数据连线变密、光流/拱门加速 ｜ speaking：地面光波和粒子随 amp 律动、偶尔横扫扫描光
   所有速度都积分成相位（uFlow / uScan …），状态权重做指数平滑，切换时不跳变。 */
const S = { idle: 1, listening: 0, thinking: 0, speaking: 0 };
const clock = new THREE.Clock(), tmpC = new THREE.Color();
let t = 0, amp = 0, prevAmp = 0, lastRip = 0, ripIdx = 0, linkTimer = 1.5, ringPhase = 0, archTravel = 0;
const sweep = { on: false, t0: -99, next: 0, prevSpeak: false };
function addRipple(k) { const i = ripIdx++ % 6; ripU.uRip.value[i] = t; ripU.uRipK.value[i] = k; lastRip = t; }
function updateSweep() {
  const speaking = J.state === 'speaking';
  if (speaking && !sweep.prevSpeak && t - sweep.t0 > 4) sweep.next = t + .6;      // 刚开口时很快来一道
  sweep.prevSpeak = speaking;
  if (!sweep.on && speaking && t > sweep.next) { sweep.on = true; sweep.t0 = t; }
  if (!sweep.on) return;
  const k = (t - sweep.t0) / CFG.sweepTime;
  if (k >= 1) { sweep.on = false; sweep.next = t + rand(...CFG.sweepEvery); U.uSweep.value.set(-99, 0); return; }
  const X = -36 + 52 * k * k * (3 - 2 * k);                                       // 缓入缓出，从左扫到右（光墙斜 37°，近处先到）
  U.uSweep.value.set(X, Math.sin(Math.PI * k));
}
function frame() {
  const raw = clock.getDelta(), dt = Math.min(raw, .05); t += dt;
  perf(raw);
  const kS = 1 - Math.exp(-dt * CFG.stateBlend);
  for (const s in S) S[s] += ((J.state === s ? 1 : 0) - S[s]) * kS;
  U.uState.value.set(S.idle, S.listening, S.thinking, S.speaking);
  const a = J.amp || 0; amp += (a - amp) * (1 - Math.exp(-dt * 12));
  U.uTime.value = t; U.uAmp.value = amp;
  const [r, g, b] = (J.rgb || '79,227,255').split(',').map(v => +v / 255); tmpC.setRGB(r, g, b, THREE.SRGBColorSpace);
  U.uColor.value.lerp(tmpC, 1 - Math.exp(-dt * 4));                                // 颜色跟着 J.rgb 平滑过渡
  const themed = document.body.dataset.theme && document.body.dataset.theme !== 'grid', kF = 1 - Math.exp(-dt * 3);
  U.uFade.value += ((themed ? .65 : 1) - U.uFade.value) * kF;                       // 照片/视频主题整体压到 0.65
  U.uPhoto.value += ((themed ? 1 : 0) - U.uPhoto.value) * kF;
  U.uBreath.value = 1 + Math.sin(t * .55) * CFG.breath * S.idle;                   // 待机呼吸
  U.uFogNear.value = CFG.fogNear; U.uFogDen.value = CFG.fogDensity; U.uFogFloor.value = CFG.fogFloor;
  U.uSat.value = CFG.saturation; U.uCenterDim.value = CFG.centerDim; ripU.uFlowD.value = CFG.flowDensity;
  fogU.uGlow.value = CFG.fogGlow; fogU.uHK.value = CFG.fogHeight; farU.uBlur.value = CFG.farBlur; farU.uGain.value = CFG.farGain;
  const sp = S.speaking * amp;
  U.uFlow.value += dt * CFG.flowSpeed * (1 + S.thinking * 1.2 + sp * 2.5);
  U.uScan.value += dt * (1 + S.listening * 2.5 + S.thinking * 1.2);
  U.uSpin.value += dt * (1 + S.thinking * 3.5 + sp * 2);
  U.uSpiral.value += dt * (1 + S.thinking * 1.5 + sp * 3);
  U.uMote.value += dt * (1 + S.thinking * .8 + sp * 1.5);
  U.uGrid.value += dt * CFG.gridScroll;
  // 地面光波：声音突然变大时；说话/思考时也定期发一圈
  if (a > .18 && a - prevAmp > .05 && t - lastRip > .45) addRipple(Math.min(1, .4 + a * 1.2));
  else if (J.state === 'speaking' && t - lastRip > 1.6) addRipple(.6);
  else if (J.state === 'thinking' && t - lastRip > 2.6) addRipple(.35);
  prevAmp = a;
  ringPhase += dt * CFG.ringSpin * (1 + (CFG.ringThink - 1) * S.thinking + sp * 2);
  for (const gr of giantRings) gr.m.rotation.z = ringPhase * gr.sp;
  gyro.rotation.y = -1.1 + Math.sin(t * .03) * .25 + ringPhase * .15;
  archTravel += dt * 1.2 * (1 + S.thinking * 2 + sp);
  for (let i = 0; i < ARCH_N; i++) arches[i].position.z = 6 - ((i * ARCH_GAP + archTravel) % (ARCH_N * ARCH_GAP));
  const sk = 1 + S.thinking * 2;
  for (const s of solids) { s.o.rotation.x += dt * s.sp * .6 * sk; s.o.rotation.y += dt * s.sp * sk; s.o.position.y = s.y + Math.sin(t * .3 + s.sp * 10) * .4; }
  // 镜头：缓慢漂移 + 鼠标视差，始终对准全息球（以球为支点产生视差）；聆听时推近
  const [px, py] = J.pm || [0, 0];
  const dx = Math.sin(t * .11) * CFG.drift[0], dy = Math.sin(t * .07) * CFG.drift[1];
  camera.position.set(px * CFG.parallax[0] + dx, .9 - py * CFG.parallax[1] + dy, 9 - S.listening * CFG.pushIn + Math.sin(t * .05) * .5);
  camera.lookAt(ORB); camera.updateMatrixWorld();
  updatePanels(t, dt);
  if ((linkTimer -= dt) <= 0) {
    const L = CFG.linkEvery;
    linkTimer = (S.idle * L.idle + S.listening * L.listening + S.thinking * L.thinking + S.speaking * L.speaking) * rand(.6, 1.4);
    spawnLink(S);
  }
  updateLinks(dt);
  updateSweep();
  fogU.uInvVP.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).invert();
  fogU.uCam.value.copy(camera.position);
  render();
}
function render() {
  renderer.setRenderTarget(null); renderer.clear();
  if (dofOn && farRT) {                     // 远景层 → 低分辨率纹理 → 模糊叠加
    camera.layers.set(FAR); U.uRes.value.set(farRT.width, farRT.height); U.uPR.value = pixelRatio * farScale;
    renderer.setRenderTarget(farRT); renderer.clear(); renderer.render(scene, camera); renderer.setRenderTarget(null);
    camera.layers.set(0); renderer.render(compScene, camera);
  } else { camera.layers.set(0); camera.layers.enable(FAR); }
  U.uRes.value.copy(mainRes); U.uPR.value = pixelRatio;
  renderer.render(scene, camera);           // 中近景（关掉景深时远景也在这里一起画）
}

/* 自动降画质：连续 2 秒平均帧率低于 50，先把像素比降到 1，还不够再把远景层分辨率降到 0.35 */
let perfT = 0, perfN = 0, perfWarm = 3;
function perf(raw) {
  if (!CFG.autoQuality) return;
  if (perfWarm > 0) { perfWarm -= raw; return; }          // 刚启动、刚切回标签页时先不统计
  if (raw > .25) return;                                   // 偶发卡顿（切主题、加载视频）不算
  perfT += raw; perfN++;
  if (perfT < 2) return;
  const fps = perfN / perfT; perfT = perfN = 0;
  if (fps >= 50) return;
  if (pixelRatio > 1) prCap = 1;
  else if (dofOn && farScale > .35) farScale = .35;
  else { CFG.autoQuality = false; return; }
  perfWarm = 1; resize();
}

/* 标签页切到后台时暂停渲染，切回来接着跑 */
let raf = 0;
function loop() { raf = requestAnimationFrame(loop); frame(); }
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { cancelAnimationFrame(raf); raf = 0; }
  else if (!raf) { clock.getDelta(); perfWarm = 2; raf = requestAnimationFrame(loop); }
});
loop();
window.JARVIS_BG = { CFG, U, S, scene, panels, links, renderer };   // 控制台调参 / 排查入口，例如 JARVIS_BG.CFG.fogGlow = .8
