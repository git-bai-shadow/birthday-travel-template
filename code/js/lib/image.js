/* ==========================================================================
   image.js · 照片压缩
   在前端完成，服务端只负责校验和存储 —— 把计算分摊到每台设备上，
   避免触发 InfinityFree 的 CPU 限制，也绕开了 GD / Imagick 扩展的依赖。
   ========================================================================== */

import { config } from '../config.js';

const { full: FULL, thumb: THUMB } = config.upload;

/** 解码图片。优先 createImageBitmap，退回 <img> */
export async function loadBitmap(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      /* 继续走下面的兜底 */
    }
  }
  return await loadViaImg(file);
}

function loadViaImg(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('图片无法解码'));
    };
    img.src = url;
  });
}

/** 缩放到长边不超过 maxEdge（缩略图用：统一小尺寸） */
function fitSize(w, h, maxEdge) {
  const longest = Math.max(w, h);
  if (longest <= maxEdge) return { width: w, height: h };
  const scale = maxEdge / longest;
  return { width: Math.round(w * scale), height: Math.round(h * scale) };
}

/* 主图的缩放不是「一律缩到同一个尺寸」：
   本来就小的照片保持原尺寸 —— 它们已经很清晰，再压一遍画质只会白丢；
   大照片按 scale 比例缩，结果夹在 [keepEdge, capEdge] 之间。
   min(longest, …) 保证只缩不放。 */
function fitFullSize(w, h, rule) {
  const longest = Math.max(w, h);
  if (longest <= rule.keepEdge) return { width: w, height: h };
  let target = Math.round(longest * rule.scale);
  target = Math.max(target, rule.keepEdge);
  target = Math.min(target, rule.capEdge, longest);
  const k = target / longest;
  return { width: Math.round(w * k), height: Math.round(h * k) };
}

/** 画到画布并导出 Blob */
async function render(bitmap, width, height, mime, quality) {
  const sw = bitmap.width || bitmap.naturalWidth;
  const sh = bitmap.height || bitmap.naturalHeight;

  if (typeof OffscreenCanvas === 'function') {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, sw, sh, 0, 0, width, height);
    return await canvas.convertToBlob({ type: mime, quality });
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, sw, sh, 0, 0, width, height);

  return await new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('导出图片失败'));
    }, mime, quality);
  });
}

/** 是否支持 WebP 导出（个别老浏览器不支持） */
let webpSupport = null;
export function supportsWebp() {
  if (webpSupport !== null) return webpSupport;
  const c = document.createElement('canvas');
  c.width = 1;
  c.height = 1;
  webpSupport = c.toDataURL('image/webp').startsWith('data:image/webp');
  return webpSupport;
}

/**
 * 压缩一张照片，输出主图与缩略图。
 * @returns {{ full: Blob, thumb: Blob, width: number, height: number }}
 */
export async function compressPhoto(file) {
  const mime = supportsWebp() ? 'image/webp' : 'image/jpeg';
  const bitmap = await loadBitmap(file);

  const rawW = bitmap.width || bitmap.naturalWidth;
  const rawH = bitmap.height || bitmap.naturalHeight;

  const big = fitFullSize(rawW, rawH, FULL);
  const small = fitSize(rawW, rawH, THUMB.maxEdge);

  /* ⚠️ close() 必须在 finally 里。原来的写法是两次 render 并行、
     close() 跟在 await 之后 —— 只要有一个 reject（比如超大图 canvas
     分配失败），close() 就永远不执行。ImageBitmap 占的是 GPU 内存，
     不靠 GC 及时回收，批量导入失败几张之后内存会明显抬高。 */
  try {
    const [fullBlob, thumbBlob] = await Promise.all([
      render(bitmap, big.width, big.height, mime, FULL.quality),
      render(bitmap, small.width, small.height, mime, THUMB.quality),
    ]);

    return {
      full: fullBlob,
      thumb: thumbBlob,
      width: big.width,
      height: big.height,
      ext: mime === 'image/webp' ? 'webp' : 'jpg',
    };
  } finally {
    if (typeof bitmap.close === 'function') bitmap.close();
  }
}

/** 串行处理一批照片，带进度回调。单张失败不影响其他张。 */
export async function compressBatch(files, onProgress) {
  const results = [];
  const failures = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    onProgress?.({ index: i, total: files.length, file, stage: 'start' });

    try {
      if (file.size > config.upload.maxFileMB * 1024 * 1024) {
        throw new Error(`超过 ${config.upload.maxFileMB}MB`);
      }
      const out = await compressPhoto(file);
      results.push({ file, ...out });
      onProgress?.({ index: i, total: files.length, file, stage: 'done' });
    } catch (err) {
      failures.push({ file, error: String(err && err.message || err) });
      onProgress?.({ index: i, total: files.length, file, stage: 'fail', error: err });
    }
  }

  return { results, failures };
}

/** 生成小预览用的 objectURL。
 *  ⚠️ 必须配对 revoke —— objectURL 不会自动回收，移动端内存上限低。
 *  原来就一句 createObjectURL 扔出去，注释提醒了但没有任何强制手段。
 *  改成返回 { url, revoke }，调用方写 try/finally 就能对上。 */
export function previewUrl(blob) {
  const url = URL.createObjectURL(blob);
  return {
    url,
    revoke() { URL.revokeObjectURL(url); },
  };
}
