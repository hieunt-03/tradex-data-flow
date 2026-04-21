# 02 - VÒNG ĐỜI DỮ LIỆU: SỔ LỆNH (BID/OFFER FLOW)

> Luồng dữ liệu sổ lệnh mua/bán (BidOffer), sổ lệnh lô lẻ (OddLot), và sổ lệnh Phái sinh (Futures BidOffer) từ nguồn **Lotte WebSocket** → Collector-Lotte → Kafka → Realtime-V2 → Redis → Query-V2 → Client.

---

## Bước 1: INGESTION (Hút Data)

### 1.1. Nguồn dữ liệu

**Service:** `market-collector-lotte`  
Cơ chế ingest runtime hiện tại **giống hệt** luồng Quote (xem `01_story_quote_flow.md`): collector nhận packet từ `websocketConnections` của Lotte WebSocket, rồi route qua `sendOutMap` → `ThreadHandler`. HTS account stream vẫn còn trong codebase nhưng deploy scripts UAT/PROD đang set `accounts: []`.

Sự khác biệt nằm ở **destClass**:
- `BidOfferAutoItem` → `BidOfferData`
- `FuturesBidOfferItem` → `FuturesBidOfferData`

### 1.2. Cấu trúc Object thô — `BidOfferData`

File: `model/realtime/BidOfferData.java` extends `TransformData<BidOfferAutoItem>`

| Field | Kiểu | Mô tả |
|---|---|---|
| `code` | String | Mã CK |
| `time` | String | Thời gian (HHmmss) |
| `bidPrice` | int | Giá mua tốt nhất |
| `offerPrice` | int | Giá bán tốt nhất |
| `bidVolume` | int | KL mua tốt nhất |
| `offerVolume` | int | KL bán tốt nhất |
| `bidOfferList` | List\<PriceItem\> | **Danh sách 3 bước giá mua/bán** |
| `totalBidVolume` | long | Tổng KL đặt mua tích lũy |
| `totalOfferVolume` | long | Tổng KL đặt bán tích lũy |
| `totalBidCount` | long | Tổng số lệnh mua tích lũy |
| `totalOfferCount` | long | Tổng số lệnh bán tích lũy |
| `diffBidOffer` | int | Chênh lệch Bid-Offer |
| `expectedPrice` | Double | Giá dự kiến khớp (chỉ ATO/ATC) |
| `expectedChange` | Double | Thay đổi dự kiến so với ref |
| `expectedRate` | Double | % thay đổi dự kiến |
| `session` | String | Phiên: `"ATO"`, `"ATC"`, hoặc `"CONTINUOUS"` |

**PriceItem** (mỗi bước giá trong sổ lệnh):

| Field | Kiểu | Mô tả |
|---|---|---|
| `bidPrice` | int | Giá đặt mua |
| `offerPrice` | int | Giá đặt bán |
| `bidVolume` | int | KL mua |
| `offerVolume` | int | KL bán |
| `bidVolumeChange` | int | Thay đổi KL mua so với snap trước |
| `offerVolumeChange` | int | Thay đổi KL bán so với snap trước |

### 1.3. Parse logic — `BidOfferData.parse(BidOfferAutoItem)`

- Map 1:1 từ `BidOfferAutoItem`.
- `bidOfferList` = `item.getBidOfferPrices().stream().map(PriceItem::parse)` — parse từng bước giá.
- `session` = `sessionControlMap.get(controlCode)`:
  - `"P"` → `"ATO"` (phiên mở cửa)
  - `"A"` → `"ATC"` (phiên đóng cửa)
  - `"O"` → `"CONTINUOUS"` (khớp lệnh liên tục)
- `expectedPrice`:
  - Chỉ có giá trị **khi session = ATO hoặc ATC** VÀ `projectOpen > 0`.
  - Nếu không thỏa: set `null` cho cả `expectedPrice/Change/Rate`.
  - Nếu thỏa: `expectedPrice = round1Decimal(projectOpen)`.

### 1.4. Cấu trúc Object thô — `FuturesBidOfferData`

File: `model/realtime/FuturesBidOfferData.java` extends `TransformData<FuturesBidOfferItem>`

Cấu trúc **tương tự** `BidOfferData` nhưng:
- `bidPrice/offerPrice` là `double` (giá phái sinh có thập phân, round 2 decimal).
- Parse `PriceItem` cũng dùng `round2DecimalFloatToDouble`.
- Dùng cùng `sessionControlMap` cho phiên giao dịch.

---

## Bước 2: MUTATE & LOGIC (Nhào Nặn)

### 2.1. ThreadHandler — Pre-processing (Collector)

File: `services/realtime/ThreadHandler.java`

Sau khi `parse() → validate() → formatTime()`, route đến:
- `BidOfferData` → `handleAutoData(BidOfferData)`
- `FuturesBidOfferData` → `handleAutoData(FuturesBidOfferData)`

### 2.2. handleAutoData(BidOfferData) — Tính Expected Change/Rate

```java
Double expectedPrice = bidOfferData.getExpectedPrice();
if (expectedPrice != null) {
    Double referencePrice = cacheService.getMapSymbolInfo()
                                        .get(bidOfferData.getCode())
                                        .getReferencePrice();
    if (referencePrice != null && referencePrice > 0) {
        double expectedChange = expectedPrice - referencePrice;
        double expectedRate   = (expectedChange / referencePrice) * 100;
        bidOfferData.setExpectedChange(round2Decimal(expectedChange));
        bidOfferData.setExpectedRate(round2Decimal(expectedRate));
    }
}
kafkaPublishRealtime("bidOfferUpdate", bidOfferData);
```

> **Công thức:**
> - `expectedChange = expectedPrice - referencePrice`
> - `expectedRate = (expectedChange / referencePrice) × 100`
> - Chỉ tính khi `expectedPrice != null` (tức là đang trong phiên ATO/ATC).

### 2.3. handleAutoData(FuturesBidOfferData) — Logic tương tự

Cùng logic tính `expectedChange/Rate` với giá tham chiếu Futures.
→ Publish: `kafkaPublishRealtime("bidOfferUpdate", bidOfferData)`.

### 2.4. Kafka Topic

Cả Stock BidOffer và Futures BidOffer đều publish cùng topic `"bidOfferUpdate"`.

---

### 2.5. BidOfferUpdateHandler — Kafka Consumer (Realtime-V2)

File: `realtime-v2/.../consumers/BidOfferUpdateHandler.java`

- Lắng nghe topic `appConf.topics.bidOfferUpdate`.
- Deserialize thành `Message<BidOffer>`.
- Gọi `monitorService.rcv(bidOffer)` → `MonitorService.handler()` → `bidOfferService.updateBidOffer(bidOffer)`.

### 2.6. BidOfferService.updateBidOffer() — Logic Cập Nhật (Realtime-V2)

File: `realtime-v2/.../services/BidOfferService.java`

```java
// 1. Set timestamp
bidOffer.setCreatedAt(currentDate);
bidOffer.setUpdatedAt(currentDate);

// 2. Cập nhật SymbolInfo trong memory cache & Redis
if (enableAutoData) {
    SymbolInfo symbolInfo = cacheService.getMapSymbolInfo().get(bidOffer.getCode());
    ConvertUtils.updateByBidOffer(symbolInfo, bidOffer);
    // → cập nhật bidPrice, offerPrice, bidVolume, offerVolume,
    //   expectedPrice, expectedChange, expectedRate, session,
    //   totalBid/OfferVolume/Count vào SymbolInfo
    marketRedisDao.setSymbolInfo(symbolInfo);        // Redis Hash: realtime_mapSymbolInfo
    bidOffer.setSequence(symbolInfo.getBidAskSequence()); // gán sequence tăng dần
}

// 3. Generate ID
bidOffer.setId(code + "_" + datetime + "_" + sequence);

// 4. Lưu BidOffer vào Redis (nếu bật)
if (enableSaveBidOffer) {
    marketRedisDao.addBidOffer(bidOffer);  // Redis List: realtime_listBidOffer_{code}
}
```

> **Lưu ý quan trọng:**
> - `ConvertUtils.updateByBidOffer()` synchronizes bidOffer data → SymbolInfo, nghĩa là bảng giá realtime (SymbolInfo) luôn chứa thông tin sổ lệnh mới nhất.
> - `bidAskSequence` tăng dần mỗi lần update → client dùng để detect thay đổi.

---

### 2.7. Luồng OddLot (Lô Lẻ)

#### Ingestion

Collector cũng nhận OddLot data từ cùng nguồn realtime collector (Lotte WebSocket ở runtime hiện tại). OddLot BidOffer/Quote được map sang các TransformData riêng và publish ra các Kafka topic riêng:
- `"bidOfferOddLotUpdate"` — sổ lệnh lô lẻ
- `"quoteOddLotUpdate"` — giá khớp lô lẻ

#### Realtime-V2 Consumers

**`BidOfferOddLotUpdateHandler`** → topic `bidOfferOddLotUpdate` → `monitorService.rcv(BidOfferOddLot)` → `BidOfferService.updateBidOfferOddLot()`:

```java
// Lấy SymbolInfo từ cache OddLot (khác cache chính)
SymbolInfo symbolInfo = cacheService.getMapSymbolInfoOddLot().get(code);
if (symbolInfo == null) {
    // Tự tạo mới nếu chưa có
    symbolInfo = new SymbolInfo();
    symbolInfo.setCode(code);
    symbolInfo.setBidAskSequence(1L);
}
ConvertUtils.updateByBidOfferOddLot(symbolInfo, bidOfferOddLot);
marketRedisDao.setSymbolInfoOddLot(symbolInfo);  // Redis Hash: realtime_mapSymbolInfoOddLot
bidOfferOddLot.setSequence(symbolInfo.getBidAskSequence() + 1);
// Generate ID
bidOfferOddLot.setId(code + "_" + datetime + "_" + sequence);
marketRedisDao.addBidOfferOddLot(bidOfferOddLot); // Redis List
```

**`QuoteOddLotUpdateHandler`** → topic `quoteOddLotUpdate` → `monitorService.rcv(SymbolQuoteOddLot)` → xử lý qua `QuoteService.updateQuote()` nhưng đi nhánh `instanceof SymbolQuoteOddLot`:
- Cập nhật `SymbolInfoOddLot` thay vì `SymbolInfo` thông thường.
- Lưu vào Redis Hash `realtime_mapSymbolInfoOddLot`.

#### Redis sample thực tế cho odd-lot

> Dump Redis user cung cấp đang có sample odd-lot ngày `2024-02-28`, giúp xác nhận nhánh odd-lot dùng key riêng và không reuse shape của board chính.

`realtime_mapSymbolInfoOddLot[SHB]`

```text
4{"code":"SHB","tradingVolume":0,"tradingValue":0.0,"upCount":0,"ceilingCount":0,"unchangedCount":0,"downCount":0,"floorCount":0,"foreignerBuyVolume":0,"foreignerSellVolume":0,"oddlotBidofferTime":"085900","updatedAt":1709110740140,"ptTradingVolume":0,"ptTradingValue":0.0,"foreignerBuyValue":0.0,"foreignerSellValue":0.0,"highLowYearData":[],"isHighlight":1000,"tradeCount":0,"unTradeCount":0,"quoteSequence":0,"bidAskSequence":1,"updatedBy":"BidOfferOddLot","oddlotBidOfferList":[{"bidPrice":11900.0,"bidVolume":254,"offerPrice":11950.0,"offerVolume":333},{"bidPrice":11850.0,"bidVolume":1695,"offerPrice":12000.0,"offerVolume":879},{"bidPrice":11800.0,"bidVolume":2641,"offerPrice":12050.0,"offerVolume":45}],"id":"SHB"}
```

`realtime_listBidOfferOddLot_DGC`

```text
4{"id":"DGC_20240228085900_2","code":"DGC","time":"085900","bidOfferList":[{"bidPrice":110700.0,"bidVolume":5,"offerPrice":111000.0,"offerVolume":79},{"bidPrice":110600.0,"bidVolume":34,"offerPrice":111200.0,"offerVolume":54},{"bidPrice":110500.0,"bidVolume":359,"offerPrice":112100.0,"offerVolume":14}],"updatedAt":1709110740076,"createdAt":1709110740076,"sequence":2}
```

---

## Bước 3: PERSISTENCE (Lưu Trữ)

### 3.1. Redis Keys

| Redis Key Pattern | Kiểu | Mô tả |
|---|---|---|
| `realtime_mapSymbolInfo` | Hash | Chứa bidPrice/offerPrice/volume, expectedPrice/Change/Rate, session, totalBid/Offer |
| `realtime_mapSymbolInfoOddLot` | Hash | Tương tự cho lô lẻ, dùng `oddlotBidOfferList` |
| `realtime_listBidOffer_{code}` | List | Lịch sử sổ lệnh intraday (chỉ khi `enableSaveBidOffer = true`) |
| `realtime_listBidOfferOddLot_{code}` | List | Lịch sử sổ lệnh lô lẻ intraday |

### 3.2. MongoDB

BidOffer **KHÔNG** được lưu trực tiếp xuống MongoDB trong luồng realtime. Dữ liệu BidOffer thực tế chỉ tồn tại trong Redis trong ngày. Trong runtime UAT/PROD hiện tại, `SymbolQuote`/`SymbolQuoteMinute` cũng **không** được snapshot thường xuyên sang Mongo vì `realtime-v2` deploy config đặt `enableSaveQuote=false` và `enableSaveQuoteMinute=false`.

---

## Bước 4: DELIVERY (Phân Phối)

### 4.1. API được phục vụ qua Query-V2

BidOffer **không có API riêng** để query danh sách sổ lệnh lịch sử. Thông tin sổ lệnh được tích hợp vào:

#### API: `/api/v2/market/symbol/latest`
- **Logic:** `redis.hmget(realtime_mapSymbolInfo, symbolList)` → `toSymbolLatestResponse()`
- **Response bao gồm fields từ BidOffer:**
  - `bidPrice`, `offerPrice`, `bidVolume`, `offerVolume`
  - `expectedPrice`, `expectedChange`, `expectedRate`
  - `session`
  - `totalBidVolume`, `totalOfferVolume`, `totalBidCount`, `totalOfferCount`

#### API: `/api/v2/market/symbol/oddlotLatest`
- **Logic:** `redis.hmget(realtime_mapSymbolInfoOddLot, symbolList)` → `toSymbolLatestResponse(, isOddLot=true)`
- **Response:** Tương tự nhưng cho lô lẻ.

#### API: `/api/v2/market/priceBoard`
- **Logic:** `redis.hmget(realtime_mapSymbolInfo, symbolList)` → `toPriceBoardResponse()`
- **Response bao gồm:** Tất cả thông tin realtime kể cả sổ lệnh.

### 4.2. WebSocket Broadcast qua WS-V2 (SocketCluster)

> Đây là chặng **cuối cùng** — dữ liệu sổ lệnh từ Realtime-V2 publish Kafka → ws-v2 consume → broadcast xuống Client App.

#### Kafka → SocketCluster Channel Mapping

**File:** `ws-v2/market.js` → `processDataPublishV2()`

| Kafka Topic | SocketCluster Channel | Parser Function |
|---|---|---|
| `bidOfferUpdate` | `market.bidoffer.{data.code}` | `convertDataPublishV2BidOffer()` |
| `bidOfferOddLotUpdate` | `market.bidofferOddLot.{data.code}` | `convertDataPublishV2BidOfferOddLot()` |

#### Payload viết tắt (`parser.js → convertDataPublishV2BidOffer`)

```javascript
// Input:  { code:"VNM", session:"ATO", bidOfferList:[...], totalBidVolume:50000, ... }
// Output: { s:"VNM", ss:"ATO",
//           bb: [{p:85000, v:1000, c:200}, {p:84900, v:500, c:-100}, ...],  // bestBids
//           bo: [{p:85100, v:800, c:50},  {p:85200, v:300, c:0},   ...],  // bestOffers
//           tb: 50000, to: 45000,     // totalBid/Offer volume
//           ep: 85050, exc: 550, exr: 0.65  // expected price (ATO/ATC only)
//         }
```

#### Snapshot on Subscribe

Khi Client subscribe `market.bidoffer.VNM` với `{ returnSnapShot: true }`:
- ws-v2 extract `code = "VNM"` → query Redis `realtime_mapSymbolInfo` → `convertSymbolInfoV2()` (chứa cả bid/offer data) → trả qua `market.returnSnapshot`.

#### Client Subscribe Pattern

```javascript
socket.subscribe('market.bidoffer.VNM', { returnSnapShot: true });
socket.subscribe('market.bidofferOddLot.VNM');

channel.watch((data) => {
    // data = { s:"VNM", ss:"ATO", bb:[...], bo:[...], ep:85050, exc:550, exr:0.65 }
});
```

---

## SƠ ĐỒ TỔNG QUAN

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                         HTS / LOTTE SERVER                                   │
│              (Socket / WebSocket)                                            │
└─────────────────────────────┬────────────────────────────────────────────────┘
                              │ BidOfferAutoItem / FuturesBidOfferItem
                              ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                       COLLECTOR-LOTTE                                        │
│                                                                              │
│  RealTimeConnectionHandler.receivePacket()                                   │
│       │                                                                      │
│       ├─ Route: BidOfferAutoItem → BidOfferData                             │
│       ├─ Route: FuturesBidOfferItem → FuturesBidOfferData                   │
│       ▼                                                                      │
│  ThreadHandler.handle()                                                      │
│       ├─ parse() → extract bidOfferList (3 bước giá)                        │
│       ├─ session = controlCode → "ATO"/"ATC"/"CONTINUOUS"                   │
│       ├─ expectedPrice = projectOpen (chỉ ATO/ATC, > 0)                    │
│       ├─ handleAutoData(BidOffer):                                           │
│       │    expectedChange = expectedPrice - referencePrice                   │
│       │    expectedRate   = (expectedChange / referencePrice) × 100          │
│       └─ kafkaPublishRealtime("bidOfferUpdate", data)                       │
│                                                                              │
│  [Song song] OddLot BidOffer → "bidOfferOddLotUpdate"                       │
│              OddLot Quote   → "quoteOddLotUpdate"                            │
└─────────────────────────────┬────────────────────────────────────────────────┘
                              │ Kafka: bidOfferUpdate / bidOfferOddLotUpdate
                              ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                       REALTIME-V2                                            │
│                                                                              │
│  BidOfferUpdateHandler          BidOfferOddLotUpdateHandler                  │
│       │                               │                                      │
│       ▼                               ▼                                      │
│  BidOfferService                BidOfferService                              │
│  .updateBidOffer()              .updateBidOfferOddLot()                      │
│       │                               │                                      │
│       ├─ updateByBidOffer()           ├─ updateByBidOfferOddLot()           │
│       │  → realtime_mapSymbolInfo     │  → realtime_mapSymbolInfoOddLot     │
│       └─ addBidOffer()                └─ addBidOfferOddLot()                │
│          → realtime_listBidOffer_{code}  → realtime_listBidOfferOddLot_{code}│
│                                                                              │
└─────────────────────────────┬────────────────────────────────────────────────┘
                              │ Redis (read)
                              ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                       QUERY-V2 (NodeJS)                                      │
│                                                                              │
│  RequestHandler.ts → SymbolService                                           │
│       ├─ /symbol/latest       → hmget realtime_mapSymbolInfo                │
│       ├─ /symbol/oddlotLatest → hmget realtime_mapSymbolInfoOddLot          │
│       └─ /priceBoard          → hmget realtime_mapSymbolInfo                │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```
