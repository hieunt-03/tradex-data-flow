# 07 - WEBSOCKET GATEWAY: WS-V2 (SocketCluster)

> Tài liệu chuyên sâu về cơ chế hoạt động của WebSocket Gateway (ws-v2), từ kết nối, xác thực, quản lý kênh, nhận Kafka message, chuyển đổi payload, đến broadcast xuống Client.

---

## 1. CONNECTION & AUTH (Kết Nối và Xác Thực)

### 1.1. Khởi tạo Server

File: `index.js` → `server.js`

```
SocketCluster Server khởi tạo với:
- Port: env.SOCKETCLUSTER_PORT hoặc conf.port (default 8000)
- Path: conf.wsPath (default '/socketcluster/')
- Codec: sc-codec-min-bin (binary encoding, tiết kiệm bandwidth)
- Auth Key: conf.authKey (default '7b3db5832f3c559a12494374d7e2')
- Channel Limit: conf.channelLimit (default 4000 channels/socket)
- Ping: interval 8s, timeout 20s
- Origins: '*:*' (chấp nhận mọi origin)
- allowClientPublish: true
```

### 1.2. Login Flow — `authen.js`

Client gửi event `'login'` qua socket. Server xử lý theo `grant_type`:

| `grant_type` | Flow |
|---|---|
| **(mặc định — password)** | Kafka request → `'aaa'` service → `'post:/api/v1/login'` → nhận `accessToken` + `refreshToken` |
| `'refresh_token'` | Kafka request → `'aaa'` service → `'post:/api/v1/refreshToken'` → nhận `accessToken` mới |
| `'access_token'` | Chỉ decode JWT, không gọi backend |
| `'demo'` | Login nhưng không enforce single-session |

**Sau khi login thành công:**
```javascript
// jwt.js - decodeAccessToken() dùng RS256:
payload = jwt.verify(accessToken, publicKey, { algorithm: 'RS256' });
// Trả về: { userId, domain, serviceCode, clientId, scopeGroupIds,
//           serviceUsername, userData, platform, grantType, exp }

// Gán auth token lên socket:
socket.setAuthToken({
    s:  { gt: grant_type },              // state
    exp: payload.exp,                    // expiry
    token: payload,                      // decoded JWT payload
    accessToken: msg.data.accessToken,   // raw access token
    refreshToken: msg.data.refreshToken, // raw refresh token
    userInfo: msg.data.userInfo,         // user info từ AAA service
});

// Emit 'loggedIn' event về client
socket.emit('loggedIn', authData);
```

### 1.3. OTP Verification — `authen.js`

Client gửi event `'login/sec/verifyOTP'`:
- Gửi Kafka → `'aaa'` → `'post:/api/v1/login/sec/verifyOTP'`
- Cập nhật `state.otp = true` trong authToken
- Gán lại `socket.setAuthToken()` với token mới

### 1.4. Single Session Per User

Nếu `conf.allowOnly1SessionPerUser = true`:
- Sau login, publish Kafka message tới `communicationTopic` (`ws-v2.update`) với `{ userId, socketId }`.
- **TẤT CẢ ws-v2 instance** lắng nghe `communicationTopic` → `communicationHandler()`:
  - Duyệt tất cả socket đang kết nối
  - Nếu `userId` trùng và `socketId` khác → `socket.deauthenticate()` (kick session cũ)

### 1.5. Re-Authentication Middleware — `sccClusterHandler.js`

Middleware `MIDDLEWARE_AUTHENTICATE`:
- Khi socket đã authenticated, gửi Kafka request verify token → AAA service
- Nếu token invalid → `socket.deauthenticate()` cho tất cả socket cùng `signedAuthToken`
- Retry tối đa 3 lần

---

## 2. KÊNH (CHANNELS) & QUYỀN (SCOPE)

### 2.1. Middleware Pipeline (3 tầng)

```
Client subscribe channel "market.quote.VNM"
         │
         ▼
[MIDDLEWARE_SUBSCRIBE] channelSubscribeHandler.js
    ├─ checkNullChannel()      — reject nếu channel == null
    ├─ checkAuthenticatedChannels() — kiểm tra channel có cần auth?
    │    Authenticated channels (conf.js):
    │    ├─ "tradex.notify.global"        (exact match)
    │    ├─ /domain\.notify\.account\..*/ (regex)
    │    └─ /tradex\.notify\.user\..*/    (regex)
    ├─ checkSystemChannel()    — channel bắt đầu bằng system prefix → cần SYSTEM login
    └─ checkingReturnSnapShotInfo() — nếu data.returnSnapShot=true → trả snapshot hiện tại
         │
         ▼
    next() → subscription GRANTED

[MIDDLEWARE_PUBLISH_IN] channelPublishHandler.js
    ├─ checkNullChannel()
    └─ checkSystemChannel()
    (Không kiểm tra auth cho publish — allowClientPublish: true)

[MIDDLEWARE_AUTHENTICATE] sccClusterHandler.js
    └─ Re-verify token qua Kafka → AAA service
```

### 2.2. Scope Management — `scope.js`

**Load scope data:** Kafka request → `'configuration'` service:
- `/api/v1/admin/scope` → load tất cả scope definitions
- `/api/v1/admin/scopeGroup` → load scope groups

**Cấu trúc:**
```
scopeMap:      { scopeId → scope }
scopeGroupMap: { scopeGroupId → [scope, scope, ...] }
groupMap:      { groupId → group }
```

**Đặc biệt:**
- `unAuthenticated` scopes = group name `"PUBLIC"` → các scope này được assign cho client chưa login.
- `getScopes(scopeGroupIds)`: trả về scopes của user (từ JWT `sgIds`) + `unAuthenticatedScopes`.
- Scope data được cache vào file `/data/scopesCached.json`, reload nếu quá `maximumAliveTime` (24h).

### 2.3. Channel Pattern Mapping — Bảng Tổng Hợp

| Kafka Topic (Input) | SocketCluster Channel (Output) | Channel Pattern | Dành cho |
|---|---|---|---|
| `quoteUpdate` | `market.quote.{code}` | `market.quote.VNM` | Giá khớp lệnh Stock |
| `quoteUpdate` (type=INDEX) | `market.quote.{code}` | `market.quote.VN` | Giá chỉ số |
| `quoteUpdate` (type=FUTURES) | `market.quote.{code}` | `market.quote.VN30F2503` | Giá phái sinh |
| `quoteOddLotUpdate` | `market.quoteOddLot` | `market.quoteOddLot` | Giá khớp lô lẻ |
| `bidOfferUpdate` | `market.bidoffer.{code}` | `market.bidoffer.VNM` | Sổ lệnh Stock |
| `bidOfferOddLotUpdate` | `market.bidofferOddLot.{code}` | `market.bidofferOddLot.VNM` | Sổ lệnh lô lẻ |
| `extraUpdate` | `market.extra.{code}` | `market.extra.VN30F2503` | Extra data (basis, CW,...) |
| `calExtraUpdate` | `market.extra.{code}` | `market.extra.VNM` | High/Low year update |
| `marketStatus` | `market.status` | `market.status` | Trạng thái phiên |
| `dealNoticeUpdate` | `market.putthrough.deal.{market}` | `market.putthrough.deal.HOSE` | GD thỏa thuận |
| `advertisedUpdate` | `market.putthrough.advertise.{market}` | `market.putthrough.advertise.HNX` | Rao bán thỏa thuận |
| `statisticUpdate` | `market.statistic.{code}` | `market.statistic.VNM` | Thống kê buy/sell |
| `themeUpdate` | `market.theme.{themeCode}` | `market.theme.BANKING` | Theme sector |
| `refreshData` | `market.refreshData` | `market.refreshData` | Clear cache signal |
| `ws.broadcast` | `{data.cn}` (dynamic) | Bất kỳ | Broadcast từ backend |
| `orderMatch` | `orderMatch.{username}` | `orderMatch.user123` | Khớp lệnh cá nhân |
| `updateConditionalOrder` | `updateConditionalOrder.{username}` | `updateConditionalOrder.user123` | Cập nhật lệnh điều kiện |

---

## 3. DATA TRANSFORMATION (Parser) — Nén Payload

File: `parser.js` — chuyển object đầy đủ sang payload viết tắt (giảm 60-70% kích thước).

### 3.1. convertDataPublishV2Quote — Quote/Index/Futures

| Field gốc | Key viết tắt | Mô tả |
|---|---|---|
| `code` | `s` | Symbol code |
| `type` | `t` | Loại (STOCK/INDEX/FUTURES) |
| `time` | `ti` | Thời gian |
| `open` | `o` | Giá mở |
| `high` | `h` | Giá cao |
| `low` | `l` | Giá thấp |
| `last` | `c` | Giá đóng/cuối |
| `change` | `ch` | Thay đổi |
| `rate` | `ra` | % thay đổi |
| `tradingVolume` | `vo` | Tổng KLGD |
| `tradingValue` | `va` | Tổng GTGD |
| `matchingVolume` | `mv` | KL khớp |
| `averagePrice` | `a` | Giá trung bình |
| `matchedBy` | `mb` | BID/ASK |
| `totalBidVolume` | `tb` | Tổng KL mua |
| `totalOfferVolume` | `to` | Tổng KL bán |
| `turnoverRate` | `tor` | Tỷ lệ quay vòng |
| `foreignerBuyVolume` | `fr.bv` | KL NN mua |
| `foreignerSellVolume` | `fr.sv` | KL NN bán |
| `foreignerCurrentRoom` | `fr.cr` | Room NN còn |
| `foreignerTotalRoom` | `fr.tr` | Room NN tổng |
| *(INDEX only)* `ceilingCount` | `ic.ce` | Số mã trần |
| *(INDEX only)* `upCount` | `ic.up` | Số mã tăng |
| *(INDEX only)* `downCount` | `ic.dw` | Số mã giảm |
| *(INDEX only)* `floorCount` | `ic.fl` | Số mã sàn |
| *(FUTURES only)* `basis` | `ba` | Basis |

### 3.2. convertDataPublishV2BidOffer — Sổ Lệnh

| Field gốc | Key viết tắt | Mô tả |
|---|---|---|
| `session` | `ss` | Phiên (ATO/ATC/CONTINUOUS) |
| `totalBidVolume` | `tb` | Tổng KL mua |
| `totalOfferVolume` | `to` | Tổng KL bán |
| `bidOfferList[].bidPrice` | `bb[].p` | Giá mua bước i |
| `bidOfferList[].bidVolume` | `bb[].v` | KL mua bước i |
| `bidOfferList[].bidVolumeChange` | `bb[].c` | Thay đổi KL mua |
| `bidOfferList[].offerPrice` | `bo[].p` | Giá bán bước i |
| `bidOfferList[].offerVolume` | `bo[].v` | KL bán bước i |
| `bidOfferList[].offerVolumeChange` | `bo[].c` | Thay đổi KL bán |
| `expectedPrice` | `ep` | Giá dự kiến khớp |
| `expectedChange` | `exc` | Thay đổi dự kiến |
| `expectedRate` | `exr` | % thay đổi dự kiến |

### 3.3. convertDataPublishV2Extra — Extra (basis, CW, PT...)

Kế thừa toàn bộ fields Quote + thêm:

| Field gốc | Key viết tắt | Mô tả |
|---|---|---|
| `basis` | `ba` | Basis futures |
| `breakEven` | `be` | Break even CW |
| `ptVolume` | `pvo` | PT volume |
| `ptValue` | `pva` | PT value |
| `ceilingPrice` | `ce` | Giá trần |
| `floorPrice` | `fl` | Giá sàn |
| `referencePrice` | `re` | Giá tham chiếu |
| `exercisePrice` | `exp` | Giá thực hiện CW |
| `exerciseRatio` | `er` | Tỷ lệ thực hiện CW |
| `listedQuantity` | `lq` | KL niêm yết |
| `openInterest` | `oi` | Open interest futures |
| `marketType` | `m` | Sàn |
| `name` | `n1` | Tên VN |
| `nameEn` | `n2` | Tên EN |

---

## 4. INTERNAL BROKER — Cơ Chế Nhận & Broadcast

### 4.1. Kafka → SocketCluster Pipeline

File: `server.js` + `market.js`

```
server.js khởi tạo 4 Kafka StreamHandler:

1. MARKET DATA (V2):
   Topics: Object.keys(mapTopicToPublishV2) 
     = [calExtraUpdate, extraUpdate, quoteUpdate, quoteOddLotUpdate,
        bidOfferUpdate, bidOfferOddLotUpdate, dealNoticeUpdate,
        advertisedUpdate, marketStatus, tickerMesgUpdate,
        refreshData, statisticUpdate, themeUpdate]
   → processDataPublishV2(msg, scExchange)

2. WS BROADCAST:
   Topic: ['ws.broadcast']
   → wsBroadcastHandler(msg)
     data = { cn: channelName, bd: bodyData }
     → scExchange.publish(cn, bd)

3. ORDER MATCH:
   Topic: ['orderMatch']
   → orderMatchHandler(msg)
     → scExchange.publish('orderMatch.{username}', data)

4. CONDITIONAL ORDER:
   Topic: ['updateConditionalOrder']
   → updateConditionalOrderHandler(msg)
     → scExchange.publish('updateConditionalOrder.{username}', data)
```

### 4.2. processDataPublishV2 — Logic Chi Tiết

File: `market.js`, function `processDataPublishV2(msg, scExchange)`

```javascript
// 1. Parse Kafka message
topic = msg.topic;          // VD: "quoteUpdate"
message = JSON.parse(msg.value.toString());
data = message.data;        // SymbolQuote/BidOffer/MarketStatus...
channel = mapTopicToPublishV2[topic];  // VD: "market.quote"

// 2. Append code/market/theme vào channel
if (topic === "dealNoticeUpdate" || topic === "advertisedUpdate")
    channel += "." + data.marketType;     // → "market.putthrough.deal.HOSE"
if (topic in [statisticUpdate, extraUpdate, quoteUpdate, bidOfferUpdate, bidOfferOddLotUpdate])
    channel += "." + data.code;           // → "market.quote.VNM"
if (topic === "themeUpdate")
    channel += "." + data.themeCode;      // → "market.theme.BANKING"

// 3. Convert & Cache & Publish
switch (topic) {
    case "quoteUpdate":
        publishData = convertDataPublishV2Quote(data);     // parser.js
        // Cache: chỉ cache nếu volume mới > volume cũ
        if (cache[code] == null || cache[code].data.vo < publishData.vo)
            setToCacheInfo(code, publishData, cache);
        scExchange.publish(channel, publishData);
        break;

    case "bidOfferUpdate":
        result = convertDataPublishV2BidOffer(data);
        setToCacheInfo(code, result, cache);
        scExchange.publish(channel, result);
        break;

    case "marketStatus":
        setToCacheInfo(`${market}-${type}`, data, cacheMarketStatus);
        scExchange.publish(channel, data);  // Không convert, publish raw
        break;

    case "refreshData":
        releaseCacheInfo();                 // Xóa toàn bộ cache
        scExchange.publish(channel, data);
        break;
    // ... tương tự cho các topic khác
}
```

### 4.3. Snapshot on Subscribe — `returnSnapShot.js`

Khi client subscribe channel với `{ returnSnapShot: true }`:

1. `channelSubscribeHandler` gọi `checkingReturnSnapShotInfo(req)`.
2. Dựa vào channel prefix, extract `code`:
   - `market.quote.VNM` → code = `"VNM"`
   - `market.extra.VN30F2503` → code = `"VN30F2503"`
   - `market.bidoffer.HPG` → code = `"HPG"`
3. Check in-memory cache:
   - Nếu cache tồn tại và `dbAt` trong vòng TTL (300s = 5 phút) → trả cache ngay.
   - Nếu không → query Redis `getSymbolInfo(code)` → `convertSymbolInfoV2(info)` → cache + trả về.
4. Trả về qua callback channel: `market.returnSnapshot` (hoặc `{channel}.cb`).

> **Mục đích:** Client subscribe lần đầu nhận được trạng thái hiện tại ngay lập tức, không phải đợi tick tiếp theo.

---

## 5. WEBSOCKET REQUEST-RESPONSE (EMIT APIs)

Bên cạnh luồng Subscribe/Publish, WS-V2 còn hỗ trợ cơ chế Request-Response (Emit) trực tiếp qua WebSocket để thay thế một số API HTTP.

### 5.1. `/api/v2/market/symbolInfo`
File: `requestHandler.js` → `marketApi.js` → `returnSnapShot.js`

Giao tiếp với Gateway qua socket event: `'/api/v2/market/symbolInfo'`, kèm body là mảng các mã chứng khoán (tối đa `conf.marketApi.maxNumberOfSymbols`).

**Luồng xử lý:**
1. `server.js` bắt sự kiện và gọi `requestHandler.js`.
2. Chuyển tiếp tới hàm `getV2SymbolInfo()` để xử lý song song danh sách mã.
3. Chạy `returnSymbolSnapShotInfo(code)` cho từng mã:
   - Check in-memory cache tĩnh.
   - Nếu miss cache hoặc quá hạn (TTL mặc định 300s): query Redis (`getSymbolInfo` từ Hash `realtime_mapSymbolInfo`), convert sang định dạng viết tắt (`convertSymbolInfoV2`), lưu lại local cache và trả về.
4. Trả kết quả về cho client theo cấu trúc `{ data: [...] }`.

**Cấu trúc Payload trả về (Compact SymbolInfo):**
Gộp chung thông tin của SymbolQuote, BidOffer, Extra,... dưới dạng field viết tắt:
- `s`, `t`, `m`, `n1`, `n2`: Thông tin cơ bản, mã, loại, sàn, tên.
- `o`, `h`, `l`, `c`, `ch`, `ra`, `vo`, `va`: Open, High, Low, Last, Change, Rate, Volume, Value.
- `tb`, `to`: Tổng khối lượng mua/bán.
- `bb`, `bo`: Sổ lệnh 3 bước giá (Mua/Bán), mỗi bước gồm `{p, v, c}`.
- `fr` (`bv`, `sv`, `cr`, `tr`): Khối ngoại mua/bán/room hiện tại/tổng room.
- `hly`: Đỉnh/đáy 52 tuần (`h`: cao nhất, `l`: thấp nhất).
- `ss`: Trạng thái phiên (Vd: LO, ATO, ATC).

> **Mục đích:** Hỗ trợ Client (Web/Mobile) tải dữ liệu Snapshot ban đầu nhanh chóng qua chính kết nối WebSocket đã mở, tiết kiệm băng thông và kết nối HTTP request so với Query-V2.

---

## 6. SƠ ĐỒ TỔNG QUAN END-TO-END

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        REALTIME-V2                                          │
│                                                                             │
│  QuoteService      BidOfferService     MarketStatusService    ...           │
│       │                  │                    │                              │
│       │   (sau khi xử lý logic + lưu Redis)                                │
│       │                  │                    │                              │
│       ▼                  ▼                    ▼                              │
│  Kafka: quoteUpdate  bidOfferUpdate    marketStatus    statisticUpdate ...   │
│                                                                             │
└────────┬─────────────┬────────────────┬──────────────┬─────────────────────┘
         │             │                │              │
         ▼             ▼                ▼              ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         WS-V2 (SocketCluster Gateway)                       │
│                                                                             │
│  ┌─── Kafka StreamHandler ──────────────────────────────────────────┐       │
│  │  Topics: quoteUpdate, bidOfferUpdate, marketStatus, ...          │       │
│  │                                                                   │       │
│  │  market.js processDataPublishV2(msg):                            │       │
│  │    1. Parse Kafka msg → extract data + topic                     │       │
│  │    2. Map topic → channel:                                       │       │
│  │       quoteUpdate     → "market.quote.{code}"                   │       │
│  │       bidOfferUpdate  → "market.bidoffer.{code}"                │       │
│  │       marketStatus    → "market.status"                         │       │
│  │       statisticUpdate → "market.statistic.{code}"              │       │
│  │       dealNoticeUpdate→ "market.putthrough.deal.{market}"      │       │
│  │       ...                                                        │       │
│  │    3. Convert via parser.js:                                     │       │
│  │       convertDataPublishV2Quote()    → {s,c,o,h,l,ch,ra,vo,...} │       │
│  │       convertDataPublishV2BidOffer() → {s,bb,bo,ep,exc,exr,...} │       │
│  │    4. Cache in-memory (per code)                                │       │
│  │    5. scExchange.publish(channel, compactPayload)               │       │
│  └──────────────────────────────────────────────────────────────────┘       │
│                                                                             │
│  ┌─── Auth Middleware ──────────────────────────────────────────────┐       │
│  │  channelSubscribeHandler:                                        │       │
│  │    checkNullChannel → checkAuthenticatedChannels → checkSystem   │       │
│  │    + returnSnapShot: Redis query → cache → emit callback         │       │
│  │                                                                   │       │
│  │  authen.js:                                                      │       │
│  │    login (password/access_token/refresh_token) → Kafka → AAA     │       │
│  │    → JWT RS256 decode → socket.setAuthToken()                    │       │
│  └──────────────────────────────────────────────────────────────────┘       │
│                                                                             │
│         scExchange.publish(channel, data)                                   │
│              │                                                              │
└──────────────┼──────────────────────────────────────────────────────────────┘
               │ SocketCluster internal pub/sub
               ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         CLIENT (Mobile/Web App)                             │
│                                                                             │
│  socket.subscribe('market.quote.VNM', { returnSnapShot: true })            │
│  socket.subscribe('market.bidoffer.VNM')                                   │
│  socket.subscribe('market.status')                                         │
│  socket.subscribe('market.statistic.VNM')                                  │
│  socket.subscribe('orderMatch.myUsername')  // cần login trước             │
│                                                                             │
│  socket.on('market.returnSnapshot', data => ...)  // snapshot callback     │
│  channel.watch(data => {                                                    │
│     // data = compact payload: { s: "VNM", c: 85000, o: 84500, ... }      │
│  })                                                                         │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```
