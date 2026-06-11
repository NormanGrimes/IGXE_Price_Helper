// IGXE Price Helper - 饰品在售页内容脚本
// 适配 https://www.igxe.cn/sell/730
// v1.0.2+: localStorage 缓存价格数据，页面刷新后不自动拉取
//   缓存键: igxe_sell_price_cache
//   刷新按钮: 仅用户主动点击才清缓存重新拉取

(function () {
  'use strict';

  const REQUEST_INTERVAL = 3000;
  const OBSERVER_DEBOUNCE = 500;
  const LOAD_MORE_DELAY = 1500;
  const CACHE_KEY = 'igxe_sell_price_cache';
  const CACHE_TTL = 24 * 60 * 60 * 1000; // 24小时过期

  const processedProducts = new Set();
  const productCardGroups = new Map();
  const pendingQueue = [];
  let isProcessing = false;
  let observer = null;
  let observerTimer = null;

  // ========================
  // localStorage 价格缓存
  // ========================
  let priceCache = {};

  function loadCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return {};
      const cache = JSON.parse(raw);
      // 过滤过期条目
      const now = Date.now();
      const valid = {};
      let changed = false;
      for (const [pid, entry] of Object.entries(cache)) {
        if (now - entry.ts < CACHE_TTL) {
          valid[pid] = entry;
        } else {
          changed = true;
        }
      }
      if (changed) saveCache(valid);
      return valid;
    } catch (e) {
      console.warn('[IGXE-Sell] 缓存读取失败:', e.message);
      return {};
    }
  }

  function saveCache(cacheObj) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(cacheObj || priceCache));
    } catch (e) {
      console.warn('[IGXE-Sell] 缓存写入失败:', e.message);
    }
  }

  function clearCache() {
    priceCache = {};
    try { localStorage.removeItem(CACHE_KEY); } catch (e) {}
    console.log('[IGXE-Sell] 缓存已清空');
  }

  function cachePrice(productId, steamPrice, autoResult) {
    priceCache[productId] = {
      steamPrice: steamPrice,
      autoPrice: autoResult ? autoResult.price : null,
      isAuto: autoResult ? autoResult.isAuto : null,
      ts: Date.now()
    };
    saveCache();
  }

  /**
   * 将缓存中的价格应用到当前页面上已有的卡片
   */
  function applyCacheToCards() {
    const cards = document.querySelectorAll('.game-unit');
    let applied = 0;
    cards.forEach(card => {
      const tradeId = card.getAttribute('data-trade-id');
      if (!tradeId) return;
      const productUrl = getCardProductUrl(card);
      const productId = extractProductId(productUrl);
      if (!productId) return;

      const cached = priceCache[productId];
      if (!cached) return;

      const autoResult = cached.autoPrice !== null
        ? { price: cached.autoPrice, isAuto: cached.isAuto }
        : null;
      updateCardPrice(card, cached.steamPrice, autoResult);
      applied++;
    });
    if (applied > 0) {
      console.log(`[IGXE-Sell] 从缓存恢复了 ${applied} 张卡片的价格`);
    }
  }

  // ========================
  // Steam 参考价
  // ========================
  const steamCache = new Map();
  const STEAM_CACHE_TTL = 5 * 60 * 1000;

  async function fetchSteamPrice(productId) {
    const cached = steamCache.get(productId);
    if (cached && (Date.now() - cached.time < STEAM_CACHE_TTL)) {
      return cached.price;
    }

    try {
      const resp = await fetch(`https://www.igxe.cn/product/730/${productId}`, {
        credentials: 'include'
      });
      const html = await resp.text();

      const match = html.match(/Steam参考价[^<]*<span[^>]*class="c-4"[^>]*>[^<]*<sub>[^<]*<\/sub>\s*([\d.]+)/);
      if (match) {
        const price = parseFloat(match[1]);
        steamCache.set(productId, { price, time: Date.now() });
        return price;
      }

      const alt = html.match(/starting-price[^<]*<span[^>]*class="c-4"[^>]*>[^<]*<sub>[^<]*<\/sub>\s*([\d.]+)/);
      if (alt) {
        const price = parseFloat(alt[1]);
        steamCache.set(productId, { price, time: Date.now() });
        return price;
      }

      return null;
    } catch (err) {
      console.warn(`[IGXE] Steam价格获取失败 (pid=${productId}):`, err.message);
      return null;
    }
  }

  // ========================
  // 自动发货价格
  // ========================

  async function fetchAutoDeliveryPrice(productId) {
    const extractLowest = (data, label) => {
      if (data.page && Array.isArray(data.page.page_rows) && data.page.page_rows.length > 0) {
        const prices = data.page.page_rows
          .map(i => parseFloat(i.unit_price || i.price))
          .filter(p => !isNaN(p) && p > 0);
        if (prices.length > 0) {
          const lowest = Math.min(...prices);
          console.log(`[IGXE] ${label} page_rows (pid=${productId}): ¥${lowest}`);
          return lowest;
        }
      }
      if (Array.isArray(data.d_list) && data.d_list.length > 0) {
        const prices = data.d_list
          .map(i => parseFloat(i.unit_price || i.price))
          .filter(p => !isNaN(p) && p > 0);
        if (prices.length > 0) {
          const lowest = Math.min(...prices);
          console.log(`[IGXE] ${label} d_list (pid=${productId}): ¥${lowest}`);
          return lowest;
        }
      }
      return null;
    };

    // 步骤1：buy_method=1 自动发货
    try {
      const url = `/product/trade/730/${productId}?buy_method=1&sort=0&sort_rule=0`;
      console.log(`[IGXE] 请求自动发货API url=${url}`);
      const resp = await fetch(url, { credentials: 'include' });
      const text = await resp.text();
      console.log(`[IGXE] 自动发货API 响应前缀: ${text.substring(0, 80)}`);
      if (text.trim().startsWith('{')) {
        let data;
        try { data = JSON.parse(text); } catch (e) {}
        if (data && data.succ) {
          console.log(`[IGXE] 自动发货API 返回结构: d_list类型=${typeof data.d_list}, page=${!!data.page}, page_rows长度=${data.page ? data.page.page_rows?.length : 'N/A'}`);
          const price = extractLowest(data, '自动发货');
          if (price !== null) return { price, isAuto: true };
        }
      }
    } catch (err) {
      console.warn(`[IGXE] 自动发货API 网络错误 (pid=${productId}):`, err.message);
    }

    // 步骤2：fallback 全部在售底价
    try {
      const url = `/product/trade/730/${productId}?sort=0&sort_rule=0`;
      const resp = await fetch(url, { credentials: 'include' });
      const text = await resp.text();
      if (text.trim().startsWith('{')) {
        let data;
        try { data = JSON.parse(text); } catch (e) {}
        if (data && data.succ) {
          const price = extractLowest(data, '底价');
          if (price !== null) return { price, isAuto: false };
        }
      }
    } catch (err) {
      console.warn(`[IGXE] 底价API 网络错误 (pid=${productId}):`, err.message);
    }

    return null;
  }

  function extractProductId(productUrl) {
    if (!productUrl) return null;
    const match = productUrl.match(/\/product\/730\/(\d+)/);
    return match ? match[1] : null;
  }

  function getCardProductUrl(card) {
    const titleEl = card.querySelector('[product-url]');
    return titleEl ? titleEl.getAttribute('product-url') : null;
  }

  function getOrCreatePriceOverlay(card) {
    let overlay = card.querySelector('.igxe-helper-price');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'igxe-helper-price';
      const titleEl = card.querySelector('.g_title');
      if (titleEl) {
        titleEl.after(overlay);
      } else {
        card.appendChild(overlay);
      }
    }
    return overlay;
  }

  function updateCardPrice(card, steamPrice, autoResult) {
    const overlay = getOrCreatePriceOverlay(card);
    let html = '';
    if (steamPrice !== null && steamPrice !== undefined) {
      html += `<span class="igxe-helper-steam" title="Steam参考价">Steam ¥${steamPrice.toFixed(2)}</span>`;
    }
    if (autoResult) {
      const label = autoResult.isAuto ? '自动' : '底价';
      const cls  = autoResult.isAuto ? 'igxe-helper-auto' : 'igxe-helper-lowest';
      const tip  = autoResult.isAuto ? '自动发货最低价' : '全部在售最低价';
      html += `<span class="${cls}" title="${tip}">${label} ¥${autoResult.price.toFixed(2)}</span>`;
    } else if (steamPrice !== null && steamPrice !== undefined) {
      html += '<span class="igxe-helper-na" title="暂无价格数据">-</span>';
    }
    if (!html) {
      html = '<span class="igxe-helper-fail">暂无数据</span>';
    }
    overlay.innerHTML = html;
  }

  function updateGroupStatus(productId, htmlFn) {
    const group = productCardGroups.get(productId);
    if (!group) return;
    group.forEach(({ card }) => {
      const overlay = getOrCreatePriceOverlay(card);
      overlay.innerHTML = htmlFn(card);
    });
  }

  function setGroupQueued(productId, position) {
    updateGroupStatus(productId, () =>
      `<span class="igxe-helper-loading">排队中 (${position})...</span>`
    );
  }

  function setGroupFetching(productId) {
    updateGroupStatus(productId, () =>
      '<span class="igxe-helper-loading">获取中...</span>'
    );
  }

  // ========================
  // 卡片扫描 & 入队
  // ========================
  function enqueueNewCards() {
    const cards = document.querySelectorAll('.game-unit');
    let cacheHits = 0;
    let newCount = 0;
    let restoredCount = 0;

    // 清理不在当前 DOM 中的旧卡片引用（排序/筛选后旧 DOM 已被清掉）
    const cardSet = new Set(cards);
    for (const [pid, group] of productCardGroups) {
      const filtered = group.filter(item => cardSet.has(item.card));
      if (filtered.length === 0) {
        productCardGroups.delete(pid);
      } else if (filtered.length !== group.length) {
        productCardGroups.set(pid, filtered);
      }
    }

    cards.forEach(card => {
      const tradeId = card.getAttribute('data-trade-id');
      if (!tradeId) return;

      const productUrl = getCardProductUrl(card);
      const productId = extractProductId(productUrl);
      if (!productId) return;

      // 记录分组
      if (!productCardGroups.has(productId)) {
        productCardGroups.set(productId, []);
      }
      const group = productCardGroups.get(productId);
      const alreadyInGroup = group.some(item => item.tradeId === tradeId);
      if (!alreadyInGroup) {
        group.push({ card, tradeId });
      }

      // 已处理过的 productId：排序/筛选后卡片是新的 DOM 元素，需要恢复价格显示
      if (processedProducts.has(productId)) {
        const cached = priceCache[productId];
        if (cached && (Date.now() - cached.ts < CACHE_TTL)) {
          const autoResult = cached.autoPrice !== null
            ? { price: cached.autoPrice, isAuto: cached.isAuto }
            : null;
          updateCardPrice(card, cached.steamPrice, autoResult);
          restoredCount++;
        }
        return;
      }

      // 优先查 localStorage 缓存
      const cached = priceCache[productId];
      if (cached && (Date.now() - cached.ts < CACHE_TTL)) {
        processedProducts.add(productId);
        cacheHits++;
        const autoResult = cached.autoPrice !== null
          ? { price: cached.autoPrice, isAuto: cached.isAuto }
          : null;
        if (group) {
          group.forEach(({ card: c }) => updateCardPrice(c, cached.steamPrice, autoResult));
        }
        return;
      }

      processedProducts.add(productId);
      pendingQueue.push({ productId });
      newCount++;
    });

    // 更新排队位置
    for (let i = 0; i < pendingQueue.length; i++) {
      setGroupQueued(pendingQueue[i].productId, i + 1);
    }

    if (newCount > 0 || cacheHits > 0 || restoredCount > 0) {
      console.log(`[IGXE-Sell] 缓存命中 ${cacheHits}，恢复 ${restoredCount}，新增 ${newCount} 种道具入队，队列长度 ${pendingQueue.length}`);
    }
  }

  async function processQueue() {
    if (isProcessing) return;
    isProcessing = true;

    while (pendingQueue.length > 0) {
      const { productId } = pendingQueue.shift();
      setGroupFetching(productId);

      try {
        const [steamPrice, autoLowest] = await Promise.all([
          fetchSteamPrice(productId),
          fetchAutoDeliveryPrice(productId)
        ]);

        // 写入持久化缓存
        cachePrice(productId, steamPrice, autoLowest);
        updateRefreshBarCount();

        const group = productCardGroups.get(productId);
        if (group) {
          group.forEach(({ card }) => updateCardPrice(card, steamPrice, autoLowest));
        }
      } catch (err) {
        console.warn(`[IGXE-Sell] 处理失败 (product=${productId}):`, err.message);
        const group = productCardGroups.get(productId);
        if (group) {
          group.forEach(({ card }) => updateCardPrice(card, null, null));
        }
      }

      if (pendingQueue.length > 0) {
        await new Promise(r => setTimeout(r, REQUEST_INTERVAL));
      }
    }

    isProcessing = false;
  }

  function kickoff() {
    enqueueNewCards();
    processQueue();
  }

  // ========================
  // 刷新按钮
  // ========================

  function insertRefreshButton() {
    if (document.getElementById('igxe-sell-refresh-bar')) return;

    // 查找插入位置：在 game-unit 列表前面
    const firstCard = document.querySelector('.game-unit');
    if (!firstCard || !firstCard.parentNode) {
      // 页面还没渲染出卡片，稍后重试
      setTimeout(insertRefreshButton, 1500);
      return;
    }

    const cacheCount = Object.keys(priceCache).length;

    const bar = document.createElement('div');
    bar.id = 'igxe-sell-refresh-bar';
    bar.className = 'igxe-sell-refresh-bar';
    bar.innerHTML = `
      <span id="igxe-sell-cache-count" class="igxe-sell-cache-info">${cacheCount > 0 ? '已缓存 ' + cacheCount + ' 个道具' : '暂无缓存数据'}</span>
      <button id="igxe-sell-refresh-btn" class="igxe-sell-refresh-btn">🔄 刷新数据</button>
    `;

    firstCard.parentNode.insertBefore(bar, firstCard);

    document.getElementById('igxe-sell-refresh-btn').addEventListener('click', onRefreshClick);
    console.log('[IGXE-Sell] 刷新按钮已插入');
  }

  function updateRefreshBarCount() {
    const el = document.getElementById('igxe-sell-cache-count');
    if (el) {
      const count = Object.keys(priceCache).length;
      el.textContent = count > 0 ? '已缓存 ' + count + ' 个道具' : '暂无缓存数据';
    }
  }

  function onRefreshClick() {
    const btn = document.getElementById('igxe-sell-refresh-btn');
    if (!btn) return;
    btn.disabled = true;
    btn.textContent = '刷新中...';

    // 清空持久化缓存
    clearCache();

    // 强制刷新页面数据
    forceRefreshAll();

    // 恢复按钮状态（forceRefreshAll 是异步的，等处理完成）
    function checkDone() {
      if (isProcessing || pendingQueue.length > 0) {
        setTimeout(checkDone, 500);
        return;
      }
      btn.disabled = false;
      btn.textContent = '🔄 刷新数据';
      updateRefreshBarCount();
    }
    setTimeout(checkDone, 2000);
  }

  // ========================
  // DOM 监听 + load-more 拦截
  // ========================

  function debouncedScan() {
    if (observerTimer) clearTimeout(observerTimer);
    observerTimer = setTimeout(() => {
      insertRefreshButton();   // 排序/筛选后 DOM 重建，重新插入按钮
      enqueueNewCards();
      processQueue();
    }, OBSERVER_DEBOUNCE);
  }

  function startObserver() {
    if (observer) return;
    observer = new MutationObserver(debouncedScan);
    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  function startLoadMoreInterceptor() {
    const loadMoreBtn = document.getElementById('js-load-more');
    if (!loadMoreBtn) return;

    loadMoreBtn.addEventListener('click', () => {
      console.log('[IGXE-Sell] 检测到 load-more 点击，等待新数据加载...');
      setTimeout(() => {
        enqueueNewCards();
        processQueue();
      }, LOAD_MORE_DELAY);
    });

    console.log('[IGXE-Sell] #js-load-more 拦截器已就绪');
  }

  // ========================
  // 初始化
  // ========================

  function init() {
    // 1. 加载缓存
    priceCache = loadCache();

    // 2. 插入刷新按钮（尽早插入）
    insertRefreshButton();

    setTimeout(() => {
      startObserver();
      startLoadMoreInterceptor();
      startModalWatcher();

      if (Object.keys(priceCache).length > 0) {
        // 有缓存：应用缓存数据，不自动拉取
        applyCacheToCards();
        // 检查是否有缓存中没覆盖到的新卡片（如加载更多后的新页）
        enqueueNewCards();
        processQueue();
        console.log(`[IGXE-Sell] 缓存就绪: ${Object.keys(priceCache).length} 个道具，已恢复显示`);
      } else {
        // 无缓存（首次访问）：自动拉取
        console.log('[IGXE-Sell] 首次访问，自动获取价格数据...');
        kickoff();
      }

      // 确保刷新按钮再次尝试插入（以防首次插入时 DOM 未就绪）
      insertRefreshButton();
    }, 2000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // ========================
  // popup 消息处理
  // ========================
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'REFRESH_PRICES') {
      // popup 刷新：等效于点击刷新按钮
      clearCache();
      forceRefreshAll();
      sendResponse({ success: true });
    }
    if (message.type === 'PING') {
      sendResponse({ alive: true });
    }
  });

  // ========================
  // 改价弹窗价格注入
  // ========================
  let modalRetryTimer = null;

  /**
   * 从弹窗行中提取 productId，尝试多种策略
   */
  function extractProductIdFromRow(row) {
    // 策略1: product-url 属性（同卡片逻辑）
    const pu = row.querySelector('[product-url]');
    if (pu) { const id = extractProductId(pu.getAttribute('product-url')); if (id) return id; }

    // 策略2: href="/product/730/xxx" 链接
    const links = row.querySelectorAll('a[href*="/product/730/"]');
    for (const a of links) { const id = extractProductId(a.getAttribute('href')); if (id) return id; }

    // 策略3: data-product-id / data-pid
    const dp = row.querySelector('[data-product-id], [data-pid]');
    if (dp) return dp.getAttribute('data-product-id') || dp.getAttribute('data-pid');

    // 策略4: 从卡片的 data-trade-id 反查 productCardGroups
    const tradeId = row.getAttribute('data-trade-id');
    if (tradeId) {
      for (const [pid, group] of productCardGroups) {
        if (group.some(item => item.tradeId === tradeId)) return pid;
      }
    }

    return null;
  }

  /**
   * 找到弹窗行中的"参考价"单元格
   * 优先用表头列号，其次用 class 匹配，最后用文本模式匹配
   */
  function getRefPriceColumnIndex(modal) {
    // 找表头中的"参考价"
    const headers = modal.querySelectorAll('th, [class*="header"], [class*="thead"] th, [class*="thead"] div');
    for (let i = 0; i < headers.length; i++) {
      if (headers[i].textContent.trim() === '参考价') return i;
    }
    return -1;
  }

  function findRefPriceCell(row, colIndex) {
    // 策略1: 按列号取单元格
    if (colIndex >= 0) {
      const cells = row.querySelectorAll('td');
      if (cells[colIndex]) return cells[colIndex];
    }

    // 策略2: class 含 ref/reference
    const ref = row.querySelector('[class*="ref"], [class*="reference"]');
    if (ref) return ref;

    // 策略3: 内容匹配纯数字（如 5.11）
    const cells = row.querySelectorAll('td, [class*="cell"], [class*="col"]');
    for (const c of cells) {
      const t = c.textContent.trim();
      if (/^\d+(\.\d{1,2})?$/.test(t)) return c;
    }

    return null;
  }

  /**
   * 在弹窗参考价单元格内注入缓存价格
   */
  function injectPriceToCell(cell, productId) {
    // 先清除旧注入（弹窗内容变更后旧数据不匹配）
    const old = cell.querySelector('.igxe-modal-price');
    if (old) old.remove();

    const cached = priceCache[productId];
    if (!cached) return;

    const wrapper = document.createElement('div');
    wrapper.className = 'igxe-modal-price';

    // Steam 参考价
    if (cached.steamPrice !== null && cached.steamPrice !== undefined) {
      wrapper.innerHTML += `<span class="igxe-modal-steam">Steam ¥${cached.steamPrice.toFixed(2)}</span>`;
    }

    // 自动发货/底价
    if (cached.autoPrice !== null) {
      const label = cached.isAuto ? '自动' : '底价';
      const cls   = cached.isAuto ? 'igxe-modal-auto' : 'igxe-modal-lowest';
      wrapper.innerHTML += `<span class="${cls}">${label} ¥${cached.autoPrice.toFixed(2)}</span>`;
    } else if (cached.steamPrice === null || cached.steamPrice === undefined) {
      wrapper.innerHTML += '<span class="igxe-modal-na">暂无数据</span>';
    }

    cell.appendChild(wrapper);
  }

  function injectModalPrices(modal, retries = 0) {
    // 先清除弹窗内所有旧注入（内容可能已变更）
    modal.querySelectorAll('.igxe-modal-price').forEach(el => el.remove());

    const colIndex = getRefPriceColumnIndex(modal);

    // 仅匹配 tbody 内的 tr，避免 thead 行干扰
    const rows = modal.querySelectorAll('tbody tr');

    // 表格还未渲染完成 → 重试（最多5次）
    if (rows.length === 0) {
      if (retries >= 5) {
        console.log('[IGXE-Sell] 弹窗重试超时，放弃注入');
        return;
      }
      console.log(`[IGXE-Sell] 弹窗表格未就绪，500ms后重试(${retries + 1}/5)...`);
      if (modalRetryTimer) clearTimeout(modalRetryTimer);
      modalRetryTimer = setTimeout(() => injectModalPrices(modal, retries + 1), 500);
      return;
    }

    if (modalRetryTimer) clearTimeout(modalRetryTimer);
    console.log(`[IGXE-Sell] 弹窗检测: 参考价列号=${colIndex}, 行数=${rows.length}`);

    let injected = 0;
    rows.forEach(row => {
      const productId = extractProductIdFromRow(row);
      if (!productId) return;

      const cell = findRefPriceCell(row, colIndex);
      if (!cell) return;

      // 缓存中没有则跳过（不 fetch，避免弹窗内大量请求）
      if (!priceCache[productId]) return;

      injectPriceToCell(cell, productId);
      injected++;
    });

    if (injected > 0) {
      console.log(`[IGXE-Sell] 弹窗价格注入: ${injected} 个道具`);
    }
  }

  /**
   * 检测弹窗出现：匹配常见的 IGXE 弹窗选择器
   */
  function startModalWatcher() {
    const MODAL_SELECTORS = [
      '.layui-layer',            // IGXE 改价弹窗 (layer.js)
      '.el-dialog__body',
      '.el-dialog',
      '[role="dialog"]',
    ];

    const modalObserver = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;

          for (const sel of MODAL_SELECTORS) {
            let modal = null;
            if (node.matches && node.matches(sel)) {
              modal = node;
            } else if (node.querySelector) {
              modal = node.querySelector(sel);
            }
            if (modal) {
              // 弹窗可能需要等 Vue 渲染表格，内部有重试机制
              setTimeout(() => injectModalPrices(modal), 400);
              return;
            }
          }
        }
      }
    });

    modalObserver.observe(document.body, {
      childList: true,
      subtree: true
    });

    console.log('[IGXE-Sell] 改价弹窗监视器已就绪');
  }

  function forceRefreshAll() {
    processedProducts.clear();
    productCardGroups.clear();
    pendingQueue.length = 0;
    isProcessing = false;
    document.querySelectorAll('.igxe-helper-price').forEach(el => el.remove());
    kickoff();
  }

})();
