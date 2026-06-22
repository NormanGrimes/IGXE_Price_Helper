// IGXE Price Helper - 库存页
// https://www.igxe.cn/inventory/skins/*
// v1.0.6 — 使用 content-shared.js

(function () {
  'use strict';

  // ======================== Bot ID 管理（页面特有）=======================
  let currentBotId = null;
  let lastBotId = null;

  function getCurrentBotId() {
    const el = document.getElementById('steam_user_id');
    return el ? el.value : null;
  }

  function belongsToCurrentBot(card) {
    if (!currentBotId) return true;
    return card.dataset.botId === currentBotId;
  }

  // ======================== 创建共享引擎 ========================
  const app = window.IGXEShared.createApp({
    LOG_PREFIX:        '[IGXE-Inv]',
    CACHE_KEY:         'igxe_inventory_price_cache',
    GAME_ID:           '730',
    REFRESH_BAR_ID:    'igxe-inv-refresh-bar',
    REFRESH_BTN_ID:    'igxe-inv-refresh-btn',
    CACHE_COUNT_ID:    'igxe-inv-cache-count',
    REFRESH_BAR_CLASS: 'igxe-sell-refresh-bar',
    REFRESH_BAR_CACHE_CLASS: 'igxe-sell-cache-info',
    REFRESH_BAR_BTN_CLASS:   'igxe-sell-refresh-btn',
    cardIdAttr:  'data-pid',
    cardIdKey:   'pid',
    cardFilter:  (card) => belongsToCurrentBot(card),
  });

  const {
    loadCache, setPriceCache, clearCache, cachePrice, updateCardPrice,
    applyCacheToCards, enqueueNewCards, processQueue, kickoff,
    insertRefreshButton, updateRefreshBarCount, onRefreshClick,
    injectCopyButton, injectAllCopyButtons,
    extractProductIdFromRow, getRefPriceColumnIndex,
    findRefPriceCell, injectPriceToCell,
    injectModalPrices, startModalWatcher,
    startObserver, forceRefreshAll, handleMessage,
  } = app;

  // 库存页：CSS 微调，抬高价格行与在售页对齐
  function injectPricePositionFix() {
    const s = document.createElement('style');
    s.textContent = '.game-unit .igxe-helper-price { margin-top: -3px; }';
    document.head.appendChild(s);
  }

  // ======================== 初始化 ========================
  function init() {
    setPriceCache(loadCache());
    currentBotId = getCurrentBotId();
    insertRefreshButton();

    setTimeout(async () => {
      console.log('[IGXE-Inv] init 回调执行');
      const id = getCurrentBotId();
      if (id) { currentBotId = id; lastBotId = id; }

      startObserver();
      startBotWatcher();
      startModalWatcher();
      injectPricePositionFix();
      injectAllCopyButtons();

      // 自主获取在售列表
      await fetchAndCacheListedItems();
      markAlreadyListed();
      injectListedPrices();
      setInterval(markAlreadyListed, 5000);
      setInterval(injectListedPrices, 5000);

      // 定价出售时清空搜索框
      const psb = document.getElementById('js-local-store-igxe');
      if (psb) psb.addEventListener('click', () => {
        const si = document.getElementById('store_search_key');
        if (si) si.value = '';
      });

      // 确认出售后执行空搜索刷新全部卡片（捕获阶段）
      console.log('[IGXE-Inv] 售出后空搜索监听器已注册(capture)');
      document.addEventListener('click', (e) => {
        const btn = e.target.closest('.js-btn-conf-sale');
        if (!btn) return;
        console.log('[IGXE-Inv] 捕获到"确认出售"点击，2秒后空搜索');
        setTimeout(() => {
          const si = document.getElementById('store_search_key');
          const sb = document.getElementById('js-btn-search-key');
          if (si && sb) {
            si.value = '';
            si.dispatchEvent(new Event('input', { bubbles: true }));
            si.dispatchEvent(new Event('change', { bubbles: true }));
            const h = sb.getAttribute('href');
            if (h) sb.removeAttribute('href');
            sb.click();
            if (h) sb.setAttribute('href', h);
            console.log('[IGXE-Inv] 售出后空搜索已执行');
            try { localStorage.removeItem(LISTED_CACHE_KEY); } catch(e) {}
          }
        }, 2000);
      }, true);

      // 启动扫描
      if (Object.keys(app.priceCache).length > 0) {
        applyCacheToCards();
        enqueueNewCards();
        processQueue();
        console.log(`[IGXE-Inv] 缓存就绪: ${Object.keys(app.priceCache).length} 个，已恢复`);
      } else {
        console.log('[IGXE-Inv] 首次访问，开始拉取...');
        kickoff();
      }

      insertRefreshButton();
    }, 2000);
  }

  // ======================== 枚举所有可能的 API 响应格式 ========================
  function extractIdsFromApiResponse(json) {
    const ids = [];
    const prices = {};
    // 尝试各种常见的响应结构
    const lists = [];
    if (json.succ) {
      if (Array.isArray(json.data)) lists.push(json.data);
      if (json.data && Array.isArray(json.data.list)) lists.push(json.data.list);
      if (json.data && Array.isArray(json.data.products)) lists.push(json.data.products);
      if (json.data && Array.isArray(json.data.items)) lists.push(json.data.items);
      if (json.page && Array.isArray(json.page.page_rows)) lists.push(json.page.page_rows);
    }
    if (Array.isArray(json)) lists.push(json);
    if (json.list) lists.push(json.list);
    if (json.products) lists.push(json.products);
    if (json.data && Array.isArray(json.data)) lists.push(json.data);
    if (json.show_data && Array.isArray(json.show_data)) lists.push(json.show_data);

    for (const list of lists) {
      for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        const pid = String(item.product_id || item.id || item.pid || item.steam_pid || '');
        if (!pid) continue;
        ids.push(pid);
        const p = parseFloat(item.unit_price || item.price || item.sell_price || item.my_price);
        if (!isNaN(p) && p > 0) prices[pid] = p;
      }
    }
    return { ids, prices };
  }

  // ======================== 页面特有：已在售标记（自主 fetch 售页）=======================
  const LISTED_CACHE_KEY = 'igxe_listed_items_cache';
  const LISTED_CACHE_TTL = 5 * 60 * 1000;

  function extractPriceFromCard(card) {
    for (const el of card.querySelectorAll('[class*="price"],[class*="Price"]')) {
      const m = el.textContent.trim().match(/[¥￥]\s*([\d.]+)/);
      if (m) return parseFloat(m[1]);
      const v = el.getAttribute('val');
      if (v) { const p = parseFloat(v); if (!isNaN(p)&&p>0) return p; }
    }
    const t = card.textContent;
    const m = t.match(/[¥￥]\s*([\d.]+)/);
    return m ? parseFloat(m[1]) : null;
  }

  function getCachedListedData() {
    try {
      const r = localStorage.getItem(LISTED_CACHE_KEY);
      if (!r) return null;
      const d = JSON.parse(r);
      if (Date.now() - d.ts > LISTED_CACHE_TTL) return null;
      return d;
    } catch(e) { return null; }
  }

  async function fetchAndCacheListedItems() {
    const cached = getCachedListedData();
    if (cached) { console.log('[IGXE-Inv] 在售缓存命中:', cached.ids.length, '个'); return cached; }
    console.log('[IGXE-Inv] 开始获取在售列表...');

    // --- 策略1：直接调用 /sell/data/730（真实 API）---
    try {
      let allIds = []; let allPrices = {}; let page = 1; let hasMore = true;
      while (hasMore) {
        const params = new URLSearchParams({ page_no: page, status_type: '9' });
        const ep = `/sell/data/730?${params}`;
        console.log('[IGXE-Inv] 第', page, '页请求:', ep);
        const resp = await fetch(ep, { credentials: 'include' });
        console.log('[IGXE-Inv] 响应状态:', resp.status);
        const text = await resp.text();
        try {
          const json = JSON.parse(text);
          const n = json.show_data?.length || 0;
          console.log('[IGXE-Inv] succ=', json.succ, 'show_data=', n, 'is_more=', json.is_more);
          if (json.succ && json.show_data) {
            for (const item of json.show_data) {
              const pid = String(item.product_id || '');
              if (!pid) continue;
              allIds.push(pid);
              const p = parseFloat(item.unit_price);
              if (!isNaN(p) && p > 0 && (!allPrices[pid] || p < allPrices[pid])) allPrices[pid] = p;
            }
          }
          hasMore = json.is_more; page++;
        } catch(e) { console.log('[IGXE-Inv] JSON 解析失败:', e.message); hasMore = false; }
      }
      if (allIds.length > 0) {
        console.log('[IGXE-Inv] 策略1成功:', allIds.length, '个产品ID,', Object.keys(allPrices).length, '个有价格');
        const data = { ids: allIds, prices: allPrices, ts: Date.now() };
        try { localStorage.setItem(LISTED_CACHE_KEY, JSON.stringify(data)); } catch(e) {}
        return data;
      }
    } catch(e) { console.warn('[IGXE-Inv] 策略1失败:', e.message); }

    // --- 策略2（降级）：fetch 售页 HTML + DOMParser（对动态渲染页无效）---
    console.log('[IGXE-Inv] 策略2：尝试 fetch 售页 HTML...');
    try {
      const resp = await fetch('/sell/730', { credentials: 'include' });
      console.log('[IGXE-Inv] fetch 售页状态:', resp.status, 'url:', resp.url);
      const html = await resp.text();
      console.log('[IGXE-Inv] 售页 HTML 长度:', html.length);
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');
      // 同时尝试两种选择器（库存页 vs 售页）
      let els = doc.querySelectorAll('.game-unit [product-url]');
      if (els.length === 0) els = doc.querySelectorAll('[product-url]');
      console.log('[IGXE-Inv] [product-url] 元素数量:', els.length);
      if (els.length > 0) {
        const ids = [];
        const prices = {};
        els.forEach(el => {
          const m = el.getAttribute('product-url').match(/\/product\/730\/(\d+)/);
          if (!m) return;
          const pid = m[1];
          ids.push(pid);
          const card = el.closest('.game-unit') || el.parentElement;
          if (card) { const p = extractPriceFromCard(card); if (p != null && isFinite(p)) prices[pid] = p; }
        });
        const data = { ids, prices, ts: Date.now() };
        try { localStorage.setItem(LISTED_CACHE_KEY, JSON.stringify(data)); } catch(e) {}
        console.log(`[IGXE-Inv] 策略2成功: ${ids.length} 个，${Object.keys(prices).length} 个有价格`);
        return data;
      }
      // HTML 中没找到卡片，输出发现的 API 端点供调试
      console.log('[IGXE-Inv] HTML 中无卡片，搜索脚本中的 API 端点...');
      const apiSet = new Set();
      for (const s of doc.querySelectorAll('script')) {
        const txt = s.textContent || '';
        for (const m of txt.matchAll(/["'](\/dmall\/seller\/[^"']{2,})["']/g)) apiSet.add(m[1]);
        for (const m of txt.matchAll(/["'](\/api\/v\d\/[^"']{2,})["']/g)) apiSet.add(m[1]);
      }
      const apis = [...apiSet];
      if (apis.length > 0) { console.log('[IGXE-Inv] 脚本中发现的可能 API 端点:', apis.slice(0,20)); }
    } catch(e) { console.warn('[IGXE-Inv] 策略2失败:', e.message); }
    return null;
  }

  function getListedProductIds() {
    const d = getCachedListedData();
    if (!d || !d.ids) {
      console.log('[IGXE-Inv] getListedProductIds: 无新缓存，尝试旧降级...');
      try {
        const r = localStorage.getItem('igxe_listed_product_ids');
        if (!r) { console.log('[IGXE-Inv] getListedProductIds: 旧降级也无数据'); return new Set(); }
        const o = JSON.parse(r);
        if (Date.now() - o.ts > 30 * 60 * 1000) { console.log('[IGXE-Inv] getListedProductIds: 旧降级数据过期'); return new Set(); }
        console.log('[IGXE-Inv] getListedProductIds: 使用旧降级, ids=', (o.ids||[]).length);
        return new Set(o.ids || []);
      } catch(e) { console.log('[IGXE-Inv] getListedProductIds: 异常'); return new Set(); }
    }
    console.log('[IGXE-Inv] getListedProductIds: 使用新缓存, ids=', d.ids.length);
    return new Set(d.ids);
  }

  function markAlreadyListed() {
    document.querySelectorAll('.game-unit.igxe-duplicate-listed').forEach(c => c.classList.remove('igxe-duplicate-listed'));
    const listed = getListedProductIds();
    console.log('[IGXE-Inv] markAlreadyListed: 在售ID数量=', listed.size);
    if (!listed.size) { console.log('[IGXE-Inv] markAlreadyListed: 无在售数据，跳过'); return; }
    const cards = document.querySelectorAll('.game-unit');
    console.log('[IGXE-Inv] markAlreadyListed: 库存卡片总数=', cards.length);
    let matched = 0;
    cards.forEach(card => {
      if (!belongsToCurrentBot(card)) return;
      const el = card.querySelector('[product-url]');
      if (!el) return;
      const m = el.getAttribute('product-url').match(/\/product\/730\/(\d+)/);
      if (m && listed.has(m[1])) { card.classList.add('igxe-duplicate-listed'); matched++; }
    });
    console.log(`[IGXE-Inv] markAlreadyListed: 标记了 ${matched} 个在售物品`);
  }

  // ======================== 页面特有：已上架物品在售价格显示 ========================
  function getListedPrices() {
    const d = getCachedListedData();
    if (!d || !d.prices) {
      console.log('[IGXE-Inv] getListedPrices: 无新缓存，尝试旧降级...');
      try {
        const r = localStorage.getItem('igxe_listed_product_prices');
        if (!r) { console.log('[IGXE-Inv] getListedPrices: 旧降级也无数据'); return {}; }
        const o = JSON.parse(r);
        if (Date.now() - o.ts > 30 * 60 * 1000) { console.log('[IGXE-Inv] getListedPrices: 旧降级数据过期'); return {}; }
        console.log('[IGXE-Inv] getListedPrices: 使用旧降级, prices=', Object.keys(o.prices||{}).length);
        return o.prices || {};
      } catch(e) { console.log('[IGXE-Inv] getListedPrices: 异常'); return {}; }
    }
    console.log('[IGXE-Inv] getListedPrices: 使用新缓存, prices=', Object.keys(d.prices).length);
    return d.prices;
  }

  function injectListedPrices() {
    try {
      const prices = getListedPrices();
      const pk = Object.keys(prices);
      console.log('[IGXE-Inv] injectListedPrices: 价格缓存数量=', pk.length);
      if (!pk.length) { console.log('[IGXE-Inv] injectListedPrices: 无价格数据，跳过'); return; }
      if (pk.length <= 5) console.log('[IGXE-Inv] injectListedPrices: prices=', JSON.stringify(prices));
      const cards = document.querySelectorAll('.game-unit.igxe-duplicate-listed');
      console.log('[IGXE-Inv] injectListedPrices: 已标记在售卡片数=', cards.length);
      let injected = 0;
      cards.forEach(card => {
        try {
          if (card.querySelector('.igxe-listed-price')) return;
          const el = card.querySelector('[product-url]');
          if (!el) return;
          const m = el.getAttribute('product-url').match(/\/product\/730\/(\d+)/);
          if (!m) return;
          const p = prices[m[1]];
          if (p == null || !isFinite(p)) { console.log('[IGXE-Inv] injectListedPrices: 无价格 pid=', m[1]); return; }
          console.log(`[IGXE-Inv] injectListedPrices: 注入 pid=${m[1]} 在售 ¥${p.toFixed(2)}`);
          const ov = card.querySelector('.igxe-helper-price');
          const div = document.createElement('div');
          div.className = 'igxe-listed-price';
          div.textContent = `在售 ¥${p.toFixed(2)}`;
          card.style.position = card.style.position || 'relative';  // 支撑绝对定位
          if (ov && ov.parentNode === card) ov.before(div); else card.appendChild(div);
          injected++;
        } catch(e) { console.warn('[IGXE-Inv] injectListedPrices 单卡异常:', e.message); }
      });
      console.log(`[IGXE-Inv] injectListedPrices: 成功注入 ${injected} 个价格`);
    } catch(e) { console.warn('[IGXE-Inv] injectListedPrices 外层异常:', e.message); }
  }

  // ======================== Bot 切换监听（页面特有）=======================
  function startBotWatcher() {
    lastBotId = getCurrentBotId();
    setInterval(() => {
      const id = getCurrentBotId();
      if (id && id !== lastBotId) {
        console.log(`[IGXE-Inv] 检测到账号切换: ${lastBotId}→${id}`);
        currentBotId = id; lastBotId = id;
        forceRefreshAll();
      }
    }, 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // ======================== popup 消息 ========================
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'REFRESH_PRICES') {
      clearCache(); forceRefreshAll(); sendResponse({ success: true });
      return true;
    }
    if (msg.type === 'PING') {
      sendResponse({ alive: true });
      return true;
    }
  });

})();
