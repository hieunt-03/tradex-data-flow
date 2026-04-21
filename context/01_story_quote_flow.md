# 01 - VÒNG ĐỜI DỮ LIỆU: GIÁ KHỚP LỆNH (QUOTE FLOW)

> Luồng dữ liệu giá khớp lệnh (Stock/Index/Futures/CW) từ nguồn **Lotte WebSocket** → Collector-Lotte → Kafka → Realtime-V2 → **Redis (intraday chính)** / MongoDB (snapshot-day-level + optional fallback) → Query-V2 → Client.

---

## Bước 1: INGESTION (Hút Data)

### 1.1. Nguồn dữ liệu đầu vào

**Service:** `market-collector-lotte` (Java/Spring Boot)

**Runtime note (UAT/PROD hiện tại):**
- Deploy scripts của `market-collector-lotte` populate `app.realtime.websocketConnections` và set `accounts: []`.
- Vì vậy collector nhận realtime quote từ **Lotte WebSocket** (`INDEX-WS`, `SESSION-WS`, `STOCK-HOSE/HNX/UPCOM`, `CW`, `ETF`, `FUTURES`), không phải HTS account stream.
- Luồng HTS account-based vẫn còn trong codebase, nhưng **không active** ở runtime UAT/PROD hiện tại.
- Sau khi packet vào collector, phần transform/routing phía dưới (`sendOutMap` → `ThreadHandler`) vẫn giữ nguyên.

### 1.2. Nhận và phân phối packet

**Method:** `RealTimeConnectionHandler.receivePacket(AutoRcv autoRcv)`

Xử lý:
1. Duyệt từng `item` trong `autoRcv.getItems()`.
2. Tra `sendOutMap` (config từ `AppConf.RealtimeConf.topics`) để tìm `SendOut` config tương ứng với `className` của item.
3. Từ `SendOut.transformTo`, xác định `destClass` (VD: `StockUpdateData`, `IndexUpdateData`, `BidOfferData`...).
4. Đưa vào queue của `ThreadHandler` tương ứng theo `code` (mã CK) — mỗi mã được gán cố định 1 thread qua `codeThreadMap`.

### 1.3. Cấu trúc Object thô — `StockUpdateData`

File: `model/realtime/StockUpdateData.java` — extends `TransformData<StockAutoItem>`

| Field | Kiểu | Mô tả |
|---|---|---|
| `code` | String | Mã chứng khoán |
| `time` | String | Thời gian (format HHmmss sau khi format) |
| `date` | String | Ngày (format yyyyMMdd) |
| `ceilingPrice` | int | Giá trần |
| `floorPrice` | int | Giá sàn |
| `referencePrice` | int | Giá tham chiếu |
| `averagePrice` | int | Giá trung bình |
| `open` | int | Giá mở cửa |
| `high` | int | Giá cao nhất |
| `low` | int | Giá thấp nhất |
| `last` | int | Giá khớp cuối |
| `change` | int | Thay đổi giá |
| `rate` | double | % thay đổi (đã round 2 decimal) |
| `turnoverRate` | double | Tỷ lệ quay vòng |
| `matchingVolume` | int | KL khớp lệnh lần này |
| `tradingVolume` | long | Tổng KLGD tích lũy |
| `tradingValue` | long | Tổng GTGD (×1.000.000 từ raw) |
| `bidPrice/offerPrice` | int | Giá đặt mua/bán tốt nhất |
| `bidVolume/offerVolume` | int | KL đặt mua/bán tốt nhất |
| `totalBidVolume/Count` | long | Tổng KL/số lệnh mua tích lũy |
| `totalOfferVolume/Count` | long | Tổng KL/số lệnh bán tích lũy |
| `foreignerBuyVolume/SellVolume` | long | KL NN mua/bán |
| `foreignerTotalRoom/CurrentRoom` | long | Room NN tổng/còn lại |
| `matchedBy` | String | `"ASK"` (index=66), `"BID"` (index=83), hoặc `null` |
| `type` | String | Mặc định `"STOCK"` |

**Parse logic (`StockUpdateData.parse(StockAutoItem)`):**
- Map 1:1 từ `StockAutoItem` fields.
- `tradingValue = stockAutoItem.getValue() * 1_000_000` (đơn vị gốc là triệu).
- `rate = NumberUtils.round2DecimalFloatToDouble(...)` — làm tròn 2 chữ số thập phân.
- `matchedBy`: Dựa vào `stockAutoItem.getMatchVolume().getIndex()` — `66 = ASK`, `83 = BID`.

### 1.4. Validate & Format

**`TransformData.formatTime()`:**
- Parse time `HH:MM:SS` → kiểm tra `hour` trong khoảng `[minHour, maxHour]` (config).
- Nếu ngoài khoảng → throw `IgnoreException` → bỏ packet.
- Trừ `hourOffset` (chênh lệch múi giờ server).
- Format lại thành `HHmmss` (không dấu phân cách).

**`StockUpdateData.validate()`:**
- Nếu `open == 0 || high == 0 || low == 0 || last == 0` → throw `IgnoreException` → bỏ packet (giá rác).

---

## Bước 2: MUTATE & LOGIC (Nhào Nặn)

### 2.1. ThreadHandler — Routing & Pre-processing (Collector)

File: `services/realtime/ThreadHandler.java`

**Method `handle(Data)`:**
1. Tạo instance `destClass` → gọi `parse()` → `validate()` → `formatTime()` → `formatRefCode()` → `parseStatus()`.
2. Route theo `destClass`:
   - `StockUpdateData` → `handleAutoData(StockUpdateData)`
   - `IndexUpdateData` → `handleAutoData(IndexUpdateData)`
   - `FuturesUpdateData` → `handleAutoData(FuturesUpdateData)`
   - `MarketStatusData` → publish trực tiếp Kafka topic `"marketStatus"`

### 2.2. handleAutoData(StockUpdateData) — Logic Lọc Quote Rác

```
SymbolInfo symbolInfo = cacheService.getMapSymbolInfo().get(code);
long lastTradingVolume = symbolInfo.getTradingVolume();
long tradingVolume = stockUpdateData.getTradingVolume();
long matchingVolume = stockUpdateData.getMatchingVolume();
```

**Luồng quyết định:**

| Điều kiện | Hành động |
|---|---|
| `matchingVolume == 0` | Tạo `StockExtra` → publish Kafka `"extraUpdate"` → **RETURN** (không publish quote) |
| CW có `exerciseRatio` và `exercisePrice` | Tính `breakEven = last × exerciseRatio + exercisePrice` |
| `lastTradingVolume == 0` hoặc `tradingVolume - matchingVolume == lastTradingVolume` | ✅ **Đúng thứ tự** — cập nhật `symbolInfo.tradingVolume` và `symbolInfo.last` |
| `tradingVolume - matchingVolume < lastTradingVolume` | ⚠️ **Quote trùng/cũ** — Log warn, nếu `enableIgnoreQuote = true` → bỏ |
| `tradingVolume - matchingVolume > lastTradingVolume` | ❌ **Sai thứ tự (wrong order)** — Log error, nếu `enableIgnoreQuote = true` → bỏ |

> **Công thức kiểm tra thứ tự:** `previousAccumulatedVolume = tradingVolume - matchingVolume`. Giá trị này phải bằng đúng `lastTradingVolume` (volume tích lũy trước đó).

Cuối cùng: `kafkaPublishRealtime("quoteUpdate", stockUpdateData)`.

### 2.3. handleAutoData(IndexUpdateData) — Logic Index

```
if (tradingVolume <= lastTradingVolume && tradingValue <= lastTradingValue) {
    // → Bỏ nếu enableIgnoreQuote
}
```

**Đặc biệt cho VN30:**
- Khi nhận index VN30, tính `basis` cho tất cả mã VN30F*:
  ```
  basis = round2Decimal(futureLast - vn30IndexLast)
  ```
- Publish `ExtraUpdate` với `basis` cho mỗi Futures.

Cuối cùng: `kafkaPublishRealtime("quoteUpdate", indexUpdateData)`.

### 2.4. handleAutoData(FuturesUpdateData) — Logic Futures

- Tính `basis = round2Decimal(futuresLast - vn30Last)` nếu code bắt đầu bằng `"VN30"`.
- Logic kiểm tra thứ tự volume tương tự Stock.
- Publish: `kafkaPublishRealtime("quoteUpdate", futuresUpdateData)`.

### 2.5. Kafka Publish (Collector → Realtime)

**Method:** `ThreadHandler.kafkaPublishRealtime(String topic, Object data)`
- Gọi `RequestSender.sendMessageSafe(topic, "Update", data)`.
- `RequestSender` extends `KafkaRequestProducer` — sử dụng `kafkaBootstraps` và `clusterId` từ config.
- **Topic Kafka:** Giá trị cụ thể của `"quoteUpdate"` được config trong `application.yaml` của Realtime-V2 phía `AppConf.Topics.quoteUpdate`.

---

### 2.6. QuoteUpdateHandler — Kafka Consumer (Realtime-V2)

File: `realtime-v2/.../consumers/QuoteUpdateHandler.java`

- Lắng nghe Kafka topic `appConf.topics.quoteUpdate`.
- Deserialize thành `Message<SymbolQuote>`.
- Gọi `monitorService.rcv(symbolQuote)` → data vào `ThreadHandler` queue → `MonitorService.handler()` → `quoteService.updateQuote(symbolQuote)`.

### 2.7. QuoteService.reCalculate() — Logic Tái Tính Toán (Realtime-V2)

File: `realtime-v2/.../services/QuoteService.java` — method `reCalculate(SymbolQuote)`

**Bước 1: Kiểm tra volume order**
```java
if (symbolQuote.getTradingVolume() < symbolInfo.getTradingVolume() && enableCheckOrderQuote) {
    ➝ Lưu vào Redis key wrong_order
    ➝ return false; // KHÔNG xử lý tiếp
}
```

**Bước 2: Fix dữ liệu**
- Nếu `high == null` → `high = last`
- Nếu `low == null` → `low = last`
- Set `createdAt`, `updatedAt`, `date` (parse từ `dateStr + time`)
- Tính `milliseconds` từ time string.
- Tạo `id = code + "_" + date + "_" + tradingVolume`.

**Bước 3: Tính toán NĐTNN (chỉ cho STOCK)**
```java
foreignerMatchBuyVolume  = quote.foreignerBuyVolume  - info.foreignerBuyVolume
foreignerMatchSellVolume = quote.foreignerSellVolume - info.foreignerSellVolume
holdVolume    = foreignerTotalRoom - foreignerCurrentRoom
buyAbleRatio  = (foreignerCurrentRoom / info.foreignerTotalRoom) × 100
holdRatio     = holdVolume / info.listedQuantity
```

**Bước 4: Cập nhật High/Low Year**
```java
if (quote.high > highLowYearItem.highPrice) → cập nhật highPrice + dateOfHighPrice
if (highLowYearItem.lowPrice > quote.low)  → cập nhật lowPrice  + dateOfLowPrice
```
- Nếu có thay đổi → publish `ExtraUpdate` qua Kafka topic `"calExtraUpdate"`.

### 2.8. QuoteService.updateQuote() — Logic Cập Nhật Chính (Realtime-V2)

**Gọi `reCalculate()` trước** — nếu `false` thì return ngay.

**A. Cập nhật SymbolStatistic (Thống kê BUY/SELL theo giá):**

Nếu `enableSaveStatistic = true` và `type != INDEX`:
```
Prices price = tìm trong statistic.prices theo price == quote.last
Nếu chưa có price:
   matchedVolume = matchingVolume
   matchedRaito  = (matchingVolume / tradingVolume) × 100
Nếu đã có:
   price.matchedVolume += matchingVolume
   Tính lại matchedRaito cho TẤT CẢ price entries

Phân loại theo matchedBy:
   BID  → price.matchedBuyVolume  += matchingVolume → buyRaito  = (buy / matched) × 100
   ASK  → price.matchedSellVolume += matchingVolume → sellRaito = (sell / matched) × 100
   null → price.matchedUnknowVolume += matchingVolume → unknowRaito = (unknow / matched) × 100

Tổng hợp:
   statistic.totalBuyVolume  → totalBuyRaito  = (totalBuy / tradingVolume) × 100
   statistic.totalSellVolume → totalSellRaito = (totalSell / tradingVolume) × 100
```

→ Lưu Redis: `marketRedisDao.setStatistic(key, statistic)`
→ Publish Kafka: topic `publishV2Statistic.topic` với `SymbolStatistic` chỉ chứa 1 price entry hiện tại.

**B. Cập nhật SymbolInfo (Cache real-time):**
```java
ConvertUtils.updateByQuote(symbolInfo, symbolQuote);
marketRedisDao.setSymbolInfo(symbolInfo);   // Redis Hash: SYMBOL_INFO
symbolQuote.setSequence(symbolInfo.getQuoteSequence()); // gán sequence tăng dần
```

**C. Cập nhật ForeignerDaily:**
```java
foreignerDaily.updateByQuote(symbolQuote);
marketRedisDao.setForeignerDaily(foreignerDaily); // Redis Hash: FOREIGNER_DAILY
```

**D. Cập nhật SymbolDaily:**
```java
ConvertUtils.updateDailyByQuote(symbolDaily, symbolQuote);
marketRedisDao.setSymbolDaily(symbolDaily); // Redis Hash: SYMBOL_DAILY
```

**E. Tạo/Cập nhật Nến Phút (SymbolQuoteMinute):**
```java
long compare = (quote.milliseconds / 60000) - (currentMinute.milliseconds / 60000);

if (currentMinute == null || compare > 0):
    // phút mới → tạo SymbolQuoteMinute mới
    ConvertUtils.fromSymbolQuote(newMinute, quote);  // open=last, high=last, low=last, close=last
    → Redis List: push vào SYMBOL_QUOTE_MINUTE_{code}

if (compare == 0):
    // cùng phút → cập nhật
    ConvertUtils.updateByQuote(minute, quote);  // high=max, low=min, close=last, volume tích lũy
    → Redis List: ghi đè phần tử cuối

if (compare < 0):
    // quote cũ hơn phút hiện tại → log warn, bỏ qua
```

**F. Lưu Quote vào Redis List (có Partitioning):**
```java
marketRedisDao.addSymbolQuote(symbolQuote);  // push vào SYMBOL_QUOTE_{code}
// Cập nhật QuotePartition trong metadata
defaultPartition.add(symbolQuote);
```

**G. Trigger thông báo Trần/Sàn:**
Nếu `last == ceilingPrice || last == floorPrice` → gửi Kafka request đến `virtualCore` topic: `"get:/api/v1/hitTheCeilingOrFloorPrice"`.

---

## Bước 3: PERSISTENCE (Lưu Trữ)

### 3.1. Redis Keys

| Redis Key Pattern | Kiểu | Mô tả |
|---|---|---|
| `SYMBOL_INFO` (hash) | Hash | Thông tin realtime mới nhất của mỗi mã (giá, KL, foreigner...) |
| `SYMBOL_INFO_ODD_LOT` (hash) | Hash | Tương tự nhưng cho giao dịch lô lẻ |
| `SYMBOL_DAILY` (hash) | Hash | Dữ liệu daily cập nhật realtime |
| `FOREIGNER_DAILY` (hash) | Hash | Dữ liệu NĐTNN daily |
| `SYMBOL_QUOTE_{code}` | List | Danh sách quote (tick) trong ngày, push append |
| `SYMBOL_QUOTE_{code}_{partition}` | List | Partition quotes khi list quá lớn |
| `SYMBOL_QUOTE_META_{code}` | String (JSON) | Metadata partitioning cho quote list |
| `SYMBOL_QUOTE_MINUTE_{code}` | List | Danh sách nến phút trong ngày |
| `SYMBOL_STATISTICS` (hash) | Hash | Thống kê buy/sell volume theo bước giá |
| `WRONG_ORDER_{code}` | List | Quotes bị sai thứ tự volume |

### 3.2. MongoDB Collections (không phải storage intraday mặc định ở runtime hiện tại)

| Collection | Repository (Query-V2) | Mô tả |
|---|---|---|
| `SymbolQuote` | `SymbolQuoteRepository` | Fallback tick intraday **nếu** có manual dump/backfill hoặc môi trường khác bật snapshot |
| `SymbolQuoteMinutes` | `SymbolQuoteMinutesRepository` | Fallback nến phút **nếu** có manual dump/backfill hoặc môi trường khác bật snapshot |
| `SymbolDaily` | `SymbolDailyRepository` | Nến ngày lịch sử |
| `ForeignerDaily` | `ForeignerDailyRepository` | NĐTNN lịch sử |

---

## Bước 4: DELIVERY (Phân Phối)

### 4.1. Kafka Topics bắn ra từ Realtime-V2

| Topic | Dữ liệu | Mục đích |
|---|---|---|
| `publishV2Statistic.topic` | `SymbolStatistic` (1 price entry) | Thống kê realtime theo bước giá |
| `calExtraUpdate` | `ExtraUpdate` (highLowYear) | Cập nhật high/low năm |
| `virtualCore` | `FloorOrCeilingRequest` | Trigger notification trần/sàn |

### 4.2. API được phục vụ qua Query-V2 (`RequestHandler.ts`)

#### API 1: `/api/v2/market/symbol/latest`
- **Method:** `SymbolService.querySymbolLatestNormal(request)`
- **Request:** `{ symbolList: string[] }`
- **Logic:** `redis.hmget(SYMBOL_INFO, symbolList)` → map qua `toSymbolLatestResponse()`
- **Response fields:** Toàn bộ thông tin realtime từ `SymbolInfo`: code, last, open, high, low, change, rate, tradingVolume, tradingValue, ceiling, floor, reference, bid/offer prices/volumes, foreigner data,...

#### API 2: `/api/v2/market/symbol/{symbol}/quote`
- **Method:** `SymbolService.querySymbolQuote(request)`
- **Request:** `{ symbol: string, fetchCount?: number, lastTradingVolume?: number }`
- **Logic:**
  1. Lấy `ListQuoteMeta` từ Redis key `SYMBOL_QUOTE_META_{symbol}`.
  2. Duyệt partitions từ cuối lên: nếu `partition.fromVolume < lastTradingVolume` → `lrange(SYMBOL_QUOTE_{symbol}_{partition}, 0, -1)`.
  3. Filter: chỉ lấy quote có `tradingVolume < lastTradingVolume`.
  4. Dừng khi đủ `fetchCount`.
- **Response:** `SymbolQuoteResponse[]` — danh sách quote ticks.

#### API 3: `/api/v2/market/symbolQuote/{symbol}`
- **Method:** `SymbolService.queryQuoteData(request)`
- **Request:** `{ symbol: string, fetchCount?: number, lastIndex?: number }`
- **Logic:** Tương tự nhưng dùng index-based pagination thay vì volume-based.
- **Response:** `{ data: ISymbolQuote[], totalIndex: number, lastIndex: number }`

#### API 4: `/api/v2/market/symbol/{symbol}/minutes`
- **Method:** `SymbolService.querySymbolQuoteMinutes(request)`
- **Request:** `{ symbol: string, fetchCount?: number, minuteUnit?: number, fromTime?: string, toTime?: string }`
- **Logic:** `commonService.actualQueryQuoteMinuteThenGrouped()` — lấy từ Redis `SYMBOL_QUOTE_MINUTE_{symbol}` trước; nếu thiếu dữ liệu và Mongo có snapshot/manual dump thì fallback query `SymbolQuoteMinute`, rồi nhóm theo `minuteUnit`.
- **Response:** `SymbolQuoteMinuteResponse[]` — nến phút đã nhóm.

#### API 5: `/api/v2/market/symbol/{symbol}/minuteChart`
- **Method:** `SymbolService.queryMinuteChart(request)`
- **Request:** `{ symbol: string }`
- **Logic:** Lấy toàn bộ `lrange(SYMBOL_QUOTE_MINUTE_{symbol}, 0, -1)` → map `toMinuteChartResponse`.
- **Response:** `IMinuteChartResponse` — dữ liệu cho biểu đồ intraday.

#### API 6: `/api/v2/market/symbol/{symbol}/ticks`
- **Method:** `SymbolService.querySymbolQuoteTick(request)`
- **Request:** `{ symbol: string, fetchCount?: number, tickUnit?: number, toSequence?: number, fromSequence?: number }`
- **Logic:**
  1. Lấy quote từ Redis `SYMBOL_QUOTE_{symbol}` → filter theo `sequence`.
  2. Nếu thiếu → fallback query MongoDB (`SymbolQuoteRepository`) **khi Mongo có intraday data**.
  3. Nhóm theo `tickUnit`: cùng key → merge (max high, min low, latest close).
  4. Tính `periodTradingVolume = higherRecord.tradingVolume - currentRecord.tradingVolume`.
- **Response:** `SymbolQuoteTickResponse[]` — nến tick đã nhóm.

#### API 7: `/api/v2/market/symbol/{symbol}/statistic`
- **Method:** `SymbolService.querySymbolStatistics(request)`
- **Request:** `{ symbol: string, pageSize: number, pageNumber: number, sortBy?: string }`
- **Logic:** `redis.hget(SYMBOL_STATISTICS, symbol)` → paginate prices list → `toSymbolStatisticsResponse`.
- **Response:** `ISymbolStatisticsResponse` — thống kê buy/sell/unknown theo bước giá.

#### API 8: `/api/v2/market/priceBoard`
- **Method:** `SymbolService.queryPriceBoard(request)`
- **Request:** `{ symbolList: string[], category?: string }`
- **Logic:** `redis.hmget(SYMBOL_INFO, symbolList)` → `toPriceBoardResponse`.
- **Response:** `IPriceBoardResponse` — bảng giá realtime.

### 4.3. WebSocket Broadcast qua WS-V2 (SocketCluster)

> Đây là chặng **cuối cùng** — dữ liệu từ Realtime-V2 publish Kafka → ws-v2 consume → broadcast xuống Client App.

#### Cơ chế: Kafka → SocketCluster Channel

**File:** `ws-v2/market.js` → `processDataPublishV2()`

ws-v2 consume **cùng các Kafka topic** mà Realtime-V2 publish:

| Kafka Topic (Realtime-V2 publish) | SocketCluster Channel | Parser Function |
|---|---|---|
| `quoteUpdate` | `market.quote.{data.code}` | `convertDataPublishV2Quote()` |
| `calExtraUpdate` | `market.extra.{data.code}` | `convertDataPublishV2Extra()` |
| `statisticUpdate` | `market.statistic.{data.code}` | `convertDataPublishV2Static()` |

> **Lưu ý:** Cả Stock, Index, và Futures đều gửi qua `quoteUpdate` → channel `market.quote.{code}`. Client phân biệt bằng field `t` (type) trong payload.

#### Data Transformation (parser.js)

`convertDataPublishV2Quote(data)` nén SymbolQuote thành payload viết tắt:

```javascript
// Input:  { code: "VNM", last: 85000, open: 84500, high: 85200, ... }
// Output: { s: "VNM", c: 85000, o: 84500, h: 85200, l: 84000,
//           ch: 500, ra: 0.59, vo: 1234567, va: 105000000000,
//           mv: 1000, a: 84800, mb: "ASK",
//           fr: { bv: 50000, sv: 30000, cr: 200000, tr: 500000 },
//           ic: { ce: 15, up: 120, dw: 80, fl: 5, uc: 45 }  // chỉ INDEX
//           ba: 1.5  // chỉ FUTURES
//         }
```

#### Cache & Volume Check

```javascript
// market.js → processDataPublishV2Quote():
const currentCacheData = cache[data.code];
// Chỉ cache nếu volume mới > volume cũ (tránh stale data)
if (currentCacheData == null || currentCacheData.data.vo < publishData.vo) {
    setToCacheInfo(data.code, publishData, cache);
}
scExchange.publish(channel, publishData);
```

#### Snapshot on Subscribe

Khi Client subscribe `market.quote.VNM` với `{ returnSnapShot: true }`:
1. ws-v2 extract `code = "VNM"` từ channel name.
2. Check cache → nếu miss hoặc TTL hết (300s) → query Redis `SYMBOL_INFO.VNM`.
3. Convert bằng `convertSymbolInfoV2()` → trả qua event `market.returnSnapshot`.

#### Client Subscribe Pattern

```javascript
// Mobile App / Web
socket.subscribe('market.quote.VNM', { returnSnapShot: true });
socket.subscribe('market.quote.VN');       // VNIndex
socket.subscribe('market.quote.VN30F2503'); // Futures

// Nhận snapshot ban đầu:
socket.on('market.returnSnapshot', (data) => { /* full state */ });

// Nhận realtime updates:
channel.watch((data) => {
    // data = { s:"VNM", c:85000, o:84500, h:85200, ch:500, ra:0.59, vo:..., ... }
});
```

---

## SƠ ĐỒ TỔNG QUAN

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           HTS / LOTTE SERVER                                │
│              (WebSocket / Socket)                                           │
└──────────────────────────────┬──────────────────────────────────────────────┘
                               │ AutoRcv (StockAutoItem, IndexAutoItem...)
                               ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        COLLECTOR-LOTTE                                      │
│                                                                             │
│  RealTimeConnectionHandler.receivePacket()                                  │
│       │                                                                     │
│       ├─ Lookup sendOutMap → destClass (StockUpdateData/IndexUpdateData/...)│
│       ├─ Route to ThreadHandler queue by code                               │
│       ▼                                                                     │
│  ThreadHandler.handle()                                                     │
│       ├─ parse(StockAutoItem) → StockUpdateData                            │
│       ├─ validate() — reject if OHLC == 0                                  │
│       ├─ formatTime() — reject if hour out of range                        │
│       ├─ handleAutoData(Stock/Index/Futures)                                │
│       │    ├─ Volume order check: vol - match == lastVol?                   │
│       │    ├─ CW breakEven = last × ratio + exercisePrice                  │
│       │    └─ Index VN30 → basis for VN30F* futures                        │
│       └─ kafkaPublishRealtime("quoteUpdate", data)                         │
│                                                                             │
└──────────────────────────────┬──────────────────────────────────────────────┘
                               │ Kafka: topic=quoteUpdate
                               ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        REALTIME-V2                                          │
│                                                                             │
│  QuoteUpdateHandler → MonitorService.rcv(SymbolQuote)                       │
│       │                                                                     │
│       ▼                                                                     │
│  QuoteService.updateQuote(SymbolQuote)                                      │
│       ├─ reCalculate()                                                      │
│       │    ├─ Volume order check → save wrong_order if wrong                │
│       │    ├─ Parse date/time → generate ID                                 │
│       │    ├─ Foreigner: matchBuy/Sell, holdVolume, buyAbleRatio            │
│       │    └─ HighLow Year update → ExtraUpdate to Kafka                   │
│       │                                                                     │
│       ├─ UPDATE REDIS:                                                      │
│       │    ├─ SYMBOL_INFO (hash) — full realtime snapshot                   │
│       │    ├─ SYMBOL_DAILY (hash) — daily OHLCV                            │
│       │    ├─ FOREIGNER_DAILY (hash) — foreigner daily                      │
│       │    ├─ SYMBOL_QUOTE_{code} (list) — append tick                     │
│       │    ├─ SYMBOL_QUOTE_MINUTE_{code} (list) — upsert minute candle     │
│       │    └─ SYMBOL_STATISTICS (hash) — buy/sell/unknown by price         │
│       │                                                                     │
│       └─ NOTIFY: ceiling/floor → Kafka virtualCore                         │
│                                                                             │
└──────────────────────────────┬──────────────────────────────────────────────┘
                               │ Redis (read)
                               ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        QUERY-V2 (NodeJS)                                    │
│                                                                             │
│  RequestHandler.ts → SymbolService                                          │
│       ├─ /symbol/latest        → hmget SYMBOL_INFO                         │
│       ├─ /symbol/{s}/quote     → lrange SYMBOL_QUOTE_{s} (partitioned)     │
│       ├─ /symbolQuote/{s}      → index-based quote pagination              │
│       ├─ /symbol/{s}/minutes   → lrange SYMBOL_QUOTE_MINUTE_{s}            │
│       ├─ /symbol/{s}/minuteChart→ full minute list for chart               │
│       ├─ /symbol/{s}/ticks     → Redis + optional Mongo fallback           │
│       ├─ /symbol/{s}/statistic → hget SYMBOL_STATISTICS                    │
│       └─ /priceBoard           → hmget SYMBOL_INFO batch                   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```
