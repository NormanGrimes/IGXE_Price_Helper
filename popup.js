// IGXE Price Helper - Popup 界面逻辑

document.addEventListener('DOMContentLoaded', () => {
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const refreshBtn = document.getElementById('refreshBtn');

  function setStatus(ok, text) {
    statusDot.style.background = ok ? '#4caf50' : '#666';
    statusText.textContent = text;
  }

  // 两步检测：先看 URL，再 ping content script 确认已注入
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab || !tab.url || !tab.url.includes('igxe.cn/inventory')) {
      setStatus(false, '请打开饰品库存页面');
      return;
    }

    setStatus(false, '检测中...');

    // ping content script 确认已注入
    chrome.tabs.sendMessage(tab.id, { type: 'PING' }, (response) => {
      if (chrome.runtime.lastError) {
        setStatus(false, '页面加载中，请稍后再试');
      } else {
        setStatus(true, '库存页已就绪');
      }
    });
  });

  refreshBtn.addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab || !tab.id) return;

      chrome.tabs.sendMessage(tab.id, { type: 'REFRESH_PRICES' }, (response) => {
        if (chrome.runtime.lastError) {
          setStatus(false, '请先打开饰品库存页');
        } else {
          setStatus(true, '正在刷新价格...');
        }
      });
    });
  });
});
