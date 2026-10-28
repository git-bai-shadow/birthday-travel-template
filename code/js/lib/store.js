/* ==========================================================================
   store.js · 数据层
   负责：读取全部旅行、增删改、照片上传、登录状态、统计。
   调试开关 config.debug.useMockData 为 true 时走本地假数据，方便无后端预览。
   ========================================================================== */

import { config } from '../config.js';
import { store as ls } from './dom.js';
import { distanceKm, centroid } from './gcj02.js';
import { cityCenter } from '../data/spots-cn.js';

const API = config.api.base;
const AUTH_KEY = 'authed';

/* --------------------------------------------------------------------------
   状态
   -------------------------------------------------------------------------- */

const state = {
  trips: [],
  loaded: false,
  loading: false,
  authed: ls.get(AUTH_KEY, false),
  error: null,
  /* CSRF token：auth.php 的 GET / 登录响应会下发。写操作必须带上，
     否则后端 403。这是 Origin/SameSite 之外的一道真正不可猜的防线。 */
  csrf: null,
  /* 当前显示的是不是「随包示例数据」（静态部署、无后端时的降级结果）。
     UI 拿它来提示一句，也用来藏掉「新增/录入」入口 —— 静态站点写不了数据。 */
  isDemo: false,
};

/** token 只在内存里，不落localStorage —— 丢了重新向auth.php GET 一次即可 */
export function getCsrf() {
  return state.csrf;
}

async function fetchCsrf() {
  if (state.csrf) return state.csrf;
  try {
    const res = await fetch(`${API}/auth.php`, { credentials: 'same-origin' });
    const type = res.headers.get('content-type') || '';
    if (!type.includes('application/json')) return null;   // 挑战页，不碰
    const j = await res.json();
    if (j && typeof j.csrf === 'string') state.csrf = j.csrf;
    if (j && typeof j.authed === 'boolean') {
      state.authed = j.authed;
      ls.set(AUTH_KEY, j.authed);
    }
  } catch { /* 拿不到就靠后端报错 */ }
  return state.csrf;
}

const listeners = new Set();

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  listeners.forEach((fn) => fn(state));
}

/* --------------------------------------------------------------------------
   请求封装
   -------------------------------------------------------------------------- */

async function request(path, options = {}) {
  const isForm = options.body instanceof FormData;
  const headers = { ...(options.headers || {}) };

  if (options.method && options.method !== 'GET' && options.method !== 'HEAD') {
    /*写操作要带 CSRF token。拿不到就照发，让后端 403 给出一句人话，
       总比静默地不带强。 */
    const token = await fetchCsrf();
    if (token) headers['X-CSRF-Token'] = token;
    if (!isForm) headers['Content-Type'] = 'application/json';
  } else if (!isForm && !options.method) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(`${API}/${path}`, {
    credentials: 'same-origin',
    ...options,
    headers,
  });

  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).message || ''; } catch { /* noop */ }
    const err = new Error(detail || `请求失败（${res.status}）`);
    err.status = res.status;
    throw err;
  }

  /* ⚠️ InfinityFree（.ct.ws 免费账户）对**所有**请求强制返回一段 JS 挑战 HTML
     （加载 /aes.js 算 __test cookie 再跳 ?i=1）。浏览器导航会执行它所以正常，
     但 fetch() 不执行 → 拿到的永远是挑战页。它是 HTTP 200 且 content-type 为
     text/html，`!res.ok` 那条分支根本不走 —— 于是下面如果宽松地退回 res.text()，
     调用方会拿到一段 HTML 字符串：Array.isArray 为 false、.trips 为 undefined，
     最后变成"空列表 + 无错误 + 永不重试"，看起来像数据被清空了。
     所以这里必须显式失败，让上层有机会把错误说给人听。 */
  const type = res.headers.get('content-type') || '';
  if (!type.includes('application/json')) {
    const err = new Error('接口返回了非 JSON 内容（可能是主机挑战页），请刷新重试');
    err.status = res.status;
    err.nonJson = true;
    throw err;
  }
  return res.json();
}

/* --------------------------------------------------------------------------
   读取
   -------------------------------------------------------------------------- */

/* 在途请求缓存（Promise 而非布尔位）。
   原来只记 `state.loading` 就 return state.trips，导致 mutate() 写完成功后
   跟的 loadTrips({force:true}) 会**立刻返回旧数组**而不是重新拉 —— 表现是
   "存了但列表没更新"。缓存 Promise 可以让并发的调用者 await 同一次请求。 */
let inflight = null;

export async function loadTrips({ force = false } = {}) {
  if (inflight) return inflight;
  if (state.loaded && !force) return state.trips;

  state.loading = true;
  state.error = null;
  emit();

  inflight = (async () => {
    try {
      const data = config.debug.useMockData ? await loadMock() : await request('trips.php');
      state.trips = normalizeTrips(Array.isArray(data) ? data : data.trips || []);
      state.loaded = true;
    } catch (err) {
      /* 后端不可用就明说，**默认**绝不能用假数据顶上。
         那几条演示数据一旦被她当成真的一起去过的地方，比空屏严重得多。

         例外：显式打开 config.api.fallbackToBundledData（静态部署场景 ——
         没有 PHP，接口必然 404）。这时退回随包的 data/trips.json，
         并打上 isDemo 标记：UI 会提示「示例数据」并藏掉写入入口。 */
      if (config.api && config.api.fallbackToBundledData) {
        try {
          const doc = await loadMock();
          state.trips = normalizeTrips(Array.isArray(doc) ? doc : doc.trips || []);
          state.loaded = true;
          state.isDemo = true;
          state.error = null;
          return state.trips;
        } catch { /* 连随包数据都没有 → 走下面的报错 */ }
      }
      state.error = String(err && err.message || err);
      /* ⚠️ 已经拿到过数据就别清空：保存成功后紧跟的刷新若因网络抖动失败，
         清空会把时间线抹成空态，用户以为白输了、可能重复录入。
         只置error，让界面保留旧数据 + 顶部提示。
         另外**不要**在这里设 loaded = true —— 一次失败就永久缓存空列表，
         她连刷新页面之外的任何重试机会都没有了。 */
      if (!state.loaded) state.trips = [];
    } finally {
      state.loading = false;
      emit();
    }
    return state.trips;
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

/** 后端错误信息（footprints 等处要用；state 对象本身不导出） */
export function getError() {
  return state.error;
}

export function getTrips() {
  return state.trips;
}

/** 当前是不是「示例数据」（静态部署降级出来的） */
export function isDemoData() {
  return state.isDemo;
}

export function getStats() {
  const trips = state.trips;
  const spots = trips.flatMap((t) => t.spots || []);
  const today = new Date();
  /* ⚠️ 必须按**本地时区**解析：`new Date('2025-07-12')`（只给日期）是按 UTC 算的，
     而下面 years/spanDays 用的都是 getFullYear()/本地午夜。在负时区（UTC-5）
     上1 月 1 日的记录会落到上一年 → "第 N 年"偏大一岁、spanDays 差一天。 */
  const dates = trips.map((t) => parseLocalDate(t.date)).filter(Boolean).sort((a, b) => a - b);

  const spanDays = dates.length >= 2
    ? Math.round((dates[dates.length - 1] - dates[0]) / 86400000)
    : 0;

  const cities = new Set();
  trips.forEach((t) => {
    if (t.city) cities.add(t.city);
  });

  // 按时间顺序算累计距离
  /* ⚠️ 原来每段只看相邻两条，没有坐标就整段跳过 —— 中间某段没景区时
     前后两点不再相连，"跨越 X 公里"被系统性低估。改成沿用**上一个
     有坐标的点**，让跨段路线连起来。 */
  let km = 0;
  let prev = null;
  /* ⚠️ state.trips 是按日期**降序**排的（sortTrips 里b-a），直接顺序累加
     等于倒着走。累计里程必须走时间正序。 */
  const byTime = [...trips].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  for (let i = 0; i < byTime.length; i++) {
    const p = byTime[i].spots?.[0] || byTime[i];
    if (!isCoord(p)) continue;
    if (prev) km += distanceKm(prev.lon, prev.lat, p.lon, p.lat);
    prev = p;
  }

  return {
    tripCount: trips.length,
    spotCount: spots.length,
    cityCount: cities.size,
    photoCount: trips.reduce((n, t) => n + (t.photos?.length || 0)
                                     + (t.spots || []).reduce((m, s) => m + (s.photos?.length || 0), 0), 0),
    spanDays,
    years: today.getFullYear() - (dates[0] ? dates[0].getFullYear() : today.getFullYear()),
    km: Math.round(km),
  };
}

/* --------------------------------------------------------------------------
   写入（都需要登录）
   -------------------------------------------------------------------------- */

export async function createTrip(trip) {
  return mutate('POST', 'trips.php', { trip });
}

export async function updateTrip(trip) {
  return mutate('POST', 'trips.php', { trip });
}

export async function deleteTrip(id) {
  return mutate('DELETE', `trips.php?id=${encodeURIComponent(id)}`);
}

async function mutate(method, path, body) {
  if (config.debug.useMockData) {
    return applyLocally(method, path, body);
  }
  const res = await request(path, {
    method,
    body: body ? JSON.stringify(body) : undefined,
  });
  await loadTrips({ force: true });
  return res;
}

/** 无后端时的本地增删改，保证预览可用 */
function applyLocally(method, path, body) {
  if (method === 'POST' && body?.trip) {
    const trip = normalizeTrip(body.trip);
    const idx = state.trips.findIndex((t) => t.id === trip.id);
    if (idx >= 0) state.trips[idx] = trip;
    else state.trips.push(trip);
  } else if (method === 'DELETE') {
    const id = new URLSearchParams(path.split('?')[1]).get('id');
    state.trips = state.trips.filter((t) => t.id !== id);
  }
  state.trips = sortTrips(state.trips);
  emit();
  return { ok: true };
}

/** 上传一张照片，返回 { full, thumb } 两个相对 URL */
export async function uploadPhoto(fullBlob, thumbBlob) {
  if (config.debug.useMockData) {
    return { full: URL.createObjectURL(fullBlob), thumb: URL.createObjectURL(thumbBlob) };
  }

  /* ⚠️ 一次请求会同时发 full + thumb，**总和**受服务器的 post_max_size 约束。
     InfinityFree 免费机的 post_max_size 常见为 8M；超限时 PHP 会清空整个
     $_FILES，后端报「没有收到文件」（400）—— 而真实原因是文件太大，
     提示完全误导，upload_error_text 里的 UPLOAD_ERR_INI_SIZE 分支永远走不到。
     在这里按总大小拦住，并把真实原因说清楚。 */
  const total = (fullBlob?.size || 0) + (thumbBlob?.size || 0);
  const limit = (config.upload.maxFileMB || 8) * 1024 * 1024 * 2;
  if (total > limit) {
    throw new Error(`两张图加起来 ${(total / 1048576).toFixed(1)}MB，超过服务器上限，请换一张小一点的`);
  }

  const form = new FormData();
  form.append('full', fullBlob, 'full.webp');
  form.append('thumb', thumbBlob, 'thumb.webp');

  return await request('upload.php', { method: 'POST', body: form });
}

/* --------------------------------------------------------------------------
   登录
   -------------------------------------------------------------------------- */

export function isAuthed() {
  return state.authed;
}

export async function login(password) {
  if (config.debug.useMockData) {
    state.authed = true;
    ls.set(AUTH_KEY, true);
    emit();
    return true;
  }
  await request('auth.php', { method: 'POST', body: JSON.stringify({ password }) });
  state.authed = true;
  ls.set(AUTH_KEY, true);
  emit();
  /*登录成功时后端换了 session id 并重新种了 csrf，必须取新的，
     否则登录后第一次保存会 403。 */
  state.csrf = null;
  await fetchCsrf();
  return true;
}

export function logout() {
  state.authed = false;
  state.csrf = null;
  ls.set(AUTH_KEY, false);
  emit();
}

/* --------------------------------------------------------------------------
   规范化与排序
   -------------------------------------------------------------------------- */

/** 只给日期（'2025-07-12'）时按**本地时区**解析，而不是 UTC。 */
function parseLocalDate(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return isNaN(d) ? null : d;
  }
  const d = new Date(s);
  return isNaN(d) ? null : d;
}

function isCoord(o) {
  /* ⚠️ 原来末尾是 `(o.lat || o.lon)` —— 坐标恰好是 0（赤道/本初子午线，
     几内亚湾那些岛）会返回 falsy，把这个点从地图上**彻底抹掉**。
     类型检查已经够了，额外那一位只是"排除 0,0"的直觉，实际副作用更大。 */
  return Boolean(o)
    && Number.isFinite(o.lat) && Number.isFinite(o.lon)
    && o.lat >= -90 && o.lat <= 90
    && o.lon >= -180 && o.lon <= 180;
}

function sortTrips(trips) {
  return [...trips].sort((a, b) => {
    const d = String(b.date).localeCompare(String(a.date));
    if (d !== 0) return d;
    return (b.createdAt || 0) - (a.createdAt || 0);
  });
}

function normalizeTrips(trips) {
  return sortTrips(trips.map(normalizeTrip));
}

function normalizeTrip(t) {
  const trip = {
    id: t.id || uid(),
    date: t.date || new Date().toISOString().slice(0, 10),
    city: t.city || '',
    country: t.country || '',
    title: t.title || '',
    note: t.note || '',
    tags: Array.isArray(t.tags) ? t.tags : [],
    spots: Array.isArray(t.spots) ? t.spots.map(normalizeSpot) : [],
    photos: Array.isArray(t.photos) ? t.photos : [],
    createdAt: t.createdAt || Date.now(),
  };
  return trip;
}

function normalizeSpot(s) {
  return {
    id: s.id || uid(),
    name: s.name || '',
    lat: typeof s.lat === 'number' ? s.lat : null,
    lon: typeof s.lon === 'number' ? s.lon : null,
    source: s.source || 'manual',
    photos: Array.isArray(s.photos) ? s.photos : [],
  };
}

export function uid() {
  if (crypto?.randomUUID) return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  return Math.random().toString(36).slice(2, 18);
}

/**
 * 地图上要画的点。
 * 规则：有景区就按景区打点（最小单位是景区）；没有景区才退到城市级。
 * 城市级坐标从内置城市表里取，取不到就只留在时间线上、不进地图。
 */
export function mapPoints() {
  const points = [];

  for (const trip of state.trips) {
    if (trip.spots?.length) {
      trip.spots.forEach((spot) => {
        if (!isCoord(spot)) return;
        points.push({
          id: `${trip.id}:${spot.id}`,
          tripId: trip.id,
          spotId: spot.id,
          name: spot.name || trip.city || trip.title,
          sub: trip.city,
          date: trip.date,
          lng: spot.lon,
          lat: spot.lat,
          level: 'spot',
        });
      });

      // 有景区但全都没定位时，用城市兜一下，避免整段消失在图上
      if (!points.some((p) => p.tripId === trip.id)) {
        const c = trip.city ? cityCenter(trip.city) : null;
        if (c) {
          points.push({
            id: trip.id,
            tripId: trip.id,
            name: trip.city,
            sub: '',
            date: trip.date,
            lng: c.lon,
            lat: c.lat,
            level: 'city',
          });
        }
      }
      continue;
    }

    // 没有景区：退到城市级
    const c = trip.city ? cityCenter(trip.city) : null;
    if (c) {
      points.push({
        id: trip.id,
        tripId: trip.id,
        name: trip.city,
        sub: '',
        date: trip.date,
        lng: c.lon,
        lat: c.lat,
        level: 'city',
      });
    }
  }

  return points;
}

export function boundsOf(points) {
  const valid = points.filter((p) => typeof p.lng === 'number' && typeof p.lat === 'number');
  if (!valid.length) return null;
  const lngs = valid.map((p) => p.lng);
  const lats = valid.map((p) => p.lat);
  return {
    minLng: Math.min(...lngs), maxLng: Math.max(...lngs),
    minLat: Math.min(...lats), maxLat: Math.max(...lats),
    center: centroid(valid.map((p) => ({ lng: p.lng, lat: p.lat }))),
  };
}

/* --------------------------------------------------------------------------
   假数据（仅用于无后端预览）
   -------------------------------------------------------------------------- */

/** 本地预览的数据源：优先读 data/trips.json —— 与服务器上 PHP 读的是同一份文件，
    用 tools/build-trips.py 或录入流程准备好数据后，本地刷新即可见、
    FTP 上服务器即可用，不用重导一遍。读不到才退回内置演示数据。 */
async function loadMock() {
  try {
    const res = await fetch('data/trips.json');
    if (res.ok) {
      const doc = await res.json();
      if (doc && Array.isArray(doc.trips) && doc.trips.length) return doc;
    }
  } catch { /* 还没准备数据，退回演示 */ }
  return mockTrips();
}

/* 本地预览用的演示数据。
   ⚠️ 全是**虚构**的地名与日期（云栖镇、屿城、灯市、北岭村并不存在），
   不要往里写真实行程 —— 这个文件是进版本库的。
   想要带照片的完整效果：python tools/import-demo.py，
   它会写好 data/trips.json 与 uploads/，上面的 loadMock() 就会优先读它。 */
function mockTrips() {
  return [
    {
      id: 'demo1', date: '2024-04-13', city: '云栖镇', country: '中国',
      title: '云栖镇', note: '雾散之前，湖面安静得像没醒。',
      tags: ['湖', '雾'],
      spots: [
        { id: 's1', name: '栖湖', lat: 30.0489, lon: 119.721, photos: [] },
        { id: 's2', name: '雾原', lat: 30.0521, lon: 119.7345, photos: [] },
        { id: 's3', name: '石桥旧巷', lat: 30.0452, lon: 119.7288, photos: [] },
      ],
      photos: [], createdAt: 1,
    },
    {
      id: 'demo2', date: '2024-08-17', city: '屿城', country: '中国',
      title: '屿城', note: '风很大，我们在礁石上坐到天黑。',
      tags: ['海'],
      spots: [
        { id: 's4', name: '白沙湾', lat: 24.4123, lon: 118.0571, photos: [] },
        { id: 's5', name: '望海台', lat: 24.4402, lon: 118.1235, photos: [] },
      ],
      photos: [], createdAt: 2,
    },
    {
      id: 'demo3', date: '2024-12-21', city: '灯市', country: '中国',
      title: '灯市', note: '灯笼一盏盏亮起来的时候，忽然不想走了。',
      tags: ['夜', '吃'],
      spots: [
        { id: 's6', name: '灯笼巷', lat: 30.6412, lon: 104.0518, photos: [] },
        { id: 's7', name: '夜食巷', lat: 30.6437, lon: 104.0472, photos: [] },
      ],
      photos: [], createdAt: 3,
    },
    {
      id: 'demo4', date: '2025-01-18', city: '北岭村', country: '中国',
      title: '北岭村', note: '雪把整条巷子盖住了，只剩一串脚印。',
      tags: ['雪'],
      spots: [
        { id: 's8', name: '雪巷', lat: 30.6121, lon: 103.9789, photos: [] },
      ],
      photos: [], createdAt: 4,
    },
  ];
}
