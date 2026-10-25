// Solar Storm Ops: the 3D scene.
// Units: 1 = one Earth radius. Satellites sit at true altitude. Earth stays fixed
// (Earth-fixed frame, same as the lat/lon from the API) and the Sun moves around it
// at its real position for the current time. The Sun to Earth view is not to scale.
import * as THREE from './vendor/three.module.min.js';
import { OrbitControls } from './vendor/OrbitControls.js';

const RE_KM = 6371;
const SUN_DIST = 46;      // scene units, not to scale (real: ~23,500 Earth radii)
const SUN_RADIUS = 3.4;
const L1_DIST = 11;       // not to scale (real: ~235 Earth radii)
const RISK_COLORS = {
  fine: new THREE.Color('#5d7aa8'),
  watch: new THREE.Color('#e9c46a'),
  high: new THREE.Color('#f4892f'),
  critical: new THREE.Color('#ff3b5c'),
  protected: new THREE.Color('#7df9c2'),
};

// lat/lon (deg) -> scene vector, matching three.js sphere UVs for an
// equirectangular Earth texture (lon 0 on +x, lon +90 on -z, north on +y)
export function llToVec(latDeg, lonDeg, r = 1, out = new THREE.Vector3()) {
  const lat = THREE.MathUtils.degToRad(latDeg);
  const lon = THREE.MathUtils.degToRad(lonDeg);
  return out.set(r * Math.cos(lat) * Math.cos(lon), r * Math.sin(lat), -r * Math.cos(lat) * Math.sin(lon));
}

// Subsolar point for a UTC date (low-precision solar position, good to ~0.1 deg)
export function sunDirection(date) {
  const n = (date.getTime() / 86400000) + 2440587.5 - 2451545.0;
  const rad = Math.PI / 180;
  const L = (280.46 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * rad;
  const lambda = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * rad;
  const eps = (23.439 - 0.0000004 * n) * rad;
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const gmst = (280.46061837 + 360.98564736629 * n) % 360;
  let lon = ra / rad - gmst;
  lon = ((lon + 540) % 360) - 180;
  return llToVec(dec / rad, lon, 1);
}

const EARTH_VERT = `
  varying vec2 vUv; varying vec3 vNormal; varying vec3 vView;
  void main() {
    vUv = uv;
    vNormal = normalize(mat3(modelMatrix) * normal);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vView = normalize(cameraPosition - wp.xyz);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }`;
const EARTH_FRAG = `
  uniform sampler2D dayMap; uniform sampler2D nightMap; uniform vec3 sunDir;
  varying vec2 vUv; varying vec3 vNormal; varying vec3 vView;
  void main() {
    vec3 n = normalize(vNormal);
    float d = dot(n, sunDir);
    float dayMix = smoothstep(-0.10, 0.22, d);
    vec3 day = texture2D(dayMap, vUv).rgb * (0.35 + 0.75 * max(d, 0.0));
    vec3 night = texture2D(nightMap, vUv).rgb;
    night = pow(night, vec3(1.6)) * vec3(1.0, 0.78, 0.5) * 2.2;
    vec3 col = mix(night + day * 0.02, day, dayMix);
    float rim = pow(1.0 - max(dot(n, normalize(vView)), 0.0), 3.0);
    col += vec3(0.30, 0.55, 1.0) * rim * (0.15 + 0.7 * smoothstep(-0.3, 0.6, d));
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }`;

const GLOW_VERT = `
  varying vec3 vN; varying vec3 vWorldN;
  void main() {
    vN = normalize(normalMatrix * normal);
    vWorldN = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;
const ATMO_FRAG = `
  uniform vec3 sunDir; varying vec3 vN; varying vec3 vWorldN;
  void main() {
    float i = pow(clamp(0.78 - dot(vN, vec3(0.0, 0.0, 1.0)), 0.0, 1.0), 3.5);
    float lit = 0.25 + 0.75 * smoothstep(-0.4, 0.5, dot(-vWorldN, sunDir));
    gl_FragColor = vec4(vec3(0.32, 0.6, 1.0) * i * 1.15 * lit, 1.0);
  }`;

const SAT_VERT = `
  attribute vec3 aColor; attribute float aSize;
  uniform float uPixelRatio; varying vec3 vColor;
  void main() {
    vColor = aColor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = aSize * uPixelRatio * clamp(4.2 / -mv.z, 0.18, 2.6);
  }`;
const SAT_FRAG = `
  uniform float uFade; varying vec3 vColor;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    if (d > 0.5) discard;
    float a = smoothstep(0.5, 0.05, d) * uFade;
    gl_FragColor = vec4(vColor * (0.55 + 0.9 * a), a);
  }`;

const SUN_VERT = `
  varying vec3 vN; varying vec3 vPos;
  void main() {
    vN = normalize(normalMatrix * normal);
    vPos = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;
const SUN_FRAG = `
  uniform float uTime; uniform float uActivity; varying vec3 vN; varying vec3 vPos;
  float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  float noise(vec3 x) {
    vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  void main() {
    float mu = max(dot(normalize(vN), vec3(0.0, 0.0, 1.0)), 0.0);
    vec3 p = normalize(vPos);
    float n = noise(p * 3.0 + uTime * 0.04) * 0.55 + noise(p * 9.0 - uTime * 0.07) * 0.3 + noise(p * 24.0 + uTime * 0.1) * 0.15;
    vec3 hot = vec3(1.0, 0.88, 0.58); vec3 warm = vec3(1.0, 0.48, 0.12);
    vec3 col = mix(warm, hot, smoothstep(0.25, 0.85, n));
    col *= 0.45 + 0.65 * pow(mu, 0.45);
    col += vec3(1.0, 0.5, 0.2) * uActivity * smoothstep(0.62, 0.9, n) * 0.8;
    gl_FragColor = vec4(col * 1.3, 1.0);
  }`;

const MAG_VERT = `
  uniform float uNose; uniform float uTail;
  varying vec3 vN; varying float vS;
  void main() {
    vec3 p = position;
    float s = p.x;                       // +x points at the Sun
    float r = s > 0.0 ? uNose : mix(uNose, uTail, -s);
    vec3 q = vec3(p.x * r, p.y * r * (s > 0.0 ? 1.0 : 1.0 - 0.45 * -s), p.z * r * (s > 0.0 ? 1.0 : 1.0 - 0.45 * -s));
    vN = normalize(normalMatrix * normal);
    vS = s;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(q, 1.0);
  }`;
const MAG_FRAG = `
  uniform float uOpacity; uniform float uFlash; varying vec3 vN; varying float vS;
  void main() {
    float rim = pow(1.0 - abs(dot(vN, vec3(0.0, 0.0, 1.0))), 2.2);
    vec3 col = mix(vec3(0.35, 0.75, 1.0), vec3(0.5, 1.0, 0.78), uFlash);
    float a = rim * (uOpacity + uFlash * 0.6) * (0.55 + 0.45 * smoothstep(-0.2, 1.0, vS));
    gl_FragColor = vec4(col * a, a);
  }`;

function radialTexture(stops) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  stops.forEach(([o, col]) => grd.addColorStop(o, col));
  g.fillStyle = grd;
  g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function createScene(canvas, labelLayer, { reducedMotion = false } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor('#03050b', 1);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.01, 2000);
  camera.position.set(0.6, 1.4, 3.6);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  controls.minDistance = 1.25;
  controls.maxDistance = 160;
  controls.rotateSpeed = 0.5;
  controls.autoRotate = !reducedMotion;
  controls.autoRotateSpeed = 0.18;

  const loader = new THREE.TextureLoader();
  const tex = (url) => { const t = loader.load(url); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t; };
  const sunDir = sunDirection(new Date());

  // stars
  {
    const n = 2600, pos = new Float32Array(n * 3), col = new Float32Array(n * 3), size = new Float32Array(n);
    const v = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      v.randomDirection().multiplyScalar(600 + Math.random() * 200);
      pos.set([v.x, v.y, v.z], i * 3);
      const w = 0.25 + Math.random() * 0.45;
      col.set([w * 0.9, w * 0.95, w], i * 3);
      size[i] = Math.random() < 0.04 ? 2.2 : 1.2;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    const mat = new THREE.ShaderMaterial({
      vertexShader: SAT_VERT.replace('clamp(4.2 / -mv.z, 0.18, 2.6)', '1.0'), fragmentShader: SAT_FRAG,
      uniforms: { uPixelRatio: { value: renderer.getPixelRatio() }, uFade: { value: 1 } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    scene.add(new THREE.Points(geo, mat));
  }

  // Earth, atmosphere
  const earthMat = new THREE.ShaderMaterial({
    vertexShader: EARTH_VERT, fragmentShader: EARTH_FRAG,
    uniforms: { dayMap: { value: tex('vendor/earth-day.jpg') }, nightMap: { value: tex('vendor/earth-night.jpg') }, sunDir: { value: sunDir } },
  });
  const earth = new THREE.Mesh(new THREE.SphereGeometry(1, 160, 80), earthMat);
  scene.add(earth);
  const atmo = new THREE.Mesh(new THREE.SphereGeometry(1.075, 96, 48), new THREE.ShaderMaterial({
    vertexShader: GLOW_VERT, fragmentShader: ATMO_FRAG, uniforms: { sunDir: { value: sunDir } },
    side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  scene.add(atmo);

  // aurora ovals around the geomagnetic poles; radius grows with Kp (illustrative)
  const auroraMat = new THREE.MeshBasicMaterial({ color: '#6dffb4', transparent: true, opacity: 0.2, depthWrite: false, blending: THREE.AdditiveBlending });
  const auroras = [];
  for (const [lat, lon] of [[80.7, -72.7], [-80.7, 107.3]]) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1, 0.012, 8, 160), auroraMat);
    ring.userData.axis = llToVec(lat, lon, 1);
    auroras.push(ring);
    scene.add(ring);
  }
  function setAurora(kp) {
    const colat = THREE.MathUtils.degToRad(Math.min(45, 21 + 2.2 * kp));
    for (const ring of auroras) {
      const r = 1.012;
      ring.scale.setScalar(r * Math.sin(colat));
      ring.position.copy(ring.userData.axis).multiplyScalar(r * Math.cos(colat));
      ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), ring.userData.axis);
    }
    auroraMat.opacity = 0.03 + Math.pow(Math.min(kp, 9) / 9, 1.4) * 0.65;
  }
  setAurora(0);

  // satellites
  const MAX_SATS = 12000;
  const satGeo = new THREE.BufferGeometry();
  const satPos = new Float32Array(MAX_SATS * 3);   // rendered
  const satTo = new Float32Array(MAX_SATS * 3);    // latest fix from the API
  const satVel = new Float32Array(MAX_SATS * 3);   // scene units per ms, from the last two fixes
  let fixTime = 0;                                 // wall-clock ms of the latest fix
  const satCol = new Float32Array(MAX_SATS * 3);
  const satSize = new Float32Array(MAX_SATS);
  satGeo.setAttribute('position', new THREE.BufferAttribute(satPos, 3).setUsage(THREE.DynamicDrawUsage));
  satGeo.setAttribute('aColor', new THREE.BufferAttribute(satCol, 3));
  satGeo.setAttribute('aSize', new THREE.BufferAttribute(satSize, 1));
  satGeo.setDrawRange(0, 0);
  const satMat = new THREE.ShaderMaterial({
    vertexShader: SAT_VERT, fragmentShader: SAT_FRAG,
    uniforms: { uPixelRatio: { value: renderer.getPixelRatio() }, uFade: { value: 1 } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const windMat = satMat.clone();
  // positions change every frame, so give raycasting a fixed bound around the shell
  satGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1.3);
  const sats = new THREE.Points(satGeo, satMat);
  sats.frustumCulled = false;
  scene.add(sats);

  // selection: ring marker + the orbit plane drawn as a circle (assumes a near-circular orbit)
  const ringTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d'); g.strokeStyle = '#ffffff'; g.lineWidth = 7;
    g.beginPath(); g.arc(64, 64, 52, 0, Math.PI * 2); g.stroke();
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  })();
  const marker = new THREE.Sprite(new THREE.SpriteMaterial({ map: ringTex, sizeAttenuation: false, depthWrite: false, transparent: true }));
  marker.scale.setScalar(0.034);
  marker.visible = false;
  marker.renderOrder = 10;
  scene.add(marker);
  const ORBIT_SEG = 256;
  const orbitGeo = new THREE.BufferGeometry();
  orbitGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((ORBIT_SEG + 1) * 3), 3));
  const orbitLine = new THREE.Line(orbitGeo, new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.55 }));
  orbitLine.visible = false;
  orbitLine.frustumCulled = false;
  scene.add(orbitLine);
  let selId = null, selIdx = -1, selectCb = null, orbitWanted = false;
  let satList = [], satCount = 0, satStamp = 0, satIds = [], batchIdx = [];
  const batchCenter = new THREE.Vector3();
  function updateBatchCenter() {
    batchCenter.set(0, 0, 0);
    for (const i of batchIdx) batchCenter.x += satPos[i * 3], batchCenter.y += satPos[i * 3 + 1], batchCenter.z += satPos[i * 3 + 2];
    if (batchIdx.length) batchCenter.divideScalar(batchIdx.length);
    return batchCenter;
  }

  // Sun, corona, L1 monitors, solar wind, magnetosphere, CME
  const sunGroup = new THREE.Group();
  scene.add(sunGroup);
  const sunMat = new THREE.ShaderMaterial({ vertexShader: SUN_VERT, fragmentShader: SUN_FRAG, uniforms: { uTime: { value: 0 }, uActivity: { value: 0 } } });
  sunGroup.add(new THREE.Mesh(new THREE.SphereGeometry(SUN_RADIUS, 96, 48), sunMat));
  const coronaTex = radialTexture([[0, 'rgba(255,214,150,1)'], [0.2, 'rgba(255,160,70,0.6)'], [0.42, 'rgba(255,120,45,0.18)'], [1, 'rgba(255,90,30,0)']]);
  const corona = new THREE.Sprite(new THREE.SpriteMaterial({ map: coronaTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  corona.scale.setScalar(SUN_RADIUS * 7);
  sunGroup.add(corona);
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: coronaTex, transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending }));
  halo.scale.setScalar(SUN_RADIUS * 16);
  sunGroup.add(halo);

  const l1Group = new THREE.Group();
  scene.add(l1Group);
  const markerTex = radialTexture([[0, 'rgba(255,255,255,1)'], [0.25, 'rgba(200,225,255,0.9)'], [0.5, 'rgba(140,180,255,0.25)'], [1, 'rgba(120,160,255,0)']]);
  const monitorSprites = {};
  for (const [i, name] of ['SOLAR1', 'ACE', 'IMAP'].entries()) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: markerTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    s.scale.setScalar(0.45);
    s.userData.offset = [[0, 0.5, 0], [0, -0.35, 0.45], [0, -0.35, -0.45]][i];
    monitorSprites[name] = s;
    l1Group.add(s);
  }

  const WIND_N = 2200;
  const windGeo = new THREE.BufferGeometry();
  const windPos = new Float32Array(WIND_N * 3);
  const windCol = new Float32Array(WIND_N * 3);
  const windSize = new Float32Array(WIND_N).fill(1.6);
  const windP = new Float32Array(WIND_N), windA = new Float32Array(WIND_N), windR = new Float32Array(WIND_N), windJ = new Float32Array(WIND_N);
  for (let i = 0; i < WIND_N; i++) { windP[i] = Math.random(); windA[i] = Math.random() * Math.PI * 2; windR[i] = Math.sqrt(Math.random()); windJ[i] = 0.75 + Math.random() * 0.5; }
  windGeo.setAttribute('position', new THREE.BufferAttribute(windPos, 3).setUsage(THREE.DynamicDrawUsage));
  windGeo.setAttribute('aColor', new THREE.BufferAttribute(windCol, 3).setUsage(THREE.DynamicDrawUsage));
  windGeo.setAttribute('aSize', new THREE.BufferAttribute(windSize, 1));
  const wind = new THREE.Points(windGeo, windMat);
  wind.frustumCulled = false;
  scene.add(wind);

  const magGroup = new THREE.Group();
  scene.add(magGroup);
  const magMat = new THREE.ShaderMaterial({
    vertexShader: MAG_VERT, fragmentShader: MAG_FRAG,
    uniforms: { uNose: { value: 2.6 }, uTail: { value: 7.5 }, uOpacity: { value: 0.18 }, uFlash: { value: 0 } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  magGroup.add(new THREE.Mesh(new THREE.SphereGeometry(1, 96, 48), magMat));

  // CME: a burst of plasma expanding in a cone from the Sun toward Earth (illustrative)
  const CME_N = 2400;
  const cmeGeo = new THREE.BufferGeometry();
  const cmePos = new Float32Array(CME_N * 3), cmeCol = new Float32Array(CME_N * 3);
  const cmeSeed = Array.from({ length: CME_N }, () => [Math.random(), Math.random() * Math.PI * 2, Math.sqrt(Math.random())]);
  cmeGeo.setAttribute('position', new THREE.BufferAttribute(cmePos, 3).setUsage(THREE.DynamicDrawUsage));
  cmeGeo.setAttribute('aColor', new THREE.BufferAttribute(cmeCol, 3).setUsage(THREE.DynamicDrawUsage));
  cmeGeo.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(CME_N).fill(4.4), 1));
  cmeGeo.setDrawRange(0, 0);
  const cme = new THREE.Points(cmeGeo, windMat);
  cme.frustumCulled = false;
  scene.add(cme);
  let cmeStart = -1;
  const CME_SECONDS = 7;

  // labels (HTML, projected each frame)
  const labels = {};
  function label(key, cls) {
    if (!labels[key]) {
      const el = document.createElement('div');
      el.className = `scene-label ${cls || ''}`;
      labelLayer.appendChild(el);
      labels[key] = el;
    }
    return labels[key];
  }

  // weather inputs
  let kp = 0, windKms = 400, monitors = [], activity = 0, protectedOn = false;

  function placeSunSystem() {
    sunGroup.position.copy(sunDir).multiplyScalar(SUN_DIST);
    l1Group.position.copy(sunDir).multiplyScalar(L1_DIST);
    const up = Math.abs(sunDir.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const side = new THREE.Vector3().crossVectors(sunDir, up).normalize();
    const up2 = new THREE.Vector3().crossVectors(side, sunDir).normalize();
    for (const s of Object.values(monitorSprites)) {
      const [, a, b] = s.userData.offset;
      s.position.copy(up2).multiplyScalar(a + s.userData.offset[1] * 0).add(side.clone().multiplyScalar(b));
    }
    magGroup.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), sunDir);
    return { side, up2 };
  }
  let basis = placeSunSystem();

  // camera choreography
  let flight = null;
  const views = {
    earth: () => ({ target: new THREE.Vector3(0, 0, 0), pos: new THREE.Vector3().copy(sunDir).multiplyScalar(2.3).add(basis.side.clone().multiplyScalar(3.9)).add(new THREE.Vector3(0, 1.5, 0)) }),
    sun: () => {
      // Sun on the left, Earth on the right (cause, then effect), framed wide
      // enough to clear the side panels
      const mid = sunDir.clone().multiplyScalar(SUN_DIST * 0.45);
      let pos = mid.clone().addScaledVector(basis.side, SUN_DIST * 1.95).addScaledVector(basis.up2, SUN_DIST * 0.35);
      const fwd = mid.clone().sub(pos).normalize();
      const right = new THREE.Vector3().crossVectors(fwd, camera.up).normalize();
      if (right.dot(sunDir) > 0) pos = mid.clone().addScaledVector(basis.side, -SUN_DIST * 1.95).addScaledVector(basis.up2, SUN_DIST * 0.35);
      return { target: mid, pos };
    },
  };
  views.batch = () => {
    if (!batchIdx.length) return views.earth();
    const dir = updateBatchCenter().clone().normalize();
    const pos = dir.clone().multiplyScalar(4.2).addScaledVector(basis.up2, 0.6);
    return { target: new THREE.Vector3(0, 0, 0), pos };
  };
  let view = 'earth';
  function flyTo(name, seconds = 2.6) {
    view = name;
    const v = views[name]();
    flight = { t0: performance.now(), dur: seconds * 1000, fromPos: camera.position.clone(), fromTarget: controls.target.clone(), toPos: v.pos, toTarget: v.target };
    controls.autoRotate = false;
  }
  { const v = views.earth(); camera.position.copy(v.pos); controls.target.copy(v.target); }

  // hover picking
  const raycaster = new THREE.Raycaster();
  raycaster.params.Points.threshold = 0.012;
  const mouse = new THREE.Vector2();
  let hoverCb = null, lastPick = 0, pointer = null;
  canvas.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    pointer = { x: e.clientX - r.left, y: e.clientY - r.top };
  });
  canvas.addEventListener('pointerleave', () => { pointer = null; hoverCb && hoverCb(null); });
  let downAt = null;
  canvas.addEventListener('pointerdown', (e) => { controls.autoRotate = false; downAt = { x: e.clientX, y: e.clientY }; });
  canvas.addEventListener('pointerup', (e) => {
    if (!downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 5) return;  // that was a drag
    const r = canvas.getBoundingClientRect();
    mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    select(pick());
  });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') select(-1); });

  // nearest satellite under the pointer that is not hidden behind Earth
  const earthSphere = new THREE.Sphere(new THREE.Vector3(), 1);
  function pick() {
    if (camera.position.length() > 20 || !satCount) return -1;
    raycaster.setFromCamera(mouse, camera);
    const pxThreshold = 0.013 * camera.position.distanceTo(controls.target) / 4;
    raycaster.params.Points.threshold = pxThreshold;
    const hitEarth = raycaster.ray.intersectSphere(earthSphere, new THREE.Vector3());
    const earthDist = hitEarth ? hitEarth.distanceTo(raycaster.ray.origin) : Infinity;
    const hits = raycaster.intersectObject(sats, false)
      .filter((x) => x.index < satCount && x.distance < earthDist)
      .sort((a, b) => a.distanceToRay - b.distanceToRay);
    return hits.length ? hits[0].index : -1;
  }

  function orbitFor(i) {
    const r = new THREE.Vector3(satTo[i * 3], satTo[i * 3 + 1], satTo[i * 3 + 2]);
    const v = new THREE.Vector3(satVel[i * 3], satVel[i * 3 + 1], satVel[i * 3 + 2]);
    if (v.lengthSq() < 1e-20) { orbitWanted = false; return; }
    const u = r.clone().normalize();
    const n = new THREE.Vector3().crossVectors(r, v).normalize();
    const w = new THREE.Vector3().crossVectors(n, u);
    const R = r.length(), arr = orbitGeo.attributes.position.array;
    for (let k = 0; k <= ORBIT_SEG; k++) {
      const a = (k / ORBIT_SEG) * Math.PI * 2;
      arr[k * 3] = R * (Math.cos(a) * u.x + Math.sin(a) * w.x);
      arr[k * 3 + 1] = R * (Math.cos(a) * u.y + Math.sin(a) * w.y);
      arr[k * 3 + 2] = R * (Math.cos(a) * u.z + Math.sin(a) * w.z);
    }
    orbitGeo.attributes.position.needsUpdate = true;
    orbitWanted = true;
  }

  function select(i) {
    selIdx = i;
    selId = i >= 0 ? satList[i].id : null;
    marker.visible = i >= 0;
    if (i >= 0) {
      const s = satList[i];
      const c = s.protected ? RISK_COLORS.protected : (RISK_COLORS[s.risk] || RISK_COLORS.fine);
      marker.material.color.copy(c);
      orbitLine.material.color.copy(c);
      orbitFor(i);
    } else {
      orbitWanted = false;
      orbitLine.visible = false;
    }
    selectCb && selectCb(i >= 0 ? satList[i] : null);
  }

  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== Math.floor(w * renderer.getPixelRatio()) || canvas.height !== Math.floor(h * renderer.getPixelRatio())) {
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
  }

  const tmp = new THREE.Vector3();
  const clock = new THREE.Clock();
  function frame() {
    const dt = Math.min(clock.getDelta(), 0.1);
    const t = clock.elapsedTime;
    resize();

    if (flight) {
      const k = Math.min(1, (performance.now() - flight.t0) / flight.dur);
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      camera.position.lerpVectors(flight.fromPos, flight.toPos, e);
      controls.target.lerpVectors(flight.fromTarget, flight.toTarget, e);
      if (k >= 1) flight = null;
    }
    controls.update();

    // satellites: dead-reckon from the latest fix with the velocity from the last two
    if (satCount) {
      const k = Math.min(Math.max(Date.now() - fixTime, 0), 90000);
      for (let i = 0; i < satCount * 3; i++) satPos[i] = satTo[i] + satVel[i] * k;
      satGeo.attributes.position.needsUpdate = true;
    }

    // solar wind stream, Sun -> Earth, speed from the measured solar wind
    const camDist = camera.position.distanceTo(controls.target) + camera.position.length() * 0.0;
    const sunView = camera.position.length() > 20;
    const speed = (windKms / 400) * 0.055 * (reducedMotion ? 0.3 : 1);
    const from = sunGroup.position;
    for (let i = 0; i < WIND_N; i++) {
      windP[i] += dt * speed * windJ[i] * (1 + activity * 1.5);
      if (windP[i] > 1) windP[i] -= 1;
      const p = windP[i];
      const spread = 0.35 + p * 3.2 + activity * p * 2.5;
      tmp.copy(from).multiplyScalar(1 - p);
      tmp.addScaledVector(basis.side, Math.cos(windA[i]) * windR[i] * spread);
      tmp.addScaledVector(basis.up2, Math.sin(windA[i]) * windR[i] * spread);
      windPos.set([tmp.x, tmp.y, tmp.z], i * 3);
      const fade = Math.min(1, p * 6) * Math.min(1, (1 - p) * 5) * (sunView ? 1 : 0);
      const w = (0.32 + activity * 0.35) * fade;
      windCol.set([w * 1.0, w * 0.68, w * 0.4], i * 3);
    }
    windGeo.attributes.position.needsUpdate = true;
    windGeo.attributes.aColor.needsUpdate = true;

    satMat.uniforms.uFade.value = 1 - THREE.MathUtils.smoothstep(camera.position.length(), 12, 30);

    // magnetosphere: compressed by Kp, flashes when the CME arrives
    magMat.uniforms.uNose.value = 2.7 - Math.min(kp, 9) * 0.11;
    magMat.uniforms.uOpacity.value = (0.22 + Math.min(kp, 9) / 9 * 0.45) * THREE.MathUtils.smoothstep(camera.position.length(), 6, 16);
    magMat.uniforms.uFlash.value = Math.max(0, magMat.uniforms.uFlash.value - dt * 0.25);

    // CME
    if (cmeStart >= 0) {
      const k = (t - cmeStart) / CME_SECONDS;
      if (k >= 1) {
        cmeStart = -1;
        cmeGeo.setDrawRange(0, 0);
        magMat.uniforms.uFlash.value = 1;
        activity = Math.max(activity, 0.6);
      } else {
        const sunR = SUN_RADIUS / SUN_DIST;
        for (let i = 0; i < CME_N; i++) {
          const [th, a, r] = cmeSeed[i];
          const p = sunR + (k * 1.08 - sunR) * (0.72 + 0.28 * th);   // leading edge is densest
          const spread = 1.2 + Math.max(p, 0) * 10;
          tmp.copy(sunGroup.position).multiplyScalar(1 - p);
          tmp.addScaledVector(basis.side, Math.cos(a) * r * spread);
          tmp.addScaledVector(basis.up2, Math.sin(a) * r * spread);
          cmePos.set([tmp.x, tmp.y, tmp.z], i * 3);
          const b = (0.55 + 1.1 * th * th) * (1 - k * 0.35) * Math.min(1, k * 10);
          cmeCol.set([b, b * 0.72, b * 0.45], i * 3);
        }
        cmeGeo.attributes.position.needsUpdate = true;
        cmeGeo.attributes.aColor.needsUpdate = true;
      }
    }
    sunMat.uniforms.uTime.value = t;
    sunMat.uniforms.uActivity.value = activity;

    // labels
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const show = (key, pos, content, cls, visible = true, html = false) => {
      const el = label(key, cls);
      tmp.copy(pos).project(camera);
      const on = visible && tmp.z < 1 && Math.abs(tmp.x) < 1.1 && Math.abs(tmp.y) < 1.1;
      el.style.display = on ? '' : 'none';
      if (on) {
        if (html) { if (el.innerHTML !== content) el.innerHTML = content; }
        else if (el.textContent !== content) el.textContent = content;
        el.style.transform = `translate(${((tmp.x + 1) / 2) * w}px, ${((1 - tmp.y) / 2) * h}px)`;
      }
    };
    show('sun', tmp.copy(sunGroup.position).addScaledVector(basis.up2, SUN_RADIUS * 1.5), 'Sun', 'big', sunView);
    show('earth', new THREE.Vector3().addScaledVector(basis.up2, 3.2), 'Earth', 'big', sunView);
    const l1 = monitors.length ? monitors : [{ source: 'SOLAR1', label: 'SOLAR1' }, { source: 'ACE', label: 'NASA ACE' }, { source: 'IMAP', label: 'NASA IMAP' }];
    const rows = l1.map((m) => `<span class="${m.active ? 'on' : ''}">${m.label}${m.speed_kms != null ? ` ${Math.round(m.speed_kms)} km/s` : ''}</span>`).join('');
    show('l1', tmp.copy(l1Group.position).addScaledVector(basis.up2, -1.4), `<em>L1, where the solar wind is measured</em>${rows}`, 'l1', sunView, true);
    if (batchIdx.length) {
      const mid = batchIdx[Math.floor(batchIdx.length / 2)];
      const c = new THREE.Vector3(satPos[mid * 3], satPos[mid * 3 + 1], satPos[mid * 3 + 2]);
      const facing = c.clone().normalize().dot(camera.position.clone().normalize()) > 0.25;
      const safe = satList[batchIdx[0]]?.protected;
      show('batch', c.multiplyScalar(1.04), `L-12, 49 SIMULATED satellites${safe ? ', protected' : ' at ~210 km'}`, safe ? 'batch safe' : 'batch', !sunView && facing);
    } else if (labels.batch) labels.batch.style.display = 'none';

    // selected satellite marker follows the interpolated position
    if (selIdx >= 0 && selIdx < satCount) {
      marker.position.set(satPos[selIdx * 3], satPos[selIdx * 3 + 1], satPos[selIdx * 3 + 2]);
      marker.visible = !sunView;
      orbitLine.visible = orbitWanted && !sunView;
    }

    // hover
    if (hoverCb && pointer && t - lastPick > 0.08) {
      lastPick = t;
      const i = sunView ? -1 : pick();
      hoverCb(i >= 0 ? { sat: satList[i], x: pointer.x, y: pointer.y } : null);
      canvas.style.cursor = i >= 0 ? 'pointer' : '';
    }

    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  return {
    setTime(date) {
      sunDir.copy(sunDirection(date));
      basis = placeSunSystem();
    },
    setPositions(doc) {
      const list = doc.sats || [];
      const n = Math.min(list.length, MAX_SATS);
      const t = Date.parse(doc.time) || Date.now();
      const newFix = t !== fixTime;      // the API recomputes positions on its own clock
      const dt = t - fixTime;
      let same = 0;                      // leading ids unchanged (L-12 is appended at the end)
      while (same < Math.min(n, satCount) && satIds[same] === list[same].id) same++;
      for (let i = 0; i < n; i++) {
        const s = list[i];
        if (newFix) {
          llToVec(s.lat, s.lon, 1 + s.alt_km / RE_KM, tmp);
          if (i < same && dt > 0 && dt < 120000) {
            satVel[i * 3] = (tmp.x - satTo[i * 3]) / dt;
            satVel[i * 3 + 1] = (tmp.y - satTo[i * 3 + 1]) / dt;
            satVel[i * 3 + 2] = (tmp.z - satTo[i * 3 + 2]) / dt;
          } else if (i >= same) {
            satVel[i * 3] = satVel[i * 3 + 1] = satVel[i * 3 + 2] = 0;
          }
          satTo.set([tmp.x, tmp.y, tmp.z], i * 3);
        }
        const c = s.protected ? RISK_COLORS.protected : (RISK_COLORS[s.risk] || RISK_COLORS.fine);
        satCol.set([c.r, c.g, c.b], i * 3);
        satSize[i] = s.simulated ? 4.6 : s.risk === 'critical' ? 3.6 : s.risk === 'high' ? 2.9 : 2.2;
      }
      satList = list.slice(0, n);
      satIds = satList.map((s) => s.id);
      batchIdx = [];
      satList.forEach((s, i) => { if (s.simulated) batchIdx.push(i); });
      if (newFix) fixTime = t;
      satCount = n;
      if (selId !== null) {  // keep the selection across refreshes and replays
        const i = satList.findIndex((s) => s.id === selId);
        if (i >= 0) select(i); else select(-1);
      }
      satGeo.setDrawRange(0, n);
      satGeo.attributes.aColor.needsUpdate = true;
      satGeo.attributes.aSize.needsUpdate = true;
      protectedOn = satList.some((s) => s.protected);
    },
    setWeather({ kpNow = 0, windSpeed = null, l1 = [], level = 'none' }) {
      kp = kpNow;
      if (windSpeed) windKms = windSpeed;
      monitors = l1;
      setAurora(kp);
      const target = level === 'critical' ? 1 : level === 'warning' ? 0.55 : level === 'watch' ? 0.2 : 0;
      activity += (target - activity) * 0.35;
    },
    launchCME() { cmeStart = clock.elapsedTime; cmeGeo.setDrawRange(0, CME_N); activity = Math.max(activity, 0.7); },
    flyTo,
    get view() { return view; },
    onHover(cb) { hoverCb = cb; },
    onSelect(cb) { selectCb = cb; },
    clearSelection() { select(-1); },
    selectId(id) { select(satList.findIndex((s) => String(s.id) === String(id))); },
  };
}
