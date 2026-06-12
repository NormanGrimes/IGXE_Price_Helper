// v1.0.3+: localStorage 缓存价格数据，页面刷新后不自动拉取
//   缓存键: igxe_inventory_price_cache
//   刷新按钮: 仅用户主动点击才清缓存重新拉取

(function () {
  'use strict';

  const REQUEST_INTERVAL = 3000;
  const OBSERVER_DEBOUNCE = 500;
  const CACHE_KEY = 'igxe_inventory_price_cache';
  const CACHE_TTL = 24 * 60 * 60 * 1000; // 24小时过期

  const processedProducts = new Set();
  const productCardGroups = new Map();
  const pendingQueue = [];
  let isProcessing = false;
  let observer = null;
  let observerTimer = null;
  let currentBotId = null;
  let lastBotId = null;

  // ========================
  // localStorage 价格缓存
  // ========================
  let priceCache = {};

  function loadCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return {};
      const cache = JSON.parse(raw);
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
      console.warn('[IGXE-Inv] 缓存读取失败:', e.message);
      return {};
    }
  }

  function saveCache(cacheObj) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(cacheObj || priceCache));
    } catch (e) {
      console.warn('[IGXE-Inv] 缓存写入失败:', e.message);
    }
  }

  function clearCache() {
    priceCache = {};
    try { localStorage.removeItem(CACHE_KEY); } catch (e) {}
    console.log('[IGXE-Inv] 缓存已清空');
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
   * 将缓存中的价格应用到当前页面上的已有卡片
   */
  function applyCacheToCards() {
    const cards = document.querySelectorAll('.game-unit');
    let applied = 0;
    cards.forEach(card => {
      const pid = card.dataset.pid;
      if (!pid) return;
      if (!belongsToCurrentBot(card)) return;
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
      console.log(`[IGXE-Inv] 从缓存恢复了 ${applied} 张卡片的价格`);
    }
  }

  // ========================
  // Steam 参考价：从产品页 HTML 提取（页面上下文 fetch，避免 SW 超时）
  // ========================
  const steamCache = new Map();
  const STEAM_CACHE_TTL = 5 * 60 * 1000;

  async function fetchSteamPrice(productId) {
    // 查缓存
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
  // 自动发货价格：本脚本直接发请求（页面 cookie 天然带上）
  // ========================

  /**
   * 获取自动发货最低价，失败则 fallback 到全部商品最低价
   * @returns {{ price: number, isAuto: boolean } | null}
   */
  async function fetchAutoDeliveryPrice(productId) {
    // 解析 page_rows 或 d_list 中的最低价
    const extractLowest = (data, label) => {
      // page.page_rows
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
      // d_list 变成商品数组时
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

    // 步骤1：buy_method=1 获取自动发货最低价（筛选仅自动发货商品）
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
          console.log(`[IGXE] 自动发货API 返回结构: d_list类型=${typeof data.d_list}, page有=${!!data.page}, page_rows长度=${data.page ? data.page.page_rows?.length : 'N/A'}`);
          const price = extractLowest(data, '自动发货');
          if (price !== null) return { price, isAuto: true };
        }
      }
    } catch (err) {
      console.warn(`[IGXE] 自动发货API 网络错误 (pid=${productId}):`, err.message);
    }

    // 步骤2：fallback 获取商品底价（全部在售）
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

  /**
   * 读取当前选中的 Steam Bot ID
   */
  function getCurrentBotId() {
    const el = document.getElementById('steam_user_id');
    return el ? el.value : null;
  }

  /**
   * 判断卡片是否属于当前选中账号
   */
  function belongsToCurrentBot(card) {
    if (!currentBotId) return true; // 还没读到 botId 时先不拦截
    return card.dataset.botId === currentBotId;
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
      html += '<span class="igxe-helper-na" title="当前无在售">当前无在售</span>';
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
  // 刷新按钮
  // ========================

  function insertRefreshButton() {
    if (document.getElementById('igxe-inv-refresh-bar')) return;

    const firstCard = document.querySelector('.game-unit');
    if (!firstCard || !firstCard.parentNode) {
      setTimeout(insertRefreshButton, 1500);
      return;
    }

    const cacheCount = Object.keys(priceCache).length;

    const bar = document.createElement('div');
    bar.id = 'igxe-inv-refresh-bar';
    bar.className = 'igxe-sell-refresh-bar';
    bar.innerHTML = `
      <span id="igxe-inv-cache-count" class="igxe-sell-cache-info">${cacheCount > 0 ? '已缓存 ' + cacheCount + ' 个道具' : '暂无缓存数据'}</span>
      <button id="igxe-inv-refresh-btn" class="igxe-sell-refresh-btn">🔄 刷新数据</button>
    `;

    firstCard.parentNode.insertBefore(bar, firstCard);

    document.getElementById('igxe-inv-refresh-btn').addEventListener('click', onRefreshClick);
    console.log('[IGXE-Inv] 刷新按钮已插入');
  }

  function updateRefreshBarCount() {
    const el = document.getElementById('igxe-inv-cache-count');
    if (el) {
      const count = Object.keys(priceCache).length;
      el.textContent = count > 0 ? '已缓存 ' + count + ' 个道具' : '暂无缓存数据';
    }
  }

  function onRefreshClick() {
    const btn = document.getElementById('igxe-inv-refresh-btn');
    if (!btn) return;
    btn.disabled = true;
    btn.textContent = '刷新中...';

    clearCache();
    forceRefreshAll();

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
  // 卡片扫描 & 入队
  // ========================

  function enqueueNewCards() {
    const cards = document.querySelectorAll('.game-unit');
    let cacheHits = 0;
    let newCount = 0;
    let restoredCount = 0;

    // 清理不在当前 DOM 中的旧卡片引用
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
      const pid = card.dataset.pid;
      if (!pid) return;

      // 跳过不属于当前 Bot 的卡片
      if (!belongsToCurrentBot(card)) return;

      const productUrl = getCardProductUrl(card);
      const productId = extractProductId(productUrl);
      if (!productId) return;

      if (!productCardGroups.has(productId)) {
        productCardGroups.set(productId, []);
      }
      const group = productCardGroups.get(productId);
      const alreadyInGroup = group.some(item => item.pid === pid);
      if (!alreadyInGroup) {
        group.push({ card, pid });
      }

      // 已处理过的 productId → 从缓存恢复（排序/筛选后 DOM 重建）
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

    // 更新排队位置（仅对还在队列中的）
    for (let i = 0; i < pendingQueue.length; i++) {
      setGroupQueued(pendingQueue[i].productId, i + 1);
    }

    if (newCount > 0 || cacheHits > 0 || restoredCount > 0) {
      console.log(`[IGXE-Inv] 缓存命中 ${cacheHits}，恢复 ${restoredCount}，新增 ${newCount} 种道具入队，队列长度 ${pendingQueue.length}`);
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

        // 更新所有同名卡片
        const group = productCardGroups.get(productId);
        if (group) {
          group.forEach(({ card }) => updateCardPrice(card, steamPrice, autoLowest));
        }
      } catch (err) {
        console.warn(`[IGXE-Inv] 处理失败 (product=${productId}):`, err.message);
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

  /**
   * 带防抖的 DOM 扫描——避免页面加载时成千上万次触发
   */
  function debouncedScan() {
    if (observerTimer) clearTimeout(observerTimer);
    observerTimer = setTimeout(() => {
      insertRefreshButton();   // 排序/筛选后 DOM 重建，重新插入按钮
      injectAllCopyButtons();  // DOM 重建后重新注入复制按钮
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

  function init() {
    // 1. 加载缓存
    priceCache = loadCache();

    // 2. 读取当前 Bot ID，尽早插入刷新按钮
    currentBotId = getCurrentBotId();
    insertRefreshButton();

    setTimeout(() => {
      const id = getCurrentBotId();
      if (id) currentBotId = id;
      lastBotId = id;

      startObserver();
      startBotWatcher();
      startModalWatcher();
      injectAllCopyButtons();

      if (Object.keys(priceCache).length > 0) {
        // 有缓存：应用缓存数据，不自动拉取
        applyCacheToCards();
        enqueueNewCards();
        processQueue();
        console.log(`[IGXE-Inv] 缓存就绪: ${Object.keys(priceCache).length} 个道具，已恢复显示`);
      } else {
        // 无缓存：自动拉取
        console.log('[IGXE-Inv] 首次访问，自动获取价格数据...');
        kickoff();
      }

      insertRefreshButton();
    }, 2000);
  }

  /**
   * 轮询监听账号切换：Bot ID 变化时自动清空状态重新抓取
   */
  function startBotWatcher() {
    lastBotId = getCurrentBotId();
    setInterval(() => {
      const id = getCurrentBotId();
      if (id && id !== lastBotId) {
        console.log(`[IGXE-Helper] 检测到账号切换: ${lastBotId} → ${id}`);
        currentBotId = id;
        lastBotId = id;
        forceRefreshAll();
      }
    }, 1000);
  }

  function forceRefreshAll() {
    processedProducts.clear();
    productCardGroups.clear();
    pendingQueue.length = 0;
    isProcessing = false;
    document.querySelectorAll('.igxe-helper-price').forEach(el => el.remove());
    insertRefreshButton();
    injectAllCopyButtons();
    kickoff();
  }

  // ========================
  // 卡片复制按钮
  // ========================

  /**
   * 从卡片 DOM 提取完整物品名称，如 "P90 | 擦擦 (崭新出厂)"
   * 策略：
   *   1. title 属性优先（IGXE 可能不含磨损 → 单独拼接）
   *   2. title属性 + 磨损标签 → 完整名称
   *   3. textContent 过滤 x1/¥ 杂质 + 磨损
   */
  function getCardItemName(card) {
    const titleEl = card.querySelector('.g_title');
    if (!titleEl) return null;

    // 提取基础名称（从 title 或 过滤后的 textContent）
    let baseName = null;
    const tAttr = titleEl.getAttribute('title');
    if (tAttr && tAttr.trim() && tAttr.includes('|')) baseName = tAttr.trim();
    if (!baseName) {
      // fallback: textContent 按行拆分取首行含 | 的文本
      // sell 页多行各含数量/价格/状态 → split 后每行天然干净
      // inventory 页可能单行含杂质 → 正则剔除 x1 / ¥ / 在售
      const lines = titleEl.textContent.split(/[\r\n]+/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.includes('|') && trimmed.length > 2) {
          baseName = trimmed.replace(/\s*x\d+\s*/g, '')
                           .replace(/\s*[¥￥]\s*[\d.]+\s*/g, '')
                           .replace(/\s*在售\s*/g, '')
                           .trim();
          break;
        }
      }
    }
    if (!baseName) return null;

    // 提取磨损值，拼接到名称后面
    const wear = getWearText(card);
    if (wear && !baseName.includes(wear)) {
      return `${baseName} (${wear})`;
    }
    return baseName;
  }

  /**
   * 从卡片中提取磨损/品质文本
   * 常见 IGXE 标签缩略 → 全名映射
   */
  const WEAR_MAP = {
    '崭新出厂': '崭新出厂', '崭新': '崭新出厂',
    '略有磨损': '略有磨损', '略磨': '略有磨损',
    '久经沙场': '久经沙场', '久经': '久经沙场',
    '破损不堪': '破损不堪', '破损': '破损不堪',
    '战痕累累': '战痕累累', '战痕': '战痕累累',
  };

  function getWearText(card) {
    // 策略1: 查找卡片内所有包含磨损关键词的 span/div
    const wearKeys = Object.keys(WEAR_MAP);
    const allEls = card.querySelectorAll('span, div, i, em, label, [class*="tag"], [class*="wear"], [class*="quality"]');
    for (const el of allEls) {
      const txt = el.textContent.trim();
      // 检查 title 属性（可能存全名）
      const tip = el.getAttribute('title');
      if (tip) {
        for (const key of wearKeys) {
          if (tip.includes(key)) return WEAR_MAP[key];
        }
      }
      // 检查 textContent
      for (const key of wearKeys) {
        if (txt === key || txt.includes(key)) return WEAR_MAP[key];
      }
    }

    // 策略2: 直接搜索卡片内全部文本节点
    const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const txt = node.textContent.trim();
      for (const key of wearKeys) {
        if (txt === key) return WEAR_MAP[key];
      }
    }

    return null;
  }

  /**
   * 为单张卡片注入复制按钮
   */
  function injectCopyButton(card) {
    if (card.querySelector('.igxe-copy-btn')) return; // 已注入

    const name = getCardItemName(card);
    if (!name) return;

    const btn = document.createElement('button');
    btn.className = 'igxe-copy-btn';
    btn.title = '复制物品名称';
    btn.textContent = '📋';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      navigator.clipboard.writeText(name).then(() => {
        btn.textContent = '✓';
        btn.classList.add('igxe-copied');
        setTimeout(() => {
          btn.textContent = '📋';
          btn.classList.remove('igxe-copied');
        }, 1200);
      }).catch(() => {});
    });

    card.style.position = card.style.position || 'relative';
    card.appendChild(btn);
  }

  /**
   * 为所有卡片注入复制按钮
   */
  function injectAllCopyButtons() {
    document.querySelectorAll('.game-unit').forEach(card => {
      if (belongsToCurrentBot(card)) {
        injectCopyButton(card);
      }
    });
  }

  // ========================
  // 物品上架弹窗价格注入
  // ========================
  let modalRetryTimer = null;

  /**
   * 从弹窗行中提取 productId，尝试多种策略
   */
  function extractProductIdFromRow(row) {
    // 策略1: product-url 属性
    const pu = row.querySelector('[product-url]');
    if (pu) { const id = extractProductId(pu.getAttribute('product-url')); if (id) return id; }

    // 策略2: href="/product/730/xxx" 链接
    const links = row.querySelectorAll('a[href*="/product/730/"]');
    for (const a of links) { const id = extractProductId(a.getAttribute('href')); if (id) return id; }

    // 策略3: data-product-id / data-pid / data-trade-id
    const dp = row.querySelector('[data-product-id], [data-pid], [data-trade-id]');
    if (dp) return dp.getAttribute('data-product-id') || dp.getAttribute('data-pid');

    // 策略4: 从 data-pid 反查 productCardGroups
    const pidAttr = row.closest ? row.closest('[data-pid]') : null;
    if (pidAttr) return pidAttr.getAttribute('data-pid');

    return null;
  }

  function getRefPriceColumnIndex(modal) {
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

    // 策略3: 内容匹配纯数字价格
    const cells = row.querySelectorAll('td, [class*="cell"], [class*="col"]');
    for (const c of cells) {
      const t = c.textContent.trim();
      if (/^\d+(\.\d{1,2})?$/.test(t)) return c;
    }

    return null;
  }

  function injectPriceToCell(cell, productId) {
    const old = cell.querySelector('.igxe-modal-price');
    if (old) old.remove();

    const cached = priceCache[productId];
    if (!cached) return;

    const wrapper = document.createElement('div');
    wrapper.className = 'igxe-modal-price';

    if (cached.steamPrice !== null && cached.steamPrice !== undefined) {
      wrapper.innerHTML += `<span class="igxe-modal-steam">Steam ¥${cached.steamPrice.toFixed(2)}</span>`;
    }

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
    modal.querySelectorAll('.igxe-modal-price').forEach(el => el.remove());

    const colIndex = getRefPriceColumnIndex(modal);
    const rows = modal.querySelectorAll('tbody tr');

    if (rows.length === 0) {
      if (retries >= 5) {
        console.log('[IGXE-Inv] 弹窗重试超时，放弃注入');
        return;
      }
      console.log(`[IGXE-Inv] 弹窗表格未就绪，500ms后重试(${retries + 1}/5)...`);
      if (modalRetryTimer) clearTimeout(modalRetryTimer);
      modalRetryTimer = setTimeout(() => injectModalPrices(modal, retries + 1), 500);
      return;
    }

    if (modalRetryTimer) clearTimeout(modalRetryTimer);
    console.log(`[IGXE-Inv] 弹窗检测: 参考价列号=${colIndex}, 行数=${rows.length}`);

    let injected = 0;
    rows.forEach(row => {
      const productId = extractProductIdFromRow(row);
      if (!productId) return;

      const cell = findRefPriceCell(row, colIndex);
      if (!cell) return;

      if (!priceCache[productId]) return;

      injectPriceToCell(cell, productId);
      injected++;
    });

    if (injected > 0) {
      console.log(`[IGXE-Inv] 弹窗价格注入: ${injected} 个道具`);
    }
  }

  function startModalWatcher() {
    const MODAL_SELECTORS = [
      '.layui-layer',
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

    console.log('[IGXE-Inv] 物品上架弹窗监视器已就绪');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'REFRESH_PRICES') {
      clearCache();
      forceRefreshAll();
      sendResponse({ success: true });
    }
    if (message.type === 'PING') {
      sendResponse({ alive: true });
    }
  });

})();
