// IGXE Price Helper - Background Service Worker
// Steam 价格已迁移至 content-inventory.js 直接 fetch（页面上下文，避免 SW 超时）
// 此文件仅保留旧消息类型兼容（FETCH_SINGLE_PRICE / FETCH_PRICES）

const CACHE_TTL = 5 * 60 * 1000;
const steamCache = new Map();

/**
 * 从产品详情页 HTML 提取 Steam 参考价
 */
async function fetchSteamPrice(productId) {
  try {
    const resp = await fetch(`https://www.igxe.cn/product/730/${productId}`, {
      credentials: 'include'
    });
    const html = await resp.text();

    const match = html.match(/Steam参考价[^<]*<span[^>]*class="c-4"[^>]*>[^<]*<sub>[^<]*<\/sub>\s*([\d.]+)/);
    if (match) return parseFloat(match[1]);

    const alt = html.match(/starting-price[^<]*<span[^>]*class="c-4"[^>]*>[^<]*<sub>[^<]*<\/sub>\s*([\d.]+)/);
    if (alt) return parseFloat(alt[1]);

    return null;
  } catch (err) {
    console.warn(`[IGXE-BG] Steam价格获取失败 (pid=${productId}):`, err.message);
    return null;
  }
}

// 监听消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'FETCH_STEAM_PRICE') {
    const { productId } = message;

    // 查缓存
    const cached = steamCache.get(productId);
    if (cached && (Date.now() - cached.time < CACHE_TTL)) {
      sendResponse({ success: true, steamPrice: cached.price });
      return false;
    }

    fetchSteamPrice(productId).then(price => {
      if (price !== null) {
        steamCache.set(productId, { price, time: Date.now() });
      }
      sendResponse({ success: true, steamPrice: price });
    }).catch(err => {
      sendResponse({ success: false, steamPrice: null, error: err.message });
    });
    return true; // 异步
  }

  // 兼容旧消息类型（只返回 Steam 价格）
  if (message.type === 'FETCH_SINGLE_PRICE') {
    const { productId } = message;
    getProductPrices(productId).then(data => {
      sendResponse({ success: true, data });
    }).catch(err => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }

  if (message.type === 'FETCH_PRICES') {
    const { productIds } = message;
    Promise.all(productIds.map(id =>
      getProductPrices(id).catch(err => ({ steamPrice: null, autoLowest: null, error: err.message }))
    )).then(all => {
      const results = {};
      productIds.forEach((id, i) => { results[id] = all[i]; });
      sendResponse({ success: true, data: results });
    }).catch(err => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }
});

// 兼容：旧 getProductPrices 只返回 steamPrice
async function getProductPrices(productId) {
  const price = await fetchSteamPrice(productId);
  return { steamPrice: price, autoLowest: null };
}

console.log('[IGXE-BG] Service Worker 已启动 (仅负责Steam参考价)');
