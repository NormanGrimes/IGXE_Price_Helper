// IGXE Price Helper - 饰品在售页
// https://www.igxe.cn/sell/730
// v1.0.6 — 使用 content-shared.js

(function () {
  'use strict';

  // ======================== 创建共享引擎 ========================
  const app = window.IGXEShared.createApp({
    LOG_PREFIX:        '[IGXE-Sell]',
    CACHE_KEY:         'igxe_sell_price_cache',
    GAME_ID:           '730',
    REFRESH_BAR_ID:    'igxe-sell-refresh-bar',
    REFRESH_BTN_ID:    'igxe-sell-refresh-btn',
    CACHE_COUNT_ID:    'igxe-sell-cache-count',
    REFRESH_BAR_CLASS: 'igxe-sell-refresh-bar',
    REFRESH_BAR_CACHE_CLASS: 'igxe-sell-cache-info',
    REFRESH_BAR_BTN_CLASS:   'igxe-sell-refresh-btn',
    cardIdAttr: 'data-trade-id',
    cardIdKey:  'tradeId',
    cardFilter: null,
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

  // ======================== 页面特有常量 ========================
  const LOAD_MORE_DELAY = 1500;
  const BASELINE_CACHE_KEY = 'igxe_sell_baseline_count';

  // ======================== 页面特有：load-more 拦截 ========================
  function startLoadMoreInterceptor() {
    const btn = document.getElementById('js-load-more');
    if (!btn) return;
    btn.addEventListener('click', () => {
      console.log('[IGXE-Sell] 检测到 load-more 点击');
      setTimeout(() => { enqueueNewCards(); processQueue(); saveListedProductIds(); }, LOAD_MORE_DELAY);
    });
    console.log('[IGXE-Sell] load-more 拦截器就绪');
  }

  // ======================== 页面特有：贩卖总数监测（基线快照方案）=======================
  let sellBaseline   = null;   // 本次页面访问的基线总数
  let baselineSealed = false;  // 基线是否已锁定（仅首次建立时更新）

  function getSellTotalInfo() {
    const el = document.getElementById('js-total-qty');
    if (!el) return null;
    const n = parseInt(el.textContent, 10);
    return isNaN(n) ? null : { element: el.parentElement, count: n };
  }

  function loadBaseline() {
    try { const r = localStorage.getItem(BASELINE_CACHE_KEY); return r ? JSON.parse(r) : null; }
    catch(e) { return null; }
  }

  function saveBaseline(n) {
    try { localStorage.setItem(BASELINE_CACHE_KEY, JSON.stringify({ count: n, ts: Date.now() })); }
    catch(e) {}
  }

  function checkSellTotal() {
    // 搜索激活：总数已被过滤，跳过避免基线污染
    const si = document.getElementById('store_search_key');
    if (si && si.value.trim()) return;

    const info = getSellTotalInfo();
    if (!info) return;
    const cur = info.count;

    // 首次：加载上次页面访问保存的基线，记录本次基线
    if (!baselineSealed) {
      baselineSealed = true;
      const cached = loadBaseline();
      sellBaseline = cached ? cached.count : cur;
      saveBaseline(cur);
      console.log(`[IGXE-Sell] 贩卖基线: 上次${sellBaseline} → 当前${cur}`);
      // 若数量一致则不显示 delta（无变化）
      if (cur === sellBaseline) return;
    }

    // 对比基线显示差值（常驻）
    const old = document.getElementById('igxe-sell-delta');
    if (old) old.remove();

    const d = cur - sellBaseline;
    if (d === 0) return;

    const el = document.createElement('span');
    el.id = 'igxe-sell-delta';
    if (d < 0) {
      el.className = 'igxe-sell-delta igxe-sell-sold';
      el.textContent = `-出售 ${Math.abs(d)}  `;
      console.log(`[IGXE-Sell] 贩卖对比: 售出 ${Math.abs(d)}（${sellBaseline}→${cur}）`);
    } else {
      el.className = 'igxe-sell-delta igxe-sell-listed';
      el.textContent = `+上架 ${d}  `;
      console.log(`[IGXE-Sell] 贩卖对比: 上架 ${d}（${sellBaseline}→${cur}）`);
    }
    if (info.element && info.element.parentNode) {
      info.element.parentNode.insertBefore(el, info.element);
    }
  }

  function startSellCountWatcher() {
    setTimeout(checkSellTotal, 3000);
    setInterval(checkSellTotal, 5000);
  }

  // ======================== 页面特有：同步在售列表供库存页使用 ========================
  function extractPriceFromCard(card) {
    for (const el of card.querySelectorAll('[class*="price"],[class*="Price"]')) {
      const m = el.textContent.trim().match(/[¥￥]\s*([\d.]+)/);
      if (m) return parseFloat(m[1]);
    }
    const t = card.textContent;
    const m = t.match(/[¥￥]\s*([\d.]+)/);
    return m ? parseFloat(m[1]) : null;
  }

  function saveListedProductIds() {
    const ids = [];
    const prices = {};
    document.querySelectorAll('.game-unit [product-url]').forEach(el => {
      try {
        const m = el.getAttribute('product-url').match(/\/product\/730\/(\d+)/);
        if (!m) return;
        const pid = m[1];
        ids.push(pid);
        const card = el.closest('.game-unit');
        if (card) {
          const p = extractPriceFromCard(card);
          if (p != null && isFinite(p)) prices[pid] = p;
        }
      } catch(e) {}
    });
    try {
      localStorage.setItem('igxe_listed_product_ids', JSON.stringify({ ids, ts: Date.now() }));
      localStorage.setItem('igxe_listed_product_prices', JSON.stringify({ prices, ts: Date.now() }));
    } catch(e) {}
  }

  // ======================== 初始化 ========================
  function init() {
    setPriceCache(loadCache());
    insertRefreshButton();

    setTimeout(() => {
      startObserver();
      startLoadMoreInterceptor();
      startModalWatcher();
      startSellCountWatcher();
      injectAllCopyButtons();
      saveListedProductIds();
      setInterval(saveListedProductIds, 3000);

      // 确认出售后重新搜索
      document.addEventListener('click', (e) => {
        if (!e.target.closest('.js-btn-conf-sale')) return;
        console.log('[IGXE-Sell] 检测到"确认出售"点击，开始监控...');
        const si = document.getElementById('store_search_key');
        const sn = si ? si.value.trim() : '';
        if (!sn) return;
        let pc = 0;
        const timer = setInterval(() => {
          pc++;
          const layer = document.querySelector('.layui-layer #js-igxe-sale-data');
          const closed = !layer || layer.offsetParent === null;
          if (closed) {
            clearInterval(timer);
            console.log(`[IGXE-Sell] 弹窗已关闭(轮询${pc}次)，2秒后搜索:"${sn}"`);
            setTimeout(() => {
              const s2 = document.getElementById('store_search_key');
              const s3 = document.getElementById('js-btn-search-key');
              if (s2 && s3) {
                s2.value = sn;
                s2.dispatchEvent(new Event('input', { bubbles: true }));
                s2.dispatchEvent(new Event('change', { bubbles: true }));
                const h = s3.getAttribute('href');
                if (h) s3.removeAttribute('href');
                s3.click();
                if (h) s3.setAttribute('href', h);
                console.log('[IGXE-Sell] 重新搜索已执行');
              }
              // 出售后更新基线（当前总数已减少）
              const ti = getSellTotalInfo();
              if (ti) { sellBaseline = ti.count; saveBaseline(ti.count); }
            }, 2000);
          }
          if (pc >= 60) { clearInterval(timer); console.log('[IGXE-Sell] 售出监控超时'); }
        }, 500);
      });

      // 启动扫描
      if (Object.keys(app.priceCache).length > 0) {
        applyCacheToCards();
        enqueueNewCards();
        processQueue();
        console.log(`[IGXE-Sell] 缓存就绪: ${Object.keys(app.priceCache).length} 个，已恢复`);
      } else {
        console.log('[IGXE-Sell] 首次访问，开始拉取...');
        kickoff();
      }

      insertRefreshButton();
    }, 2000);
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
