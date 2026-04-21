# 04 - VÒNG ĐỜI DỮ LIỆU: EXTRA UPDATE FLOW + TOÀN BỘ QUERY-V2 APIs

> Phần 1: Luồng ExtraUpdate (Basis Futures, BreakEven CW, PT data, ForeignerDaily).
> Phần 2: Tham chiếu đầy đủ ALL Query-V2 API endpoints — code-backed specification.

> **Controller Path (ALL endpoints):** `market-query-v2/src/consumers/RequestHandler.ts`
> **Transport:** Kafka request/response pattern (RequestHandler receives Kafka messages, routes by `message.uri`).

---

## REDIS KEY CONSTANTS

File: `market-query-v2/src/services/RedisService.ts`

```typescript
export const REDIS_KEY = {
  SYMBOL_INFO: 'realtime_mapSymbolInfo',               // Hash
  SYMBOL_INFO_ODD_LOT: 'realtime_mapSymbolInfoOddLot', // Hash
  SYMBOL_DAILY: 'realtime_mapSymbolDaily',              // Hash
  FOREIGNER_DAILY: 'realtime_mapForeignerDaily',        // Hash
  SYMBOL_QUOTE: 'realtime_listQuote',                   // List (per symbol: realtime_listQuote_{code})
  SYMBOL_QUOTE_META: 'realtime_listQuoteMeta',          // String (per symbol: realtime_listQuoteMeta_{code})
  SYMBOL_STATISTICS: 'realtime_mapSymbolStatistic',     // Hash
  SYMBOL_BID_OFFER: 'realtime_listBidOffer',            // List (per symbol)
  SYMBOL_QUOTE_MINUTE: 'realtime_listQuoteMinute',      // List (per symbol: realtime_listQuoteMinute_{code})
  DEAL_NOTICE: 'realtime_listDealNotice',               // List (per market: realtime_listDealNotice_{HOSE|HNX|UPCOM})
  ADVERTISED: 'realtime_listAdvertised',                // List (per market: realtime_listAdvertised_{HOSE|HNX|UPCOM})
  MARKET_STATUS: 'realtime_mapMarketStatus',            // Hash
  SYMBOL_INFO_EXTEND: 'symbolInfoExtend',               // Hash
  STOCK_RANKING_PERIOD: 'market_rise_false_stock_ranking', // String (key: market_rise_false_stock_ranking_{market}_{ranking}_{period})
  SYMBOL_STOCK_RIGHT: 'market_right_info',              // String (per symbol: market_right_info_{code})
  NOTIFICATION: 'notice_',                              // Hash (per type: notice_{type})
};
```

## REDIS RUNTIME SAMPLES

> Các query section phía dưới đang đọc đúng những shape dữ liệu tương tự các sample runtime do user cung cấp. Full raw dumps được neo ở file `06_runtime_market_data_flow_current.md`; phần này chỉ giữ summary để đối chiếu nhanh với từng key/query contract.

| Redis key / field | Sample runtime đáng chú ý | Query/API liên quan |
|---|---|---|
| `realtime_mapSymbolInfo[SHB]` | `date="20260420"`, `last=15300`, `bidOfferList[0]={bidPrice:15250, offerPrice:15300}`, `quoteSequence=8928`, `bidAskSequence=27341` | `querySymbolLatest`, `queryPriceBoard`, `querySymbolPeriod`, các ranking/summary APIs đọc latest board |
| `realtime_mapSymbolInfoOddLot[SHB]` | `oddlotBidofferTime="085900"`, `oddlotBidOfferList` có 3 steps, `updatedBy="BidOfferOddLot"` | `querySymbolLatestOddLot` |
| `realtime_listQuote_SHB` | tick có `sequence=8928`, `matchedBy="ASK"`, `tradingVolume=47390400`, `activeBuyVolume=15891000`, `activeSellVolume=31499400` | `querySymbolQuote`, `queryQuoteData`, `querySymbolQuoteTick`, `querySymbolTickSizeMatch` |
| `realtime_listQuoteMinute_SHB` | minute candle có `time="074500"`, `periodTradingVolume=8363800` | `querySymbolQuoteMinutes`, `queryMinuteChart` |
| `realtime_mapSymbolDaily[SHB]` | `id="SHB_20260420"`, `open=15200`, `high=15300`, `last=15300` | `querySymbolPeriod`, historical/day APIs |
| `realtime_mapForeignerDaily[SHB]` | sample dump đang mang ngày `2024-07-12`, gồm `foreignerCurrentRoom`, `foreignerHoldVolume`, `foreignerBuyVolume`, `foreignerSellVolume` | `querySymbolForeignerDaily` |
| `realtime_mapSymbolStatistic[SHB]` | `totalBuyVolume=15891000`, `totalSellVolume=31479000`, `prices[]` breakdown theo `price/matchedVolume` | `querySymbolStatistics` |
| `realtime_mapMarketStatus[HOSE_EQUITY]` | `status="LO"`, `market="HOSE"`, `type="EQUITY"`, `title="(HOSE) Market Open"` | `queryMarketSessionStatus` |
| `realtime_listBidOfferOddLot_DGC` | odd-lot history list sample có `sequence=2`, 3 mức giá bid/offer | không có public API riêng; được dùng làm history/runtime reference cho odd-lot flow |

> Lưu ý về ngày: bộ sample đang pha dữ liệu của `2026-04-20`, `2024-07-12` và `2024-02-28`, nên không nên giả định toàn bộ key cùng snapshot thời điểm.

---

## PHẦN 1: EXTRA UPDATE FLOW

### 1.1. ExtraUpdate — Object trung gian (Collector)

File: `collector/.../model/realtime/ExtraUpdate.java`

| Field | Kiểu | Mô tả |
|---|---|---|
| `code` | String | Mã CK |
| `basis` | Double | Chênh lệch Futures vs VN30 |
| `ptVolume` | long | Tổng KL thỏa thuận tích lũy |
| `ptValue` | double | Tổng GTGD thỏa thuận tích lũy |

**Nguồn phát sinh ExtraUpdate (trong Collector):**

| Nguồn | Trigger | Data |
|---|---|---|
| `handleAutoData(IndexUpdateData)` — VN30 | Khi nhận VN30 index update | `basis = futuresLast - vn30Last` cho mỗi VN30F* |
| `handleAutoData(FuturesUpdateData)` | Khi nhận futures update | `basis = futuresLast - vn30Last` |
| `handleAutoData(StockUpdateData)` — CW | Khi nhận CW stock update | `breakEven = last × exerciseRatio + exercisePrice` |
| `DealNoticeData` → `ExtraUpdate.fromDealNotice()` | Khi nhận deal notice | `ptVolume` và `ptValue` tích lũy |

→ Tất cả publish: `kafkaPublishRealtime("extraUpdate", extraUpdate)`.

### 1.2. ExtraQuoteService.updateExtraQuote() — Logic Xử Lý

File: `realtime-v2/.../services/ExtraQuoteService.java`

```java
public void updateExtraQuote(ExtraQuote extraQuote) {
    if (!enableAutoData) return;
    // 1. Cập nhật SymbolInfo (basis, breakEven, ptVolume, ptValue, highYear, lowYear)
    SymbolInfo symbolInfo = cacheService.getMapSymbolInfo().get(code);
    ConvertUtils.updateByExtraQuote(symbolInfo, extraQuote);
    marketRedisDao.setSymbolInfo(symbolInfo);   // Redis Hash: SYMBOL_INFO

    // 2. Cập nhật ForeignerDaily
    ForeignerDaily foreignerDaily = cacheService.getMapForeignerDaily().get(code);
    ConvertUtils.updateByExtraQuote(foreignerDaily, extraQuote);
    marketRedisDao.setForeignerDaily(foreignerDaily);  // Redis Hash: FOREIGNER_DAILY

    // 3. Upsert SymbolDaily
    upsertSymbolDaily(extraQuote, symbolInfo);  // Redis Hash: SYMBOL_DAILY
}
```

---

## PHẦN 2: QUERY-V2 — COMPREHENSIVE API SPECIFICATION

---

### 2.1. Symbol — Giá Realtime

---

#### `querySymbolLatestNormal`
- **Endpoint:** `/api/v2/market/symbol/latest`
- **Service:** `SymbolService.querySymbolLatestNormal()` → `querySymbolLatest(request, false)`
- **File:** `market-query-v2/src/services/SymbolService.ts:544`
- **Request:**
  ```typescript
  interface SymbolLatestRequest {
    symbolList: string[];  // Required. List of symbol codes
  }
  ```
- **Data Source & Logic:**
  - Storage: **Redis Hash**
  - Key: `realtime_mapSymbolInfo`
  - Operation: `HMGET realtime_mapSymbolInfo [symbolList]`
  - Filter: removes null entries
  - Transform: `toSymbolLatestResponse(symbolInfo, isOddLot=false)`

---

#### `querySymbolLatestOddLot`
- **Endpoint:** `/api/v2/market/symbol/oddlotLatest`
- **Service:** `SymbolService.querySymbolLatestOddLot()` → `querySymbolLatest(request, true)`
- **File:** `market-query-v2/src/services/SymbolService.ts:548`
- **Request:**
  ```typescript
  interface SymbolLatestRequest {
    symbolList: string[];  // Required. List of symbol codes
  }
  ```
- **Data Source & Logic:**
  - Storage: **Redis Hash**
  - Key: `realtime_mapSymbolInfoOddLot`
  - Operation: `HMGET realtime_mapSymbolInfoOddLot [symbolList]`
  - Filter: removes null entries
  - Transform: `toSymbolLatestResponse(symbolInfo, isOddLot=true)`

---

#### `queryPriceBoard`
- **Endpoint:** `/api/v2/market/priceBoard`
- **Service:** `SymbolService.queryPriceBoard()`
- **File:** `market-query-v2/src/services/SymbolService.ts:552`
- **Request:**
  ```typescript
  interface IPriceBoardRequest {
    symbolList: string[];  // Required. List of symbol codes
    category?: string;     // Optional. PRICE_BOARD_CATEGORY: FAVORITE_LIST (default), HOSE, HNX, UPCOM, VN30, HNX30...
  }
  ```
- **Data Source & Logic:**
  - Storage: **Redis Hash**
  - Key: `realtime_mapSymbolInfo`
  - Operation: `HMGET realtime_mapSymbolInfo [symbolList]`
  - Filter: removes null entries
  - Transform: `toPriceBoardResponse(symbolInfoList, category)`

---

#### `querySymbolStaticInfo`
- **Endpoint:** `/api/v2/market/symbol/staticInfo`
- **Service:** `SymbolService.querySymbolStaticInfo()`
- **File:** `market-query-v2/src/services/SymbolService.ts:588`
- **Request:**
  ```typescript
  interface SymbolStaticInfoRequest {
    symbolList?: string[];  // Optional. If empty → returns ALL symbols
  }
  ```
- **Data Source & Logic:**
  - Storage: **Redis Hash**
  - Key: `realtime_mapSymbolInfo` + `symbolInfoExtend`
  - Operation:
    - If `symbolList` empty: `HGETALL realtime_mapSymbolInfo` + `HGETALL symbolInfoExtend` → merge by code
    - If `symbolList` provided: `HMGET realtime_mapSymbolInfo [symbolList]`
  - Transform: `toSymbolStaticInfoResponse(symbolInfo, symbolExtend)` — returns referencePrice, ceiling, floor, listedQty, avgTradingVol10

---

> **Runtime note (UAT/PROD hiện tại):** Deploy scripts của `realtime-v2` set `enableSaveQuote=false` và `enableSaveQuoteMinute=false`. Vì vậy Redis là storage intraday chính cho quote/minute; các nhánh query Mongo bên dưới là **fallback code path** và chỉ trả dữ liệu khi có manual dump/backfill hoặc môi trường khác bật persist.

#### `querySymbolQuote`
- **Endpoint:** `/api/v2/market/symbol/{symbol}/quote`
- **Service:** `SymbolService.querySymbolQuote()`
- **File:** `market-query-v2/src/services/SymbolService.ts:275`
- **Request:**
  ```typescript
  interface SymbolQuoteRequest {
    symbol: string;              // Required. Symbol code
    fetchCount?: number;         // Optional. Default: DEFAULT_PAGE_SIZE
    lastTradingVolume?: number;  // Optional. Cursor: only return quotes with tradingVolume < this value
  }
  ```
- **Data Source & Logic:**
  - Storage: **Redis List** (multi-partition)
  - Meta key: `realtime_listQuoteMeta_{symbol}` — contains `ListQuoteMeta { partitions: QuotePartition[] }`
  - Data keys: `realtime_listQuote_{symbol}` (default) + `realtime_listQuote_{symbol}_{partition}` (overflow partitions)
  - Operation: `LRANGE` on each partition from latest to oldest, filter `tradingVolume < lastTradingVolume`, stop at `fetchCount`
  - Transform: `toSymbolQuoteResponse(quote)`

---

#### `queryQuoteData`
- **Endpoint:** `/api/v2/market/symbolQuote/{symbol}`
- **Service:** `SymbolService.queryQuoteData()`
- **File:** `market-query-v2/src/services/SymbolService.ts:325`
- **Request:**
  ```typescript
  interface IQuoteRequest {
    symbol: string;       // Required
    fetchCount?: number;  // Optional. Default: DEFAULT_PAGE_SIZE
    lastIndex?: number;   // Optional. Index-based cursor (start from lastIndex+1)
  }
  ```
- **Data Source & Logic:**
  - Storage: **Redis List** (multi-partition)
  - Meta key: `realtime_listQuoteMeta_{symbol}`
  - Data keys: `realtime_listQuote_{symbol}` + partition keys
  - Operation: Index-based pagination across partitions using `LRANGE(key, startIndex, endIndex)`
  - Returns: `toQuoteResponse(symbolQuotes, totalIndex, endIndex)`
  - **Key difference from `querySymbolQuote`:** uses index-based pagination instead of volume-based cursor

---

#### `querySymbolQuoteTick`
- **Endpoint:** `/api/v2/market/symbol/{symbol}/ticks`
- **Service:** `SymbolService.querySymbolQuoteTick()`
- **File:** `market-query-v2/src/services/SymbolService.ts:436`
- **Request:**
  ```typescript
  interface SymbolQuoteTickRequest {
    symbol: string;          // Required
    fetchCount?: number;     // Optional. Default: DEFAULT_PAGE_SIZE
    tickUnit: number;        // Required. Group N ticks into 1 candle
    toSequence?: number;     // Optional. Upper bound sequence (default: MAX_SAFE_INTEGER)
    fromSequence?: number;   // Optional. Lower bound sequence (default: 0)
  }
  ```
- **Data Source & Logic:**
  - Storage: **Redis List** + **optional MongoDB fallback** `SymbolQuote`
  - Redis key: `realtime_listQuote_{symbol}` → `LRANGE 0 -1`, filter by `sequence` range, sort desc
  - MongoDB fallback: `SymbolQuote.find({ code, sequence: {$lt, $gt}, date: today })` — only when Redis doesn't have enough records **and** Mongo actually has intraday data
  - Merge: concat Redis + MongoDB, group by `getKeySymbolQuoteTick(quote, tickUnit)`, aggregate OHLCV:
    ```
    high = max(all highs), low = min(all lows)
    last = latest sequence's last, open = earliest sequence's open
    periodTradingVolume = higherSequence.tradingVolume - current.tradingVolume
    ```

---

#### `querySymbolQuoteMinutes`
- **Endpoint:** `/api/v2/market/symbol/{symbol}/minutes`
- **Service:** `SymbolService.querySymbolQuoteMinutes()`
- **File:** `market-query-v2/src/services/SymbolService.ts:389`
- **Request:**
  ```typescript
  interface SymbolQuoteMinuteRequest {
    symbol: string;       // Required
    fetchCount?: number;  // Optional. Default: DEFAULT_PAGE_SIZE
    minuteUnit: number;   // Required. Group by N minutes
    fromTime?: string;    // Optional. DateTime format (default: start of today)
    toTime?: string;      // Optional. DateTime format (default: end of today)
  }
  ```
- **Data Source & Logic:**
  - Storage: **Redis List** + **optional MongoDB fallback** `SymbolQuoteMinute`
  - Delegates to: `CommonService.actualQueryQuoteMinuteThenGrouped(symbol, fromTime, toTime, fetchCount, minuteUnit)`
  - Transform: `toSymbolQuoteMinutesResponse(item, minuteUnit)`

---

#### `queryMinuteChart`
- **Endpoint:** `/api/v2/market/symbol/{symbol}/minuteChart`
- **Service:** `SymbolService.queryMinuteChart()`
- **File:** `market-query-v2/src/services/SymbolService.ts:409`
- **Request:**
  ```typescript
  interface IMinuteChartRequest {
    symbol: string;  // Required
  }
  ```
- **Data Source & Logic:**
  - Storage: **Redis List**
  - Key: `realtime_listQuoteMinute_{symbol}`
  - Operation: `LRANGE realtime_listQuoteMinute_{symbol} 0 -1`
  - **Caching:** Uses `CacheService.cacheMinuteChart` (in-memory Map). If cache hit → return immediately. Cache auto-invalidated after Promise resolves.
  - Transform: `toMinuteChartResponse(symbolQuoteMinutes)` — aggregates all minute candles into chart-ready format

---

#### `querySymbolStatistics`
- **Endpoint:** `/api/v2/market/symbol/{symbol}/statistic`
- **Service:** `SymbolService.querySymbolStatistics()`
- **File:** `market-query-v2/src/services/SymbolService.ts:379`
- **Request:**
  ```typescript
  interface ISymbolStatisticsRequest {
    symbol: string;        // Required
    pageSize: number;      // Required
    pageNumber: number;    // Required
    sortBy?: string;       // Optional
  }
  ```
- **Data Source & Logic:**
  - Storage: **Redis Hash**
  - Key: `realtime_mapSymbolStatistic`
  - Operation: `HGET realtime_mapSymbolStatistic {symbol}`
  - Transform: `toSymbolStatisticsResponse(symbolStatistics, pageSize, pageNumber, sortBy)` — server-side pagination + sorting

---

#### `querySymbolTickSizeMatch`
- **Endpoint:** `/api/v2/market/symbol/tickSizeMatch`
- **Service:** `SymbolService.querySymbolTickSizeMatch()`
- **File:** `market-query-v2/src/services/SymbolService.ts:736`
- **Request:**
  ```typescript
  interface SymbolTickSizeMatchRequest {
    symbol: string;  // Required
  }
  ```
- **Data Source & Logic:**
  - Storage: **Redis List**
  - Key: `realtime_listQuote_{symbol}`
  - Operation: `LRANGE realtime_listQuote_{symbol} 0 -1`
  - Transform: `toSymbolTickSizeMatchResponse(listSymbolQuote)` — groups tick data by price step (tick size)

---

#### `queryMarketSessionStatus`
- **Endpoint:** `/api/v2/market/sessionStatus`
- **Service:** `MarketSessionStatusService.queryMarketSessionStatus()`
- **File:** `market-query-v2/src/services/MarketSessionStatusService.ts:16`
- **Request:**
  ```typescript
  interface MarketSessionStatusRequest {
    market?: string;  // Optional. 'HOSE' | 'HNX' | 'UPCOM' | 'ALL' (default)
    type?: string;    // Optional. Session type filter (e.g., 'EQUITY', 'DERIVATIVE')
  }
  ```
- **Data Source & Logic:**
  - Storage: **Redis Hash**
  - Key: `realtime_mapMarketStatus`
  - Operation: `HGETALL realtime_mapMarketStatus`
  - Filter: by `market` and `type` if provided
  - Transform: `toMarketSessionStatusResponse(value)`

---

### 2.2. Symbol — Lịch Sử & Phân Tích

---

#### `querySymbolPeriod`
- **Endpoint:** `/api/v2/market/symbol/{symbol}/period/{periodType}`
- **Service:** `SymbolService.querySymbolPeriod()`
- **File:** `market-query-v2/src/services/SymbolService.ts:609`
- **Request:**
  ```typescript
  interface SymbolPeriodRequest {
    symbol: string;       // Required
    periodType: string;   // Required. 'D' (Daily) | 'W' (Weekly) | 'M' (Monthly) | 'Y' (Yearly)
    fetchCount?: number;  // Optional. Default: DEFAULT_PAGE_SIZE
    baseDate?: string;    // Optional. Pagination cursor date (default: tomorrow)
  }
  ```
- **Data Source & Logic:**
  - Storage: **Redis Hash** (`realtime_mapSymbolInfo` for today) + **MongoDB** `SymbolDaily` (historical)
  - Operation:
    1. `HGET realtime_mapSymbolInfo {symbol}` → get today's SymbolInfo
    2. `CommonService.actualQuerySymbolPeriod()` → query MongoDB `SymbolDaily { code, date < baseDate }` sorted `date: -1` limit `fetchCount`, then groups by period (D/W/M/Y) calculating OHLCV aggregates

---

#### `querySymbolForeignerDaily`
- **Endpoint:** `/api/v2/market/symbol/{symbolCode}/foreigner`
- **Service:** `SymbolService.querySymbolForeignerDaily()`
- **File:** `market-query-v2/src/services/SymbolService.ts:623`
- **Request:**
  ```typescript
  interface ForeignerDailyRequest {
    symbol: string;       // Required
    fetchCount?: number;  // Optional. Default: DEFAULT_PAGE_SIZE
    baseDate?: string;    // Optional. Pagination cursor date
    fromDate?: string;    // Optional. Range filter start
    toDate?: string;      // Optional. Range filter end (default: today)
  }
  ```
- **Data Source & Logic:**
  - Storage: **MongoDB** `ForeignerDaily` + **Redis Hash** `realtime_mapForeignerDaily` (hybrid)
  - MongoDB query: `ForeignerDaily.find({ code, date: { $gte: fromDate, $lt: baseDate, $lte: toDate } }).sort({date:-1}).limit(fetchCount)`
  - Redis overlay: If result list has today's data AND `toDate >= today`, replace first record with `HGET realtime_mapForeignerDaily {symbol}` (latest realtime data)

---

#### `querySymbolRight`
- **Endpoint:** `/api/v2/market/symbol/{symbol}/right`
- **Service:** `SymbolService.querySymbolRight()`
- **File:** `market-query-v2/src/services/SymbolService.ts:207`
- **Request:**
  ```typescript
  interface ISymbolStockRightRequest {
    symbol: string;  // Required
  }
  ```
- **Data Source & Logic:**
  - Storage: **Redis String**
  - Key: `market_right_info_{symbol}`
  - Operation: `GET market_right_info_{symbol}`
  - Transform: `toSymbolStockRightResponse(symbolRight)`
  - Note: Set by Collector's `RightInfoService` with TTL 2h

---

#### `querySymbolDailyReturns`
- **Endpoint:** `/api/v2/market/dailyReturns`
- **Service:** `SymbolService.querySymbolDailyReturns()`
- **File:** `market-query-v2/src/services/SymbolService.ts:1070`
- **Request:**
  ```typescript
  interface SymbolDailyReturnsRequest {
    symbolList: string[];     // Required
    numberOfDays?: number;    // Optional. Default: DEFAULT_QUERY_DAILY_RETURN_DAYS
  }
  ```
- **Data Source & Logic:**
  - Storage: **MongoDB** `SymbolDaily`
  - Operation: `SymbolDailyRepository.queryGroupedSymbolDailyList(symbolList, numberOfDays)` — uses MongoDB aggregation `$group` by `code`
  - Returns: `{ [code]: number[] }` — map of symbol code → array of daily `returns` values (log returns)

---

#### `initSymbolDailyReturns`
- **Endpoint:** `/api/v2/market/dailyReturns/init`
- **Service:** `SymbolService.initSymbolDailyReturns()`
- **File:** `market-query-v2/src/services/SymbolService.ts:1008`
- **Request:**
  ```typescript
  interface SymbolDailyReturnsInitRequest {
    symbolList?: string[];  // Optional. If empty → calculates for ALL CW underlying symbols
    floorDate?: string;     // Optional. Start date (default: DEFAULT_FLOOR_DATE)
  }
  ```
- **Data Source & Logic:**
  - Storage: **MongoDB** `SymbolDaily` (read + write)
  - Operation:
    1. If no symbolList → `getAllUnderlyingSymbolList()` (find all CW symbols → extract unique `underlyingSymbol`)
    2. `queryGroupedSymbolDailyList(symbols, MAX, floorDate)` — aggregation groups by code, sorts by date descending
    3. Calculate: `returns = Math.log(current.last / previousLast)` — logarithmic daily return
    4. `updateReturnsByBulk(finalList)` — bulk update MongoDB `SymbolDaily.returns` field
  - **Admin endpoint** — recalculates historical returns for all symbols

---

### 2.3. Ranking & Sorting

---

#### `querySymbolRankingTrade`
- **Endpoint:** `/api/v2/market/ranking/{symbolType}/trade`
- **Service:** `SymbolService.querySymbolRankingTrade()`
- **File:** `market-query-v2/src/services/SymbolService.ts:907`
- **Request:**
  ```typescript
  interface StockRankingTradeRequest {
    symbolType: string;    // From URI path
    offset?: number;       // Optional. Default: 0
    fetchCount?: number;   // Optional. Default: DEFAULT_PAGE_SIZE
    marketType?: string;   // Optional. 'HOSE'|'HNX'|'UPCOM'|'ALL' (default)
    sortType: string;      // Required. 'TRADING_VOLUME' | 'TRADING_VALUE' | 'TURNOVER_RATE'
  }
  ```
- **Data Source & Logic:**
  - Storage: **Redis Hash**
  - Key: `realtime_mapSymbolInfo`
  - Operation: `HGETALL realtime_mapSymbolInfo`
  - Filter: `type === STOCK`, then by `marketType`
  - Sort:
    - `TRADING_VOLUME`: `b.tradingVolume - a.tradingVolume` (desc)
    - `TRADING_VALUE`: `b.tradingValue - a.tradingValue` (desc)
    - Default: `b.turnoverRate - a.turnoverRate` (desc)
  - Pagination: `slice(offset, offset + fetchCount)`

---

#### `queryStockRankingUpDown`
- **Endpoint:** `/api/v2/market/stock/ranking/upDown`
- **Service:** `SymbolService.queryStockRankingUpDown()`
- **File:** `market-query-v2/src/services/SymbolService.ts:674`
- **Request:**
  ```typescript
  interface StockRankingUpDownRequest {
    fetchCount?: number;   // Optional. Default: DEFAULT_PAGE_SIZE
    offset?: number;       // Optional. Default: 0
    marketType?: string;   // Optional. 'HOSE'|'HNX'|'UPCOM'|'ALL' (default)
    upDownType?: string;   // Optional. 'UP' | 'DOWN' (default)
  }
  ```
- **Data Source & Logic:**
  - Storage: **Redis Hash**
  - Key: `realtime_mapSymbolInfo`
  - Operation: `HGETALL`, filter `type === STOCK`
  - Sort: by `rate` field. UP = ascending (worst first), DOWN = descending (best first)
  - **Special:** When `marketType === ALL`, returns split response: `{ HNX: [...], HOSE: [...], UPCOM: [...] }` — each market sorted independently

---

#### `queryStockRankingTop`
- **Endpoint:** `/api/v2/market/stock/ranking/top`
- **Service:** `SymbolService.queryStockRankingTop()`
- **File:** `market-query-v2/src/services/SymbolService.ts:747`
- **Request:**
  ```typescript
  interface StockRankingTopRequest {
    fetchCount?: number;   // Optional. Default: DEFAULT_PAGE_SIZE
    offset?: number;       // Optional. Default: 0
    marketType?: string;   // Optional. 'HOSE'|'HNX'|'UPCOM'|'ALL' (default)
    sortType?: string;     // Optional. 'TRADING_VOLUME'|'TRADING_VALUE'|'CHANGE'|'RATE'|'POWER' (default: TRADING_VOLUME)
    upDownType?: string;   // Optional. 'UP'|'DOWN' (default: DOWN)
  }
  ```
- **Data Source & Logic:**
  - Storage: **Redis Hash**
  - Key: `realtime_mapSymbolInfo`
  - Operation: `HGETALL`, filter `type === STOCK`, then by `marketType`
  - Sort by `sortType`:
    - `TRADING_VOLUME/VALUE/CHANGE/RATE`: standard sort
    - **`POWER` (DOWN):** filter `bidVolume × bidPrice > POWER_STOCK_SORT_THRESHOLD && bidPrice === ceilingPrice` → sort `bidVolume × bidPrice` desc — **finds stocks with strongest ceiling bid pressure**
    - **`POWER` (UP):** filter `offerVolume × offerPrice > threshold && offerPrice === floorPrice` → sort `offerVolume × offerPrice` desc — **finds stocks with strongest floor sell pressure**

---

#### `queryStockRankingPeriod`
- **Endpoint:** `/api/v2/market/stock/ranking/period`
- **Service:** `SymbolService.queryStockRankingPeriod()`
- **File:** `market-query-v2/src/services/SymbolService.ts:1187`
- **Request:**
  ```typescript
  interface IQueryStockRankingPeriod {
    ranking: string;      // Required. Ranking type identifier
    period: string;       // Required. Period identifier (e.g., '5D', '20D', '250D')
    marketType?: string;  // Optional. 'HOSE'|'HNX'|'UPCOM'|'ALL' (default)
    pageSize?: number;    // Optional. Default: 20
    pageNumber?: number;  // Optional. Default: 0
  }
  ```
- **Data Source & Logic:**
  - Storage: **Redis String** (pre-computed by Collector's `RiseFallStockRankService`)
  - Key: `market_rise_false_stock_ranking_{marketType}_{ranking}_{period}`
  - Operation: `GET` → parse `IRedisStockRankingPeriodResponse { symbols: [...] }` → paginate `slice(pageNumber * pageSize, pageNumber * pageSize + pageSize)`

---

#### `queryForeignerRanking`
- **Endpoint:** `/api/v2/market/ranking/foreigner`
- **Service:** `SymbolService.queryForeignerRanking()`
- **File:** `market-query-v2/src/services/SymbolService.ts:822`
- **Request:**
  ```typescript
  interface IForeignerRankingRequest {
    type: string;      // Required. 'BUY' | 'SELL'
    market?: string;   // Optional. 'HOSE'|'HNX'|'UPCOM'|'ALL' (default)
  }
  ```
- **Data Source & Logic:**
  - Storage: **Redis Hash**
  - Key: `realtime_mapSymbolInfo`
  - Operation: `HGETALL`, filter `type === STOCK`, then by `market`
  - Sort:
    - `BUY`: sort by `foreignerBuyVolume` descending
    - `SELL`: sort by `foreignerSellVolume` descending
  - **Fixed limit: top 10 results** (`splice(0, 10)`)

---

#### `queryTopForeignerTrading`
- **Endpoint:** `/api/v2/market/topForeignerTrading`
- **Service:** `SymbolService.queryTopForeignerTrading()`
- **File:** `market-query-v2/src/services/SymbolService.ts:869`
- **Request:**
  ```typescript
  interface TopForeignerTradingRequest {
    fetchCount?: number;   // Optional. Default: DEFAULT_TOP_FOREIGNER_TRADING
    offset?: number;       // Optional. Default: 0
    marketType?: string;   // Optional. 'HOSE'|'HNX'|'UPCOM'|'ALL' (default)
    upDownType?: string;   // Optional. 'UP'|'DOWN' (default: DOWN)
  }
  ```
- **Data Source & Logic:**
  - Storage: **Redis Hash**
  - Key: `realtime_mapSymbolInfo`
  - Sort formula: **`(foreignerBuyVolume × last) - (foreignerSellVolume × last)`** — net foreigner trading value
  - DOWN = descending (net buyers first), UP = ascending (net sellers first)

---

#### `queryTopAiRating`
- **Endpoint:** `/api/v2/market/topAiRating`
- **Service:** `TopAiRatingService.queryTopAiRating()`
- **File:** `market-query-v2/src/services/TopAiRatingService.ts:15`
- **Request:**
  ```typescript
  interface TopAiRatingRequest {
    fetchCount?: number;    // Optional. Default: DEFAULT_PAGE_SIZE
    lastOverAll?: number;   // Optional. Cursor: last overall score from previous page
    lastCode?: string;      // Optional. Cursor: last code from previous page
  }
  ```
- **Data Source & Logic:**
  - Storage: **MongoDB** collection `TopAiRating`
  - Operation: Cursor-based pagination using `lastOverAll` + `lastCode`:
    1. Major list: `find({ overall: { $lt: lastOverAll } }).sort({overall:-1}).limit(fetchCount)`
    2. Minor list: `find({ overall: lastOverAll })` → skip records until after `lastCode`
    3. Merge: `minorList.concat(majorList).splice(0, fetchCount)`
  - If no cursor: `find({}).sort({overall:-1}).limit(fetchCount)`

---

### 2.4. Index & Market

---

#### `queryIndexList`
- **Endpoint:** `/api/v2/market/index/list`
- **Service:** `SymbolService.queryIndexList()`
- **File:** `market-query-v2/src/services/SymbolService.ts:184`
- **Request:**
  ```typescript
  interface IIndexListRequest {
    market?: string;  // Optional. 'HOSE'|'HNX'|'UPCOM'|'ALL' (default if empty/null)
  }
  ```
- **Data Source & Logic:**
  - Storage: **Redis Hash**
  - Key: `realtime_mapSymbolInfo`
  - Operation: `HGETALL realtime_mapSymbolInfo`
  - Filter: `symbolInfo.type === 'INDEX'`, then by `marketType` if not ALL
  - Returns: `string[]` — list of index codes (e.g., `['VN', 'HNX', 'UPCOM', 'VN30', ...]`)

---

#### `queryIndexStockList`
- **Endpoint:** `/api/v2/market/indexStockList/{indexCode}`
- **Service:** `SymbolService.queryIndexStockList()`
- **File:** `market-query-v2/src/services/SymbolService.ts:263`
- **Request:**
  ```typescript
  interface IndexStockListRequest {
    indexCode: string;  // Required. From URI path (e.g., 'VN30', 'HNX30')
  }
  ```
- **Data Source & Logic:**
  - Storage: **MongoDB** collection `IndexStockList`
  - Operation: `IndexStockListRepository.findOneBy({ _id: indexCode })`
  - Transform: `toIndexStockListResponse(indexStockList)`

---

#### `queryMarketLiquidity`
- **Endpoint:** `/api/v2/market/liquidity`
- **Service:** `ChartService.queryMarketLiquidity()`
- **File:** `market-query-v2/src/services/ChartService.ts:175`
- **Request:**
  ```typescript
  interface MarketLiquidityRequest {
    market: string;    // Required. 'HOSE'|'HNX'|'UPCOM'
    from?: string;     // Optional. Date string
    to?: string;       // Optional. Date string
  }
  ```
- **Data Source & Logic:**
  - Storage:
    - **Hôm nay:** Redis `realtime_listQuoteMinute_{MARKET_INDEX_ENUM[market]}`
    - **Ngày quá khứ:** MongoDB `SymbolQuoteMinute` của **market index symbol** (`VN`, `HNX`, `UPCOM`)
  - Operation: `querySingleDateMarketLiquidity(date, market)` for each date in range
    1. Nếu date = hôm nay và Redis còn data → đọc minute list từ Redis
    2. Ngược lại query `SymbolQuoteMinute` theo `code = MARKET_INDEX_ENUM[market]` và khoảng ngày
    3. Transform: `getMinuteLiquidityList()` → trả `[time, tradingValue][]`
  - **Lưu ý runtime:** Với ngày quá khứ, kết quả phụ thuộc việc Mongo có minute data hay không; ở UAT/PROD hiện tại dữ liệu này thường chỉ có nếu manual dump/backfill.

---

#### `getLastTradingDate`
- **Endpoint:** `/api/v2/market/lastTradingDate`
- **Service:** `MarketInfoService.getLastTradingDate()`
- **File:** `market-query-v2/src/services/MarketInfoService.ts:13`
- **Request:** (no params)
- **Data Source & Logic:**
  - Storage: **MongoDB** collection `MarketInfo`
  - Operation: `MarketInfoRepository.findOne({ _id: 'LAST_TRADING_DATE' })`
  - Returns: `{ lastTradingDate: 'YYYYMMDD' }`

---

#### `getCurrentDividendList`
- **Endpoint:** `/api/v2/market/currentDividendEvent`
- **Service:** `MarketInfoService.getCurrentDividendList()`
- **File:** `market-query-v2/src/services/MarketInfoService.ts:18`
- **Request:** (no params)
- **Data Source & Logic:**
  - Storage: **MongoDB** collection `MarketInfo`
  - Operation: `MarketInfoRepository.findOne({ _id: 'CURRENT_DIVIDEND_EVENT' })`
  - Returns: `{ date: string, eventList: any[] }`

---

#### `getDailyAccumulativeVNIndex`
- **Endpoint:** `get:/api/v2/market/vnindexReturn`
- **Service:** `SymbolService.getDailyAccumulativeVNIndex()`
- **File:** `market-query-v2/src/services/SymbolService.ts:1208`
- **Request:**
  ```typescript
  interface IDailyAccumulativeVNIndexRequest {
    fromDate: string;     // Required. 'YYYYMMDD' format
    pageSize?: number;    // Optional. Default: 50
    pageNumber?: number;  // Optional. Default: 0
  }
  ```
- **Data Source & Logic:**
  - Storage: **MongoDB** `SymbolDaily` + **Redis** `realtime_mapSymbolInfo` (hybrid)
  - Operation:
    1. `SymbolDaily.find({ code: 'VN', date: { $gte: fromDate, $lte: yesterday } }).sort({date: 1})`
    2. If today is a trading day AND last page → append today's data from `HGET realtime_mapSymbolInfo VN`
    3. Calculate: `nr = round((current.last / firstRecord.last - 1) × 100, 2)` — **accumulative return %** from the first record
  - Returns: `[{ d: 'YYYYMMDD', c: last, ch: change, r: rate, nr: accumulativeReturn }]`

---

#### `queryForeignerSummary`
- **Endpoint:** `/api/v2/market/symbol/foreignerSummary`
- **Service:** `SymbolService.queryForeignerSummary()`
- **File:** `market-query-v2/src/services/SymbolService.ts:1095`
- **Request:**
  ```typescript
  interface ForeignerSummaryRequest {
    fetchCount?: number;   // Optional. Default: DEFAULT_DAILY_FETCH_COUNT
    offset?: number;       // Optional. Default: 0
    marketType?: string;   // Optional. 'HOSE'|'HNX'|'UPCOM'|'ALL' (default)
    sortType?: string;     // Optional. 'CODE'(default)|'NET_VOLUME'|'NET_VALUE'
  }
  ```
- **Data Source & Logic:**
  - Storage: **Redis Hash**
  - Key: `realtime_mapSymbolInfo`
  - Operation: `HGETALL`, filter `type === STOCK`, then by `marketType`
  - Sort by `sortType`:
    - `NET_VOLUME`: `(a.foreignerBuyVolume - a.foreignerSellVolume) - (b... - b...)` ascending
    - `NET_VALUE`: `(a.foreignerBuyValue - a.foreignerSellValue) - (b... - b...)` ascending
    - `CODE`: `a.code.localeCompare(b.code)` alphabetical
  - Pagination: `splice(offset, fetchCount)`

---

### 2.5. Thỏa Thuận (Put-Through)

---

#### `queryPutThroughAdvertise`
- **Endpoint:** `/api/v2/market/putthrough/advertise`
- **Service:** `PutThroughService.queryPutThroughAdvertise()`
- **File:** `market-query-v2/src/services/PutThroughService.ts:22`
- **Request:**
  ```typescript
  interface PutthroughAdvertiseRequest {
    marketType?: string;     // Optional. 'HOSE'|'HNX'|'UPCOM'|'ALL' (default if null)
    market?: string;         // Optional. Additional market filter within results
    sellBuyType?: string;    // Optional. Filter by sell/buy type
    fetchCount?: number;     // Optional. Default: DEFAULT_PAGE_SIZE
    offset?: number;         // Optional. Default: 0
  }
  ```
- **Data Source & Logic:**
  - Storage: **Redis List**
  - Keys: `realtime_listAdvertised_{HOSE}`, `realtime_listAdvertised_{HNX}`, `realtime_listAdvertised_{UPCOM}`
  - Operation:
    - If `marketType === ALL`: `LRANGE` all 3 keys 0..−1 → concat
    - Otherwise: `LRANGE realtime_listAdvertised_{marketType} 0 -1`
  - Filter: by `market` and `sellBuyType` if provided
  - Pagination: manual skip/limit loop with `offset` and `fetchCount`

---

#### `queryPutThroughDeal`
- **Endpoint:** `/api/v2/market/putthrough/deal`
- **Service:** `PutThroughService.queryPutThroughDeal()`
- **File:** `market-query-v2/src/services/PutThroughService.ts:67`
- **Request:**
  ```typescript
  interface PutthroughDealRequest {
    marketType?: string;   // Optional. 'HOSE'|'HNX'|'UPCOM'|'ALL' (default if null)
    market?: string;       // Optional. Additional filter within results
    fetchCount?: number;   // Optional. Default: DEFAULT_PAGE_SIZE
    offset?: number;       // Optional. Default: 0
  }
  ```
- **Data Source & Logic:**
  - Storage: **Redis List**
  - Keys: `realtime_listDealNotice_{HOSE}`, `realtime_listDealNotice_{HNX}`, `realtime_listDealNotice_{UPCOM}`
  - Operation: Same pattern as advertise — concat if ALL, filter by `market`, manual pagination

---

#### `queryPtDealTotal`
- **Endpoint:** `/api/v2/market/putthrough/dealTotal`
- **Service:** `SymbolService.queryPtDealTotal()`
- **File:** `market-query-v2/src/services/SymbolService.ts:1139`
- **Request:**
  ```typescript
  interface IPtDealTotalRequest {
    marketType?: string;  // Optional. Default: 'HOSE'
  }
  ```
- **Data Source & Logic:**
  - Storage: **Redis List**
  - Key: `realtime_listDealNotice_{marketType}`
  - Operation: `LRANGE realtime_listDealNotice_{marketType} 0 -1`
  - Transform: `toPtDealTotalResponse(dealNoticeList)` — aggregates total volume/value across all deal notices

---

### 2.6. ETF

---

#### `queryEtfNavDaily`
- **Endpoint:** `/api/v2/market/etf/{symbolCode}/nav/daily`
- **Service:** `EtfService.queryEtfNavDaily()`
- **File:** `market-query-v2/src/services/EtfService.ts:18`
- **Request:**
  ```typescript
  interface EtfNavDailyRequest {
    symbolCode: string;    // Required. From URI path
    fetchCount?: number;   // Optional. Default: DEFAULT_PAGE_SIZE
    baseDate?: string;     // Optional. Pagination cursor date (default: tomorrow)
  }
  ```
- **Data Source & Logic:**
  - Storage: **MongoDB** collection `EtfNavDaily`
  - Operation: `EtfNavDailyRepository.findBy({ code: symbolCode, date: { $lt: baseDate } }, fetchCount, { date: -1 })`
  - Transform: `toEtfNavDailyResponse(item)`

---

#### `queryEtfIndexDaily`
- **Endpoint:** `/api/v2/market/etf/{symbolCode}/index/daily`
- **Service:** `EtfService.queryEtfIndexDaily()`
- **File:** `market-query-v2/src/services/EtfService.ts:43`
- **Request:**
  ```typescript
  interface EtfIndexDailyRequest {
    symbolCode: string;    // Required. From URI path
    fetchCount?: number;   // Optional. Default: DEFAULT_PAGE_SIZE
    baseDate?: string;     // Optional. Pagination cursor date (default: tomorrow)
  }
  ```
- **Data Source & Logic:**
  - Storage: **MongoDB** collection `EtfIndexDaily`
  - Operation: `EtfIndexDailyRepository.findBy({ code: symbolCode, date: { $lt: baseDate } }, fetchCount, { date: -1 })`
  - Transform: `toEtfIndexDailyResponse(item)`

---

### 2.7. TradingView (Chart Widget API)

---

#### `queryConfig`
- **Endpoint:** `/api/v2/tradingview/config`
- **Service:** `FeedService.queryConfig()`
- **File:** `market-query-v2/src/services/FeedService.ts:46`
- **Request:** (no params)
- **Data Source & Logic:**
  - Returns static `ConfigResponse` object — hardcoded supported_resolutions, exchanges, symbols_types

---

#### `querySymbolInfo`
- **Endpoint:** `/api/v2/tradingview/symbols`
- **Service:** `FeedService.querySymbolInfo()`
- **File:** `market-query-v2/src/services/FeedService.ts:214`
- **Request:**
  ```typescript
  interface TradingViewSymbolInfoRequest {
    symbol: string;  // Required. Format: 'EXCHANGE:CODE' or just 'CODE'
  }
  ```
- **Data Source & Logic:**
  - Storage: **Redis** (via `CacheService.getSymbolInfo()`)
  - Key: `realtime_mapSymbolInfo` → `HGET {code}`
  - Parse: splits `symbol` by `:` → extracts `exchange` and `code`
  - Transform: `parseSymbolInfo(symbolInfo)` — converts to TradingView-compatible format

---

#### `querySymbolSearch`
- **Endpoint:** `/api/v2/tradingview/search`
- **Service:** `FeedService.querySymbolSearch()`
- **File:** `market-query-v2/src/services/FeedService.ts:163`
- **Request:**
  ```typescript
  interface TradingViewSymbolSearchRequest {
    query?: string;      // Optional. Search query (matches code, name, nameEn)
    type?: string;       // Optional. Securities type filter (STOCK, INDEX, etc.)
    exchange?: string;   // Optional. Market type filter (HOSE, HNX, UPCOM)
    limit?: number;      // Optional. Max results
  }
  ```
- **Data Source & Logic:**
  - Storage: **Redis** (via `CacheService.getAllSymbolInfo()`)
  - Operation: `HGETALL realtime_mapSymbolInfo`
  - Filter:
    1. Exclude foreign index (`type === INDEX && indexType === FOREIGN`)
    2. Filter by `type` and `exchange` if provided
    3. Search: **Priority matching** — code.includes(query) → high priority, name/nameEn.includes(query) → low priority
  - Sort: priority results first, then regular matches
  - Limit: `slice(0, limit)` if limit provided

---

#### `queryTradingViewHistory`
- **Endpoint:** `/api/v2/tradingview/history`
- **Service:** `FeedService.queryTradingViewHistory()`
- **File:** `market-query-v2/src/services/FeedService.ts:50`
- **Request:**
  ```typescript
  interface ITradingViewHistoryRequest {
    symbol: string;       // Required
    resolution: string;   // Required. '1'|'3'|'5'|'15'|'30'|'60' (minutes) or 'D'|'W'|'M'|'6M' (period)
    from: number;         // Required. Unix timestamp (seconds)
    to: number;           // Required. Unix timestamp (seconds)
    countback?: number;   // Optional. Number of bars to return
    lastTime?: number;    // Optional. Timestamp of last received bar
  }
  ```
- **Data Source & Logic:**
  - **Minute resolutions** (1, 3, 5, 15, 30, 60): → `getQuoteMinuteHistory()`
    - Storage: **Redis** `realtime_listQuoteMinute_{symbol}` + **optional MongoDB fallback** `SymbolQuoteMinute`
    - Groups by `minuteUnit`, returns OHLCV bars
    - If empty → returns `nextTime` from closest earlier record
  - **Period resolutions** (D, W, M, 6M): → `getDailyPeriodHistory()`
    - Storage: **MongoDB** `SymbolDaily` + **Redis** `realtime_mapSymbolInfo` (today inject)
    - Maps resolution to periodType: `D→DAILY, W→WEEKLY, M→MONTHLY, 6M→SIX_MONTH`
    - `CommonService.querySymbolHistory()` → groups by period, OHLCV aggregation
    - Countback: if initial result < countback → `querySymbolCountBackHistory()` fetches more

---

#### `querySymbolHistoryEvents`
- **Endpoint:** `/api/v2/tradingview/marks`
- **Service:** `FeedService.querySymbolHistoryEvents()`
- **File:** `market-query-v2/src/services/FeedService.ts:234`
- **Request:**
  ```typescript
  interface IQuerySymbolHistoryEventsRequest {
    symbol: string;   // Required
    from: string;     // Required. Date string
    to: string;       // Required. Date string
    headers: { 'accept-language'?: string };  // Optional. 'vi' → Vietnamese, else → English
  }
  ```
- **Data Source & Logic:**
  - Storage: **MongoDB** collection `SymbolHistoryEvents`
  - Operation: `SymbolHistoryEventsRepository.findBy({ stock: symbol, eventDate: { $gt: startOfFrom, $lte: endOfTo }, language: 'VI'|'EN' }, { eventDate: -1 })`
  - Transform: `toQuerySymbolHistoryResponse(symbolEventList)`

---

### 2.8. Chart Save/Load

---

#### `saveChart`
- **Endpoint:** `/api/v2/tradingview/charts/save` (when `request.chart` is empty)
- **Service:** `ChartService.saveChart()`
- **File:** `market-query-v2/src/services/ChartService.ts:47`
- **Request:**
  ```typescript
  interface TradingViewSaveChartRequest {
    client: string;          // Required. Client identifier (userId)
    name: string;            // Required. Chart name
    symbol: string;          // Required. Symbol code
    resolution: string;      // Required. Chart resolution
    content: string;         // Required. Chart data (JSON)
    chart?: string;          // Empty for save, chart ID for update
  }
  ```
- **Data Source & Logic:**
  - Storage: **MongoDB** collection `Chart`
  - Operation: `ChartRepository.insertOne({ _id: auto, client, name, symbol, resolution, content, timestamp: now })`
  - Returns: `{ status: 'ok', id: newId }`

---

#### `updateChart`
- **Endpoint:** `/api/v2/tradingview/charts/save` (when `request.chart` is NOT empty)
- **Service:** `ChartService.updateChart()`
- **File:** `market-query-v2/src/services/ChartService.ts:76`
- **Request:** Same as `saveChart` but with `chart` field populated (chart ID)
- **Data Source & Logic:**
  - Storage: **MongoDB** `Chart`
  - Operation: `ChartRepository.updateOne({ _id: chartId, client: userId }, { $set: { name, symbol, resolution, content, timestamp } })`
  - Returns: `{ status: 'ok' }`

---

#### `listChart`
- **Endpoint:** `/api/v2/tradingview/charts/load` (when `request.chart` is empty)
- **Service:** `ChartService.listChart()`
- **File:** `market-query-v2/src/services/ChartService.ts:109`
- **Request:**
  ```typescript
  interface TradingViewListChartRequest {
    client: string;  // Required. Client identifier
  }
  ```
- **Data Source & Logic:**
  - Storage: **MongoDB** `Chart`
  - Operation: `ChartRepository.findBy({ client }, MAX, { timestamp: -1 })`
  - Returns: list of chart metadata (id, name, symbol, resolution, timestamp) — without content

---

#### `loadChart`
- **Endpoint:** `/api/v2/tradingview/charts/load` (when `request.chart` is NOT empty)
- **Service:** `ChartService.loadChart()`
- **File:** `market-query-v2/src/services/ChartService.ts:129`
- **Request:**
  ```typescript
  interface TradingViewLoadChartRequest {
    client: string;  // Required. Client identifier
    chart: string;   // Required. Chart ID
  }
  ```
- **Data Source & Logic:**
  - Storage: **MongoDB** `Chart`
  - Operation: `ChartRepository.findOneBy({ _id: chartId, client })`
  - Returns: full chart data including `content`

---

#### `deleteChart`
- **Endpoint:** `/api/v2/tradingview/charts/delete`
- **Service:** `ChartService.deleteChart()`
- **File:** `market-query-v2/src/services/ChartService.ts:157`
- **Request:**
  ```typescript
  interface TradingViewDeleteChartRequest {
    client: string;  // Required
    chart: string;   // Required. Chart ID
  }
  ```
- **Data Source & Logic:**
  - Storage: **MongoDB** `Chart`
  - Operation: `ChartRepository.deleteOne({ _id: chartId, client })`
  - Returns: `{ status: 'ok' }`

---

### 2.9. WatchList (Danh Mục Theo Dõi)

---

#### `createWatchList`
- **Endpoint:** `post:/api/v1/favorite/watchlist`
- **Service:** `WatchListService.createWatchList()`
- **File:** `market-query-v2/src/services/WatchListService.ts:28`
- **Request:**
  ```typescript
  interface IWatchListRequest {
    name: string;             // Required. Watchlist name
    account: string;          // Required. User account
    symbolList?: string[];    // Optional. Initial symbols
  }
  ```
- **Data Source & Logic:**
  - Storage: **MongoDB** collection `WatchList`
  - Operation: Validate name (required), `WatchListRepository.insertOne({ account, name, symbolList, createdAt, updatedAt })`

---

#### `editWatchList`
- **Endpoint:** `put:/api/v1/favorite/watchlist`
- **Service:** `WatchListService.editWatchList()`
- **File:** `market-query-v2/src/services/WatchListService.ts:66`
- **Request:**
  ```typescript
  interface IWatchListRequest {
    _id: string;              // Required. WatchList ID
    name: string;             // Required. New name
    account: string;          // Required. User account
    symbolList?: string[];    // Optional. New symbol list
  }
  ```
- **Data Source & Logic:**
  - Storage: **MongoDB** `WatchList`
  - Operation: `updateOne({ _id, account }, { $set: { name, symbolList, updatedAt } })`

---

#### `getWatchList`
- **Endpoint:** `get:/api/v1/favorite/watchlist`
- **Service:** `WatchListService.getWatchList()`
- **File:** `market-query-v2/src/services/WatchListService.ts:112`
- **Request:**
  ```typescript
  interface IDataRequest {
    account: string;  // Required. User account
  }
  ```
- **Data Source & Logic:**
  - Storage: **MongoDB** `WatchList`
  - Operation: `find({ account }).sort({ createdAt: 1 }).toArray()`

---

#### `deleteWatchList`
- **Endpoint:** `delete:/api/v1/favorite/watchlist`
- **Service:** `WatchListService.deleteWatchList()`
- **File:** `market-query-v2/src/services/WatchListService.ts:126`
- **Request:**
  ```typescript
  interface IWatchListRequest {
    _id: string;       // Required. WatchList ID
    account: string;   // Required. User account
  }
  ```
- **Data Source & Logic:**
  - Storage: **MongoDB** `WatchList`
  - Operation: `deleteOne({ _id, account })`

---

#### `getWatchListSymbols`
- **Endpoint:** `get:/api/v1/favorite/symbol`
- **Service:** `WatchListService.getWatchListSymbols()`
- **File:** `market-query-v2/src/services/WatchListService.ts:170`
- **Request:**
  ```typescript
  interface IWatchListSymbolRequest {
    watchListId: string;  // Required. WatchList ID
    account: string;      // Required. User account
  }
  ```
- **Data Source & Logic:**
  - Storage: **MongoDB** `WatchList`
  - Operation: `findOne({ _id: watchListId, account })` → return `symbolList`

---

#### `addSymbolToWatchList`
- **Endpoint:** `post:/api/v1/favorite/symbol`
- **Service:** `WatchListService.addSymbolToWatchList()`
- **File:** `market-query-v2/src/services/WatchListService.ts:189`
- **Request:**
  ```typescript
  interface IAddSymbolWatchListRequest {
    watchListId: string;    // Required. WatchList ID
    account: string;        // Required. User account
    symbolList: string[];   // Required. Symbols to add
  }
  ```
- **Data Source & Logic:**
  - Storage: **MongoDB** `WatchList`
  - Operation: `findOne({ _id, account })` → merge existing + new symbols (deduplicate) → `updateOne({ $set: { symbolList } })`

---

#### `removeSymbolFromWatchList`
- **Endpoint:** `delete:/api/v1/favorite/symbol`
- **Service:** `WatchListService.removeSymbolFromWatchList()`
- **File:** `market-query-v2/src/services/WatchListService.ts:246`
- **Request:**
  ```typescript
  interface IRemoveSymbolWatchListRequest {
    watchListId: string;    // Required. WatchList ID
    account: string;        // Required. User account
    symbolList: string[];   // Required. Symbols to remove
  }
  ```
- **Data Source & Logic:**
  - Storage: **MongoDB** `WatchList`
  - Operation: `findOne` → filter out symbols → `updateOne({ $set: { symbolList } })`

---

#### `updateOrderSymbolWatchList`
- **Endpoint:** `put:/api/v1/favorite/watchlist/order`
- **Service:** `WatchListService.updateOrderSymbolWatchList()`
- **File:** `market-query-v2/src/services/WatchListService.ts:284`
- **Request:**
  ```typescript
  interface IUpdateOrderWatchListRequest {
    watchListId: string;    // Required. WatchList ID
    account: string;        // Required. User account
    symbolList: string[];   // Required. Symbols in new order
  }
  ```
- **Data Source & Logic:**
  - Storage: **MongoDB** `WatchList`
  - Operation: `findOne` → replace `symbolList` with reordered list → `updateOne`

---

#### `getWatchListIncludeSymbol`
- **Endpoint:** `get:/api/v1/favorite/symbol/include`
- **Service:** `WatchListService.getWatchListIncludeSymbol()`
- **File:** `market-query-v2/src/services/WatchListService.ts:343`
- **Request:**
  ```typescript
  interface IWatchListIncludeSymbolRequest {
    account: string;   // Required
    symbol: string;    // Required. Symbol to check
  }
  ```
- **Data Source & Logic:**
  - Storage: **MongoDB** `WatchList`
  - Operation: `find({ account })` → filter watchlists that contain `symbol` → return watchlist IDs

---

### 2.10. FIX Protocol

---

#### `queryFixSymbolList`
- **Endpoint:** `/api/v2/fix/securitiesList`
- **Service:** `FixService.queryFixSymbolList()`
- **File:** `market-query-v2/src/services/FixService.ts:16`
- **Request:**
  ```typescript
  interface FixSecurityListQueryRequest {
    instrumentCode: string;       // Required. Cursor: return symbols with code > this value
    fetchCount?: number;          // Optional. Default: DEFAULT_PAGE_SIZE
    lastUpdatedTime?: string;     // Optional. DateTime filter: only return symbols updated after this time
  }
  ```
- **Data Source & Logic:**
  - Storage: **Redis Hash**
  - Key: `realtime_mapSymbolInfo`
  - Operation: `HGETALL realtime_mapSymbolInfo`
  - Filter: `symbolInfo.code > instrumentCode` (cursor-based), then optionally `updatedAt > lastUpdatedTime`
  - Limit: `fetchCount` results
  - Transform: `parseFromSymbolInfoToFixSymbol(symbolInfo)` — converts to FIX protocol format

---

### 2.11. Admin / Crawl

---

#### `crawlChartData`
- **Endpoint:** `/api/v2/market/crawl/daily` AND `/api/v2/market/dividend/updatePrice`
- **Service:** `CrawlDataService.crawlChartData()`
- **File:** `market-query-v2/src/services/CrawlDataService.ts:33`
- **Request:**
  ```typescript
  interface ICrawlDailyDataRequest {
    from?: string;                           // Optional. 'YYYYMMDD' (default: config.crawlingChart.defaultFrom)
    to?: string;                             // Optional. 'YYYYMMDD' (default: now)
    symbols?: string[];                      // Optional. If empty → ALL symbols from SymbolInfo + futures + indices
    symbolCodeMap?: { [k: string]: string }; // Optional. Code mapping (default: VNINDEX→VN, HNXINDEX→HNX, UPCOMINDEX→UPCOM)
  }
  ```
- **Data Source & Logic:**
  - **External source:** VietStock API (configured in `config.crawlingChart.url`)
  - **Target storage:** **MongoDB** `SymbolDaily`
  - Operation:
    1. Get symbol list: from request OR `SymbolInfo.find({}).map(_id)` + manual futures/index additions
    2. **Delete existing** records: `SymbolDaily.deleteMany({ code: { $in: symbolList }, date: { $gte: from, $lte: now } })`
    3. For each symbol: `fetchRetry(url, 0)` with max 5 retries
    4. Parse response `IDaily { t[], o[], h[], l[], c[], v[] }` (TradingView OHLCV format)
    5. Build `ISymbolDaily` records: `change = c[i] - c[i-1]`, `rate = change / c[i-1]`
    6. `SymbolDaily.insertMany(insertList)`
  - **Admin endpoint** — destructive: deletes and re-crawls data for the date range

---

### 2.12. Notification

---

#### `queryAccountNotification`
- **Endpoint:** `/api/v1/equity/account/notification`
- **Service:** `SymbolService.queryAccountNotification()`
- **File:** `market-query-v2/src/services/SymbolService.ts:220`
- **Request:**
  ```typescript
  interface IGetNotificationRequest {
    type?: string;        // Optional. Notification type (default: 'ALL')
    keyword?: string;     // Optional. Search in title/content
    fromDate?: string;    // Optional. Date range start (default: DEFAULT_DAILY_FROM_DATE)
    toDate?: string;      // Optional. Date range end (default: today ISO string)
    pageSize?: number;    // Optional. Default: 20
    pageNumber?: number;  // Optional. Default: 0
  }
  ```
- **Data Source & Logic:**
  - Storage: **Redis Hash**
  - Key: `notice_{type}` (e.g., `notice_ALL`, `notice_DIVIDEND`, etc.)
  - Operation: `HGETALL notice_{type}`
  - Filter chain:
    1. `keyword`: filter by `title.includes(keyword) || content.includes(keyword)`
    2. `fromDate/toDate`: filter by `notification.date` within range
  - Sort: by `date` ascending
  - Pagination: `slice(pageNumber × pageSize, (pageNumber + 1) × pageSize)`
  - Transform: `{ sendDate, sendTime, author, title, content }`

---

## PHẦN 3: REALTIME-V2 INTERNAL ENDPOINTS (qua Kafka RPC)

File: `realtime-v2/src/main/java/com/techx/tradex/realtime/consumers/RequestHandler.java`

| Endpoint | Method | Mô tả |
|---|---|---|
| `/reloadSymbolInfo` | `redisService.reloadSymbolInfo()` | Tải lại toàn bộ SymbolInfo từ MongoDB → Redis |
| `/reloadSymbolDaily` | `redisService.reloadSymbolDaily()` | Tải lại SymbolDaily |
| `/resetCache` | `cacheService.reset()` | Xóa và rebuild tất cả cache in-memory |
| `/calculateRoller` | `symbolInfoRollerService.rollerData()` | Tính toán High/Low Year |
| `/uploadMarketStaticFile` | `symbolInfoService.uploadMarketStaticFile()` | Upload `symbol_static_data.json` → S3/CDN |
| `/mergeWrongOrder` | `monitorService.doMergeWrongOrderQuote(code)` | Merge wrong order quotes cho 1 mã |
| `/recoverQuoteMinute` | `monitorService.doRecoverQuoteMinute(code)` | Recover nến phút cho 1 mã |
| `/recoverAllQuoteMinute` | `monitorService.recoverAllMinute(threshold)` | Recover tất cả mã có minuteSize > threshold |
