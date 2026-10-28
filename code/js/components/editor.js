/* ==========================================================================
   editor.js · 录入抽屉

   数据层级：一条旅行 → 若干景区 → 每个景区挂多张照片
   位置是景区级的：一个景区定位一次，一次勾选多张照片。
   不是每张照片填一次位置。

   主路径（EXIF）：
     一次选一批照片 → 读 EXIF → 按坐标与时间聚类成候选景区 →
     每组预填位置与日期 → 你只需确认或改名字
   ========================================================================== */

import { config } from '../config.js';
import { h, clear, clearOverflow } from '../lib/dom.js';
import { readExif, sniffFormat } from '../lib/exif.js';
import { compressBatch } from '../lib/image.js';
import { clusterPhotos, dominantDate } from '../lib/cluster.js';
import { showNotice } from './notice.js';
import * as data from '../lib/store.js';

// uid 由数据层提供
const uid = () => data.uid();

const TAG_PRESETS = ['海边', '山', '城市', '古镇', '自驾', '美食', '第一次', '雪'];

export function createEditor({ onSaved }) {
  let editing = null;
  let spots = [];
  let tags = [];
  let busy = false;

  /* ---------------- 骨架 ---------------- */

  const title = h('h3', { class: 'drawer__title', text: '补上一段' });

  const closeBtn = h('button', {
    class: 'btn btn--ghost', type: 'button', text: '关闭', onClick: close,
  });

  const dateInput = h('input', { class: 'field__input', type: 'date' });
  const cityInput = h('input', { class: 'field__input', type: 'text', placeholder: '例如：屿城' });
  const countryInput = h('input', { class: 'field__input', type: 'text', placeholder: '例如：中国' });
  const noteInput = h('textarea', { class: 'field__area', placeholder: '一句话就够，写你记得的那个瞬间' });

  const chipsBox = h('div', { class: 'chips' });
  const spotsBox = h('div', {});

  const fileInput = h('input', {
    type: 'file',
    accept: config.upload.accept,
    multiple: true,
    style: { display: 'none' },
  });

  const exifHint = h('div', { class: 'upload-progress' });

  // 编辑旧行程时提醒：行程级照片这里没有编辑入口，但不会丢
  const tripPhotosHint = h('p', {
    class: 'muted', style: { fontSize: '11.5px', margin: '8px 0 0' },
  });

  const dropzone = h('div', { class: 'dropzone', onClick: () => fileInput.click() },
    h('div', { html: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="margin:0 auto 8px"><rect x="3" y="5" width="18" height="14" rx="2.5"/><circle cx="8.5" cy="10" r="1.4"/><path d="M20.5 16.5 15 11l-8.5 8.5"/></svg>' }),
    h('div', { text: '一次选一批照片，自动按地点分好组' }),
    h('div', { class: 'muted', style: { fontSize: '11.5px', marginTop: '4px' }, text: '用相册原图，微信里转发过的照片会丢失位置信息' }));

  const dropzoneWrap = h('div', {}, dropzone, exifHint, tripPhotosHint, fileInput);

  const addSpotBtn = h('button', {
    class: 'btn', type: 'button', text: '+ 手动加一个景区', onClick: () => addSpot(),
  });

  const saveBtn = h('button', {
    class: 'btn btn--accent', type: 'button', text: '收进回忆', onClick: save,
    style: { flex: '1' },
  });

  const panel = h('div', { class: 'drawer__panel' },
    h('div', { class: 'drawer__head' }, title, closeBtn),

    h('div', { class: 'field' }, h('label', { class: 'field__label', text: '日期' }), dateInput),
    h('div', { class: 'field' }, h('label', { class: 'field__label', text: '城市 / 地区' }), cityInput),
    h('div', { class: 'field' }, h('label', { class: 'field__label', text: '国家' }), countryInput),
    h('div', { class: 'field' }, h('label', { class: 'field__label', text: '写了什么' }), noteInput),

    h('div', { class: 'field' }, h('label', { class: 'field__label', text: '照片' }), dropzoneWrap),

    h('div', { class: 'field' },
      h('label', { class: 'field__label', text: '去过的地方' }),
      spotsBox,
      addSpotBtn),

    h('div', { class: 'field' }, h('label', { class: 'field__label', text: '标签' }), chipsBox),

    h('div', { style: { display: 'flex', gap: '10px', marginTop: '20px' } }, saveBtn));

  const scrim = h('div', { class: 'drawer__scrim', onClick: close });
  const el = h('div', { class: 'drawer', role: 'dialog', 'aria-modal': 'true' }, scrim, panel);
  document.body.appendChild(el);

  /* ---------------- 标签 ---------------- */

  function renderTags() {
    clear(chipsBox);
    TAG_PRESETS.forEach((t) => {
      chipsBox.appendChild(h('button', {
        class: `chip${tags.includes(t) ? ' is-on' : ''}`,
        type: 'button',
        text: t,
        onClick: () => {
          tags = tags.includes(t) ? tags.filter((x) => x !== t) : [...tags, t];
          renderTags();
        },
      }));
    });
  }

  /* ---------------- 景区 ---------------- */

  function addSpot(spot = {}) {
    spots.push({
      id: spot.id || uid(),
      name: spot.name || '',
      lat: spot.lat ?? null,
      lon: spot.lon ?? null,
      source: spot.source || 'manual',
      photos: spot.photos || [],       // 允许拖到后面再传
    });
    renderSpots();
  }

  function renderSpots() {
    clear(spotsBox);

    if (!spots.length) {
      spotsBox.appendChild(h('p', {
        class: 'muted', style: { fontSize: '12.5px', margin: '0 0 12px' },
        text: '可以跳过。没有地点的一段只会出现在时间线上。',
      }));
      return;
    }

    spots.forEach((spot, index) => {
      const nameInput = h('input', {
        class: 'field__input', type: 'text',
        placeholder: '景区名，例如：栖湖',
        value: spot.name,
        onInput: (e) => { spot.name = e.target.value; },
      });

      const list = h('div', { class: 'autocomplete__list' });
      const wrap = h('div', { class: 'autocomplete' }, nameInput, list);

      // 输入即查（带防抖），命中后自动填坐标
      let timer = null;
      /* ⚠️ 请求序号。没有它就会**静默写错坐标**：
         220ms 防抖挡不住"栖湖"→"栖湖湿地"这种连续输入，而 suggest()是
         网络（高德）+ 内置库两级降级、几乎必然乱序返回。A 先发后回、
         B 后发先回 → B 渲染完正确结果，A 回来时 clear(list) 抹掉 B
         铺上"栖湖"的旧结果 → 她点进去选中的是**另一个地点**，
         坐标悄悄偏掉几百公里，界面上完全看不出异常。
         每个 input 闭包一份 mySeq，回来先比对。 */
      let seq = 0;
      nameInput.addEventListener('input', () => {
        clearTimeout(timer);
        const q = nameInput.value.trim();
        if (q.length < 2) { list.classList.remove('is-open'); return; }
        const mySeq = ++seq;
        timer = setTimeout(async () => {
          const items = await suggest(q);
          if (mySeq !== seq) return;          // 已有更新的查询，丢弃本次结果
          clear(list);
          if (!items.length) { list.classList.remove('is-open'); return; }
          items.slice(0, 6).forEach((it) => {
            list.appendChild(h('button', {
              class: 'autocomplete__item', type: 'button',
              onClick: () => {
                spot.name = it.name;
                spot.lat = it.lat;
                spot.lon = it.lon;
                spot.source = it.source;
                nameInput.value = it.name;
                list.classList.remove('is-open');
                renderSpots();
              },
            }, h('span', { text: it.name }),
               it.city ? h('small', { text: it.city }) : null));
          });
          list.classList.add('is-open');
        }, 220);
      });

      const coordNote = (spot.lat != null && spot.lon != null)
        ? h('div', { class: 'muted', style: { fontSize: '11px', marginTop: '6px' } },
            `已定位 · ${spot.lat.toFixed(4)}, ${spot.lon.toFixed(4)}`)
        : h('div', { class: 'muted', style: { fontSize: '11px', marginTop: '6px' } },
            '未定位，不影响保存');

      const photoCount = spot.photos.length;

      spotsBox.appendChild(h('div', { class: 'spot-editor' },
        h('div', { class: 'spot-editor__head' },
          h('span', { text: `第 ${index + 1} 个地方` }),
          h('button', {
            class: 'trip__action trip__action--danger', type: 'button', text: '移除',
            onClick: () => { spots.splice(index, 1); renderSpots(); },
          })),
        wrap,
        coordNote,
        photoCount
          ? h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '8px' }, text: `${photoCount} 张照片` })
          : null));
    });
  }

  /* ---------------- 地点联想 ---------------- */

  async function suggest(q) {
    // 第一级：服务端代理高德（key 藏在服务端）
    try {
      const res = await fetch(`${config.api.geocodeEndpoint}?q=${encodeURIComponent(q)}`);
      if (res.ok) {
        const list = await res.json();
        if (Array.isArray(list) && list.length) return list;
      }
    } catch { /* 落到下一级 */ }

    // 第二级：内置表
    try {
      const mod = await import('../data/spots-cn.js');
      return mod.search(q);
    } catch {
      return [];
    }
  }

  /* ---------------- 照片：EXIF 自动整理 ---------------- */

  fileInput.addEventListener('change', async () => {
    const files = [...(fileInput.files || [])];
    fileInput.value = '';
    if (!files.length) return;

    /* 上传途中 busy 是 true。原来这里直接 return，选完毫无反应 ——
       照片看起来凭空消失了。至少说一句。 */
    if (busy) {
      showNotice('上一批还在处理，等一下再选');
      return;
    }

    await ingestPhotos(files);
  });

  async function ingestPhotos(files) {
    if (busy) {
      showNotice('上一批还在处理，等一下再选');
      return;
    }
    busy = true;
    setBusy(true);

    /* 下面这段里有好几处 await（sniffFormat / readExif），
       任何一个抛异常，busy 就永远停在 true，保存按钮从此禁用。
       所以整个读取过程包在 try/finally 里。 */
    try {
      await ingestPhotosInner(files);
    } finally {
      busy = false;
      setBusy(false);
    }
  }

  async function ingestPhotosInner(files) {
    const items = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const fmt = await sniffFormat(file);

      if (fmt === 'heic' || fmt === 'avif') {
        exifHint.textContent = '遇到 HEIC/AVIF 格式，已跳过。请改用 JPEG 或 PNG。';
        continue;
      }

      /* readExif 抛错被吞掉是对的（很多图没 EXIF），但**不能什么都不说**：
         她会以为"自动识别日期和位置"坏了。记下失败数，最后给一句人话。 */
      let exif = {};
      let exifFailed = 0;
      try { exif = await readExif(file); } catch { exifFailed += 1; }

      let lon = exif.lon ?? null;
      let lat = exif.lat ?? null;

      // 手机照片的 GPS 是 WGS-84，若来源是高德 POI 才需要转换；
      // 这里 EXIF 直接就是 WGS-84，与 DataV 地图一致，不再转换。
      items.push({ file, lat, lon, takenAt: exif.takenAt || null });
    }

    if (!items.length) {
      exifHint.textContent = '没有可用的照片。';
      return;
    }

    if (exifFailed > 0) {
      exifHint.textContent = `有 ${exifFailed} 张读不到拍摄信息（EXIF），可以稍后手动补日期和地点。`;
    }

    const groups = clusterPhotos(items);
    const withGps = groups.filter((g) => g.hasGps).length;

    groups.forEach((g) => {
      const c = g.centroid;
      const date = dominantDate(g.photos);
      spots.push({
        id: uid(),
        name: '',
        lat: c ? Number(c.lat.toFixed(6)) : null,
        lon: c ? Number(c.lng.toFixed(6)) : null,
        source: 'exif',
        photos: g.photos.map((p) => p.file),
      });
      if (date && !dateInput.value) dateInput.value = date;
    });

    renderSpots();

    exifHint.textContent = withGps
      ? `分成 ${groups.length} 组，其中 ${withGps} 组带位置。给它们起个名字就好。`
      : '这些照片里没有位置信息，麻烦手动填一下地点。';
  }

  /* ---------------- 保存 ---------------- */

  async function save() {
    if (busy) return;

    const city = cityInput.value.trim();
    if (!dateInput.value && !city) {
      showNotice('至少填个日期或地点吧');
      return;
    }

    /* editing 必须在第一个 await 之前快照。
       原来处处用 editing?.id —— 上传途中她关掉抽屉的话 close() 会把
       editing 置空，保存就走 createTrip，凭空多出一条重复行程。 */
    const snapshot = editing;

    busy = true;
    setBusy(true, '正在整理照片…');

    try {
      const failed = [];
      let uploadedCount = 0;   // 本次已落盘的照片数（失败时用于提示）
      const perSpotMax = config.upload.maxPhotosPerSpot || 12;

      /* 先给所有照片槽位分类：已上传的对象与字符串型 URL 原样保留
         （字符串不保留的话，编辑保存一次这张行程的照片就全没了），
         新照片收进一张工作清单，统一走「压缩 → 上传」并逐张报进度。
         每处的张数上限在这里就截断，超限的照片不去白传一遍。 */
      const kept = new Map();   // "spotIndex:slot" -> 该槽位最终留下的照片
      const work = [];          // { key, file }
      const capped = new Set();

      spots.forEach((spot, si) => {
        let count = 0;
        spot.photos.forEach((item, pi) => {
          const isUploaded = item && typeof item === 'object' && item.thumb && !(item instanceof File);
          const isUrl = typeof item === 'string';
          const file = isUploaded || isUrl ? null : (item instanceof File ? item : item?.file);
          if (!isUploaded && !isUrl && !file) return;

          if (count >= perSpotMax) {
            if (!capped.has(si)) {
              capped.add(si);
              failed.push('一处地点最多 ' + perSpotMax + ' 张，多的没带上');
            }
            return;
          }
          count += 1;

          if (isUploaded || isUrl) kept.set(`${si}:${pi}`, item);
          else work.push({ key: `${si}:${pi}`, file });
        });
      });

      let doneCount = 0;
      for (const job of work) {
        doneCount += 1;
        setBusy(true, `正在处理照片 ${doneCount}/${work.length}…`);

        const { results, failures } = await compressBatch([job.file]);
        const one = results[0];

        /* 压缩失败要让人知道。原来 results[0] 为空就 continue，
           照片静默消失，最后还提示"收好了"。 */
        if (!one) {
          failed.push(failures[0] ? failures[0].error : '有一张照片处理失败');
          continue;
        }

        const urls = await data.uploadPhoto(one.full, one.thumb);
        uploadedCount += 1;
        kept.set(job.key, {
          id: uid(),
          full: urls.full,
          thumb: urls.thumb || urls.full,
          w: one.width,
          h: one.height,
        });
      }

      /* 按原槽位顺序拼回：保留的、新传的、失败的各归各位。 */
      const tripSpots = spots.map((spot, si) => ({
        id: spot.id,
        name: spot.name || '',
        lat: spot.lat,
        lon: spot.lon,
        source: spot.source,
        photos: spot.photos
          .map((_, pi) => kept.get(`${si}:${pi}`))
          .filter(Boolean),
      }));

      if (failed.length) {
        showNotice(failed[0] + (failed.length > 1 ? `（共 ${failed.length} 条）` : ''), { duration: 6000 });
      }

      setBusy(true, '正在保存…');
      const trip = {
        id: snapshot?.id || uid(),
        date: dateInput.value || new Date().toISOString().slice(0, 10),
        city,
        country: countryInput.value.trim(),
        title: city,
        note: noteInput.value.trim(),
        tags,
        spots: tripSpots,
        /* 行程级照片这个抽屉没有编辑入口，但数据里有（timeline 会取它当封面）。
           原来这里不带上这个字段，编辑保存一次它就被抹掉。 */
        photos: snapshot?.photos || [],
        createdAt: snapshot?.createdAt || Date.now(),
      };

      if (snapshot) await data.updateTrip(trip);
      else await data.createTrip(trip);

      onSaved?.(trip);
      showNotice('收好了');
      close(true);
    } catch (err) {
      showNotice(`保存失败：${err && err.message || err}`);
      /* ⚠️ 照片先传、行程最后存。所以失败时磁盘上已经躺着本次传的文件，
         没人引用、没人删（trips.php 的清理只在 DELETE 时跑）。
         限流（max_uploads_hour=120）比写限流（60）宽松，连着录几轮就攒下
         一堆孤儿文件，把共享主机的小磁盘吃光 → 整站录入功能报废。
         提示她一句，让她知道照片还在、可以直接重试（重试会传新的，
         旧的这些数量级对配额来说无所谓，但至少不是静默堆积）。 */
      if (uploadedCount > 0) {
        showNotice(`保存失败：${err && err.message || err}（已传的 ${uploadedCount} 张照片还在服务器上，重试一次即可）`,
          { duration: 8000 });
      }
    } finally {
      busy = false;
      setBusy(false);
    }
  }

  function setBusy(next, label) {
    saveBtn.disabled = next;
    if (label) saveBtn.textContent = label;
    /* ⚠️ 不能无条件写回「收进回忆」。编辑已有行程时 open() 设的是
       「保存修改」，失败后 finally 又抹成「收进回忆」—— 标题还写着
       「修改这段回忆」而按钮不是，行为与文案不符。
       按当前模式取文案。 */
    else saveBtn.textContent = editing ? '保存修改' : '收进回忆';
  }

  /* ---------------- 开关 ---------------- */

  function open(trip) {
    /* ⚠️ 保存途中不能重开抽屉。save() 在 await 上传循环**之后**才读表单，
       而 open() 会无条件覆盖 dateInput/tags/spots/各输入框 —— 她在上传
       期间点遮罩关掉再点「补上一段」重开，在途的 save() 醒来后读到的是
       **新抽屉的日期、城市、备注、标签**，和它已经传好的 tripSpots 拼在一起
       存进去 = 一条内容错乱的行程。fileInput 的 change 与 save() 开头都有
       busy 检查，唯独这里没有。 */
    if (busy) {
      showNotice('正在保存，等一下就好');
      return;
    }
    editing = trip || null;
    title.textContent = trip ? '修改这段回忆' : '补上一段';
    saveBtn.textContent = trip ? '保存修改' : '收进回忆';

    dateInput.value = trip?.date || new Date().toISOString().slice(0, 10);
    cityInput.value = trip?.city || '';
    countryInput.value = trip?.country || '';
    noteInput.value = trip?.note || '';
    tags = trip?.tags ? [...trip.tags] : [];

    spots = (trip?.spots || []).map((s) => ({
      id: s.id, name: s.name, lat: s.lat, lon: s.lon,
      source: s.source, photos: s.photos || [],
    }));

    exifHint.textContent = '';
    const tpCount = trip?.photos?.length || 0;
    tripPhotosHint.textContent = tpCount
      ? `这段行程还有 ${tpCount} 张行程级照片，保存时会原样保留`
      : '';
    renderTags();
    renderSpots();

    document.body.style.overflow = 'hidden';
    requestAnimationFrame(() => el.classList.add('is-open'));
  }

  /* force=true 供 save() 自己在成功后调用 —— 保存中的关闭是**业务流程**，
     不是"她中途反悔"。其余入口（遮罩、关闭按钮、Esc）在 busy 时一律拦住，
     否则她会在上传途中关掉抽屉、在途的 save() 醒来后读到已被 close()
     置空的 editing 语境（id 已快照，但文案与状态会错乱）。 */
  function close(force = false) {
    if (busy && !force) {
      showNotice('正在保存，等一下就好');
      return;
    }
    el.classList.remove('is-open');
    clearOverflow(document.body);
    editing = null;
  }

  /* 挂在 document 上、从不摘。抽屉可能只创建一次（当前如此），
     但把解绑句柄留着，将来若支持多实例就不会叠加。 */
  const onKeydown = (e) => {
    if (e.key === 'Escape' && el.classList.contains('is-open')) close();
  };
  document.addEventListener('keydown', onKeydown);

  renderTags();

  return {
    el,
    open,
    close,
    isOpen: () => el.classList.contains('is-open'),
    destroy() {
      document.removeEventListener('keydown', onKeydown);
    },
  };
}
