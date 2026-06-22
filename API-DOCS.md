# IGXE 上架 API 文档
> 从 `饰品库存.html` 静态页面逆向分析，适用于 v1.0.6 开发参考

---

## 上架流程概览

```
用户勾选饰品 → 点击"上架"按钮
  → checkPurchase()     → POST /dmall/seller/check-purchase-before-add-product
  → (若有高价求购)      → POST /purchase/confirm_sell
  → submit_sale()       → POST /dmall/seller/add_product
```

---

## API 1: 前置检查 — 求购匹配

`POST /dmall/seller/check-purchase-before-add-product`

**触发时机**：用户点击确认上架前，检查是否有买家求购价高于当前定价

**请求参数**（`param`）：
| 参数 | 类型 | 说明 |
|------|------|------|
| `data` | string (JSON) | 商品数据 JSON 字符串 |
| `type` | int | `1`=标品，`2`=非标 |
| `is_standard` | bool | `true`=标品，`false`=非标 |
| `is_merge` | bool | 是否合并上架（从 checkbox 读取） |
| `count` | int | 商品数量 |
| `total_price` | float | 总价 |

**响应**：
```json
// 成功，无高价求购
{ "succ": true, "data": null }

// 成功，有高价求购
{
  "succ": true,
  "data": [
    {
      "steam_pid": "50740375334",
      "purchase_price": 16.50,
      ...
    }
  ]
}
```

**前端处理**：有 `res.data` 时弹提示"有买家求购的价格高于您的定价，可直接供应"，并在对应卡片显示求购按钮。

---

## API 2: 确认上架（求购匹配）

`POST /purchase/confirm_sell`

**触发时机**：用户选择"继续上架"或高价值（≥2000）饰品直接供应

**请求参数**：
| 参数 | 类型 | 说明 |
|------|------|------|
| `stock_steam_uid` | string | bot 的 steam uid |
| `purchase_id` | string | 求购 ID |
| `sale_type` | int | `2` |
| `ids` | string (JSON数组) | `["steam_pid"]` |
| `csrfmiddlewaretoken` | string | CSRF token |
| `password` | string (可选) | AES 加密的交易密码，单价 ≥2000 且自动发货时必填 |

**密码加密**：`encryptAES(pwd, cryptoKey)` — 使用前端 AES 加密

**响应**：
```json
{ "succ": true, "message": "上架成功" }
```

---

## API 3: 实际上架

`POST /dmall/seller/add_product`

**触发时机**：前置检查通过后（或有求购匹配但用户选择继续上架）

**请求参数**（`request_param`）：
| 参数 | 类型 | 说明 |
|------|------|------|
| `data` | string (JSON) | 商品数据 JSON 字符串 |
| `standard_data` | Array | 标品数据（type=1 时使用，目前为空数组） |
| `type` | int | `1`=标品，`2`=非标 |
| `is_standard` | bool | `true`=标品 |
| `is_merge` | bool | 是否合并上架 |
| `count` | int | 商品数量 |
| `total_price` | float | 总价 |

**`data` 字段详解**（每个商品的完整字段）：
| 字段 | 类型 | 说明 |
|------|------|------|
| `market_name` | string | 饰品市场名称，如 `AWP \| 响尾蛇` |
| `steam_pid` | string | Steam 产品 ID |
| `product_id` | string | IGXE 产品 ID |
| `unit_price` | string | 用户设定的售价（字符串，保留2位小数） |
| `real_price` | string | 扣除手续费后的实际收入 |
| `reference_price` | float | 参考价（Steam参考价） |
| `fee_rate` | float | 手续费率 |
| `remark` | string | 备注/描述 |
| `wear` | string | 磨损值（如 `0.152348` ） |
| `min_price` | string | 最低价 |
| `exterior_name` | string | 外观名称（如 `略磨`） |
| `point_price` | float | 点数价格（警戒值计算用） |
| `fix_price` | string | 固定价格 |
| `is_weapon` | bool | 是否武器 |
| `icon_url` | string | 图标 URL |
| `sale_qty` | int/string | 在售数量 |
| `stickers` | Array | 贴纸信息（可为空数组） |

**请求示例**：
```javascript
$.ajax({
  type: "POST",
  url: "/dmall/seller/add_product",
  data: {
    data: JSON.stringify([{ market_name: "...", steam_pid: "50740375334", unit_price: "14.40", ... }]),
    type: 2,
    is_standard: false,
    is_merge: false,
    count: 1,
    total_price: 14.40
  },
  dataType: "json"
})
```

**响应**：
```json
// 全部成功
{ "succ": true, "message": "上架成功", "is_show_tip": false }

// 部分成功（有价格错误）
{
  "succ": true,
  "succ_size": 3,
  "error_list": [
    { "market_name": "AK-47 | 红线", "error": "价格低于最低价限制" }
  ]
}

// 失败
{ "succ": false, "message": "错误信息", "code": 1001, "on_line": false }
```

**错误码**：
| code | 处理 |
|------|------|
| `1001` | 显示 `#msg-1` 的 HTML 内容 |
| `1002` | 显示 `#msg-2` 的 HTML 内容 |
| 其他 | 直接 `layer.confirm(msg)` |

**`on_line: true`** 时提示：CSGO挂售模式维护中，建议使用IGXE卖家助手或IGB饰品支付

---

## 辅助 API

### `POST /dmall/seller/query_steam_data`
获取 Steam 库存数据（页面初始化时调用）

### `GET /api/v2/product/product-search-condition/{product_id}`
获取产品的搜索条件（磨损列表、样式列表等）

### `GET /api/v2/lease/trade-list/730/{product_id}`
获取租赁在售列表

---

## 前端流程关键变量

- `temp_data`：Steam 库存原始数据数组，每个元素包含 `steam_pid`、`reference_price`、`market_name` 等
- `sale_datas`：本次要上架的 `steam_pid` 去重数组
- `max_sale_num`：单次最多上架数量（页面定义）
- `flag`：是否为标品模式（`true` = 标品）
- `shop_close`：店铺状态

---

*文档生成时间：2026-06-10*
*来源：`C:/Users/weie/Desktop/饰品库存.html`*
