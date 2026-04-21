# 05 - VÒNG ĐỜI DỮ LIỆU: SCHEDULED JOBS, INIT, RECOVERY & CÁC LUỒNG HẬU TRƯỜNG

> Tài liệu chi tiết các background jobs, luồng khởi tạo dữ liệu (downloadSymbol/Init), cơ chế recover, static file generation, rise/fall ranking, right info, theme statistics, roller, và monitor service.

---

## 1. SCHEDULED JOBS — COLLECTOR-LOTTE

### 1.1. JobService Overview

File: `market-collector-lotte/.../job/JobService.java`

| Job | Cron DEV | Cron PROD | Gọi tới | Mô tả |
|---|---|---|---|---|
| `startRealtime1st` | `0 00 2 * * MON-FRI` | `0 00 2 * * MON-FRI` | `realTimeDataListenerService.run()` | Khởi động kết nối Lotte WebSocket |
| `stopRealtime1st` | `0 05 8 * * MON-FRI` | `0 05 8 * * MON-FRI` | `realTimeDataListenerService.stop()` | Ngắt kết nối (rotation) |
| `startRealtime2nd` | `0 06 8 * * MON-FRI` | `0 06 8 * * MON-FRI` | `realTimeDataListenerService.run()` | Khởi động lại kết nối |
| `stopRealtime2nd` | `0 07 8 * * MON-FRI` | `0 07 8 * * MON-FRI` | `realTimeDataListenerService.stop()` | Ngắt kết nối (rotation) |
| `downloadSymbol` | `0 5,15,30,40,50 1,5 * * MON-FRI` | `0 5,15,30,40,50 1 * * MON-FRI` | `symbolInfoService.downloadSymbol()` | **Tải toàn bộ mã CK + thông tin chi tiết.** DEV: giờ 1 và 5. PROD: chỉ giờ 1 |
| `riseFallStockRankSave` | `0 */1 1-18 * * *` | `0 */1 1-18 * * *` | `riseFallStockRankService.getAndSaveStockRanking()` | Xếp hạng cổ phiếu tăng/giảm |
| `rightInfoSave` | `0 40 */1 * * *` | `0 40 */1 * * *` | `rightInfoService.getAndSaveRightInfo()` | Tải thông tin quyền/cổ tức |
| `resetCacheMapLastTradingVolume` | `0 0 0,1,11-16 * * MON-FRI` | `0 0 0,1,11,12,13,14,15,16 * * MON-FRI` | `monitorService.resetCacheMapLastTradingVolume()` | Reset cache KL khớp cuối cùng theo mã |
| `resetCacheMapSequence` | `0 0 0,1,11-16 * * MON-FRI` | `0 0 0,1,11,12,13,14,15,16 * * MON-FRI` | `monitorService.resetCacheMapSequence()` | Reset cache sequence theo mã |

### 1.2. MonitorService (Collector)

File: `market-collector-lotte/.../services/MonitorService.java`

| Job | Cron Key | Logic |
|---|---|---|
| `saveMonitorData` | `app.schedulers.saveMonitorData` | Ghi message stats (count per code, sorted desc) ra file JSON |
| `resetMonitorData` | `app.schedulers.resetMonitorData` | Reset counter mọi mã CK = 0 |

**Cơ chế:** Thread daemon chạy vô hạn, đọc từ `LinkedBlockingQueue<ThreadHandler.Data>`. Mỗi message realtime → ghi nhận class type + code (đếm message nhận được cho monitoring). Dữ liệu persist ra file `monitorDataFile` (JSON) → đọc lại khi restart.

---

## 2. SCHEDULED JOBS — REALTIME-V2

### 2.1. JobService Overview

File: `realtime-v2/.../services/JobService.java`

| Job | Cron (DEV) | Gọi tới | Mô tả |
|---|---|---|---|
| `removeAutoData` | `0 0 1 * * MON-FRI` | `redisService.removeAutoData()` | **Xóa TOÀN BỘ dữ liệu intraday** |
| `refreshSymbolInfo` | `0 35 1 * * MON-FRI` | `redisService.refreshSymbolInfo()` | Reset sequence, matchingVolume, bidOfferList trước phiên mới |
| `clearSymbolDaily` | `0 50 22 * * MON-FRI` | `redisService.clearOldSymbolDaily()` | Xóa SymbolDaily cũ (chạy đêm hôm trước) |
| `saveRedisToDatabase` | `0 15,29 10,11,14 * * MON-FRI` | `redisService.saveRedisToDatabase()` | **Persist Redis → MongoDB** (chạy 6 lần/ngày, KHÔNG chỉ cuối phiên) |
| `rollerSymbolInfo` | `0 0 21 * * *` | `symbolInfoRollerService.rollerData()` | Tính High/Low Year |
| `updateThemeStatistic` | `0 0 1-9 * * MON-FRI` | `themeService.updateThemeStatistic()` | Cập nhật thống kê ngành (⚠️ bị TẮT nếu `enableTheme=false`) |
| `stockTopWorstReturns` | `0 5 8 * * MON-FRI` | `symbolInfoService.stockTopWorstReturnsInfoExecute()` | Gửi push notification Top/Worst Returns |
| `restartService` | `0 0 0,10,11,23 * * *` | `System.exit(0)` | Restart JVM (4 lần/ngày) |
| `saveMonitorData` | `0 0 10,11 * * MON-FRI` | `monitorService.saveMonitorData()` | Ghi message stats ra file monitor |
| `resetMonitorData` | `0 0 16,17 * * MON-FRI` | `monitorService.resetMonitorData()` | Reset counter monitoring |
| `setStartCurrentDate` | `0 0 * * * *` | `quoteService.setStartCurrentDate()` | Reset ngày tháng hiện tại (hardcoded, không config) |

---

## 3. DOWNLOAD SYMBOL — LUỒNG KHỞI TẠO MÃ CHỨNG KHOÁN

> Đây là luồng **quan trọng bậc nhất** — tải toàn bộ danh sách mã CK và thông tin chi tiết từ HTS, tạo ra trạng thái ban đầu cho toàn hệ thống.

### 3.1. HtsSymbolInfoService.downloadSymbol()

File: `market-collector-lotte/.../services/HtsSymbolInfoService.java`

```java
public CompletableFuture<Void> downloadSymbol(String id) {
    // 1. Coordinator lock (cluster mode)
    coordinatorService.acquire(coordinatorKey, nodeId, 30000);
    // 2. Skip nếu holiday
    // 3. Download danh sách mã từ HTS
    Map<String, Symbol> mapSymbol = downloadSymbolListService.downloadFuture(false).join();
    // 4. Phân loại: stockList, indexList, futuresList, cwList, bondList
    // 5. Download chi tiết cho từng loại
    allSymbols = downloadInfoService.downloadStockInfo(connection, stockList).join()
    allSymbols += downloadInfoService.downloadFuturesInfo(connection, futuresList).join()
    allSymbols += downloadInfoService.downloadCWInfo(connection, cwList).join()
    allSymbols += downloadInfoService.downloadIndexInfo(connection, indexList).join()
    // 6. Recovery: nếu download fail 1 mã → lấy từ Redis backup
    // 7. Threshold check: allSymbols.size() >= initThresholdSize
    // 8a. enableInitMarket = true  → marketInit.init(allSymbols)
    // 8b. enableInitMarket = false → sendSymbolInfoUpdate() qua Kafka
}
```

### 3.2. Hai chế độ Init

| Chế độ | Config | Môi trường | Logic |
|---|---|---|---|
| **Direct Init** | `enableInitMarket = true` | **PROD** (chỉ Node 9, Instance 2) | `marketInit.init(allSymbols)` → Ghi TRỰC TIẾP Redis SYMBOL_INFO + MongoDB SymbolInfo + upload static file. **Realtime-V2 không tham gia.** |
| **Distributed Init** | `enableInitMarket = false` | **DEV** + PROD (các node khác) | `sendSymbolInfoUpdate(groupId, topic, allSymbols)` → Publish tất cả SymbolInfo qua Kafka topic `symbolInfoUpdate` → Realtime-V2 `InitService` nhận và thực sự ghi Redis/MongoDB/MinIO |

### 3.2b. Lựa chọn Implementation: `ISymbolInfoService`

File: `market-collector-lotte/.../configurations/BeanConf.java`

```java
// BeanConf.java — Bean selection tại startup
if (appConf.isUsingApi()) {
    return new LotteApiSymbolInfoService(...)  // UAT + PROD runtime hiện tại: isUsingApi=true
}
return new HtsSymbolInfoService(...)           // (không còn dùng)  isUsingApi=false
```

| Implementation | Config | Môi trường | Nguồn dữ liệu |
|---|---|---|---|
| **`LotteApiSymbolInfoService`** | `isUsingApi = true` | **UAT + PROD runtime hiện tại** | Lotte REST API (`/securities-name`, `/securities-price`, `/best-bid-offer`, `/indexs-list`, `/index-daily`) |
| **`HtsSymbolInfoService`** | `isUsingApi = false` | **Legacy / không active trong deploy scripts hiện tại** | HTS socket — download file `master.tbl` + gửi messages `MarketStockCurrentPriceSnd`, `MarketIndustryCurrentIndexSnd`... |

**API Endpoints (Lotte REST API) — dùng trên UAT/PROD runtime hiện tại:**

| Field config | Path | Mô tả | Batch |
|---|---|---|---|
| `symbolNames` | `tsol/apikey/tuxsvc/market/securities-name` | Danh sách tất cả mã STOCK/CW/ETF/Futures kèm tên, type, exchange | Pagination (`next_data`) |
| `indexListApi` | `tsol/apikey/tuxsvc/market/indexs-list` | Danh sách Index (VNINDEX, HNX, UPCOM...) | Pagination |
| `symbolPrices` | `tsol/apikey/tuxsvc/market/securities-price` | Giá hiện tại: Open/High/Low/Last/Change/Rate/Volume/Ceiling/Floor/RefPrice/Foreign room | **20 mã/request** |
| `bestBidAsks` | `tsol/apikey/tuxsvc/market/best-bid-offer` | BidOffer 3 bước giá + MatchingVolume + ExpectedPrice | 1 mã/request |
| `indexDaily` | `tsol/apikey/tuxsvc/market/index-daily` | 2 phiên gần nhất → `yesterdayPrice.close` = referencePrice | 1 index/request |

> **Base URL:** Được inject qua env, không hardcode trong code. Dev dùng URL nội bộ, PROD dùng URL production.

---

### 3.3. MarketInit.init() — Logic chi tiết

MarketInit (thư viện chung) thực hiện:

1. **Clear Redis:** `clearSymbolInfo()`.
2. **Set Redis:** `setSymbolInfo(symbolInfo)` cho mỗi mã.
3. **Upsert MongoDB:** `SymbolInfoRepository.save()`.
4. **Upload Static File:** `uploadMarketDataFile()` → Serialize toàn bộ `getAllSymbolInfo()` thành JSON → Upload qua `FileService` → Đây chính là file **`symbol_static_data.json`**.

### 3.4. Upload Market Static File (`symbol_static_data.json`)

File: `realtime-v2/.../services/SymbolInfoService.java`

```java
public void uploadMarketStaticFile() {
    MarketInit.uploadMarketDataFile(
        marketRedisDao.getAllSymbolInfo(),  // Toàn bộ SymbolInfo từ Redis
        objectMapper,                       // Jackson serializer
        fileService,                        // S3/CDN uploader
        appConf.getMarketConf()            // Config chứa output path
    );
}
```

**Trigger:** Có thể gọi qua Kafka request handler:
- Realtime-V2 `RequestHandler`: `/uploadMarketStaticFile` → `symbolInfoService::uploadMarketStaticFile`
- Cũng được gọi tự động bên trong `marketInit.init()`.

**Output:** File JSON chứa TOÀN BỘ thông tin mã CK (code, name, type, market, referencePrice, ceiling, floor, listedQuantity, foreignerRoom...) → Được serve qua CDN/S3 cho client mobile/web load ban đầu.

### 3.5. InitService — Nhận SymbolInfoUpdate (Distributed Mode)

File: `realtime-v2/.../services/InitService.java`

```java
// TimerTask chạy mỗi 10 giây
public class InitService extends TimerTask {
    // Nhận nhiều SymbolInfoUpdate messages thuộc cùng 1 groupId
    public void handleSymbolInfoUpdate(SymbolInfoUpdate request) {
        groupMap.computeIfAbsent(groupId, k -> new GroupCommand());
        groupCommand.symbolInfoUpdates.add(request);
        groupCommand.totalReceived += 1;
    }

    @Override
    public void run() {
        // Nếu đã nhận đủ messages (totalReceived >= totalMessages)
        // HOẶC timeout 60 giây:
        // 1. monitorService.pauseAll() — tạm dừng tất cả thread xử lý
        // 2. Clean cache theo CommandGroup:
        //    - cleanAll = true → cacheService.getMapSymbolInfo().clear()
        //    - cleanByCode → remove 1 mã
        //    - cleanByCodes → remove nhiều mã
        //    - cleanByMarket/cleanByType → remove theo sàn/loại
        // 3. symbolInfoService.updateBySymbolInfoUpdate() cho mỗi message
        // 4. monitorService.resumeAll()
        // 5. marketInit.init(cacheService.getMapSymbolInfo().values())
        // 6. cacheService.reset()
    }
}
```

> **Tác động:** Khi Collector gửi batch SymbolInfoUpdate → Realtime-V2 tạm dừng processing, xóa cache cũ, load cache mới, init Redis/MongoDB/static file, rồi resume processing.

### 3.6. MarketInitHandler — Kafka Init Coordination

File: `realtime-v2/.../consumers/MarketInitHandler.java`

- Topic: `appConf.topics.marketInit`
- **Chỉ hoạt động khi `enableInitData = false`** (tránh loop).
- Xử lý 2 URI:
  - `/startInit` → `cacheService.pauseAutoData()` + timeout thread 2s
  - `/endInit` → `cacheService.reset()` + `themeService.updateThemeStatistic()` + `cacheService.resumeAutoData()`

---

## 4. DATA RECOVERY — CƠ CHẾ PHỤC HỒI

### 4.1. DailyRecoverService — Tải SymbolDaily lịch sử

File: `market-collector-lotte/.../services/recover/DailyRecoverService.java`

**Chức năng:** Tải TOÀN BỘ dữ liệu nến ngày (SymbolDaily) từ HTS cho mọi mã CK, lưu vào MongoDB.

```java
public CompletableFuture<Object> download(boolean clearCache) {
    // 1. Lấy tất cả mã từ Redis SYMBOL_INFO
    // 2. Với mỗi mã — phân loại type:
    //    INDEX    → downloadIndexDaily() qua MarketIndexDailySnd
    //    STOCK    → downloadStockDaily() qua MarketStockDailySnd (priceType=1: đã điều chỉnh)
    //    CW       → downloadCwDaily()    qua MarketCWDailySnd
    //    ETF      → downloadStockDaily() (dùng chung)
    //    FUTURES  → downloadFuturesDaily() qua MarketCWDailySnd (reuse)
    // 3. Pagination: mỗi lần lấy 100 records, loop cho đến hết (đến năm 2012)
    // 4. Retry: tối đa 5 lần nếu fail
    // 5. Remove & Insert MongoDB: SymbolDaily collection
    // 6. Track status qua file JSON (resume nếu restart giữa chừng)
}
```

**Concurrency:** `CompletablePool` với pool size = 100 (nhiều mã tải song song).

**Trigger:** Kafka request handler hoặc manual call.

### 4.2. QuoteRecoverByApiService — Phục hồi SymbolQuote intraday

File: `market-collector-lotte/.../services/recover/QuoteRecoverByApiService.java`

**Chức năng:** Phục hồi dữ liệu tick intraday bằng cách gọi Lotte REST API.

```java
public void download(boolean clearCache) {
    // Với mỗi SymbolInfo:
    // INDEX → queryIndexQuotes():  GET apiConnection.indexQuotes  (pagination by base_time)
    // STOCK → queryStockQuotes():  GET apiConnection.stockQuotes
    // CW    → queryCwQuotes():     GET apiConnection.cwQuotes     (pagination by seq)
    // ETF   → queryEtfQuotes():    GET apiConnection.etfQuotes    (pagination by seq)
    // → Publish mỗi SymbolQuote qua Kafka topic: quoteRecover
}
```

**Khác biệt với DailyRecover:** Đây là **intraday data** (mỗi tick trong ngày), không phải candle ngày. Dùng REST API thay vì HTS socket.

---

## 5. REDIS LIFECYCLE MANAGEMENT — RedisService

File: `realtime-v2/.../services/RedisService.java`

### 5.1. refreshSymbolInfo() — Reset trước phiên mới

```java
// Gọi bởi: JobService.refreshSymbolInfo() (sáng sớm trước phiên)
for (SymbolInfo symbolInfo : redisDao.getAllSymbolInfo()) {
    symbolInfo.setSequence(0L);           // reset sequence đếm lệnh
    symbolInfo.setMatchingVolume(0L);     // reset KL khớp
    symbolInfo.setMatchedBy(null);        // reset cách khớp
    symbolInfo.setBidOfferList(null);     // xóa sổ lệnh cũ
    symbolInfo.setOddlotBidOfferList(null);
    symbolInfo.setUpdatedBy("Job Realtime refreshSymbolInfo");
    redisDao.setSymbolInfo(symbolInfo);
}
```

### 5.2. removeAutoData() — Xóa toàn bộ dữ liệu intraday

```java
// Gọi bởi: JobService.removeAutoData() (cuối ngày / đầu ngày mới)
clearAllQuoteMinute();       // QUOTE_MINUTE_*
clearAllSymbolQuote();       // SYMBOL_QUOTE_*
clearAllSymbolQuoteMeta();   // SYMBOL_QUOTE_META_*
clearAllSymbolQuoteWrongOrder();
clearAllSymbolQuoteRecoverMinute();
clearAllBidOffer();          // BID_OFFER_*
clearAllDealNotice();        // DEAL_NOTICE_*
clearAllAdvertised();        // ADVERTISED_*
clearMarketStatistic();      // MARKET_STATISTIC
```

### 5.3. saveRedisToDatabase() — Persist Redis → MongoDB

> ⚠️ **Chạy nhiều lần trong ngày** (DEV: 10:15, 10:29, 11:15, 11:29, 14:15, 14:29) — đây là snapshot pattern, KHÔNG chỉ chạy cuối phiên.

```java
// Gọi bởi: JobService.saveRedisToDatabase()
// THỨ TỰ persist:
// 1. SymbolInfo        → drop collection → bulk upsert
// 2. SymbolInfoOddLot  → drop collection → bulk upsert
// 3. SymbolDaily       → bulk upsert (append, không xóa)
// 4. ForeignerDaily    → bulk upsert (nếu rỗng → tự tạo từ SymbolInfo)
// 5. MarketStatus      → bulk upsert
// 6. SymbolQuote       → bulk upsert (nếu enableSaveQuote = true)       ⚠️ UAT/PROD runtime: TẮT
// 7. SymbolQuoteMinute → bulk upsert (nếu enableSaveQuoteMinute = true) ⚠️ UAT/PROD runtime: TẮT
// 8. BidOffer          → bulk upsert (nếu enableSaveBidAsk = true)      ⚠️ UAT/PROD runtime: TẮT
// 9. DealNotice        → bulk upsert (cả 3 sàn: HOSE, HNX, UPCOM)
// 10. Advertised       → bulk upsert (cả 3 sàn)
// 11. updateSymbolPrevious() → tính previous close/date
```

### 5.4. updateSymbolPrevious() — Tính giá đóng cửa phiên trước

```java
// So sánh ngày:
if (sameDate) {
    symbolPrevious.close = symbolDaily.last;       // chỉ update close
} else {
    symbolPrevious.previousClose = symbolPrevious.close;  // lưu close cũ
    symbolPrevious.previousTradingDate = symbolPrevious.lastTradingDate;
    symbolPrevious.close = symbolDaily.last;
    symbolPrevious.lastTradingDate = symbolDaily.date;
}
// → MongoDB: SymbolPrevious collection
```

> **Tác động:** Client dùng `previousClose` để tính % thay đổi so với phiên trước (khác với `referencePrice` là giá tham chiếu chính thức).

---

## 6. RISE/FALL STOCK RANKING

File: `market-collector-lotte/.../services/RiseFallStockRankService.java`

### Logic

```java
// Periods: 5 ngày, 20 ngày, 250 ngày
// MarketType: HOSE, HNX (enum)
// UpDownType: UP, DOWN (enum)
// → Tổng cộng 3 × 2 × 2 = 12 bộ ranking

// Mỗi bộ:
RiseFallRankSnd req = new RiseFallRankSnd();
req.fromDate = today - days;   // trừ ngày, skip cuối tuần
req.toDate = today;
req.fetchCount = 60;           // top 60 mã

// HTS response: sequence, stockCode, last, change, rate, volume, upDownRate, upDownRange
// → Lưu Redis: key = "market_rise_false_stock_ranking_{market}_{upDown}_{days}"
```

---

## 7. RIGHT INFO (QUYỀN & CỔ TỨC)

File: `market-collector-lotte/.../services/RightInfoService.java`

### Logic

```java
// Với MỖI mã CK trong cache:
RightInfoSnd req = new RightInfoSnd();
req.stockCode = stockCode;
// HTS response chứa 3 loại quyền:
// 1. WithCon (Phát hành thêm kèm điều kiện): baseDate, baseRate, dividRate, issuePrice, applyPeriod, transferPeriod
// 2. WithoutCon (Phát hành thêm không điều kiện): baseDate, baseRate, dividRate, frcStkPrice, frcPayDate
// 3. Dividend (Cổ tức): baseDate, stkDividRate, cashDividRate, frcStkPrice, cashPayDate
// + meetDate (ngày ĐHCĐ)

// → Redis: "market_right_info_{code}" (TTL: 7200000ms = 2 giờ)
```

**Concurrency:** `CompletablePool`, pool size = 100.

---

## 8. SYMBOL INFO ROLLER (HIGH/LOW YEAR)

File: `realtime-v2/.../services/SymbolInfoRollerService.java`

### rollerData() — Tính High/Low 52 tuần

```java
// 1. Query MongoDB: SymbolDaily có date > (today - 1 năm)
// 2. Với mỗi mã: tìm giá cao nhất (High) và thấp nhất (Low)
// 3. Lưu kết quả:
//    HighLowYearItem {
//        highPrice, dateOfHighPrice,
//        lowPrice,  dateOfLowPrice
//    }
// 4. MongoDB: deleteAll() → saveAll() SymbolInfoRoller collection
```

### updateHighLowYear() — Cập nhật vào Redis SymbolInfo

```java
// Gọi qua Kafka request handler
// Tính highLowYearData → set vào SymbolInfo.highLowYearData → redisDao.setSymbolInfo()
// → Client nhận được high/low year trực tiếp trong SymbolInfo (API /symbol/latest)
```

---

## 9. THEME STATISTICS (THỐNG KÊ NGÀNH)

File: `realtime-v2/.../services/ThemeService.java`

### updateThemeStatistic() — Cập nhật thống kê ngành realtime

```java
// Guard: chỉ chạy trong giờ giao dịch (startInitTheme → endTradingHour)
// 1. Lấy list symbolInfo đã thay đổi trong minute gần nhất
// 2. Tìm tất cả Theme chứa mã đó
// 3. Với mỗi Theme:
//    a. Tính themeIndexChange = trung bình rate của tất cả mã trong Theme
//    b. Đếm: noOfIncreases, noOfDecreases, noOfUnchanges
//    c. Tính 3D và 1W change:
//       themeChange_3D = Π(1 + dailyRate[i]/100) - 1    // compound rate 3 ngày
//       themeChange_1W = Π(1 + dailyRate[i]/100) - 1    // compound rate 1 tuần
//    d. So sánh với Redis value cũ → chỉ update nếu khác
// 4. Lưu Redis: setThemeStatistic(themeCode, themeStatistic)
// 5. Publish Kafka: topic "themeUpdate"
```

**Output ThemeStatistic:**
```json
{
    "themeName": "Ngân hàng",
    "themeCode": "TC_BANK",
    "time": "20240315143000",
    "themeData": [
        { "period": "1D", "themeChange": 1.25, "increases": 8, "decreases": 3, "unchanges": 1 },
        { "period": "3D", "themeChange": 3.45, "increases": 9, "decreases": 2, "unchanges": 1, "stockData": [...] },
        { "period": "1W", "themeChange": -0.82, "increases": 5, "decreases": 6, "unchanges": 1, "stockData": [...] }
    ]
}
```

---

## 10. TOP/WORST RETURNS NOTIFICATION

File: `realtime-v2/.../services/SymbolInfoService.java`

### stockTopWorstReturnsInfoExecute()

```java
// 1. Lấy VNIndex info: marketRedisDao.getSymbolInfo("VN")
// 2. Query Top HSX: indexStockService.getIndexRanks(VN, RATE_DESC, 0, N)
// 3. Query Worst HSX: indexStockService.getIndexRanks(VN, RATE_ASC, 0, N)
// 4. Build message data:
//    vnIndexInfo:      "1250.50 (+0.35%)"
//    hsxTopStockInfo:  "VNM +6.98%, HPG +5.23%, ..."
//    hsxWorstStockInfo: "MWG -4.12%, TCB -3.56%, ..."
// 5. Push notification qua OneSignal:
//    filter: vnindexReturns = "true"
//    domain: PAAVE
//    template: PAAVE_STOCK_TOP_WORST_RETURNS_NOTIFICATION_TEMPLATE_NAME
```

---

## 11. SƠ ĐỒ LIFECYCLE HÀNG NGÀY

> Cron times dưới đây phản ánh PROD config. DEV có một số khác biệt được ghi chú.

```
[ĐÊM HÔM TRƯỚC]
22:50     clearSymbolDaily (R-V2) → xóa SymbolDaily Redis cũ
00:00     restartService (R-V2) → JVM restart #1

[SÁNG SỚM]
01:00     removeAutoData (R-V2) → xóa Quote/Minute/BidOffer/Deal/Advertised/Statistic
01:05-    downloadSymbol (Collector)
          PROD: chạy tại phút 5,15,30,40,50 → chỉ giờ 1
          DEV:  chạy tại phút 5,15,30,40,50 → giờ 1 VÀ giờ 5
          └── PROD (Node9-Inst2, enableInitMarket=true):  ghi trực tiếp Redis+MongoDB+MinIO
          └── DEV  (enableInitMarket=false): publish Kafka symbolInfoUpdate → R-V2 InitService ghi
01:35     refreshSymbolInfo (R-V2) → reset sequence/matchingVolume/bidOfferList
01:40     timeStartReceiveBidAsk (Collector) → bắt đầu nhận BidAsk
02:00     startRealtime1st (Collector) → mở kết nối Lotte WebSocket
          └─── [Data bắt đầu chảy: Quote → BidOffer → Index → Status]

[ROTATION CYCLE]
08:05     stopRealtime1st  (Collector) → ngắt kết nối
08:06     startRealtime2nd (Collector) → mở lại kết nối
08:07     stopRealtime2nd  (Collector) → ngắt (connection re-established by code)
08:05     stockTopWorstReturns (R-V2) → gửi push notification Top/Worst

[TRADING SESSION 9:00-14:45]
          riseFallStockRankSave (Collector) → mỗi phút, giờ 1-18
          rightInfoSave (Collector) → mỗi giờ tại phút 40
          resetCacheMapLastTradingVolume, resetCacheMapSequence (Collector) → giờ 0,1,11-16

[SNAPSHOT PERSIST — TRONG PHIÊN]
10:15     saveRedisToDatabase (R-V2) → snapshot #1
10:29     saveRedisToDatabase (R-V2) → snapshot #2
10:00     restartService (R-V2) → JVM restart #2 (trước snapshot!)
11:00     restartService (R-V2) → JVM restart #3
11:15     saveRedisToDatabase (R-V2) → snapshot #3
11:29     saveRedisToDatabase (R-V2) → snapshot #4
14:15     saveRedisToDatabase (R-V2) → snapshot #5
14:29     saveRedisToDatabase (R-V2) → snapshot #6 (sau ATC)

[SAU PHIÊN]
21:00     rollerSymbolInfo (R-V2) → tính High/Low Year
23:00     timeStopReceiveBidAsk (Collector) → ngừng nhận BidAsk
23:00     restartService (R-V2) → JVM restart #4

[On-demand]
          DailyRecoverService → tải lịch sử nến ngày từ HTS
          QuoteRecoverByApiService → phục hồi tick intraday từ Lotte API
          uploadMarketStaticFile → generate symbol_static_data.json → MinIO
```

---

## 12. TỔNG HỢP REDIS KEYS BỔ SUNG

| Redis Key Pattern | Kiểu | Service quản lý | Mô tả |
|---|---|---|---|
| `market_rise_false_stock_ranking_{market}_{upDown}_{days}` | String (JSON) | Collector | Xếp hạng cổ phiếu tăng/giảm 5/20/250 ngày |
| `market_right_info_{code}` | String (JSON, TTL 2h) | Collector | Thông tin quyền/cổ tức mã CK |
| `THEME_STATISTIC_{themeCode}` | String (JSON) | Realtime-V2 | Thống kê ngành (1D/3D/1W) |

## 13. TỔNG HỢP MONGODB COLLECTIONS BỔ SUNG

| Collection | Service quản lý | Mô tả |
|---|---|---|
| `SymbolPrevious` | Realtime-V2.RedisService | Giá đóng cửa phiên trước + previousClose |
| `SymbolInfoRoller` | Realtime-V2.SymbolInfoRollerService | High/Low Year data |
| `ForeignerDaily` | Realtime-V2.RedisService | Room ngoại + KL mua/bán ngoại ngày |
| `Theme` | (pre-loaded) | Mapping mã CK ↔ ngành/chủ đề |
| `SymbolQuote` | Realtime-V2.RedisService (code path tồn tại) | Tick data intraday **chỉ khi** bật `enableSaveQuote` hoặc manual dump/backfill; runtime UAT/PROD hiện tại: OFF |
| `SymbolQuoteMinute` | Realtime-V2.RedisService (code path tồn tại) | Nến phút **chỉ khi** bật `enableSaveQuoteMinute` hoặc manual dump/backfill; runtime UAT/PROD hiện tại: OFF |
| `BidOffer` | Realtime-V2.RedisService (code path tồn tại) | Sổ lệnh intraday **chỉ khi** bật `enableSaveBidAsk`; runtime UAT/PROD hiện tại: OFF |
| `DealNotice` | Realtime-V2.RedisService (persist) | GD thỏa thuận đã khớp (từ Redis) |
| `Advertised` | Realtime-V2.RedisService (persist) | Rao bán thỏa thuận (từ Redis) |
| `MarketStatus` | Realtime-V2.RedisService (persist) | Trạng thái phiên (từ Redis) |

## 14. TỔNG HỢP KAFKA TOPICS BỔ SUNG

| Topic | Publisher | Consumer | Mô tả |
|---|---|---|---|
| `symbolInfoUpdate` | Collector (HtsSymbolInfoService) | Realtime-V2 (InitService) | Batch update SymbolInfo khi downloadSymbol |
| `marketInit` | Collector/Admin | Realtime-V2 (MarketInitHandler) | Coordination: startInit/endInit |
| `themeUpdate` | Realtime-V2 (ThemeService) | ws-v2 | Cập nhật thống kê ngành → broadcast client |
| `quoteRecover` | Collector (QuoteRecoverByApiService) | Realtime-V2 | Phục hồi tick data intraday |

## 15. FEATURE FLAGS — ẢNH HƯỞNG ĐẾN HÀNH VI HỆ THỐNG

> Các flag này config trong `application.yml` / deployment script, quyết định tính năng nào BẬT/TẮT tại runtime.

### 15.1. Collector Feature Flags

| Flag | DEV | PROD | Ảnh hưởng |
|---|---|---|---|
| `isUsingApi` | `true` | `true` | Cả UAT và PROD → `LotteApiSymbolInfoService` (Lotte REST API) |
| `enableInitMarket` | `false` | `true` (Node9-Inst2 only) | DEV + PROD non-init nodes → Distributed Init qua Kafka. PROD init node → Direct Init vào Redis/MongoDB/MinIO |
| `enableMultipleInstance` | `false` | `true` | DEV: single instance không cần coordinator lock cạnh tranh. PROD: nhiều instance, coordinator lock quyết định ai chạy `downloadSymbol` |
| `enableIgnoreQuote` | `false` | `false` | Xử lý tất cả quote, không bỏ qua mã nào |
| `enableQuery` | `false` | `false` | Không expose REST query endpoints trên Collector |
| `enableStoreConnectionInfo` | `false` | `false` | Không lưu thông tin connection HTS vào storage |

**Logic quyết định `enableInitMarket` trên PROD:**
```bash
enableInitData=true
if [[ "$TRADEX_ENV_INIT_MARKET_BY_REALTIME" != "" ]]; then
  enableInitData=false   # Hầu hết nodes: non-empty → false
fi
if [[ "$TRADEX_ENV_NODE_ID" == "9" && "$TRADEX_ENV_INSTANCE_ID" == "2" ]]; then
  enableInitData=true    # Node 9 Instance 2 luôn là init node
fi
```

**PROD Node Topology (Collector):**

| Node | IP | Instance | `isUsingApi` | `enableInitMarket` | HTS Accounts | Vai trò |
|---|---|---|---|---|---|---|
| Node 9 (`172.33.10.70`) | — | 2 | `true` | **`true`** | `accounts: []` rỗng | **Init-only** — download symbol + ghi Redis/MongoDB/MinIO |
| Node 10 (`172.33.10.71`) | — | 1 | `true` | `false` | HOSE accounts | STOCK-HOSE collector |
| Node 10 | — | 2 | `true` | `false` | HNX accounts | STOCK-HNX collector |
| Node 10 | — | 3 | `true` | `false` | UPCOM accounts | STOCK-UPCOM collector |
| Node 10 | — | 1 (INDEX type) | `true` | `false` | INDEX account | INDEX + MarketStatus |
| Node 10 | — | 3 (CW type) | `true` | `false` | CW/ETF account | CW + ETF collector |

### 15.2. Realtime-V2 Feature Flags

| Flag | DEV | PROD | Ảnh hưởng |
|---|---|---|---|
| `enableInitData` | `true` | `true` | Cho phép nhận SymbolInfoUpdate từ Kafka (InitService hoạt động) |
| `enableCheckOrderQuote` | `true` | `true` | Kiểm tra thứ tự quote (detect wrong order) |
| `enableQuotePartition` | `true` | `true` | Chia quote data thành multiple partitions |
| `enableSaveWrongOrderQuote` | `true` | `true` | Lưu wrong-order quotes vào Redis để recovery |
| `enableSaveStatistic` | `true` | `true` | Lưu market statistic data |
| `enableSocketCluster` | `false` | `false` | SocketCluster **TẮT**; dùng Kafka → ws-v2 thay thế |
| `enableTheme` | `false` | `false` | Theme statistics **TẮT** |
| `enableSaveQuote` | `false` | `false` | **KHÔNG persist** SymbolQuote vào MongoDB |
| `enableSaveQuoteMinute` | `false` | `false` | **KHÔNG persist** SymbolQuoteMinute |
| `enableSaveBidOffer` | `false` | `false` | **KHÔNG persist** BidOffer |
| `enableSaveBidAsk` | `false` | `false` | **KHÔNG persist** BidAsk |

> ⚠️ **Tác động:** Trong runtime **UAT/PROD hiện tại**, `saveRedisToDatabase` chỉ thực sự persist: **SymbolInfo, SymbolInfoOddLot, SymbolDaily, ForeignerDaily, MarketStatus, DealNotice, Advertised** — Quote/QuoteMinute/BidOffer đều BỎ QUA.

> **Ghi chú nguồn cấu hình:** Kết luận trên dựa theo `application.yml` được generate bởi deploy scripts runtime của `realtime-v2` trên UAT/PROD. Repo source vẫn còn code path persist intraday và `application.yaml` checked-in có thể khác.

---

## 16. DATA SOURCE — WEBSOCKET CONNECTION CONFIG

> Collector nhận realtime data qua **Lotte WebSocket** (`ws://[lotte-ws-host]:9900`). HTS socket accounts **disabled** trong runtime UAT/PROD hiện tại (dùng Lotte WS thay thế).

### 16.1. WebSocket Connections

| Connection Name | codeType | Exchange | Channel Pattern | Mô tả | DEV | PROD |
|---|---|---|---|---|---|---|
| `INDEX-WS` | INDEX | — | `channels: []` (trống) | Index data (VNINDEX→VN mapping) | ✅ Có (channels rỗng) | Node 10-Inst1 dùng `sub/pro.pub.auto.idxqt./<code>` |
| `SESSION-WS` | MARKET-STATUS | — | `sub/pro.pub.auto.tickerNews.*/` | Trạng thái phiên giao dịch | ✅ | Node 10-Inst1 |
| `STOCK-HOSE` | STOCK | HOSE | `sub/pro.pub.auto.qt./` + `sub/pro.pub.auto.bo./` | Quote + BidOffer HOSE | ✅ | Node 10-Inst1 |
| `STOCK-HNX` | STOCK | HNX | `sub/pro.pub.auto.qt./` + `sub/pro.pub.auto.bo./` | Quote + BidOffer HNX | ✅ | Node 10-Inst2 |
| `STOCK-UPCOM` | STOCK | UPCOM | `sub/pro.pub.auto.qt./` + `sub/pro.pub.auto.bo./` | Quote + BidOffer UPCOM | ✅ | Node 10-Inst3 |
| `CW` | CW | — | `sub/pro.pub.auto.qt./` + `sub/pro.pub.auto.bo./` | Chứng quyền | ✅ | Node 10-Inst3 |
| `ETF` | ETF | — | `sub/pro.pub.auto.qt./` + `sub/pro.pub.auto.bo./` | ETF | ✅ | Node 10-Inst3 |

> **Khác biệt PROD:** Mỗi instance Node 10 chỉ subscribe **1 connection type** tương ứng với vai trò của nó (HOSE/HNX/UPCOM tách biệt). DEV chạy tất cả connections trong 1 process.

### 16.2. Channel Pattern Giải thích

| Pattern | Dữ liệu | Mapping tới Kafka topic |
|---|---|---|
| `sub/pro.pub.auto.qt./` | Real-time quote (giá khớp, KL, OHLC) | → `quoteUpdate` |
| `sub/pro.pub.auto.bo./` | Real-time bid/offer (sổ lệnh 3 bước giá) | → `bidOfferUpdate` |
| `sub/pro.pub.auto.tickerNews.*/` | Session status changes | → `marketStatus` |
| `sub/pro.pub.auto.idxqt./<code>` | Index quote (PROD only, DEV commented out) | → `quoteUpdate` (INDEX type) |

### 16.3. Code Mapping

| Lotte Code | Internal Code |
|---|---|
| `VNINDEX` | `VN` |

### 16.4. BidAsk Time Window

| Config | DEV | PROD | Mô tả |
|---|---|---|---|
| `timeStartReceiveBidAsk` | `01:40` | `01:40` | Bắt đầu nhận BidAsk |
| `timeStopReceiveBidAsk` | `23:00` | `23:00` | Ngừng nhận BidAsk |

> Cửa sổ 01:40 → 23:00 bao trùm cả pre-market và after-hours. Ngoài cửa sổ này, BidAsk messages bị bỏ qua.

---

## 17. SO SÁNH DEV vs PROD — TỔNG HỢP

| Tiêu chí | DEV | PROD |
|---|---|---|
| **Download symbol** | `LotteApiSymbolInfoService`: Lotte REST API (`/securities-name`, `/securities-price`...) | `LotteApiSymbolInfoService`: Lotte REST API (`/securities-name`, `/securities-price`...) |
| **Init storage** | Publish Kafka `symbolInfoUpdate` → R-V2 `InitService` ghi | Node9-Inst2: ghi trực tiếp Redis+MongoDB+MinIO |
| **`enableInitMarket`** | `false` (hardcoded) | `true` (Node9-Inst2), `false` (others) |
| **`isUsingApi`** | `true` | `true` |
| **`enableMultipleInstance`** | `false` | `true` |
| **Collector instances** | 1 process (tất cả connections) | Node 9: init-only, Node 10: 3+ instances theo sàn |
| **`downloadSymbol` cron** | Giờ 1 VÀ giờ 5 | Chỉ giờ 1 |
| **HTS accounts** | Không dùng (`isUsingApi=true`, Lotte API thay thế) | Nhiều accounts theo instance (cho Lotte WS auth) |
| **Lotte WS host** | Internal IP | Internal IP |
| **accountDownload** | Config nhưng không dùng khi `isUsingApi=true` | Không cần cho download |
