# 03 - VÒNG ĐỜI DỮ LIỆU: INDEX, TRẠNG THÁI PHIÊN & CÁC LUỒNG PHỤ TRỢ

> Luồng dữ liệu chỉ số (VNIndex, HNX, VN30...), trạng thái phiên giao dịch (MarketStatus), thỏa thuận (Advertised/DealNotice), danh sách mã trong Index, và ETF.

---

## Bước 1: INGESTION (Hút Data)

### 1.1. IndexUpdateData — Dữ liệu chỉ số

File: `collector/.../model/realtime/IndexUpdateData.java` extends `TransformData<IndexAutoItem>`

| Field | Kiểu | Mô tả |
|---|---|---|
| `code` | String | Mã index (sau formatRefCode) |
| `time` | String | Thời gian HHmmss |
| `open/high/low/last` | double | OHLC của index (round 2 decimal) |
| `change` | double | Thay đổi điểm |
| `rate` | double | % thay đổi |
| `tradingVolume` | long | Tổng KLGD |
| `tradingValue` | long | Tổng GTGD (×1.000.000) |
| `matchingVolume` | long | KL khớp |
| `upCount` | int | Số mã tăng |
| `ceilingCount` | int | Số mã trần |
| `unchangedCount` | int | Số mã đứng giá |
| `downCount` | int | Số mã giảm |
| `floorCount` | int | Số mã sàn |
| `sessions` | List\<Session\> | Data **từng phiên** (tối đa 3 phiên) |
| `type` | String | = `"INDEX"` |

**Session sub-object:**

| Field | Kiểu | Mô tả |
|---|---|---|
| `last` | double | Điểm cuối phiên |
| `change` | double | Thay đổi trong phiên |
| `rate` | double | % thay đổi trong phiên |
| `tradingVolume` | long | KL phiên |
| `tradingValue` | long | GT phiên |

**Parse logic đặc biệt:**

1. **Fix lỗi HNX:** Nếu `open/high/low/last >= 2000` → chia 100 (VD: `10346` → `103.46`). Đây là workaround cho lỗi HTS trả giá chỉ số HNX bị nhân 100.

2. **formatRefCode():** `this.code = cacheService.getRefIndexCodeMap().get(this.code)` — chuyển mã index gốc (từ HTS) sang mã chuẩn hệ thống. Nếu `null` → throw `IgnoreException`.

3. **Sessions 1-3:** Parse lần lượt session1/2/3 từ IndexAutoItem. Session 3 chỉ được add nếu `hasValue()` (tất cả fields != 0).

4. **validate():** `open == 0 || high == 0 || low == 0 || last == 0` → bỏ.

### 1.2. MarketStatusData — Trạng thái phiên

File: `collector/.../model/realtime/MarketStatusData.java` extends `TransformData<A78AutoItem>`

| Field | Kiểu | Mô tả |
|---|---|---|
| `id` | int | ID từ HTS |
| `code` | String | Mã từ HTS |
| `title` | String | Tiêu đề chứa tên sàn (VD: "HOSE ... ATO") |
| `market` | String | Sàn: `"HOSE"`, `"HNX"`, `"UPCOM"` |
| `status` | String | Trạng thái phiên (VD: `"ATO"`, `"ATC"`, `"CONTINUOUS"`, `"INTERMISSION"`...) |
| `type` | String | = `"EQUITY"` |

**Parse logic:**
1. Parse raw fields từ `A78AutoItem`.
2. **Override `formatTime()`:** Không xử lý (khác với TransformData mặc định).
3. **`parseStatus()`** — xử lý quan trọng:
   - Detect `market` từ `title` string: tìm chứa `"HNX"`, `"HOSE"`, hoặc `"UPCOM"`. Nếu không tìm thấy → throw `IgnoreException`.
   - Lookup `status` từ `statusMap` (config map title→status). Nếu `null` → throw `IgnoreException`.
   - **Chuyển timezone UTC:** Parse `yyyyMMdd + HHmmss` → trừ 7 giờ (UTC+7 → UTC) → format lại time.

### 1.3. AdvertisedData — Rao bán thỏa thuận

File: `collector/.../model/realtime/AdvertisedData.java`

- Parse từ HTS auto data.
- Collector chỉ thêm `marketType` từ `SymbolInfo` cache.
- Publish: `kafkaPublishRealtime("advertisedUpdate", advertisedData)`.

### 1.4. DealNoticeData — Giao dịch thỏa thuận đã khớp

File: `collector/.../model/realtime/DealNoticeData.java`

- Parse từ HTS auto data (matchVolume, matchValue...).
- **Tính tích lũy PT:**
  ```java
  ptValue  = symbolInfo.ptTradingValue  + (matchValue × matchVolume)
  ptVolume = symbolInfo.ptTradingVolume + matchVolume
  ```
- Publish 2 topics:
  - `"dealNoticeUpdate"` — DealNoticeData với ptValue/ptVolume
  - `"extraUpdate"` — ExtraUpdate (cập nhật PT data vào SymbolInfo)

---

## Bước 2: MUTATE & LOGIC (Nhào Nặn)

### 2.1. Index Quote — ThreadHandler (Collector)

Đã mô tả chi tiết trong `01_story_quote_flow.md` phần `handleAutoData(IndexUpdateData)`:
- Kiểm tra volume order (bỏ nếu volume/value không tăng).
- **VN30 → tính basis** cho tất cả mã VN30F*.
- Publish: `kafkaPublishRealtime("quoteUpdate", indexUpdateData)`.

### 2.2. MarketStatus — ThreadHandler (Collector)

```java
if (destClass.equals(MarketStatusData.class)) {
    kafkaPublishRealtime("marketStatus", destInstance);
}
```
→ Publish trực tiếp, không qua `handleAutoData`.

---

### 2.3. MarketStatusUpdateHandler (Realtime-V2)

File: `realtime-v2/.../consumers/MarketStatusUpdateHandler.java`

- Topic: `appConf.topics.marketStatus`
- Deserialize thành `Message<MarketStatus>`.
- → `MarketStatusService.updateMarketStatus(marketStatus)`.

### 2.4. MarketStatusService — Logic Cập Nhật

File: `realtime-v2/.../services/MarketStatusService.java`

```java
public void updateMarketStatus(MarketStatus marketStatus) {
    // 1. Generate ID
    marketStatus.setId(market + "_" + type);   // VD: "HOSE_EQUITY"
    marketStatus.setDate(new Date());

    // 2. Lưu vào Redis Hash
    marketRedisDao.setMarketStatus(marketStatus);  // Redis Hash: MARKET_STATUS

    // 3. Propagate session sang TẤT CẢ SymbolInfo cùng sàn
    String session = (!"ATO".equals(status) && !"ATC".equals(status))
                     ? null : status;
    // → Nếu status = "ATO" hoặc "ATC" → gán session, còn lại = null

    cacheService.getMapSymbolInfo().forEach((code, symbolInfo) -> {
        if (symbolInfo.getMarketType().equals(market)) {
            symbolInfo.setSessions(session);
            marketRedisDao.setSymbolInfo(symbolInfo);  // Cập nhật từng SymbolInfo
        }
    });
}
```

> **Tác động quan trọng:** Khi status chuyển sang ATO/ATC, TẤT CẢ `SymbolInfo` của sàn đó sẽ có field `sessions = "ATO"/"ATC"`. Client dùng field này để hiển thị trạng thái phiên trên bảng giá.

### 2.5. AdvertisedService (Realtime-V2)

File: `realtime-v2/.../services/AdvertisedService.java`

```java
public void updateAdvertised(Advertised advertised) {
    advertised.setCreatedAt(currentDate);
    advertised.setUpdatedAt(currentDate);
    advertised.setDate(parseDateTime(todayStr + time));
    advertised.setId(code + "_" + System.currentTimeMillis());
    marketRedisDao.addAdvertised(advertised);  // Redis List: ADVERTISED_{code}
}
```

### 2.6. DealNoticeService (Realtime-V2)

File: `realtime-v2/.../services/DealNoticeService.java`

```java
public void updateDealNotice(DealNotice dealNotice) {
    SymbolInfo symbolInfo = getFromCache(dealNotice.getCode());
    if (symbolInfo == null) {
        // Tự tạo mới SymbolInfo nếu chưa có
        symbolInfo = new SymbolInfo();
        symbolInfo.setPtTradingValue(0.0);
        symbolInfo.setPtTradingVolume(0L);
        cacheService.put(symbolInfo);
    }

    // Kiểm tra trùng confirmNumber
    Set<String> existingConfirmNumbers = getAllDealNotice(code)
        .stream().map(DealNotice::getConfirmNumber).collect(toSet());
    if (existingConfirmNumbers.contains(dealNotice.getConfirmNumber())) {
        return;  // BỎ QUA nếu đã tồn tại
    }

    // Cập nhật SymbolInfo với PT data
    ConvertUtils.updateByDealNotice(symbolInfo, dealNotice);
    marketRedisDao.setSymbolInfo(symbolInfo);   // SYMBOL_INFO hash

    // Lưu DealNotice
    dealNotice.setId(code + "_" + System.currentTimeMillis());
    dealNotice.setDate(parseDateTime(todayStr + time));
    marketRedisDao.addDealNotice(dealNotice);   // DEAL_NOTICE_{code} list
}
```

### 2.7. IndexStockListUpdateHandler (Realtime-V2)

File: `realtime-v2/.../consumers/IndexStockListUpdateHandler.java`

- Topic: `appConf.topics.indexStockListUpdate`
- → `MonitorService.handler()` → `indexStockService.updateIndexList(item)`:

```java
public void updateIndexList(IndexStockList item) {
    // Normalize code
    if (item.getIndexCode().equals("VNINDEX")) item.setIndexCode("VN");
    if (item.getIndexCode().equals("HNXINDEX")) item.setIndexCode("HNX");
    item.setUpdatedAt(new Date());
    indexStockListRepository.save(item);  // MongoDB: IndexStockList collection
}
```

### 2.8. IndexStockService.getIndexRanks() — xếp hạng Index

Tính năng xếp hạng cổ phiếu trong index:
1. Lấy danh sách mã từ MongoDB `IndexStockList`.
2. Với mỗi mã, lấy `SymbolInfo` từ Redis.
3. Sort theo `rate` (% thay đổi) hoặc `tradingValue`, ascending/descending.
4. Paginate và trả về `IndexRankResponse`.

---

## Bước 3: PERSISTENCE (Lưu Trữ)

### 3.1. Redis Keys

| Redis Key | Kiểu | Mô tả |
|---|---|---|
| `SYMBOL_INFO` (hash) | Hash | Index quote = SymbolInfo với `type=INDEX`, chứa OHLCV, upCount, downCount... |
| `MARKET_STATUS` (hash) | Hash | Key = `{market}_{type}`. Value = MarketStatus object |
| `ADVERTISED_{code}` | List | Danh sách rao bán thỏa thuận intraday |
| `DEAL_NOTICE_{code}` | List | Danh sách GD thỏa thuận đã khớp intraday |

### 3.2. MongoDB

| Collection | Mô tả |
|---|---|
| `IndexStockList` | Danh sách mã thuộc Index (VN, HNX, VN30...) |
| `EtfNavDaily` | NAV ngày của ETF |
| `EtfIndexDaily` | Chỉ số tracking ngày của ETF |

---

## Bước 4: DELIVERY (Phân Phối)

### 4.1. API qua Query-V2

#### `/api/v2/market/sessionStatus`
- **Service:** `MarketSessionStatusService.queryMarketSessionStatus(request)`
- **Request:** `{ market?: string, type?: string }`
- **Logic:** `redis.hgetall(MARKET_STATUS)` → filter theo `market` và `type`.
- **Response:** `MarketSessionStatusResponse[]` — danh sách trạng thái phiên.

#### `/api/v2/market/symbol/latest` (Index data)
- Index data nằm trong `SYMBOL_INFO` hash với `type=INDEX`.
- Client truyền mã Index (VD: `"VN"`, `"HNX"`, `"VN30"`) trong `symbolList`.
- Response chứa: `last`, `change`, `rate`, `upCount`, `downCount`, `ceilingCount`, `floorCount`, `tradingVolume/Value`.

#### `/api/v2/market/index/list`
- **Service:** `SymbolService.queryIndexList(request)`
- **Logic:** `redis.hgetall(SYMBOL_INFO)` → filter `type === 'INDEX'` → filter theo `market`.
- **Response:** `string[]` — danh sách mã Index.

#### `/api/v2/market/indexStockList/{indexCode}`
- **Service:** `SymbolService.queryIndexStockList(request)`
- **Logic:** MongoDB `IndexStockListRepository.findOneBy({ _id: indexCode })`.
- **Response:** Danh sách mã cổ phiếu thuộc Index.

#### `/api/v2/market/etf/{symbolCode}/nav/daily`
- **Service:** `EtfService.queryEtfNavDaily(request)`
- **Logic:** MongoDB `EtfNavDailyRepository.findBy({ code, date < baseDate }, fetchCount, sort: date desc)`.
- **Response:** `EtfNavDailyResponse[]` — lịch sử NAV.

#### `/api/v2/market/etf/{symbolCode}/index/daily`
- **Service:** `EtfService.queryEtfIndexDaily(request)`
- **Logic:** MongoDB `EtfIndexDailyRepository.findBy(...)`.
- **Response:** `EtfIndexDailyResponse[]` — lịch sử chỉ số tracking.

#### `/api/v2/market/putthrough/advertise`
- **Service:** `PutThroughService.queryPutThroughAdvertise(request)`
- **Logic:** Lấy từ Redis `ADVERTISED_{code}`.

#### `/api/v2/market/putthrough/deal`
- **Service:** `PutThroughService.queryPutThroughDeal(request)`
- **Logic:** Lấy từ Redis `DEAL_NOTICE_{code}`.

#### `/api/v2/market/putthrough/dealTotal`
- **Service:** `SymbolService.queryPtDealTotal(request)`
- **Response:** Tổng hợp PT volume/value.

### 4.2. WebSocket Broadcast qua WS-V2 (SocketCluster)

> Đây là chặng **cuối cùng** — dữ liệu từ Realtime-V2 publish Kafka → ws-v2 consume → broadcast xuống Client App.

#### Kafka → SocketCluster Channel Mapping

**File:** `ws-v2/market.js` → `processDataPublishV2()`

| Kafka Topic | SocketCluster Channel | Đặc điểm |
|---|---|---|
| `quoteUpdate` (type=INDEX) | `market.quote.{data.code}` | VD: `market.quote.VN` — publish raw qua `convertDataPublishV2Quote()` với `ic` (index counts) |
| `marketStatus` | `market.status` | **Không append code** — channel chung cho tất cả sàn, publish raw data (không convert) |
| `dealNoticeUpdate` | `market.putthrough.deal.{data.marketType}` | Append `marketType`: VD `market.putthrough.deal.HOSE` |
| `advertisedUpdate` | `market.putthrough.advertise.{data.marketType}` | Append `marketType`: VD `market.putthrough.advertise.HNX` |

#### Payload viết tắt — Index Quote

```javascript
// convertDataPublishV2Quote() cho type=INDEX:
// { s:"VN", t:"INDEX", c:1250.5, o:1248.0, h:1252.3, l:1247.1,
//   ch:2.5, ra:0.2, vo:500000000, va:12000000000000,
//   ic: { ce:15, up:120, dw:80, fl:5, uc:45 }  // index counts
// }
```

#### Payload — MarketStatus (không convert)

```javascript
// Publish raw:
// { market:"HOSE", type:"EQUITY", status:"ATO", id:"HOSE_EQUITY", date:"..." }
```

#### Payload — Deal / Advertise

```javascript
// convertDataPublishV2Deal():
// { s:"VNM", t:"...", mp:85000, mvo:1000, mva:85000000, pvo:5000, pva:425000000, m:"HOSE" }

// convertDataPublishV2Advertise():
// { s:"HPG", t:"...", sb:"S", p:25000, v:10000, m:"HOSE" }
```

#### Client Subscribe Pattern

```javascript
socket.subscribe('market.quote.VN');      // VNIndex
socket.subscribe('market.status');         // ALL market status
socket.subscribe('market.putthrough.deal.HOSE');       // PT deal HOSE
socket.subscribe('market.putthrough.advertise.HNX');   // PT advertise HNX

channel.watch(data => { /* abbreviated payload */ });
```

---

## SƠ ĐỒ TỔNG QUAN

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                          HTS / LOTTE SERVER                                  │
└────────┬──────────┬──────────┬──────────┬──────────┬────────────────────────┘
         │          │          │          │          │
    IndexAutoItem  A78Auto  AdvertisedAuto DealNotice IndexStockList
         │          │          │          │          │
         ▼          ▼          ▼          ▼          ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                        COLLECTOR-LOTTE                                       │
│                                                                              │
│ IndexUpdateData:        MarketStatusData:     AdvertisedData:                │
│  ├ parse IndexAutoItem   ├ detect market       ├ add marketType             │
│  ├ fix HNX ≥2000→/100     from title           └→ Kafka: advertisedUpdate  │
│  ├ formatRefCode         ├ lookup statusMap                                 │
│  ├ parse sessions 1-3   ├ convert UTC time    DealNoticeData:               │
│  └→ Kafka: quoteUpdate  └→ Kafka: marketStatus ├ calc PT cumulative        │
│                                                  └→ Kafka: dealNoticeUpdate │
│                                                  └→ Kafka: extraUpdate      │
└────────┬──────────┬──────────┬──────────┬──────────┬────────────────────────┘
         │          │          │          │          │
         ▼          ▼          ▼          ▼          ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                        REALTIME-V2                                           │
│                                                                              │
│ QuoteService:        MarketStatusService:         AdvertisedService:          │
│  ├ reCalculate         ├ save MARKET_STATUS hash   ├ save to Redis list     │
│  ├ update SYMBOL_INFO  ├ propagate session to     │                          │
│  ├ update Daily          ALL SymbolInfo same       DealNoticeService:         │
│  └ update Minute         market                    ├ dedup by confirmNumber  │
│                                                     ├ updateByDealNotice     │
│ IndexStockService:                                  │  → SYMBOL_INFO         │
│  └ save to MongoDB                                  └ save to Redis list     │
│    IndexStockList                                                            │
└────────┬──────────┬──────────┬──────────┬──────────┬────────────────────────┘
         │          │          │          │          │
         ▼   Redis  ▼   Redis ▼  Redis   ▼  Redis  ▼  MongoDB
┌──────────────────────────────────────────────────────────────────────────────┐
│                        QUERY-V2 (NodeJS)                                     │
│                                                                              │
│  /sessionStatus     → hgetall MARKET_STATUS                                  │
│  /symbol/latest     → hmget SYMBOL_INFO (type=INDEX)                        │
│  /index/list        → hgetall SYMBOL_INFO → filter type=INDEX               │
│  /indexStockList    → MongoDB IndexStockList                                 │
│  /etf/nav/daily     → MongoDB EtfNavDaily                                   │
│  /etf/index/daily   → MongoDB EtfIndexDaily                                 │
│  /putthrough/advertise → Redis ADVERTISED_{code}                            │
│  /putthrough/deal   → Redis DEAL_NOTICE_{code}                              │
│  /putthrough/dealTotal → Redis (PT summary from SymbolInfo)                 │
└──────────────────────────────────────────────────────────────────────────────┘
```
