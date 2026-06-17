// IGXE Price Helper - 库存页
// https://www.igxe.cn/inventory/skins/*
// v1.0.5 — 使用 content-shared.js

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

  // ======================== 初始化 ========================
  function init() {
    setPriceCache(loadCache());
    currentBotId = getCurrentBotId();
    insertRefreshButton();

    setTimeout(() => {
      console.log('[IGXE-Inv] init 回调执行');
      const id = getCurrentBotId();
      if (id) { currentBotId = id; lastBotId = id; }

      startObserver();
      startBotWatcher();
      startModalWatcher();
      injectAllCopyButtons();

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
