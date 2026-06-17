// IGXE Price Helper - 共享核心模块 v1.0.5
// 由 content-sell.js 和 content-inventory.js 通过 createApp(cfg) 调用

(function(global) {
  'use strict';

  global.IGXEShared = {
    createApp: function(cfg) {
      // cfg: { LOG_PREFIX, CACHE_KEY, GAME_ID,
      //        REFRESH_BAR_ID, REFRESH_BTN_ID, CACHE_COUNT_ID,
      //        REFRESH_BAR_CLASS, REFRESH_BAR_CACHE_CLASS, REFRESH_BAR_BTN_CLASS,
      //        cardIdAttr, cardIdKey, cardFilter }

      const P = cfg.LOG_PREFIX;
      const GAME_ID = cfg.GAME_ID || '730';

      function log(...args) { try { console.log(P, ...args); } catch(e) {} }
      function warn(...args) { try { console.warn(P, ...args); } catch(e) {} }

      // ======================== 常量 ========================
      const REQUEST_INTERVAL  = 3000;
      const OBSERVER_DEBOUNCE = 500;
      const CACHE_TTL         = 24 * 60 * 60 * 1000;
      const STEAM_CACHE_TTL   = 5 * 60 * 1000;
      const SEARCH_DELAY      = 300;
      const COPY_BTN_RESET    = 1200;
      const MODAL_DELAY       = 400;
      const MODAL_RETRY_INT  = 500;
      const MODAL_RETRY_MAX   = 5;
      const REFRESH_RETRY_INT = 1500;

      // ======================== 状态 ========================
      const processedProducts   = new Set();
      const productCardGroups   = new Map();
      const pendingQueue        = [];
      let   isProcessing       = false;
      let   observer           = null;
      let   observerTimer      = null;
      let   modalRetryTimer    = null;
      let   priceCache         = {};
      let   abortController    = new AbortController();

      // ======================== 缓存 ========================
      function loadCache() {
        try {
          const raw = localStorage.getItem(cfg.CACHE_KEY);
          if (!raw) return {};
          const cache = JSON.parse(raw);
          const now = Date.now();
          const valid = {};
          let changed = false;
          for (const [pid, entry] of Object.entries(cache)) {
            if (now - entry.ts < CACHE_TTL) valid[pid] = entry;
            else changed = true;
          }
          if (changed) _saveCache(valid);
          return valid;
        } catch (e) { warn('缓存读取失败:', e.message); return {}; }
      }

      function _saveCache(obj) {
        try { localStorage.setItem(cfg.CACHE_KEY, JSON.stringify(obj || priceCache)); }
        catch (e) { warn('缓存写入失败:', e.message); }
      }

      function clearCache() {
        priceCache = {};
        try { localStorage.removeItem(cfg.CACHE_KEY); } catch(e) {}
        log('缓存已清空');
      }

      function cachePrice(productId, steamPrice, autoResult) {
        priceCache[productId] = {
          steamPrice,
          autoPrice: autoResult ? autoResult.price : null,
          isAuto:    autoResult ? autoResult.isAuto : null,
          ts: Date.now()
        };
        _saveCache();
      }

      // ======================== Steam 参考价 ========================
      const steamCache = new Map();

      async function fetchSteamPrice(productId, signal) {
        const c = steamCache.get(productId);
        if (c && Date.now() - c.time < STEAM_CACHE_TTL) return c.price;
        try {
          const resp = await fetch(`https://www.igxe.cn/product/${GAME_ID}/${productId}`, { credentials:'include', signal });
          const html = await resp.text();
          let m = html.match(/Steam参考价[^<]*<span[^>]*class="c-4"[^>]*>[^<]*<sub>[^<]*<\/sub>\s*([\d.]+)/);
          if (m) { const p = parseFloat(m[1]); steamCache.set(productId,{price:p,time:Date.now()}); return p; }
          m = html.match(/starting-price[^<]*<span[^>]*class="c-4"[^>]*>[^<]*<sub>[^<]*<\/sub>\s*([\d.]+)/);
          if (m) { const p = parseFloat(m[1]); steamCache.set(productId,{price:p,time:Date.now()}); return p; }
          return null;
        } catch (err) { if (err.name==='AbortError') throw err; warn(`Steam价格获取失败(pid=${productId}):`, err.message); return null; }
      }

      // ======================== 自动发货价格 ========================
      async function fetchAutoDeliveryPrice(productId, signal) {
        const _extract = (data, label) => {
          if (data.page && Array.isArray(data.page.page_rows) && data.page.page_rows.length>0) {
            const ps = data.page.page_rows.map(i=>parseFloat(i.unit_price||i.price)).filter(p=>!isNaN(p)&&p>0);
            if (ps.length) { log(`${label} page_rows(pid=${productId}): ¥${Math.min(...ps)}`); return Math.min(...ps); }
          }
          if (Array.isArray(data.d_list) && data.d_list.length>0) {
            const ps = data.d_list.map(i=>parseFloat(i.unit_price||i.price)).filter(p=>!isNaN(p)&&p>0);
            if (ps.length) { log(`${label} d_list(pid=${productId}): ¥${Math.min(...ps)}`); return Math.min(...ps); }
          }
          return null;
        };
        // 步骤1 自动发货
        try {
          const resp = await fetch(`/product/trade/${GAME_ID}/${productId}?buy_method=1&sort=0&sort_rule=0`, { credentials:'include', signal });
          const text = await resp.text();
          if (text.trim().startsWith('{')) {
            let data; try { data = JSON.parse(text); } catch(e) {}
            if (data && data.succ) {
              log(`自动发货API 返回结构: d_list=${typeof data.d_list}, page=${!!data.page}`);
              const p = _extract(data,'自动发货'); if (p!==null) return { price:p, isAuto:true };
            }
          }
        } catch(err) { if (err.name==='AbortError') throw err; warn(`自动发货API 错误(pid=${productId}):`, err.message); }
        // 步骤2 底价
        try {
          const resp = await fetch(`/product/trade/${GAME_ID}/${productId}?sort=0&sort_rule=0`, { credentials:'include', signal });
          const text = await resp.text();
          if (text.trim().startsWith('{')) {
            let data; try { data = JSON.parse(text); } catch(e) {}
            if (data && data.succ) { const p = _extract(data,'底价'); if (p!==null) return { price:p, isAuto:false }; }
          }
        } catch(err) { if (err.name==='AbortError') throw err; warn(`底价API 错误(pid=${productId}):`, err.message); }
        return null;
      }

      // ======================== 通用工具 ========================
      function extractProductId(url) {
        if (!url) return null;
        const m = url.match(new RegExp(`/product/${GAME_ID}/(\\d+)`));
        return m ? m[1] : null;
      }

      function getCardProductUrl(card) {
        const el = card.querySelector('[product-url]');
        return el ? el.getAttribute('product-url') : null;
      }

      function getOrCreatePriceOverlay(card) {
        let ov = card.querySelector('.igxe-helper-price');
        if (!ov) {
          ov = document.createElement('div');
          ov.className = 'igxe-helper-price';
          const t = card.querySelector('.g_title');
          if (t) t.after(ov); else card.appendChild(ov);
        }
        return ov;
      }

      function updateCardPrice(card, steamPrice, autoResult) {
        const ov = getOrCreatePriceOverlay(card);
        let h = '';
        if (steamPrice != null) h += `<span class="igxe-helper-steam" title="Steam参考价">Steam ¥${steamPrice.toFixed(2)}</span>`;
        if (autoResult) {
          const lb = autoResult.isAuto ? '自动' : '底价';
          const cl = autoResult.isAuto ? 'igxe-helper-auto' : 'igxe-helper-lowest';
          h += `<span class="${cl}" title="${autoResult.isAuto?'自动发货最低价':'全部在售最低价'}">${lb} ¥${autoResult.price.toFixed(2)}</span>`;
        } else if (steamPrice != null) {
          h += '<span class="igxe-helper-na" title="当前无在售">当前无在售</span>';
        }
        if (!h) h = '<span class="igxe-helper-fail">暂无数据</span>';
        ov.innerHTML = h;
      }

      function _updateGroup(productId, fn) {
        const g = productCardGroups.get(productId); if (!g) return;
        g.forEach(({card}) => { const ov = getOrCreatePriceOverlay(card); ov.innerHTML = fn(card); });
      }

      function setGroupQueued(pid, pos) {
        _updateGroup(pid, () => `<span class="igxe-helper-loading">排队中(${pos})...</span>`);
      }
      function setGroupFetching(pid) {
        _updateGroup(pid, () => '<span class="igxe-helper-loading">获取中...</span>');
      }

      // ======================== 卡片扫描 ========================
      function applyCacheToCards() {
        const cards = document.querySelectorAll('.game-unit');
        let n = 0;
        cards.forEach(card => {
          const id = card.getAttribute(cfg.cardIdAttr);
          if (!id) return;
          if (cfg.cardFilter && !cfg.cardFilter(card)) return;
          const pid = extractProductId(getCardProductUrl(card));
          if (!pid) return;
          const c = priceCache[pid]; if (!c) return;
          const ar = c.autoPrice!=null ? {price:c.autoPrice,isAuto:c.isAuto} : null;
          updateCardPrice(card, c.steamPrice, ar); n++;
        });
        if (n) log(`从缓存恢复 ${n} 张`);
      }

      function enqueueNewCards() {
        const cards = document.querySelectorAll('.game-unit');
        let hits=0, news=0, rest=0;
        const cs = new Set(cards);
        for (const [pid,g] of productCardGroups) {
          const f = g.filter(i=>cs.has(i.card));
          if (!f.length) productCardGroups.delete(pid);
          else if (f.length!==g.length) productCardGroups.set(pid,f);
        }
        cards.forEach(card => {
          const id = card.getAttribute(cfg.cardIdAttr);
          if (!id) return;
          if (cfg.cardFilter && !cfg.cardFilter(card)) return;
          const pid = extractProductId(getCardProductUrl(card));
          if (!pid) return;
          if (!productCardGroups.has(pid)) productCardGroups.set(pid,[]);
          const g = productCardGroups.get(pid);
          if (!g.some(i=>i[cfg.cardIdKey]===id)) { const e={card}; e[cfg.cardIdKey]=id; g.push(e); }
          if (processedProducts.has(pid)) {
            const c = priceCache[pid];
            if (c && Date.now()-c.ts<CACHE_TTL) {
              const ar = c.autoPrice!=null ? {price:c.autoPrice,isAuto:c.isAuto} : null;
              updateCardPrice(card, c.steamPrice, ar); rest++;
            }
            return;
          }
          const c = priceCache[pid];
          if (c && Date.now()-c.ts<CACHE_TTL) {
            processedProducts.add(pid); hits++;
            const ar = c.autoPrice!=null ? {price:c.autoPrice,isAuto:c.isAuto} : null;
            g.forEach(({card:c2})=>updateCardPrice(c2,c.steamPrice,ar));
            return;
          }
          processedProducts.add(pid); pendingQueue.push({productId:pid}); news++;
        });
        for (let i=0;i<pendingQueue.length;i++) setGroupQueued(pendingQueue[i].productId, i+1);
        if (news||hits||rest) log(`缓存命中${hits} 恢复${rest} 新增${news} 队列${pendingQueue.length}`);
      }

      async function processQueue() {
        if (isProcessing) return;
        isProcessing = true;
        while (pendingQueue.length) {
          if (abortController.signal.aborted) { isProcessing = false; return; }
          const {productId} = pendingQueue.shift();
          setGroupFetching(productId);
          const sig = abortController.signal;
          try {
            const [sp,al] = await Promise.all([fetchSteamPrice(productId, sig), fetchAutoDeliveryPrice(productId, sig)]);
            cachePrice(productId, sp, al);
            updateRefreshBarCount();
            const g = productCardGroups.get(productId);
            if (g) g.forEach(({card})=>updateCardPrice(card,sp,al));
          } catch(err) {
            if (err.name === 'AbortError') { isProcessing = false; return; }
            warn(`处理失败(pid=${productId}):`,err.message);
            const g = productCardGroups.get(productId);
            if (g) g.forEach(({card})=>updateCardPrice(card,null,null));
          }
          if (pendingQueue.length) await new Promise(r=>setTimeout(r,REQUEST_INTERVAL));
        }
        isProcessing = false;
        updateRefreshBarCount();
      }

      function kickoff() { enqueueNewCards(); processQueue(); }

      // ======================== 刷新按钮 ========================
      function insertRefreshButton() {
        if (document.getElementById(cfg.REFRESH_BAR_ID)) return;
        const fc = document.querySelector('.game-unit');
        if (!fc || !fc.parentNode) { setTimeout(insertRefreshButton, REFRESH_RETRY_INT); return; }
        const cnt = Object.keys(priceCache).length;
        const bar = document.createElement('div');
        bar.id = cfg.REFRESH_BAR_ID;
        bar.className = cfg.REFRESH_BAR_CLASS;
        bar.innerHTML = `<span id="${cfg.CACHE_COUNT_ID}" class="${cfg.REFRESH_BAR_CACHE_CLASS}">${cnt?'已缓存'+cnt+'个道具':'暂无缓存数据'}</span><button id="${cfg.REFRESH_BTN_ID}" class="${cfg.REFRESH_BAR_BTN_CLASS}">🔄 刷新数据</button>`;
        fc.parentNode.insertBefore(bar, fc);
        document.getElementById(cfg.REFRESH_BTN_ID).addEventListener('click', onRefreshClick);
        log('刷新按钮已插入');
      }

      function updateRefreshBarCount() {
        const el = document.getElementById(cfg.CACHE_COUNT_ID);
        if (el) el.textContent = (()=>{const c=Object.keys(priceCache).length;return c?'已缓存'+c+'个道具':'暂无缓存数据';})();
      }

      function onRefreshClick() {
        const btn = document.getElementById(cfg.REFRESH_BTN_ID);
        if (!btn) return;
        btn.disabled = true; btn.textContent = '刷新中...';
        clearCache(); forceRefreshAll();
        function cd() {
          if (isProcessing||pendingQueue.length) { setTimeout(cd,500); return; }
          btn.disabled=false; btn.textContent='🔄 刷新数据'; updateRefreshBarCount();
        }
        setTimeout(cd, 2000);
      }

      // ======================== Observer ========================
      function _debouncedScan() {
        if (observerTimer) clearTimeout(observerTimer);
        observerTimer = setTimeout(()=>{
          insertRefreshButton(); injectAllCopyButtons(); enqueueNewCards(); processQueue();
        }, OBSERVER_DEBOUNCE);
      }

      function startObserver() {
        if (observer) return;
        observer = new MutationObserver(_debouncedScan);
        observer.observe(document.body, {childList:true, subtree:true});
      }

      function forceRefreshAll() {
        abortController.abort();
        abortController = new AbortController();
        processedProducts.clear(); productCardGroups.clear(); pendingQueue.length=0; isProcessing=false;
        document.querySelectorAll('.igxe-helper-price').forEach(el=>el.remove());
        insertRefreshButton(); injectAllCopyButtons(); kickoff();
      }

      // ======================== 磨损 & 名称 ========================
      const WEAR_MAP = {'崭新出厂':'崭新出厂','崭新':'崭新出厂','略有磨损':'略有磨损','略磨':'略有磨损','久经沙场':'久经沙场','久经':'久经沙场','破损不堪':'破损不堪','破损':'破损不堪','战痕累累':'战痕累累','战痕':'战痕累累'};
      function getWearText(card) {
        const keys=Object.keys(WEAR_MAP);
        for (const el of card.querySelectorAll('span,div,i,em,label,[class*="tag"],[class*="wear"],[class*="quality"]')) {
          const t=el.textContent.trim(), tip=el.getAttribute('title');
          if (tip) for (const k of keys) if (tip.includes(k)) return WEAR_MAP[k];
          for (const k of keys) if (t===k||t.includes(k)) return WEAR_MAP[k];
        }
        const w=document.createTreeWalker(card,NodeFilter.SHOW_TEXT); let n;
        while ((n=w.nextNode())) { const t=n.textContent.trim(); for (const k of keys) if (t===k) return WEAR_MAP[k]; }
        return null;
      }

      function getCardItemName(card) {
        const te = card.querySelector('.g_title'); if (!te) return null;
        let bn = null;
        const ta = te.getAttribute('title'); if (ta&&ta.trim()) bn=ta.trim();
        if (!bn) {
          for (const l of te.textContent.split(/[\r\n]+/)) {
            const t=l.trim(); if (t.length>2) { bn=t.replace(/\s*x\d+\s*/g,'').replace(/\s*[¥￥]\s*[\d.]+\s*/g,'').replace(/\s*在售\s*/g,'').trim(); break; }
          }
        }
        if (!bn) return null;
        const w = getWearText(card); if (w&&!bn.includes(w)) return `${bn} (${w})`;
        return bn;
      }

      // ======================== 搜索此物品按钮 ========================
      function injectCopyButton(card) {
        if (card.querySelector('.igxe-copy-btn')) return;
        const name = getCardItemName(card); if (!name) return;
        const btn = document.createElement('button');
        btn.className='igxe-copy-btn'; btn.title='搜索此物品'; btn.textContent='📋';
        btn.addEventListener('click', (e)=>{
          e.stopPropagation(); e.preventDefault();
          const ca = document.getElementById('js-check-all'); if (ca&&ca.checked) ca.click();
          const si=document.getElementById('store_search_key'), sb=document.getElementById('js-btn-search-key');
          if (si&&sb) {
            si.value=name;
            si.dispatchEvent(new Event('input',{bubbles:true})); si.dispatchEvent(new Event('change',{bubbles:true}));
            const h=sb.getAttribute('href'); if (h) sb.removeAttribute('href'); sb.click(); if (h) sb.setAttribute('href',h);
            setTimeout(()=>{ const c=document.getElementById('js-check-all'); if (c) c.click(); }, SEARCH_DELAY);
          }
          navigator.clipboard.writeText(name).catch(()=>{});
          btn.textContent='✓'; btn.classList.add('igxe-copied');
          setTimeout(()=>{ btn.textContent='📋'; btn.classList.remove('igxe-copied'); }, COPY_BTN_RESET);
        });
        card.style.position = card.style.position||'relative';
        card.appendChild(btn);
      }

      function injectAllCopyButtons() {
        document.querySelectorAll('.game-unit').forEach(card=>{
          if (!cfg.cardFilter || cfg.cardFilter(card)) injectCopyButton(card);
        });
      }

      // ======================== 弹窗注入 ========================
      function extractProductIdFromRow(row) {
        let pu=row.querySelector('[product-url]'); if (pu) { const i=extractProductId(pu.getAttribute('product-url')); if (i) return i; }
        for (const a of row.querySelectorAll(`a[href*="/product/${GAME_ID}/"]`)) { const i=extractProductId(a.getAttribute('href')); if (i) return i; }
        const dp=row.querySelector('[data-product-id],[data-pid]'); if (dp) return dp.getAttribute('data-product-id')||dp.getAttribute('data-pid');
        const tid=row.getAttribute('data-trade-id'); if (tid) for (const [pid,g] of productCardGroups) if (g.some(i=>i.tradeId===tid||i.pid===tid)) return pid;
        const pa=row.closest&&row.closest('[data-pid]'); if (pa) return pa.getAttribute('data-pid');
        return null;
      }

      function getRefPriceColumnIndex(modal) {
        for (const h of modal.querySelectorAll('th,[class*="header"],[class*="thead"] th,[class*="thead"] div'))
          if (h.textContent.trim()==='参考价') return Array.from(modal.querySelectorAll('th,[class*="header"]')).indexOf(h);
        return -1;
      }

      function findRefPriceCell(row, colIndex) {
        if (colIndex>=0) { const cs=row.querySelectorAll('td'); if (cs[colIndex]) return cs[colIndex]; }
        const r=row.querySelector('[class*="ref"],[class*="reference"]'); if (r) return r;
        for (const c of row.querySelectorAll('td,[class*="cell"],[class*="col"]')) {
          if (c.querySelector('input,textarea')) continue;
          const t=c.textContent.trim(); if (/^\d+(\.\d{1,2})?$/.test(t)) return c;
        }
        return null;
      }

      function injectPriceToCell(cell, productId) {
        const o=cell.querySelector('.igxe-modal-price'); if (o) o.remove();
        const c=priceCache[productId]; if (!c) return;
        const w=document.createElement('div'); w.className='igxe-modal-price';
        if (c.steamPrice!=null) w.innerHTML+=`<span class="igxe-modal-steam">Steam ¥${c.steamPrice.toFixed(2)}</span>`;
        if (c.autoPrice!=null) { const lb=c.isAuto?'自动':'底价', cl=c.isAuto?'igxe-modal-auto':'igxe-modal-lowest'; w.innerHTML+=`<span class="${cl}">${lb} ¥${c.autoPrice.toFixed(2)}</span>`; }
        else if (c.steamPrice==null) w.innerHTML+='<span class="igxe-modal-na">暂无数据</span>';
        cell.appendChild(w);
      }

      function injectModalPrices(modal, retries) {
        retries=retries||0;
        modal.querySelectorAll('.igxe-modal-price').forEach(el=>el.remove());
        const ci=getRefPriceColumnIndex(modal), rows=modal.querySelectorAll('tbody tr');
        if (!rows.length) {
          if (retries>=MODAL_RETRY_MAX) { log('弹窗重试超时'); return; }
          log(`弹窗未就绪,重试(${retries+1}/${MODAL_RETRY_MAX})...`);
          if (modalRetryTimer) clearTimeout(modalRetryTimer);
          modalRetryTimer=setTimeout(()=>injectModalPrices(modal,retries+1),MODAL_RETRY_INT);
          return;
        }
        if (modalRetryTimer) clearTimeout(modalRetryTimer);
        log(`弹窗注入: 列=${ci} 行=${rows.length}`);
        let n=0; rows.forEach(row=>{
          const pid=extractProductIdFromRow(row); if (!pid) return;
          const cell=findRefPriceCell(row,ci); if (!cell) return;
          if (!priceCache[pid]) return;
          injectPriceToCell(cell,pid); n++;
        });
        if (n) log(`弹窗注入 ${n} 个`);
      }

      function startModalWatcher() {
        const SELS=['.layui-layer','.el-dialog__body','.el-dialog','[role="dialog"]'];
        const ob=new MutationObserver(muts=>{
          for (const m of muts) for (const nd of m.addedNodes) {
            if (nd.nodeType!==1) continue;
            for (const s of SELS) {
              let mod=null;
              if (nd.matches&&nd.matches(s)) mod=nd;
              else if (nd.querySelector) mod=nd.querySelector(s);
              if (mod) { setTimeout(()=>injectModalPrices(mod),MODAL_DELAY); return; }
            }
          }
        });
        ob.observe(document.body,{childList:true,subtree:true});
        log('弹窗监视器就绪');
      }

      // ======================== 消息处理 ========================
      function handleMessage(msg, sender, sendResponse) {
        if (msg.type==='REFRESH_PRICES') { clearCache(); forceRefreshAll(); sendResponse({success:true}); return true; }
        if (msg.type==='PING') { sendResponse({alive:true}); return true; }
        return false;
      }

      // ======================== 返回 API ========================
      return {
        loadCache, setPriceCache: (c)=>{priceCache=c;}, clearCache, cachePrice,
        applyCacheToCards, enqueueNewCards, processQueue, kickoff,
        insertRefreshButton, updateRefreshBarCount, onRefreshClick,
        injectCopyButton, injectAllCopyButtons,
        getCardItemName, getWearText,
        extractProductIdFromRow, getRefPriceColumnIndex, findRefPriceCell, injectPriceToCell,
        injectModalPrices, startModalWatcher,
        startObserver, forceRefreshAll, handleMessage,
        updateCardPrice,
        // 状态访问
        get priceCache() { return priceCache; },
        get pendingQueue() { return pendingQueue; },
        get isProcessing() { return isProcessing; },
      };
    }
  };
})(window);
