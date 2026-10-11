# akbot API 文档

> 自动从 `docs/akbot_api.html` 转换（Apifox Swagger UI 导出 → OpenAPI 3.0.1）
> 基础 URL: `https://api.akbot.pro/api`
> 生成日期: 2026-10-11

## 鉴权

所有接口都通过 `x-api-key` 请求头鉴权。

| Header | 必填 | 示例 |
|---|---|---|
| `x-api-key` | 是 | `oFmk0_Qmuthni7uA2r4I09P352q468vl5nK43HF-HUY` |

## 标签分组

- `NEW_AK_BOT_全局_配置`
- `NEW_AK_BOT_配置`
- `标签_配置`

## 接口列表

### NEW_AK_BOT_全局_配置

#### `GET /akBot/get/globalConfig`

**获取全局配置**


**Headers**

| 名称 | 必填 | 类型 | 默认 | 说明 |
|---|---|---|---|---|
| `x-api-key` | ✓ | string | `"oFmk0_Qmuthni7uA2r4I09P352q468vl5nK43HF-HUY"` |  |

**Response 200**

Schema: `ResponseDTOAkGlobalConfig`

```json
{
  "code": 0,
  "level": "",
  "msg": "",
  "ok": false,
  "data": {
    "userId": 0,
    "walletNote": "",
    "walletPubKey": "",
    "walletPrivateKey": "",
    "sellTip": 0,
    "sellGas": 0,
    "privateAccount": "",
    "privateProgram": "",
    "usdcMode": 0,
    "usd1Mode": 0,
    "globalSwitch": 0,
    "updateTime": ""
  },
  "dataType": 0
}
```

---

#### `POST /akBot/update/globalConfig/wallet`

**导入钱包保存全局配置**


**Headers**

| 名称 | 必填 | 类型 | 默认 | 说明 |
|---|---|---|---|---|
| `x-api-key` | ✓ | string | `"oFmk0_Qmuthni7uA2r4I09P352q468vl5nK43HF-HUY"` |  |

**Request Body** (application/json)

Schema: `AkGlobalConfig`

**Response 200**

Schema: `ResponseDTOString`

```json
{
  "code": 0,
  "level": "",
  "msg": "",
  "ok": false,
  "data": "",
  "dataType": 0
}
```

---

#### `POST /akBot/update/globalConfig`

**更新全局配置**

保存全局配置


**Headers**

| 名称 | 必填 | 类型 | 默认 | 说明 |
|---|---|---|---|---|
| `x-api-key` | ✓ | string | `"oFmk0_Qmuthni7uA2r4I09P352q468vl5nK43HF-HUY"` |  |

**Request Body** (application/json)

Schema: `AkGlobalConfig`

Example:

```json
{
  "innerStatus": 1,
  "outerStatus": 1,
  "singleBuy": 1,
  "singleBuyNum": 1,
  "walletNote": "大吉大利",
  "walletPrivateKey": "Jeg5P5a4hx51z3ePfA2XZMbGQmoDmV67PUCgD4Zqhy3yfAz3A8tmywSc2DXWBtTmRkWt6DuW3YyKbMJZD25WKAt",
  "walletMinSol": 1.1,
  "walletSupplySol": 4.1,
  "minBalanceStop": 1.3,
  "top10Limit": 80.5,
  "openDelay": 0,
  "devSellSwitch": 1,
  "devLiquidateRatio": 80.5,
  "devSelfSellRatio": 50.5
}
```

**Response 200**

Schema: `ResponseDTOString`

```json
{
  "code": 0,
  "level": "",
  "msg": "",
  "ok": false,
  "data": "",
  "dataType": 0
}
```

---

### NEW_AK_BOT_配置

#### `POST /akBot/list`

**查询akBot配置**

不分页查询akBot配置


**Headers**

| 名称 | 必填 | 类型 | 默认 | 说明 |
|---|---|---|---|---|
| `x-api-key` | ✓ | string | `"oFmk0_Qmuthni7uA2r4I09P352q468vl5nK43HF-HUY"` |  |

**Request Body** (application/json)

Schema: `AkBotListQQ`

**Response 200**

Schema: `ResponseDTOListAkBotListDTO`

```json
{
  "code": 0,
  "level": "",
  "msg": "",
  "ok": false,
  "data": [
    {
      "akCommonConfig": {
        "idConfig": 0,
        "enableSwitch": 0,
        "userId": 0,
        "copyAddressNote": "",
        "groupSlippageMultiple": 0,
        "platform": "",
        "firstPurchaseSwitch": 0,
        "positionFollowSwitch": 0,
        "followSellPctMode": 0,
        "followClearPct": 0,
        "stopFollowSwitch": 0,
        "blockCount": 0,
        "stopFollowSecond": 0,
        "onlyDevSwitch": 0,
        "mayhemSwitch": 0,
        "addressBlacklist": "",
        "quickSellSwitch": 0,
        "quickSellMs": 0,
        "quickSellPct": 0,
        "stopFollowTimes": 0,
        "drawdownPctSwitch": 0,
        "drawdownPct": 0,
        "drawdownActivateTarget": 0,
        "copyMinAmount": 0,
        "copyMaxAmount": 0,
        "updateTime": "",
        "pinTopTime": "",
        "akCopyAddresses": [
          {
            "idAddress": 0,
            "idConfig": 0,
            "userId": 0,
            "copyAddress": "",
            "orderNum": 0
          }
        ],
        "akConfigLabels": [
          {
            "idConfigLabel": 0,
            "userId": 0,
            "idLabel": 0,
            "labelName": "",
            "idConfig": 0
          }
        ]
      },
      "akBuyDetails": [
        {
          "idDetail": 0,
          "userId": 0,
          "idConfig": 0,
          "buyMode": 0,
          "buyAmount": 0,
          "marketValueMin": 0,
          "marketValueMax": 0,
          "tipFee": 0,
          "gasFee": 0,
          "slippageBuy": 0,
          "slippageMode": 0,
          "highGasMode": 0,
          "highGas": 0,
          "highGasTip": 0,
          "highGasSlippage": 0,
          "orderNum": 0
        }
      ],
      "akProfitTpSegments": [
        {
          "idSegment": 0,
          "userId": 0,
          "idConfig": 0,
          "segmentOrder": 0,
          "triggerPct": 0,
          "sellPct": 0,
          "timeOutSwitch": 0,
          "timeOutStamp": 0,
          "timeoutAtTriggerPct": 0
        }
      ],
      "akLossSegments": [
        {
          "idLoss": 0,
          "userId": 0,
          "idConfig": 0,
          "segmentOrder": 0,
          "triggerPct": 0,
          "sellPct": 0
        }
      ]
    }
  ],
  "dataType": 0
}
```

---

#### `POST /akBot/add`

**添加akBot配置**


**Headers**

| 名称 | 必填 | 类型 | 默认 | 说明 |
|---|---|---|---|---|
| `x-api-key` | ✓ | string | `"oFmk0_Qmuthni7uA2r4I09P352q468vl5nK43HF-HUY"` |  |

**Request Body** (application/json)

Schema: `AkBotAddDTO`

**Response 200**

Schema: `ResponseDTOInteger`

```json
{
  "code": 0,
  "level": "",
  "msg": "",
  "ok": false,
  "data": 0,
  "dataType": 0
}
```

---

#### `POST /akBot/update`

**更新akBot配置**


**Headers**

| 名称 | 必填 | 类型 | 默认 | 说明 |
|---|---|---|---|---|
| `x-api-key` | ✓ | string | `"oFmk0_Qmuthni7uA2r4I09P352q468vl5nK43HF-HUY"` |  |

**Request Body** (application/json)

Schema: `AkBotAddDTO`

**Response 200**

Schema: `ResponseDTOString`

```json
{
  "code": 0,
  "level": "",
  "msg": "",
  "ok": false,
  "data": "",
  "dataType": 0
}
```

---

#### `POST /akBot/copy/config`

**复制akBot配置**


**Headers**

| 名称 | 必填 | 类型 | 默认 | 说明 |
|---|---|---|---|---|
| `x-api-key` | ✓ | string | `"oFmk0_Qmuthni7uA2r4I09P352q468vl5nK43HF-HUY"` |  |

**Request Body** (application/json)

Schema: `AkBotCopyDTO`

**Response 200**

Schema: `ResponseDTOString`

```json
{
  "code": 0,
  "level": "",
  "msg": "",
  "ok": false,
  "data": "",
  "dataType": 0
}
```

---

#### `POST /akBot/switch/config`

**批量开关akBot配置**


**Headers**

| 名称 | 必填 | 类型 | 默认 | 说明 |
|---|---|---|---|---|
| `x-api-key` | ✓ | string | `"oFmk0_Qmuthni7uA2r4I09P352q468vl5nK43HF-HUY"` |  |

**Request Body** (application/json)

Schema: `AkBotSwitchDTO`

**Response 200**

Schema: `ResponseDTOString`

```json
{
  "code": 0,
  "level": "",
  "msg": "",
  "ok": false,
  "data": "",
  "dataType": 0
}
```

---

#### `POST /akBot/delete/v2`

**通过ids删除详细配置(v2)**


**Headers**

| 名称 | 必填 | 类型 | 默认 | 说明 |
|---|---|---|---|---|
| `x-api-key` | ✓ | string | `"oFmk0_Qmuthni7uA2r4I09P352q468vl5nK43HF-HUY"` |  |

**Request Body** (application/json)

Schema: `inline`

Example:

```json
[
  24,
  30
]
```

**Response 200**

Schema: `ResponseDTOAkBotAddDTO`

```json
{
  "code": 0,
  "level": "",
  "msg": "",
  "ok": false,
  "data": {
    "akCommonConfig": {
      "idConfig": 0,
      "enableSwitch": 0,
      "copyAddressNote": "",
      "groupSlippageMultiple": 0,
      "platform": "",
      "firstPurchaseSwitch": 0,
      "positionFollowSwitch": 0,
      "followSellPctMode": 0,
      "followClearPct": 0,
      "stopFollowSwitch": 0,
      "blockCount": 0,
      "stopFollowSecond": 0,
      "onlyDevSwitch": 0,
      "mayhemSwitch": 0,
      "addressBlacklist": "",
      "quickSellSwitch": 0,
      "quickSellMs": 0,
      "quickSellPct": 0,
      "stopFollowTimes": 0,
      "drawdownPctSwitch": 0,
      "drawdownPct": 0,
      "drawdownActivateTarget": 0,
      "copyMinAmount": 0,
      "copyMaxAmount": 0,
      "akCopyAddresses": [
        {
          "idAddress": 0,
          "idConfig": 0,
          "userId": 0,
          "copyAddress": "",
          "orderNum": 0
        }
      ],
      "akConfigLabels": [
        {
          "idConfigLabel": 0,
          "userId": 0,
          "idLabel": 0,
          "labelName": "",
          "idConfig": 0
        }
      ]
    },
    "akProfitTpSegments": [
      {
        "idSegment": 0,
        "userId": 0,
        "idConfig": 0,
        "segmentOrder": 0,
        "triggerPct": 0,
        "sellPct": 0,
        "timeOutSwitch": 0,
        "timeOutStamp": 0,
        "timeoutAtTriggerPct": 0
      }
    ],
    "akLossSegments": [
      {
        "idLoss": 0,
        "userId": 0,
        "idConfig": 0,
        "segmentOrder": 0,
        "triggerPct": 0,
        "sellPct": 0
      }
    ],
    "akBuyDetails": [
      {
        "idDetail": 0,
        "userId": 0,
        "idConfig": 0,
        "buyMode": 0,
        "buyAmount": 0,
        "marketValueMin": 0,
        "marketValueMax": 0,
        "tipFee": 0,
        "gasFee": 0,
        "slippageBuy": 0,
        "slippageMode": 0,
        "highGasMode": 0,
        "highGas": 0,
        "highGasTip": 0,
        "highGasSlippage": 0,
        "orderNum": 0
      }
    ]
  },
  "dataType": 0
}
```

---

#### `GET /akBot/getConfigDetail`

**获取详细配置**


**Headers**

| 名称 | 必填 | 类型 | 默认 | 说明 |
|---|---|---|---|---|
| `x-api-key` | ✓ | string | `"oFmk0_Qmuthni7uA2r4I09P352q468vl5nK43HF-HUY"` |  |

**Query 参数**

| 名称 | 位置 | 必填 | 类型 | 默认 | 说明 |
|---|---|---|---|---|---|
| `idConfig` | query | ✓ | integer | - |  |

**Response 200**

Schema: `ResponseDTOAkBotListDTO`

```json
{
  "code": 0,
  "level": "",
  "msg": "",
  "ok": false,
  "data": {
    "akCommonConfig": {
      "idConfig": 0,
      "enableSwitch": 0,
      "userId": 0,
      "copyAddressNote": "",
      "groupSlippageMultiple": 0,
      "platform": "",
      "firstPurchaseSwitch": 0,
      "positionFollowSwitch": 0,
      "followSellPctMode": 0,
      "followClearPct": 0,
      "stopFollowSwitch": 0,
      "blockCount": 0,
      "stopFollowSecond": 0,
      "onlyDevSwitch": 0,
      "mayhemSwitch": 0,
      "addressBlacklist": "",
      "quickSellSwitch": 0,
      "quickSellMs": 0,
      "quickSellPct": 0,
      "stopFollowTimes": 0,
      "drawdownPctSwitch": 0,
      "drawdownPct": 0,
      "drawdownActivateTarget": 0,
      "copyMinAmount": 0,
      "copyMaxAmount": 0,
      "updateTime": "",
      "pinTopTime": "",
      "akCopyAddresses": [
        {
          "idAddress": 0,
          "idConfig": 0,
          "userId": 0,
          "copyAddress": "",
          "orderNum": 0
        }
      ],
      "akConfigLabels": [
        {
          "idConfigLabel": 0,
          "userId": 0,
          "idLabel": 0,
          "labelName": "",
          "idConfig": 0
        }
      ]
    },
    "akBuyDetails": [
      {
        "idDetail": 0,
        "userId": 0,
        "idConfig": 0,
        "buyMode": 0,
        "buyAmount": 0,
        "marketValueMin": 0,
        "marketValueMax": 0,
        "tipFee": 0,
        "gasFee": 0,
        "slippageBuy": 0,
        "slippageMode": 0,
        "highGasMode": 0,
        "highGas": 0,
        "highGasTip": 0,
        "highGasSlippage": 0,
        "orderNum": 0
      }
    ],
    "akProfitTpSegments": [
      {
        "idSegment": 0,
        "userId": 0,
        "idConfig": 0,
        "segmentOrder": 0,
        "triggerPct": 0,
        "sellPct": 0,
        "timeOutSwitch": 0,
        "timeOutStamp": 0,
        "timeoutAtTriggerPct": 0
      }
    ],
    "akLossSegments": [
      {
        "idLoss": 0,
        "userId": 0,
        "idConfig": 0,
        "segmentOrder": 0,
        "triggerPct": 0,
        "sellPct": 0
      }
    ]
  },
  "dataType": 0
}
```

---

### 标签_配置

#### `GET /akBot/get/getLabels`

**获取标签**


**Headers**

| 名称 | 必填 | 类型 | 默认 | 说明 |
|---|---|---|---|---|
| `x-api-key` | ✓ | string | `"oFmk0_Qmuthni7uA2r4I09P352q468vl5nK43HF-HUY"` |  |

**Response 200**

Schema: `ResponseDTOListAkLabel`

```json
{
  "code": 0,
  "level": "",
  "msg": "",
  "ok": false,
  "data": [
    {
      "idLabel": 0,
      "userId": 0,
      "labelName": ""
    }
  ],
  "dataType": 0
}
```

---

#### `POST /akBot/update/labels`

**更新标签**


**Headers**

| 名称 | 必填 | 类型 | 默认 | 说明 |
|---|---|---|---|---|
| `x-api-key` | ✓ | string | `"oFmk0_Qmuthni7uA2r4I09P352q468vl5nK43HF-HUY"` |  |

**Request Body** (application/json)

Schema: `inline`

Example:

```json
[
  {
    "labelName": "测试标签 1"
  },
  {
    "labelName": "测试标签 2"
  },
  {
    "labelName": "测试标签 3"
  }
]
```

**Response 200**

Schema: `ResponseDTOString`

```json
{
  "code": 0,
  "level": "",
  "msg": "",
  "ok": false,
  "data": "",
  "dataType": 0
}
```

---

## 数据模型 (components/schemas)

### `AkBotAddDTO`


| 字段 | 类型 | 必填 | 默认 | 范围 | 说明 |
|---|---|---|---|---|---|
| `akCommonConfig` | [AkCommonConfigADD] | ✓ | - | - | 通用配置 |
| `akProfitTpSegments` | array<AkProfitTpSegment> |  | - | - |  |
| `akLossSegments` | array<AkLossSegment> |  | - | - |  |
| `akBuyDetails` | array<AkBuyDetail> | ✓ | - | - | 买入详情配置 |

**必填**: `akCommonConfig`, `akBuyDetails`

### `AkBotCopyDTO`


| 字段 | 类型 | 必填 | 默认 | 范围 | 说明 |
|---|---|---|---|---|---|
| `idConfig` | integer | ✓ | - | - | 配置主键 id |
| `copyAddress` | array<string> | ✓ | - | - | 复制跟单地址列表 |

**必填**: `idConfig`, `copyAddress`

### `AkBotListDTO`


| 字段 | 类型 | 必填 | 默认 | 范围 | 说明 |
|---|---|---|---|---|---|
| `akCommonConfig` | [AkCommonConfig] |  | - | - | 通用配置 |
| `akBuyDetails` | array<AkBuyDetail> |  | - | - | 买入详情配置 |
| `akProfitTpSegments` | array<AkProfitTpSegment> |  | - | - | 止盈分段配置 |
| `akLossSegments` | array<AkLossSegment> |  | - | - | 止损分段配置 |

### `AkBotListQQ`


| 字段 | 类型 | 必填 | 默认 | 范围 | 说明 |
|---|---|---|---|---|---|
| `userId` | integer |  | - | - | 用户ID |
| `keywords` | string |  | - | - | 查询关键词 配置名称或公钥 |
| `idLabels` | array<integer> |  | - | - | 标签主键 id 列表 |
| `enableSwitch` | integer |  | - | - | 是否启用开关（1=开，0=关） 是否启用开关（1=开，0=关）全选传 null 或不传 |

### `AkBotSwitchDTO`


| 字段 | 类型 | 必填 | 默认 | 范围 | 说明 |
|---|---|---|---|---|---|
| `enableSwitch` | integer | ✓ | - | - | 是否启用开关 id 是否启用开关（1=开，0=关） |
| `idConfigs` | array<integer> | ✓ | - | - | 配置列表id |

**必填**: `enableSwitch`, `idConfigs`

### `AkBuyDetail`


| 字段 | 类型 | 必填 | 默认 | 范围 | 说明 |
|---|---|---|---|---|---|
| `idDetail` | integer |  | - | - | 配置详情 id |
| `userId` | integer |  | - | - | 用户ID |
| `idConfig` | integer |  | - | - | 关联通用配置ID |
| `buyMode` | integer |  | - | min=1 max=3 | 购买模式（1=固定金额，2=正倍数金额，3=反比例金额） |
| `buyAmount` | number | ✓ | - | - | 固定购买金额（SOL）或倍数（按 buy_mode 语义） |
| `marketValueMin` | number |  | - | min=0 | 市值区间下限（K）0 为不限制 |
| `marketValueMax` | number |  | - | - | 市值区间上限（K）0 为不限制 |
| `tipFee` | number |  | - | min=0.0001 max=100 | 服务商小费（SOL） |
| `gasFee` | number |  | - | min=0.000005 max=20 | 上链gas优先费（SOL） |
| `slippageBuy` | number | ✓ | - | min=0 max=500 | 买入滑点（%） |
| `slippageMode` | integer |  | - | min=0 max=1 | 滑点模式 0=百分比 1=SOL数量 |
| `highGasMode` | integer |  | - | min=0 max=1 | 高gas低小模式 1=开启 0=关闭 |
| `highGas` | number |  | - | max=60 | 高gas低小费gas费 |
| `highGasTip` | number |  | - | max=100 | 高gas低小费tip费 |
| `highGasSlippage` | number |  | - | min=0 max=500 | 高gas模式滑点（%或SOL数量，取决于 slippage_mode） |
| `orderNum` | integer |  | - | - | 排序号 |

**必填**: `buyAmount`, `slippageBuy`

### `AkCommonConfig`


| 字段 | 类型 | 必填 | 默认 | 范围 | 说明 |
|---|---|---|---|---|---|
| `idConfig` | integer |  | - | - | 配置主键 id |
| `enableSwitch` | integer |  | - | - | 是否启用开关（1=开，0=关） |
| `userId` | integer |  | - | - | 用户ID |
| `copyAddressNote` | string |  | - | - | 跟单地址备注 |
| `groupSlippageMultiple` | integer |  | - | - | 购买滑点倍数 |
| `platform` | string |  | - | - | 平台，多个用逗号分隔 |
| `firstPurchaseSwitch` | integer |  | - | - | 是否开启首购（1=开，0=关） |
| `positionFollowSwitch` | integer |  | - | - | 是否开启持仓跟单（1=开，0=关） |
| `followSellPctMode` | integer |  | - | - | 被跟单比例跟卖开关（2=集团跟卖 1=开，0=关） |
| `followClearPct` | integer |  | - | - | 跟卖清仓比例（%） |
| `stopFollowSwitch` | integer |  | - | - | 防割开关 0.关 1.开 |
| `blockCount` | integer (int64) |  | - | - | 防割检测——区块数，默认10 |
| `stopFollowSecond` | integer (int64) |  | - | - | 防割检测——停跟时长（秒），默认300 |
| `onlyDevSwitch` | integer |  | - | - | 是否只跟创建代币行为:1=是 0=否 |
| `mayhemSwitch` | integer |  | - | - | 混乱模式开关:1=是 0=否 |
| `addressBlacklist` | string |  | - | - | 地址黑名单 多个用逗号隔开 |
| `quickSellSwitch` | integer |  | - | - | 闪电卖出开关：1=开启，0=关闭 |
| `quickSellMs` | integer |  | - | - | 闪电卖毫秒 |
| `quickSellPct` | integer |  | - | - | 闪电卖百分比 |
| `stopFollowTimes` | integer |  | - | - | 次数停跟 |
| `drawdownPctSwitch` | integer |  | - | - | 回撤开关 0关 1开 |
| `drawdownPct` | integer |  | - | - | 最高价回撤比例（%） |
| `drawdownActivateTarget` | integer |  | - | - | 回撤开启最低涨幅 |
| `copyMinAmount` | number |  | - | - | 跟单地址最低购买金额 |
| `copyMaxAmount` | number |  | - | - | 跟单地址最高购买金额 |
| `updateTime` | string |  | - | - | 更新时间 |
| `pinTopTime` | string |  | - | - | 置顶时间 |
| `akCopyAddresses` | array<AkCopyAddress> |  | `"new ArrayList<>()"` | - | 跟单地址列表 |
| `akConfigLabels` | array<AkConfigLabel> |  | `"new ArrayList<>()"` | - | 跟单地址列表 标签配置 |

### `AkCommonConfigADD`


| 字段 | 类型 | 必填 | 默认 | 范围 | 说明 |
|---|---|---|---|---|---|
| `idConfig` | integer |  | - | - | 配置主键 id |
| `enableSwitch` | integer |  | - | min=0 max=1 | 是否开启首购（1=开，0=关） 是否启用开关（1=开，0=关） |
| `copyAddressNote` | string |  | - | - | 跟单地址备注 |
| `groupSlippageMultiple` | integer |  | `1` | max=20 | 购买滑点倍数 |
| `platform` | string |  | - | - | 平台，多个用逗号分隔 |
| `firstPurchaseSwitch` | integer |  | `1` | min=0 max=1 | 是否开启首购（1=开，0=关） |
| `positionFollowSwitch` | integer |  | `0` | min=0 max=1 | 是否开启持仓跟单（1=开，0=关） |
| `followSellPctMode` | integer |  | `0` | min=0 max=2 | 被跟单比例跟卖开关（2=集团跟卖 1=开，0=关） |
| `followClearPct` | integer |  | - | min=0 max=100 | 跟卖清仓比例（%）大于 0 生效 |
| `stopFollowSwitch` | integer |  | - | min=0 max=1 | 防割开关 0关1开 |
| `blockCount` | integer (int64) |  | - | - | 防割检测——区块数，默认10 |
| `stopFollowSecond` | integer (int64) |  | - | - | 防割检测——停跟时长（秒），默认300 |
| `onlyDevSwitch` | integer |  | `0` | min=0 max=1 | 是否只跟创建代币行为:1=是 0=否 |
| `mayhemSwitch` | integer |  | - | min=0 max=1 | 混乱模式开关:1=是 0=否 |
| `addressBlacklist` | string |  | - | - | 地址黑名单 多个逗号隔开，最多 5 个 |
| `quickSellSwitch` | integer |  | `0` | min=0 max=1 | 闪电卖出开关：1=开启，0=关闭 |
| `quickSellMs` | integer |  | - | max=20000 | 闪电卖毫秒 |
| `quickSellPct` | integer |  | - | max=100 | 闪电卖百分比 |
| `stopFollowTimes` | integer |  | - | - | 次数停跟 |
| `drawdownPctSwitch` | integer |  | `0` | min=0 max=1 | 回撤开关 0关 1开 |
| `drawdownPct` | integer |  | - | - | 最高价回撤比例（%） |
| `drawdownActivateTarget` | integer |  | - | - | 回撤开启最低涨幅 |
| `copyMinAmount` | number |  | `"public static final BigDecimal ZERO;"` | min=0 max=60 | 跟单地址最低购买金额 |
| `copyMaxAmount` | number |  | `"public static final BigDecimal ZERO;"` | min=0 max=60 | 跟单地址最大购买金额 |
| `akCopyAddresses` | array<AkCopyAddress> | ✓ | `"new ArrayList<>()"` | - | 跟单地址列表 |
| `akConfigLabels` | array<AkConfigLabel> |  | `"new ArrayList<>()"` | - | 跟单地址列表 标签配置 |

**必填**: `akCopyAddresses`

### `AkConfigLabel`


| 字段 | 类型 | 必填 | 默认 | 范围 | 说明 |
|---|---|---|---|---|---|
| `idConfigLabel` | integer |  | - | - | 标签关联表 |
| `userId` | integer |  | - | - | 用户ID |
| `idLabel` | integer |  | - | - | 标签 id |
| `labelName` | string |  | - | - | 标签 id 标签名称,不存数据库 |
| `idConfig` | integer |  | - | - | 配置主键ID |

### `AkCopyAddress`


| 字段 | 类型 | 必填 | 默认 | 范围 | 说明 |
|---|---|---|---|---|---|
| `idAddress` | integer |  | - | - | 跟单地址id |
| `idConfig` | integer |  | - | - | 关联通用配置ID |
| `userId` | integer |  | - | - | 用户ID |
| `copyAddress` | string |  | - | - | 跟单地址 |
| `orderNum` | integer |  | - | - | 排序号 |

### `AkGlobalConfig`


| 字段 | 类型 | 必填 | 默认 | 范围 | 说明 |
|---|---|---|---|---|---|
| `userId` | integer |  | - | - | 用户 id |
| `walletNote` | string |  | - | - | 备注 |
| `walletPubKey` | string |  | - | - | 跟单公钥/公链地址 |
| `walletPrivateKey` | string |  | - | - | 跟单私钥/私链地址 |
| `sellTip` | number |  | - | - | 卖出服务商小费 |
| `sellGas` | number |  | - | - | 卖出服务商gas费 |
| `privateAccount` | string |  | - | - | 定制合约所属账户 |
| `privateProgram` | string |  | - | - | 定制合约程序地址 |
| `usdcMode` | integer |  | - | - | 支持 usdc 0.不支持，1.支持 |
| `usd1Mode` | integer |  | - | - | 支持 usd1 0.不支持，1.支持 |
| `globalSwitch` | integer |  | - | - | 全局开关 0.关闭 1.开启 |
| `updateTime` | string |  | - | - | 更新时间 |

### `AkLabel`


| 字段 | 类型 | 必填 | 默认 | 范围 | 说明 |
|---|---|---|---|---|---|
| `idLabel` | integer |  | - | - | 标签 id |
| `userId` | integer |  | - | - | 用户ID |
| `labelName` | string | ✓ | - | - | 标签名称 |

**必填**: `labelName`

### `AkLossSegment`


| 字段 | 类型 | 必填 | 默认 | 范围 | 说明 |
|---|---|---|---|---|---|
| `idLoss` | integer |  | - | - | 分段ID |
| `userId` | integer |  | - | - | 用户ID |
| `idConfig` | integer |  | - | - | 关联通用配置ID |
| `segmentOrder` | integer |  | - | - | 段位顺序 |
| `triggerPct` | number |  | - | min=5 max=100 | 触发价格下跌阈值（%） |
| `sellPct` | integer |  | - | min=0 max=100 | 卖出比例（%） |

### `AkProfitTpSegment`


| 字段 | 类型 | 必填 | 默认 | 范围 | 说明 |
|---|---|---|---|---|---|
| `idSegment` | integer |  | - | - | 分段明细ID |
| `userId` | integer |  | - | - | 用户ID |
| `idConfig` | integer |  | - | - | 关联通用配置ID |
| `segmentOrder` | integer |  | - | - | 段位顺序 |
| `triggerPct` | number | ✓ | - | min=5 | 触发价格上涨阈值（%） |
| `sellPct` | integer |  | - | min=0 | 卖出比例（%） |
| `timeOutSwitch` | integer | ✓ | - | min=0 max=1 | 超时开关 0 关 1 开 |
| `timeOutStamp` | integer |  | - | - | 超时时间秒 |
| `timeoutAtTriggerPct` | number |  | - | - | 超时卖出比例 |

**必填**: `triggerPct`, `timeOutSwitch`

### `ResponseDTOAkBotAddDTO`


| 字段 | 类型 | 必填 | 默认 | 范围 | 说明 |
|---|---|---|---|---|---|
| `code` | integer |  | - | - |  |
| `level` | string |  | - | - |  |
| `msg` | string |  | - | - |  |
| `ok` | boolean |  | - | - |  |
| `data` | [AkBotAddDTO] |  | - | - |  |
| `dataType` | integer |  | - | - |  |

### `ResponseDTOAkBotListDTO`


| 字段 | 类型 | 必填 | 默认 | 范围 | 说明 |
|---|---|---|---|---|---|
| `code` | integer |  | - | - | 返回码 |
| `level` | string |  | - | - | 级别 |
| `msg` | string |  | - | - |  |
| `ok` | boolean |  | - | - |  |
| `data` | [AkBotListDTO] |  | - | - | 返回数据 |
| `dataType` | integer |  | - | - |  |

### `ResponseDTOAkGlobalConfig`


| 字段 | 类型 | 必填 | 默认 | 范围 | 说明 |
|---|---|---|---|---|---|
| `code` | integer |  | - | - |  |
| `level` | string |  | - | - |  |
| `msg` | string |  | - | - |  |
| `ok` | boolean |  | - | - |  |
| `data` | [AkGlobalConfig] |  | - | - |  |
| `dataType` | integer |  | - | - |  |

### `ResponseDTOInteger`


| 字段 | 类型 | 必填 | 默认 | 范围 | 说明 |
|---|---|---|---|---|---|
| `code` | integer |  | - | - |  |
| `level` | string |  | - | - |  |
| `msg` | string |  | - | - |  |
| `ok` | boolean |  | - | - |  |
| `data` | integer |  | - | - |  |
| `dataType` | integer |  | - | - |  |

### `ResponseDTOListAkBotListDTO`


| 字段 | 类型 | 必填 | 默认 | 范围 | 说明 |
|---|---|---|---|---|---|
| `code` | integer |  | - | - | 返回码 |
| `level` | string |  | - | - | 级别 |
| `msg` | string |  | - | - |  |
| `ok` | boolean |  | - | - |  |
| `data` | array<AkBotListDTO> |  | - | - | 返回数据 |
| `dataType` | integer |  | - | - |  |

### `ResponseDTOListAkLabel`


| 字段 | 类型 | 必填 | 默认 | 范围 | 说明 |
|---|---|---|---|---|---|
| `code` | integer |  | - | - | 返回码 |
| `level` | string |  | - | - | 级别 |
| `msg` | string |  | - | - |  |
| `ok` | boolean |  | - | - |  |
| `data` | array<AkLabel> |  | - | - | 返回数据 |
| `dataType` | integer |  | - | - |  |

### `ResponseDTOString`


| 字段 | 类型 | 必填 | 默认 | 范围 | 说明 |
|---|---|---|---|---|---|
| `code` | integer |  | - | - |  |
| `level` | string |  | - | - |  |
| `msg` | string |  | - | - |  |
| `ok` | boolean |  | - | - |  |
| `data` | string |  | - | - |  |
| `dataType` | integer |  | - | - |  |
