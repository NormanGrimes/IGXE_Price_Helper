// IGXE Price Helper - 饰品在售页
// https://www.igxe.cn/sell/730
// v1.0.7 — 使用 content-shared.js

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

  // ======================== 页面特有：改价计时器 ========================
  // 设计：用「基准时间戳 + 基准秒数」计算当前时间，不依赖 setInterval tick 计数，
  //       浏览器休眠/后台挂起时 setInterval 会停止，但 Date.now() 不受影响。
  //
  //   timerBaseSec  ：计时器归零时的累计秒数（重置时为 0）
  //   timerBaseTs   ：最后一次同步 timerBaseSec 时的 Date.now() 时间戳
  //   当前显示秒数   = Math.min(timerBaseSec + (Date.now() - timerBaseTs)/1000, TIMER_MAX_SEC)
  //
  const TIMER_KEY      = 'igxe_sell_timer';
  const TIMER_MAX_SEC  = 60 * 60; // 60分钟
  const TIMER_SAVE_INT = 5000;    // 每5秒写一次 sessionStorage
  let timerBaseSec   = 0;       // 归零时的累计秒数（休眠恢复后仍为 0，除非已计过时）
  let timerBaseTs    = Date.now(); // 上次同步基准的时间戳
  let timerInterval   = null;
  let timerSaveTimer  = null;
  let timerObserver   = null;

  // ---- 计算当前秒数（核心：不用 tick 计数，用时间戳算） ----
  function getTimerSeconds() {
    const elapsed = (Date.now() - timerBaseTs) / 1000;
    let sec = timerBaseSec + elapsed;
    if (sec > TIMER_MAX_SEC) sec = TIMER_MAX_SEC;
    return Math.floor(sec);
  }

  // ---- 将当前计算值同步到 base，用于重置或持久化前"冻结"当前值 ----
  function freezeTimer() {
    timerBaseSec = getTimerSeconds();
    timerBaseTs  = Date.now();
  }

  // ---- sessionStorage 持久化 ----
  // 存储格式：{ sec: 累计秒数, ts: 写入时的时间戳 }
  // 恢复时：sec + (Date.now() - ts) = 恢复后的累计秒数
  function loadTimerState() {
    try {
      const raw = sessionStorage.getItem(TIMER_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw);
      if (typeof s.sec !== 'number') return null;
      const elapsed = (Date.now() - s.ts) / 1000;
      let sec = s.sec + elapsed;
      if (sec > TIMER_MAX_SEC) sec = TIMER_MAX_SEC;
      return Math.floor(sec);
    } catch(e) { return null; }
  }

  function saveTimerState() {
    try {
      freezeTimer(); // 先冻结当前值，再存
      sessionStorage.setItem(TIMER_KEY, JSON.stringify({
        sec: timerBaseSec,
        ts:  timerBaseTs,
      }));
    } catch(e) {}
  }

  function clearTimerState() {
    try { sessionStorage.removeItem(TIMER_KEY); } catch(e) {}
  }

  // ---- 格式化 ----
  function formatTimer(sec) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  }

  function updateTimerDisplay() {
    const el = document.getElementById('igxe-sell-timer');
    if (el) el.textContent = `改价计时: ${formatTimer(getTimerSeconds())}`;
  }

  // ---- 重置 ----
  function resetTimer() {
    timerBaseSec = 0;
    timerBaseTs  = Date.now();
    updateTimerDisplay();
    saveTimerState(); // 立即写入，防止重置后刷新页面恢复旧值
    console.log('[IGXE-Sell] 计时器重置（检测到改价/出售确认）');
  }

  // ---- 计时主循环 ----
  // 不计数 tick，只负责每秒刷新显示（实际秒数由 getTimerSeconds() 实时计算）
  function startTimer() {
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(() => {
      updateTimerDisplay();
      // 达到上限后停止刷新（节省资源）
      if (getTimerSeconds() >= TIMER_MAX_SEC) {
        clearInterval(timerInterval);
        timerInterval = null;
      }
    }, 1000);

    // 定期持久化（不每 tick 都写）
    if (timerSaveTimer) clearInterval(timerSaveTimer);
    timerSaveTimer = setInterval(() => {
      saveTimerState();
    }, TIMER_SAVE_INT);
  }

  // ---- 插入/恢复 DOM ----
  function ensureTimerDOM() {
    if (document.getElementById('igxe-sell-timer')) return true;

    const bar = document.getElementById('igxe-sell-refresh-bar');
    if (!bar) return false;

    const timerSpan = document.createElement('span');
    timerSpan.id = 'igxe-sell-timer';
    timerSpan.className = 'igxe-sell-timer';
    timerSpan.textContent = `改价计时: ${formatTimer(getTimerSeconds())}`;

    const btn = document.getElementById('igxe-sell-refresh-btn');
    if (btn && btn.parentNode === bar) {
      bar.insertBefore(timerSpan, btn);
    } else {
      bar.appendChild(timerSpan);
    }
    return true;
  }

  // ---- 监听浏览器休眠/恢复（visibilitychange） ----
  // 这是修复"休眠后计时停止"的关键：页面从后台回到前台时，
  // 不需要做任何特殊操作——getTimerSeconds() 用 Date.now() 计算，
  // 天然能正确处理休眠期间的流逝时间。
  // 只需在恢复时立即刷新一次显示即可。
  function startVisibilityWatcher() {
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        // 页面恢复可见：立即刷新显示（此时 getTimerSeconds() 已自动包含休眠期间的时间）
        updateTimerDisplay();
        console.log('[IGXE-Sell] 页面恢复可见，计时器已自动校准');
        // 如果计时器之前因达到上限而被清除，恢复后重新启动（防止边界情况）
        if (!timerInterval && getTimerSeconds() < TIMER_MAX_SEC) {
          startTimer();
        }
      }
    });
    // 额外监听 window.focus（某些浏览器/场景下 visibilitychange 不触发）
    window.addEventListener('focus', () => {
      updateTimerDisplay();
    });
  }

  // ---- MutationObserver：监听刷新栏被 IGXE 动态替换 ----
  function startTimerBarObserver() {
    if (timerObserver) return;
    timerObserver = new MutationObserver(() => {
      setTimeout(() => {
        if (!document.getElementById('igxe-sell-timer')) {
          console.log('[IGXE-Sell] 检测到计时器 DOM 丢失，重新插入...');
          ensureTimerDOM();
        }
      }, 300);
    });
    const target = document.querySelector('.game-list') || document.body;
    if (target) timerObserver.observe(target, { childList: true, subtree: true });
  }

  function initTimer() {
    // 恢复上次状态（页面刷新后）
    const saved = loadTimerState();
    if (saved !== null) {
      timerBaseSec = saved;
      timerBaseTs  = Date.now();
      console.log(`[IGXE-Sell] 恢复计时器状态: ${formatTimer(saved)}`);
    }

    const tryInit = () => {
      if (!ensureTimerDOM()) { setTimeout(tryInit, 500); return; }
      updateTimerDisplay();
      startTimer();
      startTimerBarObserver();
      startVisibilityWatcher();
      console.log('[IGXE-Sell] 改价计时器已启动');

      // 监听改价/出售确认：多策略检测
      // 策略1：匹配已知 class / data-action
      // 策略2：按钮文本含"确认/确定/改价/出售"等关键词
      // 策略3：弹窗关闭后（IGXE 用 layui-layer，关闭时 .layui-layer 从 DOM 移除）
      let _timerResetListened = false;

      document.addEventListener('click', (e) => {
        // 策略1：已知选择器
        const target = e.target.closest(
          '.js-btn-conf-sale, .js-btn-conf-modify, .js-btn-conf-update, .js-btn-conf-price, [data-action="confirm-price"], [data-action="update-price"]'
        );
        if (target) {
          console.log('[IGXE-Sell] [策略1] 检测到改价/出售确认，重置计时器', target.className);
          resetTimer();
          return;
        }

        // 策略2：按钮文本关键词（兼容 IGXE 改版后 class 变化的情况）
        const btn = e.target.closest('button, a, [role="button"], .btn, .layui-btn');
        if (btn) {
          const txt = btn.textContent.trim();
          if (txt.includes('确认') || txt.includes('确定') || txt.includes('改价') || txt.includes('出售') || txt.includes('上架')) {
            console.log('[IGXE-Sell] [策略2] 检测到改价/出售相关按钮点击，重置计时器 text="' + txt.substring(0, 20) + '"');
            resetTimer();
            return;
          }
        }
      }, true); // 捕获阶段，确保比 IGXE 本身的事件先执行

      // 策略3：监听改价弹窗关闭（layui-layer 被移除）
      if (!_timerResetListened) {
        _timerResetListened = true;
        let _layerTimeout = null;
        const checkLayerClose = () => {
          // 找到所有 layui-layer（IGXE 的弹窗容器）
          const layers = document.querySelectorAll('.layui-layer');
          for (const layer of layers) {
            // 标记：如果这个 layer 有关键字，记录它在 DOM 中
            if (!layer.dataset._igxeTimerWatch && layer.textContent.includes('改价')) {
              layer.dataset._igxeTimerWatch = '1';
              // 用 MutationObserver 监听这个 layer 被移除
              const parent = layer.parentNode;
              if (parent) {
                const obs = new MutationObserver(() => {
                  if (!document.contains(layer)) {
                    // layer 已从 DOM 移除，说明弹窗关闭了
                    console.log('[IGXE-Sell] [策略3] 检测到改价弹窗关闭，重置计时器');
                    resetTimer();
                    obs.disconnect();
                  }
                });
                obs.observe(parent, { childList: true });
              }
            }
          }
          // 清空已关闭的 layer 的标记
          document.querySelectorAll('.layui-layer').forEach(l => { if (!l.dataset._igxeTimerWatch) l.dataset._igxeTimerWatch = '1'; });
        };
        // 定期检查新弹窗（弹窗是动态插入的）
        setInterval(checkLayerClose, 2000);
        checkLayerClose();
      }
    };
    tryInit();
  }

  // ======================== 初始化 ========================
  function init() {
    setPriceCache(loadCache());
    insertRefreshButton();
    initTimer();

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
