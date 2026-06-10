// IGXE Price Helper - 饰品库存页内容脚本
// 同款道具按 productId 去重，只请求一次，所有同名卡片同步更新
// 逐个请求，间隔3秒，获取后立即显示
// Steam价格 + 自动发货价格 → 全部在页面上下文直接 fetch（避免 SW 超时）

(function () {
  'use strict';

  const REQUEST_INTERVAL = 3000;
  const OBSERVER_DEBOUNCE = 500;
  const processedProducts = new Set();
  const productCardGroups = new Map();
  const pendingQueue = [];
  let isProcessing = false;
  let observer = null;
  let observerTimer = null;
  let currentBotId = null;

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

  function enqueueNewCards() {
    const cards = document.querySelectorAll('.game-unit');
    let newCount = 0;

    cards.forEach(card => {
      const pid = card.dataset.pid;
      if (!pid) return;

      // 跳过不属于当前 Bot 的卡片（其他账号的道具不能显示在此页面）
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

      if (processedProducts.has(productId)) return;

      processedProducts.add(productId);
      pendingQueue.push({ productId });
      newCount++;
    });

    // 更新排队位置（仅对还在队列中的）
    for (let i = 0; i < pendingQueue.length; i++) {
      setGroupQueued(pendingQueue[i].productId, i + 1);
    }

    if (newCount > 0) {
      console.log(`[IGXE-Helper] 新增 ${newCount} 种道具入队，队列长度 ${pendingQueue.length}`);
    }
  }

  async function processQueue() {
    if (isProcessing) return;
    isProcessing = true;

    while (pendingQueue.length > 0) {
      const { productId } = pendingQueue.shift();
      setGroupFetching(productId);

      try {
        // 两步都在页面上下文完成，不依赖 Service Worker
        const [steamPrice, autoLowest] = await Promise.all([
          fetchSteamPrice(productId),
          fetchAutoDeliveryPrice(productId)
        ]);

        // 更新所有同名卡片
        const group = productCardGroups.get(productId);
        if (group) {
          group.forEach(({ card }) => updateCardPrice(card, steamPrice, autoLowest));
        }
      } catch (err) {
        console.warn(`[IGXE-Helper] 处理失败 (product=${productId}):`, err.message);
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
    // 读取当前选中的 Bot ID
    currentBotId = getCurrentBotId();

    // 页面完全就绪后再启动观察器
    setTimeout(() => {
      // 再次确认 botId（页面可能刚加载完DOM）
      const id = getCurrentBotId();
      if (id) currentBotId = id;
      lastBotId = id;

      startObserver();
      startBotWatcher();
      kickoff();
    }, 2000);
  }

  /**
   * 轮询监听账号切换：Bot ID 变化时自动清空状态重新抓取
   */
  let lastBotId = null;
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
    // 清空所有状态：已处理、分类组、待处理队列
    processedProducts.clear();
    productCardGroups.clear();
    pendingQueue.length = 0;
    isProcessing = false; // 如果旧的 processQueue 还在跑，下一轮 while 会自然结束
    document.querySelectorAll('.igxe-helper-price').forEach(el => el.remove());
    kickoff();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'REFRESH_PRICES') {
      forceRefreshAll();
      sendResponse({ success: true });
    }
    if (message.type === 'PING') {
      sendResponse({ alive: true });
    }
  });

})();
