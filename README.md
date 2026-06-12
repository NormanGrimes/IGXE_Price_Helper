# IGXE Price Helper v1.0.3

在 IGXE 饰品库存页（`/inventory/skins/730`）和我的在架页（`/sell/730`）自动展示 Steam 参考价和自动发货最低价。

---

## 功能特性

- 自动在每张饰品卡片下方显示 **Steam 参考价**
- 自动显示 **自动发货最低价**（无自动发货商品时显示全部在售底价）
- 📋 每张卡片右上角悬浮 **复制按钮**，点击复制物品完整名称（含磨损值）到剪贴板
- 同款道具按 `productId` 去重，只请求一次，所有同名卡片同步更新
- 逐个请求，间隔 3 秒，获取后立即显示，支持滚动懒加载
- 切换 Steam 账号（Bot ID）时自动清空并重新获取
- 内置 5 分钟 Steam 价格缓存，减少重复请求
- 弹窗界面可手动触发重新获取

---

## 安装方法

1. 打开 Chrome / Edge → 扩展程序管理页面
   - Chrome：`chrome://extensions`
   - Edge：`edge://extensions`
2. 右上角开启 **开发者模式**
3. 点击 **加载已解压的扩展程序**
4. 选择 `igxe-price-helper` 目录
5. 确认扩展已启用

> 首次安装需准备图标文件：在 `igxe-price-helper/icons/` 目录下放置 `icon16.png`、`icon48.png`、`icon128.png`。

---

## 使用方法

1. 登录 [igxe.cn](https://www.igxe.cn)
2. 打开 **饰品库存页**（`/inventory/skins/730`）或 **我的在架页**（`/sell/730`）
3. 插件自动扫描卡片，排队逐张获取价格
4. 每张卡片下方显示市场参考价格标签
5. 点击弹窗中的 **重新获取价格** 可强制刷新

---

## 价格标签含义

| 标签 | 颜色 | 含义 |
|------|------|------|
| `Steam ¥XX.XX` | 灰色 | Steam 参考价，来自 IGXE 产品页 |
| `自动 ¥XX.XX` | 绿色 | 自动发货最低价（`buy_method=1`） |
| `底价 ¥XX.XX` | 橙色 | 无自动发货商品时，显示全部在售最低价（fallback） |
| `当前无在售` | 红色 | 平台无在售商品，无自动发货/底价数据 |
| `暂无数据` | 浅灰 | 两项价格均获取失败 |

---

## 调试日志

插件在浏览器 Console 输出详细日志，方便排查问题。打开方式：

1. 在库存页按 `F12` 打开 DevTools
2. 切换到 **Console** 面板
3. 筛选 `[IGXE]` 前缀的日志

### 日志说明

| 日志 | 含义 |
|------|------|
| `[IGXE-Helper] 新增 N 种道具入队，队列长度 M` | 扫描到新卡片并入队 |
| `[IGXE] 请求自动发货API url=...` | 发出的自动发货 API 请求 URL |
| `[IGXE] 自动发货API 响应前缀: ...` | API 响应前 80 字符，确认是否为 JSON |
| `[IGXE] 自动发货API 返回结构: ...` | 响应数据结构（d_list 类型、page_rows 长度） |
| `[IGXE] 自动发货 page_rows (pid=XXX): ¥XX` | 从 `page_rows` 解析到自动发货最低价 |
| `[IGXE] 自动发货 d_list (pid=XXX): ¥XX` | 从 `d_list` 解析到最低价（罕见路径） |
| `[IGXE] 底价 page_rows (pid=XXX): ¥XX` | Fallback：全部在售商品最低价 |
| `[IGXE-Helper] 检测到账号切换: A → B` | Steam Bot 账号切换，触发全量刷新 |
| `[IGXE-BG] Service Worker 已启动` | 后台 Service Worker 加载成功 |

---

## 文件结构

```
igxe-price-helper/
├── manifest.json         ← MV3 配置（版本号、权限、注入规则）
├── background.js         ← Service Worker（兼容旧消息接口）
├── content-inventory.js  ← 库存页注入脚本
├── content-sell.js       ← 在售页注入脚本
├── injected.css          ← 注入样式（价格标签颜色/布局）
├── popup.html            ← 扩展弹窗界面
├── popup.js              ← 弹窗逻辑（状态检测、刷新按钮）
├── README.md
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## 技术说明

### API 参数

自动发货价格通过 IGXE 内部 API 获取：

```
GET /product/trade/730/{productId}?buy_method={0,1,2}&sort=0&sort_rule=0
```

| buy_method | 含义 |
|------------|------|
| `0` | 全部商品 |
| `1` | ✅ 自动发货（插件使用此值） |
| `2` | 非自动发货（手动发货） |

### 响应结构

```json
{
  "succ": true,
  "d_list": { "...": "..." },
  "page": {
    "page_rows": [ { "unit_price": 0.39, "...": "..." } ],
    "total": 2,
    "page_no": 1
  }
}
```

- `d_list`：筛选器元数据（object，非数组）
- `page.page_rows`：商品列表数组，每条含 `unit_price` 字段
- 价格字段名为 `unit_price`（非 `price`）

### 架构

| 页面 | 脚本 | 卡片选择器 | 分页方式 | Bot 过滤 |
|------|------|-----------|----------|----------|
| 库存页 `/inventory/skins/730` | `content-inventory.js` | `.game-unit` + `data-pid` | 滚动懒加载 | ✅ 仅当前 Bot |
| 在售页 `/sell/730` | `content-sell.js` | `.game-unit` + `data-trade-id` | `#js-load-more` 点击 | ❌ 全部 Bot |

| 数据 | 请求位置 | 方式 |
|------|----------|------|
| Steam 参考价 | 页面上下文 | fetch 产品页 HTML → 正则提取 |
| 自动发货最低价 | 页面上下文 | fetch API → 解析 `page_rows` |

所有请求在页面上下文直接执行，天然携带 Cookie，避免 Chrome MV3 Service Worker 生命周期超时。

---

## 版本记录

### v1.0.3 — 2026-06-05

- ✅ **新功能**：每张卡片右上角添加 📋 **复制按钮**，点击复制物品完整名称（含磨损值）到剪贴板
  - 按钮 hover 时浮现，点击后显示 ✓ 反馈 1.2 秒
  - 名称格式：`武器名 | 皮肤名 (磨损值)`，如 `P90 | 擦擦 (崭新出厂)`
  - 支持磨损缩写映射（崭新 → 崭新出厂，略磨 → 略有磨损 等）
- ✅ **修复**：复制按钮在在售页不可点击 → 添加 `pointer-events: auto !important` + z-index 提升
- ✅ **修复**：复制内容含 `x1`、`¥`、`在售` 等杂质 → 多策略名称提取：`title` 属性优先 → textContent 按行拆分 → 正则清洗
- ✅ **修复**：复制内容缺少磨损值 → `getWearText()` 遍历卡片 DOM 提取磨损标签
- ✅ **优化**：无在售数据显示从灰色 `-` 改为红色 **「当前无在售」**
- ✅ **样式**：`.igxe-helper-na` / `.igxe-modal-na` 颜色 `#555`/`#aaa` → `#e53935`（红色）
- ✅ **修复**：贩卖总数变化监测不显示差值 → `getSellTotalInfo()` 正则匹配修复
  - IGXE 页面数字在独立 `<span>` 中（如 `贩卖总数：<span>2526</span>`），与标签文字不在同一 textNode
  - 改为取父元素完整 `textContent` 做正则匹配，覆盖跨元素行内数字场景

### v1.0.2 — 2026-06-05

- ✅ **新功能**：支持「我的在架」页面（`https://www.igxe.cn/sell/730`）
  - 独立内容脚本 `content-sell.js`，复用价格获取逻辑
  - 适配在售页卡片结构：`.put-sell-item.game-unit` + `data-trade-id`
  - 拦截 `#js-load-more` 点击分页，自动扫描新加载卡片
  - 无需 Bot 账号过滤（在售页展示所有 Bot 物品）
- ✅ `popup.js` 弹窗支持双重 URL 检测（`/inventory` + `/sell`）
- ✅ `popup.html` 界面文案更新

### v1.0.1（正式版）— 2026-06-05

- ✅ 修正 `buy_method` 参数：`0` → `1`（正确筛选自动发货商品）
- ✅ 新增 Fallback 逻辑：无自动发货商品时显示「底价 ¥XX」（橙色）
- ✅ 新增详细调试日志（Console 可查看 API 请求/响应结构）
- ✅ 完善 `popup.js` 状态检测逻辑（先检测 URL，再 ping content script）
- ✅ 修复 `background.js` 中 `fetchSteamPrice` 与 `getProductPrices` 并存导致的混淆
- ✅ 价格字段统一使用 `unit_price`（覆盖 `price` 兜底）

### v1.0.0（测试版）— 2026-06-04

- 初始版本，实现基本价格展示功能
- 已知问题：`buy_method` 参数错误，获取的为全部商品最低价

---

## 已知限制

- 需要登录 IGXE 账号才能获取完整价格数据
- 仅支持 CS2 库存页（`/inventory/skins/730`）和我的在架页（`/sell/730`）

---

## License

MIT
