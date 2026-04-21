// ============================================================================
// TradeX Market Data — Flow Definitions (rebuilt from context/06)
// ============================================================================
// Mỗi flow gồm:
//   - meta: id, title, subtitle, accent
//   - nodes[]: { id, kind, layer, title, subtitle, inputs[], outputs[],
//               position: {x,y}, details }
//   - edges[]: { source, target, label?, animated? }
//
// kind controls visual styling:
//   source   – WS / API nguồn bên ngoài (Lotte)
//   service  – Java/Node service (collector, realtime-v2, query-v2, ws-v2)
//   logic    – Bước xử lý / business logic bên trong 1 service
//   kafka    – Kafka topic
//   redis    – Redis hot state key
//   mongo    – MongoDB collection
//   api      – REST / RPC endpoint
//   ws       – Gateway / SocketCluster channel
//   client   – Mobile / Web client
//   schedule – Cron job trigger
//   config   – Feature flag / runtime config
// ============================================================================

// Node width = 320px, height ≈ 140-170px tùy nội dung
// Để có gap thoáng giữa các node:
//   - COL = 480 → gap ngang ≈ 160px
//   - ROW = 280 → gap dọc ≈ 110-140px (kể cả với multiplier 0.7 fanout dọc)
const COL = 480;
const ROW = 280;

// ─────────────────────────────────────────────────────────────────────────
// 0. OVERVIEW
// ─────────────────────────────────────────────────────────────────────────
const overview = {
  id: 'overview',
  title: 'OVERVIEW — Toàn cảnh runtime Market Data',
  subtitle:
    'Init từ REST · Ingest realtime từ WebSocket · Hợp nhất state ở Redis · Snapshot chọn lọc sang Mongo · Query Redis-first · Broadcast realtime qua ws-v2',
  accent: '#60a5fa',
  nodes: [
    {
      id: 'lotte-rest',
      kind: 'source',
      layer: 'Nguồn dữ liệu',
      title: 'Lotte REST API',
      subtitle: 'tsol/apikey/tuxsvc/market/*',
      position: { x: 0, y: 0 },
      inputs: [{ name: 'HTTP GET', type: 'REST', description: 'Init job + recover' }],
      outputs: [
        { name: 'securities-name / securities-price', type: 'JSON paged', description: 'Danh sách & giá' },
        { name: 'best-bid-offer', type: 'JSON', description: 'Snapshot order book đầu ngày' },
        { name: 'indexs-list / index-daily / DR APIs', type: 'JSON', description: 'Index + futures metadata' },
      ],
      details:
        'Là nguồn cho INIT JOB chạy đầu ngày (downloadSymbol) để dựng baseline market state. ' +
        'Page qua nextKey, batch ≤20 mã/request cho securities-price, 1 mã/request cho best-bid-offer.',
    },
    {
      id: 'lotte-ws',
      kind: 'source',
      layer: 'Nguồn dữ liệu',
      title: 'Lotte WebSocket',
      subtitle: 'ws://[lotte]:9900',
      position: { x: 0, y: ROW * 2 },
      inputs: [{ name: 'Subscribe channels', type: 'WS', description: 'sub/pro.pub.auto.*' }],
      outputs: [
        { name: 'auto.qt.<code>', type: 'pipe-delimited', description: 'Stock/CW/ETF quote tick' },
        { name: 'auto.bo.<code>', type: 'pipe-delimited', description: 'Bid/offer 10 levels' },
        { name: 'auto.idxqt.<code>', type: 'pipe-delimited', description: 'Index quote' },
        { name: 'auto.tickerNews.*', type: 'pipe-delimited', description: 'Session/market status events' },
      ],
      details:
        'Active ingest path runtime hiện tại (deploy scripts để accounts:[], chỉ websocketConnections). ' +
        'Một số node UAT còn có dr.qt và dr.bo cho futures.',
    },
    {
      id: 'collector',
      kind: 'service',
      layer: 'Collector layer',
      title: 'market-collector-lotte',
      subtitle: 'Java / Spring Boot',
      position: { x: COL, y: ROW },
      inputs: [
        { name: 'WsConnection.handleMessage()', type: 'raw text', description: 'parts[] từ Lotte WS' },
        { name: 'LotteApiSymbolInfoService', type: 'REST', description: 'Init/recover qua REST' },
      ],
      outputs: [
        { name: 'quoteUpdate', type: 'Kafka', description: 'Equity / Index / CW / ETF quote (cơ sở)' },
        { name: 'quoteUpdateDR', type: 'Kafka', description: 'DR / Futures quote (phái sinh)' },
        { name: 'quoteOddLotUpdate', type: 'Kafka', description: 'Lô lẻ (topic riêng)' },
        { name: 'bidOfferUpdate', type: 'Kafka', description: 'Order book Equity / CW / ETF' },
        { name: 'bidOfferUpdateDR', type: 'Kafka', description: 'Order book DR / Futures' },
        { name: 'bidOfferOddLotUpdate', type: 'Kafka', description: 'Lô lẻ (topic riêng)' },
        { name: 'extraUpdate / calExtraUpdate', type: 'Kafka', description: 'Basis / breakEven / pt' },
        { name: 'marketStatus', type: 'Kafka', description: 'ATO/LO/INTERMISSION/ATC/PLO/CLOSED' },
        { name: 'dealNoticeUpdate / advertisedUpdate', type: 'Kafka', description: 'Put-through' },
        { name: 'statisticUpdate', type: 'Kafka', description: '' },
        { name: 'symbolInfoUpdate', type: 'Kafka', description: 'Distributed init batch' },
      ],
      details:
        'StartupService.run() → RealTimeService.run() → start() → forEach websocketConnections → WsConnection.start(). ' +
        'Convert raw text thành QuoteUpdate / BidOfferUpdate / MarketStatusData rồi RequestSender.sendMessageSafe → Kafka.',
    },
    {
      id: 'kafka',
      kind: 'kafka',
      layer: 'Messaging',
      title: 'Kafka Cluster',
      subtitle: 'Market topics',
      position: { x: COL * 2, y: ROW },
      inputs: [
        { name: 'producer: collector', type: 'Kafka', description: 'quote/bidoffer/status/symbolInfo' },
        { name: 'producer: realtime-v2', type: 'Kafka', description: 'calExtraUpdate khi high/low year đổi' },
      ],
      outputs: [
        { name: 'realtime-v2 consumers', type: 'Kafka', description: 'QuoteUpdate / BidOffer / Extra / MarketStatus / SymbolInfoUpdate' },
        { name: 'ws-v2 consumers', type: 'Kafka', description: 'Direct fan-out cho client' },
      ],
      details:
        'Topics: quoteUpdate, quoteUpdateDR, quoteOddLotUpdate, ' +
        'bidOfferUpdate, bidOfferUpdateDR, bidOfferOddLotUpdate, ' +
        'extraUpdate, calExtraUpdate, marketStatus, symbolInfoUpdate, ' +
        'dealNoticeUpdate, advertisedUpdate, statisticUpdate.\n\n' +
        'Odd-lot stream luôn đi topic riêng — KHÔNG trộn với main session.',
    },
    {
      id: 'realtime',
      kind: 'service',
      layer: 'Realtime processing',
      title: 'realtime-v2',
      subtitle: 'Java / Spring Boot',
      position: { x: COL * 3, y: 0 },
      inputs: [{ name: 'Kafka market topics', type: 'Kafka', description: 'Tất cả market events' }],
      outputs: [
        { name: 'Redis hot state', type: 'Redis HSET/RPUSH', description: 'mapSymbolInfo / Daily / Quote / Statistic' },
        { name: 'Mongo snapshot', type: 'MongoDB bulk', description: 'saveRedisToDatabase 6 lần/ngày' },
        { name: 'calExtraUpdate', type: 'Kafka', description: 'Khi high/low year đổi' },
      ],
      details:
        'Hợp nhất state realtime, tạo minute bar, statistic, market status. ' +
        'Runtime flags hiện tại: enableSaveQuote=false, enableSaveQuoteMinute=false, enableSaveBidAsk=false → không persist tick/minute/bid-offer theo event.',
    },
    {
      id: 'redis',
      kind: 'redis',
      layer: 'Hot state',
      title: 'Redis',
      subtitle: 'Intraday hot store',
      position: { x: COL * 4, y: 0 },
      inputs: [{ name: 'realtime-v2 services', type: 'HSET/RPUSH', description: 'Quote/BidOffer/Extra/Status/DealNotice services' }],
      outputs: [
        { name: 'mapSymbolInfo / mapSymbolInfoOddLot', type: 'Hash', description: 'Main + odd-lot top book' },
        { name: 'mapSymbolDaily / mapForeignerDaily', type: 'Hash', description: 'Daily OHLC + foreigner room' },
        { name: 'listQuote_{code} / listQuoteMinute_{code} / listQuoteMeta_{code}', type: 'List', description: 'Tick + minute + partition meta' },
        { name: 'listBidOfferOddLot_{code}', type: 'List', description: 'Odd-lot history (runtime ON)' },
        { name: 'mapSymbolStatistic / mapMarketStatus', type: 'Hash', description: 'Statistic + session status' },
        { name: 'listDealNotice_{market} / listAdvertised_{market}', type: 'List', description: 'Put-through history theo sàn' },
        { name: 'symbolInfoExtend', type: 'Hash', description: 'Metadata phụ (right info, etc.)' },
        { name: 'market_rise_false_stock_ranking_{market}_{ranking}_{period}', type: 'String', description: 'Snapshot ranking đã tính' },
        { name: 'market_right_info_{code}', type: 'String', description: 'Quyền phát hành / cổ tức' },
        { name: 'notice_{type}', type: 'Hash', description: 'Notification theo loại' },
      ],
      details:
        'Là PRIMARY store cho intraday. Reset bởi cron removeAutoData (00:55), refreshSymbolInfo (01:35), clearOldSymbolDaily (22:50).\n\n' +
        'REDIS_KEY constants (file market-query-v2/src/services/RedisService.ts):\n' +
        '  SYMBOL_INFO, SYMBOL_INFO_ODD_LOT, SYMBOL_DAILY, FOREIGNER_DAILY,\n' +
        '  SYMBOL_QUOTE, SYMBOL_QUOTE_META, SYMBOL_STATISTICS, SYMBOL_BID_OFFER,\n' +
        '  SYMBOL_QUOTE_MINUTE, DEAL_NOTICE, ADVERTISED, MARKET_STATUS,\n' +
        '  SYMBOL_INFO_EXTEND, STOCK_RANKING_PERIOD, SYMBOL_STOCK_RIGHT, NOTIFICATION.',
    },
    {
      id: 'mongo',
      kind: 'mongo',
      layer: 'Persistence',
      title: 'MongoDB',
      subtitle: 'Snapshot / day-level only',
      position: { x: COL * 4, y: ROW * 2 },
      inputs: [{ name: 'saveRedisToDatabase()', type: 'bulk write', description: 'Cron 0 15,29 10,11,14 MON-FRI' }],
      outputs: [{ name: 'Fallback cho query-v2', type: 'find()', description: 'Khi Redis miss (rất hiếm)' }],
      details:
        'Active collections: c_symbol_info, c_symbol_daily, c_foreigner_daily, c_market_session_status, c_deal_notice, c_advertise, c_symbol_previous. ' +
        'KHÔNG ghi: c_symbol_quote, c_symbol_quote_minute, c_bid_offer (flags tắt).',
    },
    {
      id: 'query',
      kind: 'service',
      layer: 'Query layer',
      title: 'market-query-v2',
      subtitle: 'Node.js / TypeScript',
      position: { x: COL * 5, y: ROW },
      inputs: [
        { name: 'REST request', type: 'HTTP', description: 'Mobile/Web' },
        { name: 'Redis primary', type: 'HGET/LRANGE', description: 'Intraday' },
        { name: 'Mongo fallback', type: 'find()', description: 'Historical hoặc khi Redis thiếu' },
      ],
      outputs: [{ name: 'JSON response', type: 'HTTP 200', description: 'Board, tick, minute, statistic, session' }],
      details:
        'Redis-first cho intraday. Endpoints: querySymbolLatest, priceBoard, querySymbolQuote, querySymbolQuoteTick, querySymbolQuoteMinutes, queryMinuteChartBySymbol, querySymbolStatistics, MarketSessionStatusService.',
    },
    {
      id: 'wsv2',
      kind: 'ws',
      layer: 'Realtime delivery',
      title: 'ws-v2 (SocketCluster)',
      subtitle: 'Node.js gateway',
      position: { x: COL * 5, y: ROW * 3 },
      inputs: [{ name: 'Kafka market topics', type: 'consume', description: 'Direct, không qua Mongo' }],
      outputs: [{ name: 'SocketCluster publish', type: 'channel', description: 'market.quote.{code}, market.bidoffer.{code}, market.status, ...' }],
      details:
        'market.js processDataPublishV2() → mapTopicToPublishV2 → parser.js compact payload → cache → publish. ' +
        'Snapshot on subscribe nếu req.data.returnSnapShot=true.',
    },
    {
      id: 'client',
      kind: 'client',
      layer: 'Client',
      title: 'Mobile / Web App',
      subtitle: 'TradeX clients',
      position: { x: COL * 6, y: ROW * 2 },
      inputs: [
        { name: 'REST từ query-v2', type: 'HTTPS', description: 'Page load + lazy fetch' },
        { name: 'WS từ ws-v2', type: 'SocketCluster', description: 'Realtime channels + snapshot' },
      ],
      outputs: [{ name: 'Render board / chart / order book', type: 'UI', description: '' }],
      details: 'Page load: query-v2 cho snapshot ban đầu. Subscribe ws-v2 cho realtime stream + optional snapshot.',
    },
    {
      id: 'cron-jobs',
      kind: 'schedule',
      layer: 'Cron jobs',
      title: 'Realtime-v2 cron jobs',
      subtitle: 'Daily lifecycle',
      position: { x: COL * 3, y: ROW * 3 },
      inputs: [{ name: 'Spring @Scheduled', type: 'cron', description: '' }],
      outputs: [
        { name: 'removeAutoData', type: '0 55 0 * * MON-FRI', description: 'Reset tick/minute/bid-offer' },
        { name: 'refreshSymbolInfo', type: '0 35 1 * * MON-FRI', description: 'Reset sequence + bidOfferList' },
        { name: 'clearOldSymbolDaily', type: '0 50 22 * * MON-FRI', description: 'Clear daily map' },
        { name: 'saveRedisToDatabase', type: '0 15,29 10,11,14 * * MON-FRI', description: 'Snapshot Mongo 6 lần/ngày' },
      ],
      details:
        'Lifecycle realtime-v2: 00:55 reset hot state → 01:35 refresh symbol info → ban ngày 6 lần snapshot → 22:50 dọn daily.',
    },
  ],
  edges: [
    { source: 'lotte-rest', target: 'collector', label: 'REST init/recover' },
    { source: 'lotte-ws', target: 'collector', label: 'WS subscribe', animated: true },
    { source: 'collector', target: 'kafka', label: 'producer', animated: true },
    { source: 'kafka', target: 'realtime', label: 'consumer', animated: true },
    { source: 'realtime', target: 'redis', label: 'HSET / RPUSH', animated: true },
    { source: 'realtime', target: 'mongo', label: 'snapshot', animated: false },
    { source: 'redis', target: 'query', label: 'HGET / LRANGE' },
    { source: 'mongo', target: 'query', label: 'fallback' },
    { source: 'kafka', target: 'wsv2', label: 'consumer', animated: true },
    { source: 'query', target: 'client', label: 'REST JSON' },
    { source: 'wsv2', target: 'client', label: 'SocketCluster', animated: true },
    { source: 'cron-jobs', target: 'redis', label: 'reset / refresh' },
    { source: 'cron-jobs', target: 'mongo', label: 'saveRedisToDatabase' },
  ],
};

// ─────────────────────────────────────────────────────────────────────────
// 1. INIT JOB — downloadSymbol baseline đầu ngày
// ─────────────────────────────────────────────────────────────────────────
const initJobFlow = {
  id: 'init-job',
  title: 'INIT JOB — downloadSymbol baseline đầu ngày',
  subtitle:
    'Cron / startup → LotteApiSymbolInfoService → REST APIs → merge → 2 mode init (direct hoặc qua Kafka symbolInfoUpdate)',
  accent: '#f59e0b',
  nodes: [
    {
      id: 'trigger',
      kind: 'schedule',
      layer: 'Trigger',
      title: 'JobService.downloadSymbol()',
      subtitle: 'cron + startup',
      position: { x: 0, y: ROW },
      inputs: [
        { name: 'Spring cron', type: 'cron', description: 'Trigger đầu ngày' },
        { name: 'StartupService.run()', type: 'JVM boot', description: 'RealTimeService → downloadResource()' },
      ],
      outputs: [{ name: 'symbolInfoService.downloadSymbol("JobScheduler")', type: 'call', description: 'Kick off init' }],
      details: 'File: services/market-collector-lotte/.../job/JobService.java và .../services/StartupService.java.',
    },
    {
      id: 'orch',
      kind: 'service',
      layer: 'Collector orchestration',
      title: 'LotteApiSymbolInfoService.downloadSymbol(id)',
      subtitle: 'Build full market universe',
      position: { x: COL, y: ROW * 2.5 },
      inputs: [{ name: 'logical init request', type: 'string id', description: 'Source: cron hoặc startup' }],
      outputs: [{ name: 'orchestration', type: 'gọi 5 step download', description: 'list → idx → info → idxInfo → DR' }],
      details: 'Orchestrate 5 download step rồi merge thành SymbolInfo hoàn chỉnh, cuối cùng quyết định init mode theo enableInitMarket.',
    },

    // ─── 5 steps ở COL*2 (stack dọc) ───────────────────────────────
    {
      id: 'step-list',
      kind: 'logic',
      layer: 'Step 1',
      title: 'downloadSymbolList()',
      subtitle: 'Stock / CW / ETF / bond',
      position: { x: COL * 2, y: 0 },
      inputs: [{ name: 'GET /securities-name', type: 'paginated', description: 'Loop tới hasNext=false' }],
      outputs: [{ name: 'Map<String, SymbolNameResponse.Item>', type: 'in-memory', description: 'Tổng hợp toàn bộ symbol name/type/exchange' }],
      details: 'Cộng dồn toàn bộ page vào Map trước khi sang bước query giá và bid/ask.',
    },
    {
      id: 'step-idx',
      kind: 'logic',
      layer: 'Step 2',
      title: 'downloadIndexList()',
      subtitle: 'Index list',
      position: { x: COL * 2, y: ROW },
      inputs: [{ name: 'GET /indexs-list', type: 'paginated REST', description: 'Tải danh sách mã index từ Lotte' }],
      outputs: [{ name: 'index code map', type: 'in-memory', description: 'Cho downloadIndexInfo() và mapping 09401→VNSI runtime' }],
      details: 'Bước này chuẩn bị input cho downloadIndexInfo() và cho handleIndexQuote() ở runtime WebSocket.',
    },
    {
      id: 'step-info',
      kind: 'logic',
      layer: 'Step 3',
      title: 'downloadSymbolInfo()',
      subtitle: 'Stock / CW / ETF / bond info',
      position: { x: COL * 2, y: ROW * 2.5 },
      inputs: [
        { name: 'best-bid-offer per code', type: 'REST', description: 'Order book baseline' },
        { name: 'securities-price batch', type: 'REST', description: 'Giá baseline' },
      ],
      outputs: [{ name: 'Map<String, SymbolInfo>', type: 'in-memory', description: 'SymbolInfo cho stock/CW/ETF/bond' }],
      details: 'Query batch giá + per-code bid/offer rồi merge vào SymbolInfo.',
    },
    {
      id: 'step-idx-info',
      kind: 'logic',
      layer: 'Step 4',
      title: 'downloadIndexInfo()',
      subtitle: 'Index info',
      position: { x: COL * 2, y: ROW * 4 },
      inputs: [{ name: 'index APIs', type: 'REST', description: 'Per index code (chưa có raw sample log)' }],
      outputs: [{ name: 'SymbolInfo(type=INDEX)', type: 'in-memory', description: 'Index info cho merge' }],
      details: 'Dùng index code map từ step-idx để query info chi tiết từng index.',
    },
    {
      id: 'step-dr',
      kind: 'logic',
      layer: 'Step 5',
      title: 'downloadDerivatives()',
      subtitle: 'Futures',
      position: { x: COL * 2, y: ROW * 5 },
      inputs: [{ name: 'DR APIs', type: 'REST', description: 'Derivatives endpoints (chưa có raw sample log)' }],
      outputs: [{ name: 'SymbolInfo(type=FUTURES)', type: 'in-memory', description: 'Futures info cho merge' }],
      details: 'Tải futures metadata; với VN30F* sẽ có thêm refCode mapping ở runtime.',
    },

    // ─── APIs ở COL*3 cặp đôi với từng step ────────────────────────
    {
      id: 'api-name',
      kind: 'api',
      layer: 'Lotte REST API',
      title: 'GET /securities-name',
      subtitle: 'Page qua nextKey',
      position: { x: COL * 3, y: 0 },
      inputs: [{ name: 'paginated request', type: 'REST', description: 'nextKey, hasNext' }],
      outputs: [{ name: 'list[]', type: 'JSON', description: 'symbol, code, exchange, type, names' }],
      details:
        'Sample log 2026-04-20: trang nextKey=1200 chứa stock SBV/SC5/SHB/SSB; trang nextKey=1900 chứa coveredwarrant CMSN2606/CMWG2601/CSHB2505/CSTB2601. ' +
        'Mỗi page có thể trộn nhiều type (stock + coveredwarrant).',
    },
    {
      id: 'api-idx-list',
      kind: 'api',
      layer: 'Lotte REST API',
      title: 'GET /indexs-list',
      subtitle: 'Index codes',
      position: { x: COL * 3, y: ROW },
      inputs: [{ name: 'paginated request', type: 'REST', description: 'Trả paginated giống securities-name' }],
      outputs: [{ name: 'list[] index', type: 'JSON', description: 'idxCode → name (ví dụ 09401 → VN Sustainability Index → VNSI)' }],
      details: 'Dùng cho mapping 09401 → VNSI ở handleIndexQuote runtime. Chưa có raw sample log trong bundle hiện tại.',
    },
    {
      id: 'api-bbo',
      kind: 'api',
      layer: 'Lotte REST API',
      title: 'GET /best-bid-offer',
      subtitle: '1 mã / request',
      position: { x: COL * 3, y: ROW * 2.1 },
      inputs: [{ name: '{stk_cd: code, bo_cnt: "10"}', type: 'REST', description: 'Per code' }],
      outputs: [
        { name: 'ceiling/floor/refPrice/last', type: 'JSON', description: 'Baseline biên độ' },
        { name: 'bidOfferList[10]', type: 'JSON', description: 'Order book; đầu ngày thường toàn 0' },
      ],
      details:
        'Sample log SHB: ceiling=16500, floor=14400, refPrice=18100, last=18100, matchedVol=0, bidOfferList toàn {bid:0, bidSize:0, offer:0, offerSize:0}. ' +
        'Sample CW CSHB2505 tương tự. Các dòng bid/offer toàn 0 sẽ bị filter bỏ khi merge → SymbolInfo.bidOfferList có thể rỗng.',
    },
    {
      id: 'api-price',
      kind: 'api',
      layer: 'Lotte REST API',
      title: 'GET /securities-price',
      subtitle: 'Batch ≤20 mã',
      position: { x: COL * 3, y: ROW * 2.9 },
      inputs: [{ name: 'list code (batch ≤20)', type: 'REST', description: 'Sau khi có symbol list' }],
      outputs: [{ name: 'SymbolPriceResponse', type: 'JSON batch', description: 'Giá + foreigner + listedQty + ...' }],
      details: 'Chưa có raw sample log trong bundle hiện tại, nhưng code path đã xác nhận.',
    },

    // ─── Merge + branch ────────────────────────────────────────────
    {
      id: 'merge',
      kind: 'logic',
      layer: 'Merge',
      title: 'merge(name + price + bidAsk)',
      subtitle: 'Build complete SymbolInfo',
      position: { x: COL * 4, y: ROW * 2.5 },
      inputs: [
        { name: 'symbolName item', type: 'object', description: 'metadata' },
        { name: 'symbolPrice', type: 'object', description: 'OHLC + foreigner + biên' },
        { name: 'bidAskResponse', type: 'object', description: 'Order book' },
      ],
      outputs: [{ name: 'SymbolInfo hoàn chỉnh', type: 'object', description: 'allSymbols list' }],
      details:
        'Map các nhóm: giá (open/high/low/last/change/rate/tradingVolume/Value), thời gian (time/highTime/lowTime), biên (ceiling/floor/refPrice), ' +
        'intraday (averagePrice/turnoverRate/matchingVolume/bidOfferList/totalBid+OfferVolume/expectedPrice), ' +
        'foreigner (buy/sell/totalRoom/currentRoom), metadata (code/name/type/exchange/marketType/listedQuantity/controlCode/underlyingSymbol/highLowYearData).',
    },
    {
      id: 'flag-init',
      kind: 'config',
      layer: 'Feature flag',
      title: 'enableInitMarket',
      subtitle: 'Quyết định mode',
      position: { x: COL * 5, y: ROW * 2.5 },
      inputs: [{ name: 'application config', type: 'boolean', description: 'true / false' }],
      outputs: [
        { name: 'true → direct init', type: 'branch', description: 'Ghi thẳng baseline' },
        { name: 'false → distributed init', type: 'branch', description: 'Qua Kafka cho realtime-v2' },
      ],
      details: 'Switch giữa direct init (ghi luôn) hoặc distributed init (qua Kafka cho realtime-v2 init).',
    },
    {
      id: 'init-direct',
      kind: 'logic',
      layer: 'Mode A',
      title: 'marketInit.init(allSymbols)',
      subtitle: 'Direct init',
      position: { x: COL * 6, y: ROW * 0.8 },
      inputs: [{ name: 'List<SymbolInfo>', type: 'object', description: 'Universe đầy đủ' }],
      outputs: [
        { name: 'Redis baseline', type: 'HSET', description: 'realtime_mapSymbolInfo' },
        { name: 'Mongo baseline', type: 'upsert', description: 'c_symbol_info' },
        { name: 'symbol_static_data.json', type: 'file', description: 'uploadMarketDataFile()' },
      ],
      details: 'Chạy khi enableInitMarket=true. Source MarketInit nằm ngoài workspace nên field-level lib không liệt kê hết được.',
    },
    {
      id: 'kafka-symbol-info',
      kind: 'kafka',
      layer: 'Mode B',
      title: 'Kafka symbolInfoUpdate',
      subtitle: 'Distributed init',
      position: { x: COL * 6, y: ROW * 4.2 },
      inputs: [{ name: 'sendSymbolInfoUpdate(groupId, allSymbols)', type: 'producer', description: 'Split / group messages' }],
      outputs: [{ name: 'realtime-v2 InitService consume', type: 'Kafka', description: 'Buffer theo groupId' }],
      details: 'Chạy khi enableInitMarket=false. Group messages theo groupId để realtime-v2 batch init.',
    },
    {
      id: 'init-service',
      kind: 'service',
      layer: 'Realtime init',
      title: 'realtime-v2 InitService',
      subtitle: 'Buffer + apply',
      position: { x: COL * 7, y: ROW * 4.2 },
      inputs: [{ name: 'SymbolInfoUpdate messages', type: 'Kafka', description: 'Group theo groupId' }],
      outputs: [
        { name: 'monitorService.pauseAll()', type: 'control', description: 'Pause consumer threads' },
        { name: 'cacheService clean', type: 'control', description: 'Clean cache theo command' },
        { name: 'symbolInfoService.updateBySymbolInfoUpdate()', type: 'apply', description: 'Apply batch update' },
        { name: 'marketInit.init(cache.values())', type: 'apply', description: 'Re-init từ cache' },
        { name: 'cacheService.reset() + resume', type: 'control', description: 'Resume threads' },
      ],
      details:
        'Lifecycle: 1) nhận đủ messages hoặc timeout 60s · 2) pauseAll · 3) clean cache · 4) updateBySymbolInfoUpdate · 5) marketInit.init · 6) cacheService.reset() · 7) resume threads.',
    },
    {
      id: 'redis-baseline',
      kind: 'redis',
      layer: 'Output',
      title: 'realtime_mapSymbolInfo',
      subtitle: 'Baseline đầu ngày',
      position: { x: COL * 8, y: ROW * 1.5 },
      inputs: [{ name: 'marketInit.init', type: 'HSET', description: 'Direct hoặc qua InitService' }],
      outputs: [{ name: 'Sẵn sàng cho QuoteService.updateQuote()', type: 'Hash', description: 'Tick chỉ accept khi đã có baseline' }],
      details: 'Baseline phải có trước khi tick đầu tiên về, vì reCalculate() validate có SymbolInfo mới chấp nhận quote.',
    },
    {
      id: 'mongo-baseline',
      kind: 'mongo',
      layer: 'Output',
      title: 'c_symbol_info baseline',
      subtitle: 'Persisted master',
      position: { x: COL * 8, y: ROW * 3.5 },
      inputs: [{ name: 'marketInit.init', type: 'upsert', description: 'Bulk upsert từ allSymbols' }],
      outputs: [{ name: 'Master data ngày', type: 'collection', description: 'Snapshot symbol info ngày' }],
      details: 'Đảm bảo có snapshot symbol info ngày sau init xong, độc lập với cron saveRedisToDatabase.',
    },
  ],
  edges: [
    { source: 'trigger', target: 'orch', label: 'downloadSymbol(id)' },
    { source: 'orch', target: 'step-list', label: 'step 1' },
    { source: 'orch', target: 'step-idx', label: 'step 2' },
    { source: 'orch', target: 'step-info', label: 'step 3' },
    { source: 'orch', target: 'step-idx-info', label: 'step 4' },
    { source: 'orch', target: 'step-dr', label: 'step 5' },

    // step ↔ API: 2 chiều (call + response) cho tất cả các cặp
    { source: 'step-list', target: 'api-name', label: 'GET', animated: true },
    { source: 'api-name', target: 'step-list', label: 'paged JSON' },
    { source: 'step-idx', target: 'api-idx-list', label: 'GET', animated: true },
    { source: 'api-idx-list', target: 'step-idx', label: 'paged JSON' },
    { source: 'step-info', target: 'api-bbo', label: 'GET per code', animated: true },
    { source: 'api-bbo', target: 'step-info', label: 'bid/offer JSON' },
    { source: 'step-info', target: 'api-price', label: 'GET batch', animated: true },
    { source: 'api-price', target: 'step-info', label: 'price JSON' },

    // step → merge
    { source: 'step-list', target: 'merge', label: 'name map' },
    { source: 'step-idx', target: 'step-idx-info', label: 'index code map' },
    { source: 'step-info', target: 'merge', label: 'price + bidAsk' },
    { source: 'step-idx-info', target: 'merge', label: 'INDEX' },
    { source: 'step-dr', target: 'merge', label: 'FUTURES' },

    // merge → flag → 2 modes
    { source: 'merge', target: 'flag-init', label: 'allSymbols' },
    { source: 'flag-init', target: 'init-direct', label: 'enableInitMarket=true' },
    { source: 'flag-init', target: 'kafka-symbol-info', label: 'enableInitMarket=false', animated: true },
    { source: 'kafka-symbol-info', target: 'init-service', label: 'consume', animated: true },

    // 2 modes → outputs
    { source: 'init-direct', target: 'redis-baseline', label: 'HSET' },
    { source: 'init-direct', target: 'mongo-baseline', label: 'upsert' },
    { source: 'init-service', target: 'redis-baseline', label: 'HSET' },
    { source: 'init-service', target: 'mongo-baseline', label: 'upsert' },
  ],
};

// ─────────────────────────────────────────────────────────────────────────
// 2. QUOTE FLOW — auto.qt → quoteUpdate
// ─────────────────────────────────────────────────────────────────────────
const quoteFlow = {
  id: 'quote-flow',
  title: 'QUOTE FLOW — auto.qt → quoteUpdate → Redis',
  subtitle: 'Lotte WS tick → handleStockQuote → Kafka quoteUpdate → realtime-v2 → Redis hot state',
  accent: '#22c55e',
  nodes: [
    {
      id: 'ws',
      kind: 'source',
      layer: 'Lotte WS',
      title: 'auto.qt.<code>',
      subtitle: 'pipe-delimited tick',
      position: { x: 0, y: ROW * 1.5 },
      inputs: [{ name: 'subscribe sub/pro.pub.auto.qt./...', type: 'WS', description: '' }],
      outputs: [
        {
          name: 'raw line',
          type: 'string',
          description: 'auto.qt.BCM|1|93020|BCM|91500|91903|55800.0|2|55800.0|2|55600.0|5|55800.0|2|100.0|...|83|...',
        },
      ],
      details: 'Time raw 93020 = HH:mm:ss theo local Lotte (VN timezone).',
    },
    {
      id: 'handle-msg',
      kind: 'logic',
      layer: 'WsConnection',
      title: 'handleMessage(payload)',
      subtitle: 'Dispatch theo prefix',
      position: { x: COL, y: ROW * 1.5 },
      inputs: [{ name: 'raw text', type: 'string', description: 'splitted thành parts[]' }],
      outputs: [
        { name: 'handleStockQuote(parts)', type: 'route', description: 'auto.qt.* và auto.idxqt.* sau khi check' },
        { name: 'handleStockBidAsk(parts)', type: 'route', description: 'auto.bo.* (xem flow BidOffer)' },
      ],
      details: 'Dispatcher chính của WsConnection.',
    },
    {
      id: 'handle-quote',
      kind: 'logic',
      layer: 'WsConnection',
      title: 'handleStockQuote(parts)',
      subtitle: 'Build QuoteUpdate',
      position: { x: COL * 2, y: ROW * 1.5 },
      inputs: [{ name: 'parts[]', type: 'string[]', description: 'split bởi |' }],
      outputs: [
        {
          name: 'QuoteUpdate',
          type: 'object',
          description:
            'time (parts[2], VN→UTC), code (parts[3]), highTime (parts[4]), lowTime (parts[5]), open (parts[6]), high (parts[8]), low (parts[10]), last (parts[12]), change (parts[14]), rate (parts[16]), turnoverRate (parts[17]), averagePrice (parts[18]), referencePrice (parts[20]), tradingValue (parts[21]), tradingVolume (parts[22]), matchingVolume (parts[23]), matchedBy (parts[24] 83=ASK 66=BID), foreigner Buy/Sell/TotalRoom/CurrentRoom (parts[25..28]), activeSell/BuyVolume (parts[33..34])',
        },
      ],
      details:
        'Time conversion nuance: time parse theo VN → convert UTC trước format → "023020". highTime/lowTime parse theo VN nhưng KHÔNG convert UTC → ra "091500"/"091903". ' +
        'Tức log runtime đang dùng 2 cách biểu diễn time khác nhau cho cùng 1 quote object.',
    },
    {
      id: 'sender',
      kind: 'logic',
      layer: 'Producer',
      title: 'RequestSender.sendMessageSafe',
      subtitle: '"quoteUpdate", "Update", QuoteUpdate',
      position: { x: COL * 3, y: ROW * 1.5 },
      inputs: [{ name: 'QuoteUpdate', type: 'object', description: '' }],
      outputs: [
        { name: 'topic quoteUpdate', type: 'Kafka', description: 'Equity / Index / CW / ETF' },
        { name: 'topic quoteUpdateDR', type: 'Kafka', description: 'DR / Futures' },
      ],
      details: 'WsConnectionThread.run() chọn topic theo type của object.',
    },
    {
      id: 'kafka',
      kind: 'kafka',
      layer: 'Kafka',
      title: 'topic quoteUpdate',
      subtitle: 'Message<SymbolQuote>',
      position: { x: COL * 4, y: ROW * 1.5 },
      inputs: [{ name: 'producer collector', type: 'Kafka', description: '' }],
      outputs: [
        { name: 'realtime-v2 consumer', type: 'Kafka', description: 'QuoteUpdateHandler' },
        { name: 'ws-v2 consumer', type: 'Kafka', description: 'Direct broadcast (xem WS flow)' },
      ],
      details: '',
    },
    {
      id: 'handler',
      kind: 'logic',
      layer: 'realtime-v2',
      title: 'QuoteUpdateHandler.handle()',
      subtitle: 'Null-check + forward',
      position: { x: COL * 5, y: ROW * 0.5 },
      inputs: [{ name: 'Message<SymbolQuote>', type: 'Kafka payload', description: '' }],
      outputs: [{ name: 'monitorService.rcv(symbolQuote)', type: 'call', description: '' }],
      details: '',
    },
    {
      id: 'monitor',
      kind: 'logic',
      layer: 'realtime-v2',
      title: 'MonitorService',
      subtitle: 'Per-code queue + dispatch',
      position: { x: COL * 5, y: ROW * 1.5 },
      inputs: [{ name: 'rcv(symbolQuote)', type: 'enqueue', description: 'Queue theo code' }],
      outputs: [{ name: 'handler() → updateQuote()', type: 'dispatch', description: 'By type' }],
      details: 'Đảm bảo per-code thứ tự xử lý, không race giữa các tick cùng mã.',
    },
    {
      id: 'qs-update',
      kind: 'logic',
      layer: 'realtime-v2',
      title: 'QuoteService.updateQuote()',
      subtitle: 'Normalize + recalc + write',
      position: { x: COL * 6, y: ROW * 1.5 },
      inputs: [{ name: 'SymbolQuote', type: 'object', description: '' }],
      outputs: [
        { name: 'reCalculate(symbolQuote)', type: 'logic', description: '' },
        { name: 'Redis writes (7 keys)', type: 'HSET/RPUSH', description: '' },
      ],
      details: '',
    },
    {
      id: 'recalc',
      kind: 'logic',
      layer: 'realtime-v2',
      title: 'reCalculate(symbolQuote)',
      subtitle: 'Validate + enrich',
      position: { x: COL * 7, y: ROW * 0.3 },
      inputs: [{ name: 'SymbolQuote', type: 'object', description: '' }],
      outputs: [
        { name: 'date / createdAt / updatedAt / milliseconds / id', type: 'set', description: 'id = code+date+tradingVolume' },
        { name: 'STOCK: foreignerMatchBuy/Sell, holdVolume, buyAbleRatio, holdRatio', type: 'compute', description: '' },
        { name: 'FUTURES: refCode', type: 'set', description: '' },
        { name: 'Kafka calExtraUpdate', type: 'producer', description: 'khi high/low year đổi' },
      ],
      details:
        'Validate có SymbolInfo trong cache + tradingVolume>=0. Nếu sai thứ tự volume và enableCheckOrderQuote=true → add wrong-order Redis (nếu bật) và return false.',
    },
    {
      id: 'flag-quote',
      kind: 'config',
      layer: 'Feature flag',
      title: 'enableSaveQuote / Minute / BidAsk',
      subtitle: 'false trên runtime hiện tại',
      position: { x: COL * 7, y: ROW * 3 },
      inputs: [{ name: 'application config', type: 'boolean', description: '' }],
      outputs: [{ name: 'KHÔNG persist tick/minute event vào Mongo', type: 'branch', description: '' }],
      details: 'Hệ quả: không có path event → c_symbol_quote / c_symbol_quote_minute / c_bid_offer.',
    },
    {
      id: 'redis-stat',
      kind: 'redis',
      layer: 'Redis writes',
      title: 'realtime_mapSymbolStatistic[code]',
      subtitle: 'Hash',
      position: { x: COL * 8, y: 0 },
      inputs: [{ name: 'matched buy/sell/unknown', type: 'compute', description: 'theo matchedBy (ASK/BID/UNKNOWN)' }],
      outputs: [{ name: 'statistic latest', type: 'Hash', description: 'Aggregated theo price level' }],
      details:
        'Chỉ áp dụng khi type != INDEX.\n\n' +
        '─── Sample SHB runtime ───\n' +
        '{\n' +
        '  "code":"SHB","type":"STOCK","time":"074500",\n' +
        '  "tradingVolume":47390400,\n' +
        '  "totalBuyVolume":15891000,"totalBuyRaito":33.53,\n' +
        '  "totalSellVolume":31479000,"totalSellRaito":66.42,\n' +
        '  "prices":[\n' +
        '    {"price":15200.0,"matchedVolume":30874000,"matchedRaito":65.15,\n' +
        '     "matchedBuyVolume":12837300,"buyRaito":41.58,\n' +
        '     "matchedSellVolume":18036700,"sellRaito":58.42},\n' +
        '    {"price":15250.0,"matchedVolume":3986200,"matchedRaito":8.41,\n' +
        '     "matchedBuyVolume":1508700,"matchedSellVolume":2477500},\n' +
        '    {"price":15150.0,"matchedVolume":1545000,"buyRaito":100.0},\n' +
        '    {"price":15300.0,"matchedVolume":10964800,"sellRaito":100.0}\n' +
        '  ]\n' +
        '}',
    },
    {
      id: 'redis-info',
      kind: 'redis',
      layer: 'Redis writes',
      title: 'realtime_mapSymbolInfo[code]',
      subtitle: 'Hash',
      position: { x: COL * 8, y: ROW * 0.7 },
      inputs: [{ name: 'merge quote vào SymbolInfo', type: 'merge', description: 'Merge field từ SymbolQuote vào SymbolInfo hiện có' }],
      outputs: [{ name: 'latest snapshot', type: 'Hash', description: 'Single source of truth cho priceBoard / querySymbolLatest' }],
      details:
        'Mỗi hash entry là 1 SymbolInfo đầy đủ: metadata + OHLC + biên + bidOfferList + foreigner + session + ...\n\n' +
        '─── Sample SHB runtime ───\n' +
        '{\n' +
        '  "code":"SHB","time":"074500","date":"20260420","type":"STOCK",\n' +
        '  "open":15200.0,"high":15300.0,"low":15150.0,"last":15300.0,\n' +
        '  "change":0.0,"rate":0.0,\n' +
        '  "tradingVolume":47390400,"tradingValue":7.2155262E11,\n' +
        '  "matchingVolume":100,"averagePrice":15250.0,\n' +
        '  "ceilingPrice":16350.0,"floorPrice":14250.0,"referencePrice":15300.0,\n' +
        '  "highTime":"144500","lowTime":"091606",\n' +
        '  "turnoverRate":1.0315,\n' +
        '  "foreignerBuyVolume":804300,"foreignerSellVolume":95278,\n' +
        '  "foreignerTotalRoom":1378260007,"foreignerCurrentRoom":1227600932,\n' +
        '  "matchedBy":"ASK",\n' +
        '  "bidOfferList":[\n' +
        '    {"bidPrice":15250.0,"bidVolume":9000,"offerPrice":15300.0,"offerVolume":3368800},\n' +
        '    {"bidPrice":15200.0,"bidVolume":662400,"offerPrice":15350.0,"offerVolume":3803500},\n' +
        '    {"bidPrice":15150.0,"bidVolume":3096400,"offerPrice":15400.0,"offerVolume":4194100}\n' +
        '  ],\n' +
        '  "expectedPrice":15300.0,\n' +
        '  "name":"Ngân hàng TMCP Sài Gòn – Hà Nội","nameEn":"SHB",\n' +
        '  "marketType":"HOSE","securitiesType":"STOCK","exchange":"HOSE",\n' +
        '  "bidofferTime":"074500","updatedAt":1776671118783,\n' +
        '  "listedQuantity":4594200024,"controlCode":"Y",\n' +
        '  "highLowYearData":[{"highPrice":21500.0,"lowPrice":11800.0}],\n' +
        '  "quoteSequence":8928,"bidAskSequence":27341,\n' +
        '  "updatedBy":"SymbolQuote","id":"SHB"\n' +
        '}',
    },
    {
      id: 'redis-foreigner',
      kind: 'redis',
      layer: 'Redis writes',
      title: 'realtime_mapForeignerDaily[code]',
      subtitle: 'Hash',
      position: { x: COL * 8, y: ROW * 1.4 },
      inputs: [{ name: 'merge foreigner data', type: 'merge', description: 'Từ foreignerBuy/Sell/TotalRoom/CurrentRoom ở quote' }],
      outputs: [{ name: 'foreigner daily', type: 'Hash', description: 'Room NN + tỷ lệ hold/buyable theo ngày' }],
      details:
        '─── Sample SHB runtime ───\n' +
        '{\n' +
        '  "code":"SHB","symbolType":"STOCK","date":1720758584000,\n' +
        '  "foreignerBuyAbleRatio":89.54783184403507,\n' +
        '  "foreignerCurrentRoom":984016554,\n' +
        '  "foreignerTotalRoom":1098872562,\n' +
        '  "foreignerBuyValue":0.0,"foreignerSellValue":0.0,\n' +
        '  "foreignerBuyVolume":979000,"foreignerSellVolume":58654,\n' +
        '  "foreignerHoldVolume":114856008,\n' +
        '  "foreignerHoldRatio":0.031356504450773696,\n' +
        '  "listedQuantity":3.662908542E9,\n' +
        '  "createdAt":1720749045763,"updatedAt":1720758584866\n' +
        '}\n\n' +
        'Khi snapshot cron chạy (saveRedisToDatabase), id được set = code + "_" + yyyyMMdd hôm nay trước khi bulk write Mongo c_foreigner_daily.',
    },
    {
      id: 'redis-daily',
      kind: 'redis',
      layer: 'Redis writes',
      title: 'realtime_mapSymbolDaily[code]',
      subtitle: 'Hash',
      position: { x: COL * 8, y: ROW * 2.1 },
      inputs: [{ name: 'upsertSymbolDaily(quote, info)', type: 'compute', description: 'Build daily bar từ tick hiện tại' }],
      outputs: [{ name: 'daily OHLCV', type: 'Hash', description: 'OHLC + volume/value ngày — dùng cho querySymbolDaily' }],
      details:
        '─── Sample SHB runtime ───\n' +
        '{\n' +
        '  "id":"SHB_20260420","code":"SHB",\n' +
        '  "date":1776686400000,\n' +
        '  "open":15200.0,"high":15300.0,"low":15150.0,"last":15300.0,\n' +
        '  "change":0.0,"rate":0.0,\n' +
        '  "tradingVolume":47390400,\n' +
        '  "tradingValue":7.2155262E11,\n' +
        '  "referencePrice":15300.0,\n' +
        '  "createdAt":1776649851171,"updatedAt":1776671118784\n' +
        '}',
    },
    {
      id: 'redis-minute',
      kind: 'redis',
      layer: 'Redis writes',
      title: 'realtime_listQuoteMinute_{code}',
      subtitle: 'List',
      position: { x: COL * 8, y: ROW * 2.8 },
      inputs: [{ name: 'minute bar create/update', type: 'compute', description: 'sang phút mới → tạo bar · cùng phút → update' }],
      outputs: [{ name: 'SymbolQuoteMinute[]', type: 'List', description: 'Mỗi element là 1 minute bar + periodTradingVolume' }],
      details:
        '─── Sample 1 phần tử trong list của SHB ───\n' +
        '{\n' +
        '  "code":"SHB","time":"074500","milliseconds":27900000,\n' +
        '  "open":15300.0,"high":15300.0,"low":15300.0,"last":15300.0,\n' +
        '  "tradingVolume":47390400,\n' +
        '  "tradingValue":7.2155262E11,\n' +
        '  "periodTradingVolume":8363800,\n' +
        '  "date":1776671100000\n' +
        '}\n\n' +
        'periodTradingVolume = volume giao dịch riêng trong minute này (delta so với minute trước).',
    },
    {
      id: 'redis-tick',
      kind: 'redis',
      layer: 'Redis writes',
      title: 'realtime_listQuote_{code}',
      subtitle: 'List append',
      position: { x: COL * 8, y: ROW * 3.5 },
      inputs: [{ name: 'append tick', type: 'RPUSH', description: 'Sau reCalculate() thành công' }],
      outputs: [{ name: 'SymbolQuote[]', type: 'List', description: 'Full tick history — dùng cho querySymbolQuote / Tick' }],
      details:
        '─── Sample 1 tick của SHB ───\n' +
        '{\n' +
        '  "code":"SHB","type":"STOCK","time":"074500",\n' +
        '  "open":15200.0,"high":15300.0,"low":15150.0,"last":15300.0,\n' +
        '  "change":0.0,"rate":0.0,\n' +
        '  "highTime":"144500","lowTime":"091606",\n' +
        '  "averagePrice":15250.0,"referencePrice":15300.0,\n' +
        '  "tradingVolume":47390400,"tradingValue":7.2155262E11,\n' +
        '  "turnoverRate":1.0315,"matchingVolume":100,\n' +
        '  "foreignerBuyVolume":804300,"foreignerSellVolume":95278,\n' +
        '  "foreignerTotalRoom":1378260007,"foreignerCurrentRoom":1227600932,\n' +
        '  "matchedBy":"ASK",\n' +
        '  "holdVolume":150659075,"holdRatio":0.0328,\n' +
        '  "buyAbleRatio":89.07,\n' +
        '  "date":1776671100000,"milliseconds":27900000,\n' +
        '  "sequence":8928,\n' +
        '  "foreignerMatchBuyVolume":0,"foreignerMatchSellVolume":0,\n' +
        '  "foreignerMatchBuyValue":0.0,"foreignerMatchSellValue":0.0,\n' +
        '  "createdAt":1776671118783,"updatedAt":1776671118783,\n' +
        '  "activeBuyVolume":15891000,"activeSellVolume":31499400\n' +
        '}\n\n' +
        'Các field enrich (holdVolume/holdRatio/buyAbleRatio/foreignerMatch*) được QuoteService.reCalculate() compute trước khi append.',
    },
    {
      id: 'redis-meta',
      kind: 'redis',
      layer: 'Redis writes',
      title: 'realtime_listQuoteMeta_{code}',
      subtitle: 'String/encoded',
      position: { x: COL * 8, y: ROW * 4.2 },
      inputs: [{ name: 'partition meta', type: 'encode', description: 'Cập nhật khi append tick' }],
      outputs: [
        {
          name: 'List<QuotePartition>',
          type: 'encoded',
          description: 'partition|fromVolume|toVolume|totalItems · partition=-1 default',
        },
      ],
      details:
        'market-query-v2 dùng metadata này để paging tick theo lastTradingVolume hoặc lastIndex.\n\n' +
        'Format mỗi partition: partition|fromVolume|toVolume|totalItems\n' +
        'Ví dụ: "-1|0|50000000|8928" — partition default, từ volume 0 → 50M, tổng 8928 tick.',
    },

    // ─── Odd-lot Quote branch (topic RIÊNG quoteOddLotUpdate) ─────────
    {
      id: 'ws-qt-odd',
      kind: 'source',
      layer: 'Lotte WS',
      title: 'auto.qt.oddlot.<code>',
      subtitle: 'Odd-lot quote',
      position: { x: 0, y: ROW * 5.5 },
      inputs: [{ name: 'channel odd-lot riêng từ Lotte', type: 'WS', description: '' }],
      outputs: [{ name: 'raw odd-lot quote line', type: 'string', description: '' }],
      details: '',
    },
    {
      id: 'parse-qt-odd',
      kind: 'logic',
      layer: 'Collector · Parse',
      title: 'SymbolQuoteOddLot.parse(item)',
      subtitle: 'Nhánh parse riêng',
      position: { x: COL * 2, y: ROW * 5.5 },
      inputs: [{ name: 'odd-lot quote item', type: 'object', description: '' }],
      outputs: [
        {
          name: 'SymbolQuoteOddLot',
          type: 'object',
          description: 'OHLC + tradingVolume/Value + foreigner summary cho lô lẻ',
        },
      ],
      details: '',
    },
    {
      id: 'kafka-qt-odd',
      kind: 'kafka',
      layer: 'Kafka',
      title: 'topic quoteOddLotUpdate',
      subtitle: 'RIÊNG (không phải quoteUpdate)',
      position: { x: COL * 4, y: ROW * 5.5 },
      inputs: [{ name: 'producer collector', type: 'Kafka', description: '' }],
      outputs: [
        { name: 'realtime-v2: QuoteOddLotUpdateHandler', type: 'Kafka', description: '' },
        { name: 'ws-v2: market.quoteOddLot.{code}', type: 'Kafka', description: '' },
      ],
      details: '',
    },
    {
      id: 'handler-qt-odd',
      kind: 'logic',
      layer: 'realtime-v2 · Consumer',
      title: 'QuoteOddLotUpdateHandler.handle()',
      subtitle: 'Handler RIÊNG',
      position: { x: COL * 5, y: ROW * 5.5 },
      inputs: [{ name: 'Message<SymbolQuoteOddLot>', type: 'Kafka payload', description: '' }],
      outputs: [{ name: 'monitorService.rcv(SymbolQuoteOddLot)', type: 'call', description: '' }],
      details: '',
    },
    {
      id: 'qs-update-odd',
      kind: 'logic',
      layer: 'realtime-v2',
      title: 'QuoteService.updateQuote() — nhánh OddLot',
      subtitle: 'instanceof SymbolQuoteOddLot',
      position: { x: COL * 6, y: ROW * 5.5 },
      inputs: [
        { name: 'SymbolQuoteOddLot', type: 'object', description: '' },
        { name: 'cacheService.getMapSymbolInfoOddLot()[code]', type: 'SymbolInfo|null', description: '' },
      ],
      outputs: [
        { name: 'merge vào SymbolInfoOddLot', type: 'merge', description: 'KHÔNG chạm SymbolInfo main' },
        { name: 'setSymbolInfoOddLot() → HSET realtime_mapSymbolInfoOddLot[code]', type: 'Redis', description: '' },
      ],
      details:
        'Cùng QuoteService nhưng re-route sang cache odd-lot, KHÔNG ghi tick/minute/stat/daily/foreigner.\n' +
        'updatedBy = "SymbolQuoteOddLot" trên hash.',
    },
    {
      id: 'redis-info-odd',
      kind: 'redis',
      layer: 'Redis writes',
      title: 'realtime_mapSymbolInfoOddLot[code]',
      subtitle: 'Chia sẻ với BidOfferOddLot',
      position: { x: COL * 8, y: ROW * 5.5 },
      inputs: [{ name: 'QuoteOddLot + BidOfferOddLot merge', type: 'HSET', description: 'updatedBy = "SymbolQuoteOddLot" hoặc "BidOfferOddLot"' }],
      outputs: [{ name: 'querySymbolLatestOddLot', type: 'Hash', description: '' }],
      details: 'Cùng hash key dùng chung với nhánh BidOfferOddLot (xem flow BidOffer).',
    },
  ],
  edges: [
    { source: 'ws', target: 'handle-msg', label: 'raw text', animated: true },
    { source: 'handle-msg', target: 'handle-quote', label: 'auto.qt.*' },
    { source: 'handle-quote', target: 'sender', label: 'QuoteUpdate' },
    { source: 'sender', target: 'kafka', label: 'producer', animated: true },
    { source: 'kafka', target: 'handler', label: 'consume', animated: true },
    { source: 'handler', target: 'monitor', label: 'rcv()' },
    { source: 'monitor', target: 'qs-update', label: 'updateQuote()' },
    { source: 'qs-update', target: 'recalc', label: 'reCalculate()' },
    { source: 'recalc', target: 'kafka', label: 'calExtraUpdate', animated: true },
    { source: 'flag-quote', target: 'qs-update', label: 'control persist branches' },
    { source: 'qs-update', target: 'redis-stat', label: 'HSET (non-INDEX)' },
    { source: 'qs-update', target: 'redis-info', label: 'HSET' },
    { source: 'qs-update', target: 'redis-foreigner', label: 'HSET' },
    { source: 'qs-update', target: 'redis-daily', label: 'HSET' },
    { source: 'qs-update', target: 'redis-minute', label: 'create/update' },
    { source: 'qs-update', target: 'redis-tick', label: 'RPUSH' },
    { source: 'qs-update', target: 'redis-meta', label: 'update meta' },
    // Odd-lot quote branch
    { source: 'ws-qt-odd', target: 'parse-qt-odd', label: 'raw odd-lot', animated: true },
    { source: 'parse-qt-odd', target: 'kafka-qt-odd', label: 'publish "quoteOddLotUpdate"', animated: true },
    { source: 'kafka-qt-odd', target: 'handler-qt-odd', label: 'consume', animated: true },
    { source: 'handler-qt-odd', target: 'monitor', label: 'rcv(SymbolQuoteOddLot)' },
    { source: 'monitor', target: 'qs-update-odd', label: 'nhánh odd-lot' },
    { source: 'qs-update-odd', target: 'redis-info-odd', label: 'HSET oddlot' },
  ],
};

// ─────────────────────────────────────────────────────────────────────────
// 3. BIDOFFER FLOW — bidOfferUpdate (stock + futures) + bidOfferOddLotUpdate
// ─────────────────────────────────────────────────────────────────────────
const bidOfferFlow = {
  id: 'bidoffer-flow',
  title: 'BIDOFFER FLOW — stock/futures + odd-lot split',
  subtitle:
    '3 nhánh: Stock BO (BidOfferData) · Futures BO (FuturesBidOfferData, price=double) · Odd-lot BO (topic riêng). Collector tính expectedChange/Rate trước khi publish.',
  accent: '#a78bfa',
  nodes: [
    // ─── Row 0: Stock BidOffer ────────────────────────────────────────
    {
      id: 'ws-bo',
      kind: 'source',
      layer: 'Lotte WS',
      title: 'auto.bo.<code>',
      subtitle: 'Stock BidOffer (int price)',
      position: { x: 0, y: 0 },
      inputs: [{ name: 'subscribe sub/pro.pub.auto.bo./...', type: 'WS', description: 'Cổ phiếu HOSE/HNX/UPCOM + CW + ETF' }],
      outputs: [
        {
          name: 'raw line',
          type: 'string',
          description:
            'auto.bo.BCM|1|93020|BCM|O|55800.0|2|55700.0|3|2800|55800.0|2|1800|55700.0|3|2800|...|14900|12500|...',
        },
      ],
      details: 'parts[4]=controlCode, parts[5]=expectedPrice (ATO/ATC), parts[13..]=3 bước giá bid/offer.',
    },
    {
      id: 'parse-bo',
      kind: 'logic',
      layer: 'Collector · Parse',
      title: 'BidOfferData.parse(item)',
      subtitle: 'handleStockBidAsk(parts)',
      position: { x: COL, y: 0 },
      inputs: [{ name: 'BidOfferAutoItem', type: 'object', description: 'Raw struct từ Lotte WS' }],
      outputs: [
        {
          name: 'BidOfferData',
          type: 'object',
          description:
            'code, time(HHmmss), bidPrice/offerPrice(int), bidVolume/offerVolume, bidOfferList (3 PriceItem), totalBid/OfferVolume, totalBid/OfferCount, diffBidOffer, expectedPrice (null nếu không phải ATO/ATC), session',
        },
      ],
      details:
        'session = sessionControlMap.get(controlCode):\n' +
        '  P → ATO · A → ATC · O → CONTINUOUS · I → INTERMISSION · C → PLO · K/G → CLOSED\n\n' +
        '⚠ Naming alias across services:\n' +
        '  • Collector / BidOfferData.session = "CONTINUOUS"\n' +
        '  • MarketStatus hash (realtime_mapMarketStatus).status = "LO" (legacy)\n' +
        '  • Client-facing payload (ws-v2 parser) = giữ nguyên field đầu nguồn\n' +
        '"CONTINUOUS" ≡ "LO" ≡ giờ giao dịch khớp lệnh liên tục.\n\n' +
        'expectedPrice = round1Decimal(projectOpen) khi session=ATO/ATC VÀ projectOpen>0, ngược lại null.\n' +
        'PriceItem: bidPrice, offerPrice, bidVolume, offerVolume, bidVolumeChange, offerVolumeChange.',
    },
    {
      id: 'handle-auto-bo',
      kind: 'logic',
      layer: 'Collector · handleAutoData',
      title: 'handleAutoData(BidOfferData)',
      subtitle: 'Tính expectedChange / expectedRate',
      position: { x: COL * 2, y: 0 },
      inputs: [
        { name: 'BidOfferData', type: 'object', description: 'Có expectedPrice' },
        { name: 'cacheService.getMapSymbolInfo()[code].referencePrice', type: 'Double', description: 'Giá tham chiếu từ cache SymbolInfo' },
      ],
      outputs: [
        {
          name: 'BidOfferData enriched',
          type: 'object',
          description:
            'expectedChange = round2(expectedPrice − referencePrice)\nexpectedRate = round2((expectedChange / referencePrice) × 100)',
        },
      ],
      details:
        'Chỉ tính khi expectedPrice != null (đang ATO/ATC) và referencePrice > 0.\n' +
        'Sau khi enrich → kafkaPublishRealtime("bidOfferUpdate", bidOfferData).',
    },

    // ─── Row 1: Futures BidOffer ──────────────────────────────────────
    {
      id: 'ws-bo-dr',
      kind: 'source',
      layer: 'Lotte WS',
      title: 'auto.bo.<futuresCode>',
      subtitle: 'Futures BidOffer (double price)',
      position: { x: 0, y: ROW },
      inputs: [{ name: 'subscribe sub/pro.pub.auto.bo./...', type: 'WS', description: 'VN30F1M, VN30F2M, …' }],
      outputs: [
        {
          name: 'raw line',
          type: 'string',
          description: 'Cùng format như stock nhưng giá là decimal (VD: 1285.70).',
        },
      ],
      details: '',
    },
    {
      id: 'parse-bo-dr',
      kind: 'logic',
      layer: 'Collector · Parse',
      title: 'FuturesBidOfferData.parse(item)',
      subtitle: 'extends TransformData<FuturesBidOfferItem>',
      position: { x: COL, y: ROW },
      inputs: [{ name: 'FuturesBidOfferItem', type: 'object', description: '' }],
      outputs: [
        {
          name: 'FuturesBidOfferData',
          type: 'object',
          description:
            'Cùng shape như BidOfferData nhưng bidPrice/offerPrice = double (round2DecimalFloatToDouble). PriceItem cũng dùng double.',
        },
      ],
      details:
        'Dùng chung sessionControlMap. Cùng logic expectedPrice nhưng áp dụng round 2 decimal.\n' +
        'Một khác biệt quan trọng so với stock: mọi field giá đều double.',
    },
    {
      id: 'handle-auto-bo-dr',
      kind: 'logic',
      layer: 'Collector · handleAutoData',
      title: 'handleAutoData(FuturesBidOfferData)',
      subtitle: 'Logic tương tự stock',
      position: { x: COL * 2, y: ROW },
      inputs: [
        { name: 'FuturesBidOfferData', type: 'object', description: '' },
        { name: 'referencePrice futures', type: 'double', description: 'Từ cache SymbolInfo (futures)' },
      ],
      outputs: [
        { name: 'FuturesBidOfferData enriched', type: 'object', description: 'expectedChange/Rate đã round2' },
      ],
      details: 'Cùng topic publish: kafkaPublishRealtime("bidOfferUpdate", data) — không có topic riêng cho futures.',
    },

    // ─── Row 2: Odd-lot BidOffer ──────────────────────────────────────
    {
      id: 'ws-bo-odd',
      kind: 'source',
      layer: 'Lotte WS',
      title: 'auto.bo.oddlot.<code>',
      subtitle: 'Odd-lot BidOffer',
      position: { x: 0, y: ROW * 2.3 },
      inputs: [{ name: 'channel odd-lot riêng từ Lotte', type: 'WS', description: '' }],
      outputs: [{ name: 'raw odd-lot line', type: 'string', description: '' }],
      details: 'Runtime hiện tại odd-lot luôn enable (khác main session có thể tắt history).',
    },
    {
      id: 'parse-bo-odd',
      kind: 'logic',
      layer: 'Collector · Parse',
      title: 'BidOfferOddLotData.parse(item)',
      subtitle: 'TransformData branch riêng',
      position: { x: COL, y: ROW * 2.3 },
      inputs: [{ name: 'odd-lot item', type: 'object', description: '' }],
      outputs: [
        {
          name: 'BidOfferOddLot',
          type: 'object',
          description: 'oddlotBidOfferList[3], oddlotBidofferTime, code, time',
        },
      ],
      details: '',
    },
    {
      id: 'pub-bo-odd',
      kind: 'logic',
      layer: 'Collector · Producer',
      title: 'kafkaPublishRealtime("bidOfferOddLotUpdate", data)',
      subtitle: 'Topic RIÊNG (không phải bidOfferUpdate)',
      position: { x: COL * 2, y: ROW * 2.3 },
      inputs: [{ name: 'BidOfferOddLot', type: 'object', description: '' }],
      outputs: [{ name: 'Kafka record', type: 'Kafka', description: '' }],
      details: '',
    },

    // ─── Column 3: Kafka topics ───────────────────────────────────────
    {
      id: 'kafka-bo',
      kind: 'kafka',
      layer: 'Kafka',
      title: 'topic bidOfferUpdate',
      subtitle: 'Stock + Futures cùng topic',
      position: { x: COL * 3, y: ROW * 0.5 },
      inputs: [{ name: 'producer collector', type: 'Kafka', description: 'BidOfferData + FuturesBidOfferData' }],
      outputs: [
        { name: 'realtime-v2: BidOfferUpdateHandler', type: 'Kafka', description: '' },
        { name: 'ws-v2: market.bidoffer.{code}', type: 'Kafka', description: '' },
      ],
      details: '',
    },
    {
      id: 'kafka-bo-odd',
      kind: 'kafka',
      layer: 'Kafka',
      title: 'topic bidOfferOddLotUpdate',
      subtitle: 'Odd-lot RIÊNG',
      position: { x: COL * 3, y: ROW * 2.3 },
      inputs: [{ name: 'producer collector', type: 'Kafka', description: '' }],
      outputs: [
        { name: 'realtime-v2: BidOfferOddLotUpdateHandler', type: 'Kafka', description: '' },
        { name: 'ws-v2: market.bidofferOddLot.{code}', type: 'Kafka', description: '' },
      ],
      details: '',
    },

    // ─── Column 4–5: Handlers + Service ───────────────────────────────
    {
      id: 'handler-bo',
      kind: 'logic',
      layer: 'realtime-v2 · Consumer',
      title: 'BidOfferUpdateHandler.handle()',
      subtitle: 'Deserialize Message<BidOffer>',
      position: { x: COL * 4, y: ROW * 0.5 },
      inputs: [{ name: 'Message<BidOffer>', type: 'Kafka payload', description: '' }],
      outputs: [{ name: 'monitorService.rcv(bidOffer)', type: 'call', description: '' }],
      details: '',
    },
    {
      id: 'handler-bo-odd',
      kind: 'logic',
      layer: 'realtime-v2 · Consumer',
      title: 'BidOfferOddLotUpdateHandler.handle()',
      subtitle: 'Handler RIÊNG cho odd-lot',
      position: { x: COL * 4, y: ROW * 2.3 },
      inputs: [{ name: 'Message<BidOfferOddLot>', type: 'Kafka payload', description: '' }],
      outputs: [{ name: 'monitorService.rcv(bidOfferOddLot)', type: 'call', description: '' }],
      details: 'Không share handler với main bidOfferUpdate.',
    },
    {
      id: 'monitor',
      kind: 'logic',
      layer: 'realtime-v2',
      title: 'MonitorService.handler()',
      subtitle: 'Dispatch theo instanceof',
      position: { x: COL * 5, y: ROW * 1.4 },
      inputs: [
        { name: 'BidOffer', type: 'object', description: 'từ handler-bo' },
        { name: 'BidOfferOddLot', type: 'object', description: 'từ handler-bo-odd' },
      ],
      outputs: [
        { name: 'BidOfferService.updateBidOffer(bidOffer)', type: 'call', description: 'nhánh main' },
        { name: 'BidOfferService.updateBidOfferOddLot(bidOfferOddLot)', type: 'call', description: 'nhánh odd-lot' },
      ],
      details: 'Cùng MonitorService nhưng 2 nhánh method riêng → không chia sẻ state.',
    },
    {
      id: 'bs-update',
      kind: 'logic',
      layer: 'realtime-v2 · BidOfferService',
      title: 'updateBidOffer()',
      subtitle: 'Main session — merge top book',
      position: { x: COL * 6, y: ROW * 0.5 },
      inputs: [
        { name: 'BidOffer', type: 'object', description: '' },
        { name: 'cacheService.getMapSymbolInfo()[code]', type: 'SymbolInfo', description: '' },
      ],
      outputs: [
        { name: 'set createdAt / updatedAt', type: 'set', description: '' },
        { name: 'ConvertUtils.updateByBidOffer(symbolInfo, bidOffer)', type: 'merge', description: 'bidPrice/offerPrice/volume + expectedPrice/Change/Rate + session + totalBid/Offer' },
        { name: 'HSET realtime_mapSymbolInfo[code]', type: 'Redis', description: '' },
        { name: 'bidAskSequence++ trên SymbolInfo', type: 'counter', description: '' },
        { name: 'id = code + "_" + datetime + "_" + sequence', type: 'string', description: '' },
      ],
      details:
        'Chỉ chạy nhánh merge khi enableAutoData=true.\n' +
        'Nếu enableSaveBidOffer=true → marketRedisDao.addBidOffer() (RUNTIME=false → skip).\n' +
        'Mongo c_bid_offer luôn off (enableSaveBidAsk=false).',
    },
    {
      id: 'bs-update-odd',
      kind: 'logic',
      layer: 'realtime-v2 · BidOfferService',
      title: 'updateBidOfferOddLot()',
      subtitle: 'Method RIÊNG — luôn ghi cả 2 key',
      position: { x: COL * 6, y: ROW * 2.3 },
      inputs: [
        { name: 'BidOfferOddLot', type: 'object', description: '' },
        { name: 'cacheService.getMapSymbolInfoOddLot()[code]', type: 'SymbolInfo|null', description: 'Tự tạo mới nếu null (sequence=1)' },
      ],
      outputs: [
        { name: 'ConvertUtils.updateByBidOfferOddLot(symbolInfo, bidOfferOddLot)', type: 'merge', description: '' },
        { name: 'setSymbolInfoOddLot() → HSET realtime_mapSymbolInfoOddLot[code]', type: 'Redis', description: '' },
        { name: 'sequence = symbolInfo.bidAskSequence + 1', type: 'counter', description: '' },
        { name: 'id = code + "_" + datetime + "_" + sequence', type: 'string', description: '' },
        { name: 'addBidOfferOddLot() → RPUSH realtime_listBidOfferOddLot_{code}', type: 'Redis', description: 'Không phụ thuộc flag save' },
      ],
      details: 'Không check enableSaveBidOffer — odd-lot history luôn được giữ ở Redis.',
    },

    // ─── Column 7: Redis output ───────────────────────────────────────
    {
      id: 'flag-save',
      kind: 'config',
      layer: 'Feature flag',
      title: 'enableSaveBidOffer / enableSaveBidAsk',
      subtitle: 'false runtime',
      position: { x: COL * 6, y: ROW * 3.6 },
      inputs: [{ name: 'application config', type: 'boolean', description: '' }],
      outputs: [
        { name: 'Skip realtime_listBidOffer_{code}', type: 'branch', description: '' },
        { name: 'Skip Mongo c_bid_offer', type: 'branch', description: '' },
      ],
      details: 'CHỈ áp dụng cho main session. Odd-lot không bị ảnh hưởng.',
    },
    {
      id: 'redis-info',
      kind: 'redis',
      layer: 'Redis output',
      title: 'realtime_mapSymbolInfo[code]',
      subtitle: 'Top book main',
      position: { x: COL * 7, y: 0 },
      inputs: [{ name: 'BidOfferService merge', type: 'HSET', description: '' }],
      outputs: [{ name: 'query-v2 đọc latest book qua HGET', type: 'Hash', description: 'Fields: bidPrice/offerPrice/volume/session/expectedPrice+Change+Rate/totalBid+Offer' }],
      details: 'CHỖ DUY NHẤT runtime hiện tại giữ bid/offer main session (không có history list).',
    },
    {
      id: 'redis-list-skip',
      kind: 'redis',
      layer: 'Inactive',
      title: 'realtime_listBidOffer_{code}',
      subtitle: 'Code path tồn tại, runtime tắt',
      position: { x: COL * 7, y: ROW },
      inputs: [{ name: 'enableSaveBidOffer=false', type: 'flag', description: '' }],
      outputs: [{ name: 'không ghi', type: 'skip', description: '' }],
      details: '',
    },
    {
      id: 'redis-info-odd',
      kind: 'redis',
      layer: 'Redis output',
      title: 'realtime_mapSymbolInfoOddLot[code]',
      subtitle: 'Top book odd-lot',
      position: { x: COL * 7, y: ROW * 1.9 },
      inputs: [{ name: 'updateBidOfferOddLot merge', type: 'HSET', description: '' }],
      outputs: [{ name: 'query-v2: querySymbolLatestOddLot (HMGET)', type: 'Hash', description: '' }],
      details:
        '─── Sample SHB ───\n' +
        '{\n' +
        '  "id":"SHB","code":"SHB",\n' +
        '  "oddlotBidofferTime":"085900",\n' +
        '  "oddlotBidOfferList":[\n' +
        '    {"bidPrice":11900.0,"bidVolume":254,"offerPrice":11950.0,"offerVolume":333},\n' +
        '    {"bidPrice":11850.0,"bidVolume":1695,"offerPrice":12000.0,"offerVolume":879},\n' +
        '    {"bidPrice":11800.0,"bidVolume":2641,"offerPrice":12050.0,"offerVolume":45}\n' +
        '  ],\n' +
        '  "quoteSequence":0,"bidAskSequence":1,\n' +
        '  "updatedBy":"BidOfferOddLot","updatedAt":1709110740140\n' +
        '}',
    },
    {
      id: 'redis-bo-oddlot',
      kind: 'redis',
      layer: 'Redis output',
      title: 'realtime_listBidOfferOddLot_{code}',
      subtitle: 'Odd-lot history (RUNTIME ON)',
      position: { x: COL * 7, y: ROW * 2.8 },
      inputs: [{ name: 'updateBidOfferOddLot → addBidOfferOddLot', type: 'RPUSH', description: '' }],
      outputs: [{ name: 'List<BidOfferOddLot>', type: 'List', description: 'id = <CODE>_<yyyyMMddHHmmss>_<sequence>' }],
      details:
        'Khác với main session (chỉ giữ top book), odd-lot GIỮ toàn bộ history ở Redis.\n\n' +
        '─── Sample 1 element DGC ───\n' +
        '{\n' +
        '  "id":"DGC_20240228085900_2","code":"DGC","time":"085900",\n' +
        '  "bidOfferList":[\n' +
        '    {"bidPrice":110700.0,"bidVolume":5,"offerPrice":111000.0,"offerVolume":79},\n' +
        '    {"bidPrice":110600.0,"bidVolume":34,"offerPrice":111200.0,"offerVolume":54},\n' +
        '    {"bidPrice":110500.0,"bidVolume":359,"offerPrice":112100.0,"offerVolume":14}\n' +
        '  ],\n' +
        '  "sequence":2,\n' +
        '  "createdAt":1709110740076,"updatedAt":1709110740076\n' +
        '}',
    },
    {
      id: 'mongo-skip',
      kind: 'mongo',
      layer: 'Inactive',
      title: 'c_bid_offer',
      subtitle: 'Không persist',
      position: { x: COL * 7, y: ROW * 3.7 },
      inputs: [{ name: 'enableSaveBidAsk=false', type: 'flag', description: '' }],
      outputs: [{ name: 'không có Mongo bid/offer history', type: 'skip', description: '' }],
      details: '',
    },
  ],
  edges: [
    // Stock BO main
    { source: 'ws-bo', target: 'parse-bo', label: 'raw', animated: true },
    { source: 'parse-bo', target: 'handle-auto-bo', label: 'BidOfferData' },
    { source: 'handle-auto-bo', target: 'kafka-bo', label: 'publish "bidOfferUpdate"', animated: true },
    // Futures BO (same topic as stock)
    { source: 'ws-bo-dr', target: 'parse-bo-dr', label: 'raw', animated: true },
    { source: 'parse-bo-dr', target: 'handle-auto-bo-dr', label: 'FuturesBidOfferData' },
    { source: 'handle-auto-bo-dr', target: 'kafka-bo', label: 'publish "bidOfferUpdate"', animated: true },
    // Odd-lot BO (separate topic)
    { source: 'ws-bo-odd', target: 'parse-bo-odd', label: 'raw odd-lot', animated: true },
    { source: 'parse-bo-odd', target: 'pub-bo-odd', label: 'BidOfferOddLot' },
    { source: 'pub-bo-odd', target: 'kafka-bo-odd', label: 'publish', animated: true },
    // Consumer chain main
    { source: 'kafka-bo', target: 'handler-bo', label: 'consume', animated: true },
    { source: 'handler-bo', target: 'monitor', label: 'rcv(BidOffer)' },
    { source: 'monitor', target: 'bs-update', label: 'updateBidOffer()' },
    // Consumer chain odd-lot
    { source: 'kafka-bo-odd', target: 'handler-bo-odd', label: 'consume', animated: true },
    { source: 'handler-bo-odd', target: 'monitor', label: 'rcv(BidOfferOddLot)' },
    { source: 'monitor', target: 'bs-update-odd', label: 'updateBidOfferOddLot()' },
    // Writes main
    { source: 'flag-save', target: 'bs-update', label: 'control persist' },
    { source: 'bs-update', target: 'redis-info', label: 'HSET top book' },
    { source: 'bs-update', target: 'redis-list-skip', label: 'skipped' },
    { source: 'flag-save', target: 'mongo-skip', label: 'skipped' },
    // Writes odd-lot
    { source: 'bs-update-odd', target: 'redis-info-odd', label: 'HSET oddlot info' },
    { source: 'bs-update-odd', target: 'redis-bo-oddlot', label: 'RPUSH history' },
  ],
};

// ─────────────────────────────────────────────────────────────────────────
// 4. INDEX + MARKET STATUS FLOW
// ─────────────────────────────────────────────────────────────────────────
const indexStatusFlow = {
  id: 'index-status-flow',
  title: 'INDEX + MARKET STATUS — auto.idxqt + auto.tickerNews',
  subtitle:
    'Index quote (no statistic) + session/market status events propagate sang SymbolInfo cùng market khi ATO/ATC',
  accent: '#fbbf24',
  nodes: [
    {
      id: 'ws-idx',
      kind: 'source',
      layer: 'Lotte WS',
      title: 'auto.idxqt.<idxCode>',
      subtitle: 'pipe-delimited',
      position: { x: 0, y: 0 },
      inputs: [{ name: 'subscribe sub/pro.pub.auto.idxqt./...', type: 'WS', description: '' }],
      outputs: [
        {
          name: 'raw line',
          type: 'string',
          description: 'auto.idxqt.09401|1|93020|09401|VN Sustainability Index|3193.04|2|3196.71|...',
        },
      ],
      details: '',
    },
    {
      id: 'handle-idx',
      kind: 'logic',
      layer: 'WsConnection',
      title: 'handleIndexQuote(parts)',
      subtitle: 'Build QuoteUpdate(type=INDEX)',
      position: { x: COL, y: 0 },
      inputs: [{ name: 'parts[]', type: 'string[]', description: '' }],
      outputs: [
        {
          name: 'QuoteUpdate(type=INDEX)',
          type: 'object',
          description:
            'code map qua indexList API (09401 → VNSI), thêm ceilingCount, upCount, unchangedCount, downCount, floorCount',
        },
      ],
      details: 'Cần indexList đã được init sẵn (xem flow Init Job) thì mapping mới chính xác.',
    },
    {
      id: 'sender-idx',
      kind: 'logic',
      layer: 'Producer',
      title: 'sendMessageSafe("quoteUpdate")',
      subtitle: 'Cùng topic với equity quote',
      position: { x: COL * 2, y: 0 },
      inputs: [{ name: 'QuoteUpdate(type=INDEX)', type: 'object', description: '' }],
      outputs: [{ name: 'topic quoteUpdate', type: 'Kafka', description: '' }],
      details: '',
    },
    {
      id: 'kafka-quote',
      kind: 'kafka',
      layer: 'Kafka',
      title: 'topic quoteUpdate',
      subtitle: 'INDEX message',
      position: { x: COL * 3, y: 0 },
      inputs: [{ name: 'producer collector', type: 'Kafka', description: '' }],
      outputs: [{ name: 'realtime-v2 + ws-v2 consume', type: 'Kafka', description: '' }],
      details: '',
    },
    {
      id: 'qs-idx',
      kind: 'logic',
      layer: 'realtime-v2',
      title: 'QuoteService.updateQuote() (INDEX)',
      subtitle: 'Same as quote, no statistic',
      position: { x: COL * 4, y: 0 },
      inputs: [{ name: 'SymbolQuote(type=INDEX)', type: 'object', description: '' }],
      outputs: [
        { name: 'HSET realtime_mapSymbolInfo[indexCode]', type: 'Redis', description: '' },
        { name: 'HSET realtime_mapSymbolDaily[indexCode]', type: 'Redis', description: '' },
        { name: 'append realtime_listQuote_indexCode', type: 'Redis', description: '' },
        { name: 'update realtime_listQuoteMinute_indexCode', type: 'Redis', description: '' },
      ],
      details: 'KHÔNG ghi realtime_mapSymbolStatistic vì type=INDEX.',
    },
    {
      id: 'redis-idx',
      kind: 'redis',
      layer: 'Redis output',
      title: 'Index keys',
      subtitle: 'mapSymbolInfo / Daily / listQuote / listQuoteMinute',
      position: { x: COL * 5, y: 0 },
      inputs: [{ name: 'QuoteService writes', type: 'HSET/RPUSH', description: '' }],
      outputs: [{ name: 'query-v2 + ws-v2 read', type: 'Redis', description: '' }],
      details: '',
    },
    {
      id: 'ws-news',
      kind: 'source',
      layer: 'Lotte WS',
      title: 'auto.tickerNews.*',
      subtitle: 'session events',
      position: { x: 0, y: ROW * 2 },
      inputs: [{ name: 'subscribe sub/pro.pub.auto.tickerNews.*/...', type: 'WS', description: '' }],
      outputs: [{ name: 'raw text', type: 'string', description: 'time, code, title' }],
      details: '',
    },
    {
      id: 'handle-news',
      kind: 'logic',
      layer: 'WsConnection',
      title: 'handleSessionEvent(parts)',
      subtitle: 'Build MarketStatusData',
      position: { x: COL, y: ROW * 2 },
      inputs: [{ name: 'parts[]', type: 'string[]', description: '' }],
      outputs: [{ name: 'MarketStatusData {time, code, title}', type: 'object', description: '' }],
      details: 'parseStatus(statusMap) map ra trạng thái phiên nội bộ.',
    },
    {
      id: 'sender-status',
      kind: 'logic',
      layer: 'Producer',
      title: 'sendMessageSafe("marketStatus")',
      subtitle: '',
      position: { x: COL * 2, y: ROW * 2 },
      inputs: [{ name: 'MarketStatusData', type: 'object', description: '' }],
      outputs: [{ name: 'topic marketStatus', type: 'Kafka', description: '' }],
      details: '',
    },
    {
      id: 'kafka-status',
      kind: 'kafka',
      layer: 'Kafka',
      title: 'topic marketStatus',
      subtitle: 'Message<MarketStatus>',
      position: { x: COL * 3, y: ROW * 2 },
      inputs: [{ name: 'producer collector', type: 'Kafka', description: '' }],
      outputs: [
        { name: 'realtime-v2 MarketStatusUpdateHandler', type: 'Kafka', description: '' },
        { name: 'ws-v2 → market.status', type: 'Kafka', description: '' },
      ],
      details: '',
    },
    {
      id: 'ms-svc',
      kind: 'logic',
      layer: 'realtime-v2',
      title: 'MarketStatusService.updateMarketStatus()',
      subtitle: 'Persist + propagate',
      position: { x: COL * 4, y: ROW * 2 },
      inputs: [{ name: 'MarketStatus', type: 'object', description: '' }],
      outputs: [
        { name: 'set id = market + "_" + type + date', type: 'set', description: '' },
        { name: 'HSET realtime_mapMarketStatus', type: 'Redis', description: '' },
        {
          name: 'Propagate sessions=status sang mọi SymbolInfo cùng market',
          type: 'broadcast',
          description: 'Chỉ khi status là ATO hoặc ATC',
        },
        { name: 'HSET realtime_mapSymbolInfo[*]', type: 'Redis', description: 'sau propagate' },
      ],
      details: '',
    },
    {
      id: 'redis-status',
      kind: 'redis',
      layer: 'Redis output',
      title: 'realtime_mapMarketStatus',
      subtitle: 'Hash by market_type (id = <MARKET>_<TYPE>)',
      position: { x: COL * 5, y: ROW * 2 },
      inputs: [{ name: 'MarketStatusService', type: 'HSET', description: 'Ghi mỗi khi nhận news/session change' }],
      outputs: [{ name: 'query-v2 + ws-v2', type: 'Hash', description: 'Read by MarketService.getCurrentStatus()' }],
      details:
        '─── Sample HOSE_EQUITY runtime ───\n' +
        '{\n' +
        '  "id":"HOSE_EQUITY","market":"HOSE","type":"EQUITY",\n' +
        '  "status":"LO",\n' +
        '  "date":1745892901611,"time":"021501",\n' +
        '  "title":"(HOSE) Market Open"\n' +
        '}\n\n' +
        'status lifecycle điển hình trong 1 phiên HOSE EQUITY:\n' +
        'PRE_OPEN → ATO → LO (sáng) → INTERMISSION → LO (chiều) → ATC → PLO → CLOSED.\n' +
        'Mỗi transition sinh 1 news → update hash key tương ứng + publish qua ws-v2.\n\n' +
        '⚠ Alias: field status="LO" trong hash này TƯƠNG ĐƯƠNG session="CONTINUOUS" trong BidOfferData/SymbolInfo. ' +
        'Client cần chuẩn hóa khi render priceBoard để hiển thị đồng nhất trạng thái phiên.',
    },
  ],
  edges: [
    { source: 'ws-idx', target: 'handle-idx', label: 'raw text', animated: true },
    { source: 'handle-idx', target: 'sender-idx', label: 'QuoteUpdate(INDEX)' },
    { source: 'sender-idx', target: 'kafka-quote', label: 'producer', animated: true },
    { source: 'kafka-quote', target: 'qs-idx', label: 'consume', animated: true },
    { source: 'qs-idx', target: 'redis-idx', label: 'writes' },

    { source: 'ws-news', target: 'handle-news', label: 'raw text', animated: true },
    { source: 'handle-news', target: 'sender-status', label: 'MarketStatusData' },
    { source: 'sender-status', target: 'kafka-status', label: 'producer', animated: true },
    { source: 'kafka-status', target: 'ms-svc', label: 'consume', animated: true },
    { source: 'ms-svc', target: 'redis-status', label: 'HSET' },
  ],
};

// ─────────────────────────────────────────────────────────────────────────
// 5. EXTRA / DEAL / ADVERTISED FLOW
// ─────────────────────────────────────────────────────────────────────────
const extraUpdateFlow = {
  id: 'extra-update-flow',
  title: 'EXTRA / DEAL / ADVERTISED — 4 trigger sources cho ExtraUpdate',
  subtitle:
    'ExtraUpdate = object trung gian cho basis/breakEven/pt · 4 nguồn phát (VN30 · Futures · CW · DealNotice) + nhánh calExtraUpdate từ realtime-v2 khi high/low year đổi',
  accent: '#f472b6',
  nodes: [
    // ─── 4 sources of ExtraUpdate từ collector ──────────────────────
    {
      id: 'src-vn30',
      kind: 'source',
      layer: 'Collector · Source 1/4',
      title: 'handleAutoData(IndexUpdateData) — VN30',
      subtitle: 'Trigger: VN30 index update',
      position: { x: 0, y: 0 },
      inputs: [{ name: 'IndexUpdateData(code=VN30)', type: 'object', description: '' }],
      outputs: [
        {
          name: 'ExtraUpdate',
          type: 'object',
          description: 'Với mỗi VN30F*: basis = futuresLast − vn30Last',
        },
      ],
      details: 'Khi tick VN30 tới, collector iterate các mã futures VN30F* và sinh ExtraUpdate cho từng mã.',
    },
    {
      id: 'src-futures',
      kind: 'source',
      layer: 'Collector · Source 2/4',
      title: 'handleAutoData(FuturesUpdateData)',
      subtitle: 'Trigger: Futures update',
      position: { x: 0, y: ROW * 0.9 },
      inputs: [{ name: 'FuturesUpdateData', type: 'object', description: 'VN30F1M / VN30F2M / ...' }],
      outputs: [
        { name: 'ExtraUpdate', type: 'object', description: 'basis = futuresLast − vn30Last (đọc vn30Last từ cache)' },
      ],
      details: 'Chiều ngược với Source 1 — khi futures tick tới, tính lại basis cho chính mã đó.',
    },
    {
      id: 'src-cw',
      kind: 'source',
      layer: 'Collector · Source 3/4',
      title: 'handleAutoData(StockUpdateData) — CW',
      subtitle: 'Trigger: CW stock update',
      position: { x: 0, y: ROW * 1.8 },
      inputs: [{ name: 'StockUpdateData (type=CW)', type: 'object', description: '' }],
      outputs: [
        {
          name: 'ExtraUpdate',
          type: 'object',
          description: 'breakEven = last × exerciseRatio + exercisePrice',
        },
      ],
      details: 'Chỉ áp dụng cho chứng quyền (CW). Công thức từ ConvertUtils/formula layer.',
    },
    {
      id: 'src-deal',
      kind: 'source',
      layer: 'Collector · Source 4/4',
      title: 'DealNoticeData → ExtraUpdate.fromDealNotice()',
      subtitle: 'Trigger: Deal notice (PT)',
      position: { x: 0, y: ROW * 2.7 },
      inputs: [{ name: 'DealNoticeData', type: 'object', description: 'Mỗi deal PT mới' }],
      outputs: [
        {
          name: 'ExtraUpdate',
          type: 'object',
          description: 'ptVolume (tích lũy) + ptValue (tích lũy)',
        },
      ],
      details: 'Cùng lúc deal notice cũng được publish ra topic riêng dealNoticeUpdate (xem nhánh dưới).',
    },
    {
      id: 'publish-extra',
      kind: 'logic',
      layer: 'Collector · Producer',
      title: 'kafkaPublishRealtime("extraUpdate", extraUpdate)',
      subtitle: 'Tập trung 4 source',
      position: { x: COL * 1.3, y: ROW * 1.35 },
      inputs: [
        {
          name: 'ExtraUpdate',
          type: 'object',
          description:
            'Fields: code, basis (Double), ptVolume (long), ptValue (double) — (breakEven merge vào symbolInfo qua field extend).',
        },
      ],
      outputs: [{ name: 'Kafka record topic extraUpdate', type: 'Kafka', description: '' }],
      details: '',
    },

    // ─── Nhánh calExtraUpdate từ realtime-v2 ──────────────────────────
    {
      id: 'recalc-source',
      kind: 'logic',
      layer: 'realtime-v2 · Source 5/5',
      title: 'QuoteService.reCalculate()',
      subtitle: 'Detect high/low year đổi',
      position: { x: COL * 1.3, y: ROW * 3.6 },
      inputs: [{ name: 'SymbolQuote', type: 'object', description: 'từ flow Quote' }],
      outputs: [{ name: 'phát Kafka topic calExtraUpdate', type: 'producer', description: '' }],
      details:
        'Nguồn calExtraUpdate ACTIVE trong runtime websocket-only: mỗi khi high/low year thay đổi so với SymbolInfo cache, realtime-v2 tự phát để các service khác rebuild cached aggregates.',
    },

    // ─── Kafka topics ──────────────────────────────────────────────────
    {
      id: 'kafka-extra',
      kind: 'kafka',
      layer: 'Kafka',
      title: 'topic extraUpdate / calExtraUpdate',
      subtitle: 'Cùng consumer, khác nguồn',
      position: { x: COL * 2.5, y: ROW * 1.8 },
      inputs: [
        { name: 'producer collector (extraUpdate)', type: 'Kafka', description: '4 sources VN30/Futures/CW/Deal' },
        { name: 'producer realtime-v2 (calExtraUpdate)', type: 'Kafka', description: 'high/low year đổi' },
      ],
      outputs: [
        { name: 'realtime-v2 ExtraQuoteUpdateHandler', type: 'Kafka', description: '' },
        { name: 'ws-v2 → market.extra.{code}', type: 'Kafka', description: '' },
      ],
      details: '',
    },

    // ─── Realtime-v2 consumer + service ──────────────────────────────
    {
      id: 'extra-handler',
      kind: 'logic',
      layer: 'realtime-v2 · Consumer',
      title: 'ExtraQuoteUpdateHandler.handle()',
      subtitle: '',
      position: { x: COL * 3.5, y: ROW * 1.8 },
      inputs: [{ name: 'Message<ExtraQuote>', type: 'Kafka payload', description: '' }],
      outputs: [{ name: 'monitorService.rcv(extraQuote)', type: 'call', description: '' }],
      details: '',
    },
    {
      id: 'extra-svc',
      kind: 'logic',
      layer: 'realtime-v2 · ExtraQuoteService',
      title: 'updateExtraQuote(extraQuote)',
      subtitle: 'Merge 3 target',
      position: { x: COL * 4.5, y: ROW * 1.8 },
      inputs: [
        { name: 'ExtraQuote', type: 'object', description: '' },
        { name: 'enableAutoData flag', type: 'boolean', description: 'false → return ngay' },
      ],
      outputs: [
        {
          name: '① SymbolInfo',
          type: 'merge',
          description: 'ConvertUtils.updateByExtraQuote() → basis / breakEven / ptVolume / ptValue / highYear / lowYear',
        },
        {
          name: '② ForeignerDaily',
          type: 'merge',
          description: 'ConvertUtils.updateByExtraQuote(foreignerDaily, extraQuote)',
        },
        {
          name: '③ SymbolDaily',
          type: 'upsert',
          description: 'upsertSymbolDaily(extraQuote, symbolInfo)',
        },
      ],
      details: 'Chỉ chạy khi enableAutoData=true. Tất cả 3 target đều HSET lên Redis.',
    },

    // ─── DealNotice branch (separate from ExtraUpdate) ──────────────
    {
      id: 'kafka-deal',
      kind: 'kafka',
      layer: 'Kafka',
      title: 'topic dealNoticeUpdate',
      subtitle: 'Put-through deals',
      position: { x: COL * 2.5, y: ROW * 4.5 },
      inputs: [{ name: 'producer collector', type: 'Kafka', description: 'Đồng thời với source 4 ExtraUpdate' }],
      outputs: [{ name: 'realtime-v2 + ws-v2', type: 'Kafka', description: '' }],
      details: 'DealNotice raw đi topic riêng cùng lúc fromDealNotice() sinh ExtraUpdate.',
    },
    {
      id: 'deal-svc',
      kind: 'logic',
      layer: 'realtime-v2',
      title: 'DealNoticeService.updateDealNotice()',
      subtitle: 'PT deals',
      position: { x: COL * 4.5, y: ROW * 4.5 },
      inputs: [{ name: 'DealNotice', type: 'object', description: '' }],
      outputs: [
        { name: 'ensure SymbolInfo tồn tại', type: 'check', description: '' },
        { name: 'de-dup theo confirmNumber', type: 'compute', description: '' },
        { name: 'merge PT value/volume vào SymbolInfo', type: 'merge', description: '' },
        { name: 'HSET realtime_mapSymbolInfo[code]', type: 'Redis', description: '' },
        { name: 'RPUSH realtime_listDealNotice_{market}', type: 'Redis List', description: '' },
      ],
      details: '',
    },

    // ─── Advertised branch ──────────────────────────────────────────
    {
      id: 'kafka-adv',
      kind: 'kafka',
      layer: 'Kafka',
      title: 'topic advertisedUpdate',
      subtitle: 'Put-through advertised',
      position: { x: COL * 2.5, y: ROW * 5.5 },
      inputs: [{ name: 'producer collector', type: 'Kafka', description: '' }],
      outputs: [{ name: 'realtime-v2 + ws-v2', type: 'Kafka', description: '' }],
      details: '',
    },
    {
      id: 'adv-svc',
      kind: 'logic',
      layer: 'realtime-v2',
      title: 'AdvertisedService.updateAdvertised()',
      subtitle: 'PT advertised',
      position: { x: COL * 4.5, y: ROW * 5.5 },
      inputs: [{ name: 'Advertised', type: 'object', description: '' }],
      outputs: [
        { name: 'set id, date, timestamps', type: 'set', description: '' },
        { name: 'RPUSH realtime_listAdvertised_{market}', type: 'Redis List', description: '' },
      ],
      details: '',
    },

    // ─── Redis outputs ────────────────────────────────────────────────
    {
      id: 'redis-extra',
      kind: 'redis',
      layer: 'Redis output',
      title: 'mapSymbolInfo + mapSymbolDaily + mapForeignerDaily',
      subtitle: 'Extra fields merged',
      position: { x: COL * 6, y: ROW * 1.8 },
      inputs: [{ name: 'ExtraQuoteService → HSET (3 keys)', type: 'HSET', description: '' }],
      outputs: [{ name: 'query-v2 + ws-v2', type: 'Redis', description: '' }],
      details: 'basis/breakEven/pt value đều nằm trong SymbolInfo nên query-v2 đọc qua SYMBOL_INFO.',
    },
    {
      id: 'redis-deal',
      kind: 'redis',
      layer: 'Redis output',
      title: 'realtime_listDealNotice_{market}',
      subtitle: 'List per market',
      position: { x: COL * 6, y: ROW * 4.5 },
      inputs: [{ name: 'DealNoticeService', type: 'RPUSH', description: '' }],
      outputs: [{ name: 'query-v2: queryPutThroughDeal', type: 'List', description: '' }],
      details: 'Per market: HOSE / HNX / UPCOM.',
    },
    {
      id: 'redis-adv',
      kind: 'redis',
      layer: 'Redis output',
      title: 'realtime_listAdvertised_{market}',
      subtitle: 'List per market',
      position: { x: COL * 6, y: ROW * 5.5 },
      inputs: [{ name: 'AdvertisedService', type: 'RPUSH', description: '' }],
      outputs: [{ name: 'query-v2: queryPutThroughAdvertise', type: 'List', description: '' }],
      details: '',
    },
  ],
  edges: [
    // 4 ExtraUpdate sources → producer
    { source: 'src-vn30', target: 'publish-extra', label: 'basis futures' },
    { source: 'src-futures', target: 'publish-extra', label: 'basis futures' },
    { source: 'src-cw', target: 'publish-extra', label: 'breakEven CW' },
    { source: 'src-deal', target: 'publish-extra', label: 'pt volume/value' },
    { source: 'publish-extra', target: 'kafka-extra', label: 'extraUpdate', animated: true },
    // calExtraUpdate
    { source: 'recalc-source', target: 'kafka-extra', label: 'calExtraUpdate', animated: true },
    // Consumer
    { source: 'kafka-extra', target: 'extra-handler', label: 'consume', animated: true },
    { source: 'extra-handler', target: 'extra-svc', label: 'rcv()' },
    { source: 'extra-svc', target: 'redis-extra', label: 'HSET (3 keys)' },

    // DealNotice branch (raw topic cùng lúc với source 4)
    { source: 'src-deal', target: 'kafka-deal', label: 'raw dealNotice' },
    { source: 'kafka-deal', target: 'deal-svc', label: 'consume', animated: true },
    { source: 'deal-svc', target: 'redis-deal', label: 'RPUSH' },

    // Advertised branch
    { source: 'kafka-adv', target: 'adv-svc', label: 'consume' },
    { source: 'adv-svc', target: 'redis-adv', label: 'RPUSH' },
  ],
};

// ─────────────────────────────────────────────────────────────────────────
// 6. RESET / MAINTENANCE FLOW (NEW)
// ─────────────────────────────────────────────────────────────────────────
const resetFlow = {
  id: 'reset-flow',
  title: 'RESET / MAINTENANCE — removeAutoData · refreshSymbolInfo · clearOldSymbolDaily',
  subtitle: '3 cron jobs lifecycle daily ở realtime-v2 để dọn / reset Redis hot state',
  accent: '#fb7185',
  nodes: [
    {
      id: 'cron-remove',
      kind: 'schedule',
      layer: 'Cron',
      title: 'removeAutoData',
      subtitle: '0 55 0 * * MON-FRI (00:55)',
      position: { x: 0, y: 0 },
      inputs: [{ name: '@Scheduled cron', type: 'cron', description: '' }],
      outputs: [{ name: 'JobService.removeAutoData()', type: 'call', description: '' }],
      details: 'Chạy đầu ngày để dọn tick/minute của ngày hôm trước.',
    },
    {
      id: 'cron-refresh',
      kind: 'schedule',
      layer: 'Cron',
      title: 'refreshSymbolInfo',
      subtitle: '0 35 1 * * MON-FRI (01:35)',
      position: { x: 0, y: ROW * 2 },
      inputs: [{ name: '@Scheduled cron', type: 'cron', description: '' }],
      outputs: [{ name: 'JobService.refreshSymbolInfo()', type: 'call', description: '' }],
      details: 'Reset 1 số field intraday trên SymbolInfo để chuẩn bị phiên mới.',
    },
    {
      id: 'cron-clear',
      kind: 'schedule',
      layer: 'Cron',
      title: 'clearOldSymbolDaily',
      subtitle: '0 50 22 * * MON-FRI (22:50)',
      position: { x: 0, y: ROW * 4 },
      inputs: [{ name: '@Scheduled cron', type: 'cron', description: '' }],
      outputs: [{ name: 'JobService.clearOldSymbolDaily()', type: 'call', description: '' }],
      details: 'Dọn daily map cuối ngày.',
    },
    {
      id: 'check-holiday',
      kind: 'logic',
      layer: 'Pre-check',
      title: 'check holiday / weekend',
      subtitle: 'Skip nếu không phải trading day',
      position: { x: COL, y: 0 },
      inputs: [{ name: 'JobService.removeAutoData()', type: 'call', description: '' }],
      outputs: [{ name: 'tiếp tục hoặc skip', type: 'branch', description: '' }],
      details: '',
    },
    {
      id: 'rs-remove',
      kind: 'logic',
      layer: 'realtime-v2',
      title: 'RedisService.removeAutoData()',
      subtitle: 'Bulk clear keys',
      position: { x: COL * 2, y: 0 },
      inputs: [{ name: 'không có (pure clear)', type: 'call', description: '' }],
      outputs: [
        { name: 'clearAllQuoteMinute()', type: 'DEL', description: 'realtime_listQuoteMinute_*' },
        { name: 'clearAllSymbolQuote()', type: 'DEL', description: 'realtime_listQuote_*' },
        { name: 'clearAllSymbolQuoteMeta()', type: 'DEL', description: 'realtime_listQuoteMeta_*' },
        { name: 'clearAllSymbolQuoteWrongOrder()', type: 'DEL', description: '' },
        { name: 'clearAllSymbolQuoteRecoverMinute()', type: 'DEL', description: '' },
        { name: 'clearAllBidOffer()', type: 'DEL', description: '' },
        { name: 'clearAllDealNotice() / Advertised()', type: 'DEL', description: '' },
        { name: 'clearMarketStatistic()', type: 'DEL', description: 'mapSymbolStatistic' },
      ],
      details: '',
    },
    {
      id: 'rs-refresh',
      kind: 'logic',
      layer: 'realtime-v2',
      title: 'RedisService.refreshSymbolInfo()',
      subtitle: 'Reset field per SymbolInfo',
      position: { x: COL * 2, y: ROW * 2 },
      inputs: [{ name: 'redisDao.getAllSymbolInfo()', type: 'list', description: '' }],
      outputs: [
        { name: 'sequence = 0', type: 'reset', description: '' },
        { name: 'matchingVolume = 0', type: 'reset', description: '' },
        { name: 'matchedBy = null', type: 'reset', description: '' },
        { name: 'bidOfferList = null', type: 'reset', description: '' },
        { name: 'oddlotBidOfferList = null', type: 'reset', description: '' },
        { name: 'updatedBy = "Job Realtime refreshSymbolInfo"', type: 'set', description: '' },
        { name: 'setSymbolInfo() per code', type: 'HSET', description: '' },
      ],
      details: 'KHÔNG xóa SymbolInfo — chỉ reset một số field intraday.',
    },
    {
      id: 'rs-clear',
      kind: 'logic',
      layer: 'realtime-v2',
      title: 'RedisService.clearOldSymbolDaily()',
      subtitle: 'Clear daily',
      position: { x: COL * 2, y: ROW * 4 },
      inputs: [{ name: 'không có', type: 'call', description: '' }],
      outputs: [
        { name: 'clear realtime_mapSymbolDaily', type: 'DEL', description: '' },
        { name: 'cacheService.getMapSymbolDaily().clear()', type: 'in-memory clear', description: '' },
      ],
      details: '',
    },
    {
      id: 'cache-reset',
      kind: 'logic',
      layer: 'realtime-v2',
      title: 'cacheService.reset()',
      subtitle: 'In-memory cache reset',
      position: { x: COL * 3, y: ROW * 1 },
      inputs: [{ name: 'sau remove/refresh', type: 'call', description: '' }],
      outputs: [{ name: 'in-memory cache về 0', type: 'reset', description: '' }],
      details: '',
    },
    {
      id: 'redis-cleared',
      kind: 'redis',
      layer: 'Redis after',
      title: 'BỊ XÓA',
      subtitle: 'Tick · minute · bid-offer · stats',
      position: { x: COL * 4, y: 0 },
      inputs: [{ name: 'removeAutoData', type: 'DEL', description: '' }],
      outputs: [
        { name: 'realtime_listQuote_*', type: 'cleared', description: '' },
        { name: 'realtime_listQuoteMinute_*', type: 'cleared', description: '' },
        { name: 'realtime_listQuoteMeta_*', type: 'cleared', description: '' },
        { name: 'realtime_listBidOffer_*', type: 'cleared', description: '' },
        { name: 'realtime_listDealNotice_* / Advertised_*', type: 'cleared', description: '' },
        { name: 'realtime_mapSymbolStatistic', type: 'cleared', description: '' },
      ],
      details: '',
    },
    {
      id: 'redis-kept',
      kind: 'redis',
      layer: 'Redis after',
      title: 'GIỮ LẠI',
      subtitle: 'SymbolInfo · ForeignerDaily · MarketStatus',
      position: { x: COL * 4, y: ROW * 2 },
      inputs: [{ name: 'removeAutoData không động vào', type: 'preserve', description: '' }],
      outputs: [
        { name: 'realtime_mapSymbolInfo', type: 'kept', description: '(field intraday được refresh ở 01:35)' },
        { name: 'realtime_mapForeignerDaily', type: 'kept', description: '' },
        { name: 'realtime_mapMarketStatus', type: 'kept', description: '' },
      ],
      details: '',
    },
    {
      id: 'redis-daily-cleared',
      kind: 'redis',
      layer: 'Redis after',
      title: 'realtime_mapSymbolDaily',
      subtitle: 'Cleared cuối ngày',
      position: { x: COL * 4, y: ROW * 4 },
      inputs: [{ name: 'clearOldSymbolDaily', type: 'DEL', description: '' }],
      outputs: [{ name: 'sạch sàng cho ngày sau', type: 'cleared', description: '' }],
      details: '',
    },
  ],
  edges: [
    { source: 'cron-remove', target: 'check-holiday', label: 'trigger' },
    { source: 'check-holiday', target: 'rs-remove', label: 'pass' },
    { source: 'rs-remove', target: 'cache-reset', label: 'reset cache' },
    { source: 'rs-remove', target: 'redis-cleared', label: 'DEL bulk' },
    { source: 'rs-remove', target: 'redis-kept', label: 'untouched' },

    { source: 'cron-refresh', target: 'rs-refresh', label: 'trigger' },
    { source: 'rs-refresh', target: 'cache-reset', label: 'reset cache' },
    { source: 'rs-refresh', target: 'redis-kept', label: 'HSET reset fields' },

    { source: 'cron-clear', target: 'rs-clear', label: 'trigger' },
    { source: 'rs-clear', target: 'redis-daily-cleared', label: 'DEL' },
  ],
};

// ─────────────────────────────────────────────────────────────────────────
// 7. PERSIST SNAPSHOT FLOW — saveRedisToDatabase (NEW)
// ─────────────────────────────────────────────────────────────────────────
const persistFlow = {
  id: 'persist-flow',
  title: 'PERSIST SNAPSHOT — saveRedisToDatabase Redis → MongoDB',
  subtitle:
    'Cron 6 lần/ngày (10:15, 10:29, 11:15, 11:29, 14:15, 14:29) snapshot day-level state sang Mongo. KHÔNG persist tick/minute/bid-offer (flags tắt).',
  accent: '#34d399',
  nodes: [
    {
      id: 'cron',
      kind: 'schedule',
      layer: 'Cron',
      title: 'JobService.saveRedisToDatabase()',
      subtitle: '0 15,29 10,11,14 * * MON-FRI',
      position: { x: 0, y: ROW * 2 },
      inputs: [{ name: '@Scheduled cron', type: 'cron', description: '6 lần/ngày' }],
      outputs: [{ name: 'RedisService.saveRedisToDatabase(flags)', type: 'call', description: '' }],
      details: '10:15 · 10:29 · 11:15 · 11:29 · 14:15 · 14:29.',
    },
    {
      id: 'rs-save',
      kind: 'logic',
      layer: 'realtime-v2',
      title: 'RedisService.saveRedisToDatabase()',
      subtitle: 'Orchestrate bulk write',
      position: { x: COL, y: ROW * 2 },
      inputs: [
        { name: 'enableSaveQuote', type: 'boolean', description: 'runtime = false' },
        { name: 'enableSaveQuoteMinute', type: 'boolean', description: 'runtime = false' },
        { name: 'enableSaveBidAsk', type: 'boolean', description: 'runtime = false' },
      ],
      outputs: [{ name: '7 bulk writes + updateSymbolPrevious', type: 'call', description: '' }],
      details: '',
    },
    {
      id: 'r-info',
      kind: 'redis',
      layer: 'Redis read',
      title: 'redisDao.getAllSymbolInfo()',
      subtitle: '',
      position: { x: COL * 2, y: 0 },
      inputs: [{ name: 'realtime_mapSymbolInfo', type: 'HGETALL', description: '' }],
      outputs: [{ name: 'List<SymbolInfo>', type: 'list', description: '' }],
      details: '',
    },
    {
      id: 'r-oddlot',
      kind: 'redis',
      layer: 'Redis read',
      title: 'redisDao.getAllSymbolInfoOddLot()',
      subtitle: 'Hash realtime_mapSymbolInfoOddLot',
      position: { x: COL * 2, y: ROW * 0.7 },
      inputs: [{ name: 'realtime_mapSymbolInfoOddLot', type: 'HGETALL', description: 'Key tách riêng với mapSymbolInfo' }],
      outputs: [{ name: 'List<SymbolInfoOddLot>', type: 'list', description: 'Chỉ có bidOfferList odd-lot + foreigner summary' }],
      details:
        '─── Sample SHB ───\n' +
        '{\n' +
        '  "id":"SHB","code":"SHB",\n' +
        '  "tradingVolume":0,"tradingValue":0.0,\n' +
        '  "upCount":0,"ceilingCount":0,"unchangedCount":0,\n' +
        '  "downCount":0,"floorCount":0,\n' +
        '  "foreignerBuyVolume":0,"foreignerSellVolume":0,\n' +
        '  "foreignerBuyValue":0.0,"foreignerSellValue":0.0,\n' +
        '  "ptTradingVolume":0,"ptTradingValue":0.0,\n' +
        '  "oddlotBidofferTime":"085900",\n' +
        '  "updatedAt":1709110740140,\n' +
        '  "oddlotBidOfferList":[\n' +
        '    {"bidPrice":11900.0,"bidVolume":254,"offerPrice":11950.0,"offerVolume":333},\n' +
        '    {"bidPrice":11850.0,"bidVolume":1695,"offerPrice":12000.0,"offerVolume":879},\n' +
        '    {"bidPrice":11800.0,"bidVolume":2641,"offerPrice":12050.0,"offerVolume":45}\n' +
        '  ],\n' +
        '  "quoteSequence":0,"bidAskSequence":1,\n' +
        '  "isHighlight":1000,\n' +
        '  "updatedBy":"BidOfferOddLot"\n' +
        '}\n\n' +
        'Lưu ý: key lưu riêng vì odd-lot không khớp sequence với main session. ' +
        'Đi kèm history list: realtime_listBidOfferOddLot_<code> (xem flow BidOffer).',
    },
    {
      id: 'r-daily',
      kind: 'redis',
      layer: 'Redis read',
      title: 'redisDao.getAllSymbolDaily()',
      subtitle: '',
      position: { x: COL * 2, y: ROW * 1.4 },
      inputs: [{ name: 'realtime_mapSymbolDaily', type: 'HGETALL', description: '' }],
      outputs: [{ name: 'List<SymbolDaily>', type: 'list', description: '' }],
      details: '',
    },
    {
      id: 'r-foreigner',
      kind: 'redis',
      layer: 'Redis read',
      title: 'redisDao.getAllForeignerDaily()',
      subtitle: 'set id=code_yyyyMMdd',
      position: { x: COL * 2, y: ROW * 2.1 },
      inputs: [{ name: 'realtime_mapForeignerDaily', type: 'HGETALL', description: '' }],
      outputs: [{ name: 'List<ForeignerDaily> (id mapped today)', type: 'list', description: '' }],
      details: '',
    },
    {
      id: 'r-status',
      kind: 'redis',
      layer: 'Redis read',
      title: 'redisDao.getAllMarketStatus()',
      subtitle: '',
      position: { x: COL * 2, y: ROW * 2.8 },
      inputs: [{ name: 'realtime_mapMarketStatus', type: 'HGETALL', description: '' }],
      outputs: [{ name: 'List<MarketStatus>', type: 'list', description: '' }],
      details: '',
    },
    {
      id: 'r-deal',
      kind: 'redis',
      layer: 'Redis read',
      title: 'redisDao.getAllDealNotice(market)',
      subtitle: 'HNX / UPCOM / HOSE',
      position: { x: COL * 2, y: ROW * 3.5 },
      inputs: [{ name: 'realtime_listDealNotice_{market}', type: 'LRANGE', description: '' }],
      outputs: [{ name: 'List<DealNotice>', type: 'list', description: '' }],
      details: '',
    },
    {
      id: 'r-adv',
      kind: 'redis',
      layer: 'Redis read',
      title: 'redisDao.getAllAdvertised(market)',
      subtitle: 'HNX / UPCOM / HOSE',
      position: { x: COL * 2, y: ROW * 4.2 },
      inputs: [{ name: 'realtime_listAdvertised_{market}', type: 'LRANGE', description: '' }],
      outputs: [{ name: 'List<Advertised>', type: 'list', description: '' }],
      details: '',
    },
    {
      id: 'bulk',
      kind: 'logic',
      layer: 'Mongo bulk',
      title: 'MongoBulkUtils.updateInBulk',
      subtitle: 'Per collection',
      position: { x: COL * 3, y: ROW * 2.5 },
      inputs: [{ name: '7 lists từ Redis', type: 'list', description: '' }],
      outputs: [{ name: 'BulkWriteResult', type: 'Mongo', description: '' }],
      details: 'Bulk upsert hiệu suất cao thay vì insert từng cái.',
    },
    {
      id: 'm-info',
      kind: 'mongo',
      layer: 'Mongo write',
      title: 'c_symbol_info',
      subtitle: 'Active',
      position: { x: COL * 4, y: 0 },
      inputs: [{ name: 'bulk', type: 'upsert', description: '' }],
      outputs: [{ name: 'snapshot', type: 'collection', description: '' }],
      details: '',
    },
    {
      id: 'm-oddlot',
      kind: 'mongo',
      layer: 'Mongo write',
      title: 'odd-lot collection (SymbolInfoOddLot)',
      subtitle: 'Active',
      position: { x: COL * 4, y: ROW * 0.7 },
      inputs: [{ name: 'bulk', type: 'upsert', description: '' }],
      outputs: [{ name: 'snapshot', type: 'collection', description: '' }],
      details: '',
    },
    {
      id: 'm-daily',
      kind: 'mongo',
      layer: 'Mongo write',
      title: 'c_symbol_daily',
      subtitle: 'Active',
      position: { x: COL * 4, y: ROW * 1.4 },
      inputs: [{ name: 'bulk', type: 'upsert', description: '' }],
      outputs: [{ name: 'snapshot', type: 'collection', description: '' }],
      details: '',
    },
    {
      id: 'm-foreigner',
      kind: 'mongo',
      layer: 'Mongo write',
      title: 'c_foreigner_daily',
      subtitle: 'Active',
      position: { x: COL * 4, y: ROW * 2.1 },
      inputs: [{ name: 'bulk', type: 'upsert', description: '' }],
      outputs: [{ name: 'snapshot', type: 'collection', description: '' }],
      details: '',
    },
    {
      id: 'm-status',
      kind: 'mongo',
      layer: 'Mongo write',
      title: 'c_market_session_status',
      subtitle: 'Active',
      position: { x: COL * 4, y: ROW * 2.8 },
      inputs: [{ name: 'bulk', type: 'upsert', description: '' }],
      outputs: [{ name: 'snapshot', type: 'collection', description: '' }],
      details: '',
    },
    {
      id: 'm-deal',
      kind: 'mongo',
      layer: 'Mongo write',
      title: 'c_deal_notice',
      subtitle: 'Active',
      position: { x: COL * 4, y: ROW * 3.5 },
      inputs: [{ name: 'bulk', type: 'upsert', description: '' }],
      outputs: [{ name: 'snapshot', type: 'collection', description: '' }],
      details: '',
    },
    {
      id: 'm-adv',
      kind: 'mongo',
      layer: 'Mongo write',
      title: 'c_advertise',
      subtitle: 'Active',
      position: { x: COL * 4, y: ROW * 4.2 },
      inputs: [{ name: 'bulk', type: 'upsert', description: '' }],
      outputs: [{ name: 'snapshot', type: 'collection', description: '' }],
      details: '',
    },
    {
      id: 'prev',
      kind: 'logic',
      layer: 'Post step',
      title: 'updateSymbolPrevious()',
      subtitle: 'Build previous/close',
      position: { x: COL * 3, y: ROW * 4.9 },
      inputs: [{ name: 'SymbolDaily hôm nay', type: 'list', description: '' }],
      outputs: [{ name: 'previous/close state', type: 'compute', description: '' }],
      details: '',
    },
    {
      id: 'm-prev',
      kind: 'mongo',
      layer: 'Mongo write',
      title: 'c_symbol_previous',
      subtitle: 'Active',
      position: { x: COL * 4, y: ROW * 4.9 },
      inputs: [{ name: 'updateSymbolPrevious()', type: 'upsert', description: '' }],
      outputs: [{ name: 'previous-day state', type: 'collection', description: '' }],
      details: '',
    },
    {
      id: 'inactive-quote',
      kind: 'config',
      layer: 'Inactive (flags off)',
      title: 'enableSaveQuote / Minute / BidAsk = false',
      subtitle: 'Runtime hiện tại',
      position: { x: COL * 3, y: 0 },
      inputs: [{ name: 'application config', type: 'boolean', description: '' }],
      outputs: [
        { name: 'KHÔNG getAllSymbolQuote', type: 'skip', description: '' },
        { name: 'KHÔNG getAllSymbolQuoteMinute', type: 'skip', description: '' },
        { name: 'KHÔNG getAllBidOffer', type: 'skip', description: '' },
      ],
      details: 'Hệ quả: c_symbol_quote, c_symbol_quote_minute, c_bid_offer KHÔNG được persist runtime.',
    },
  ],
  edges: [
    { source: 'cron', target: 'rs-save', label: 'saveRedisToDatabase(flags)' },
    { source: 'rs-save', target: 'r-info', label: 'load' },
    { source: 'rs-save', target: 'r-oddlot', label: 'load' },
    { source: 'rs-save', target: 'r-daily', label: 'load' },
    { source: 'rs-save', target: 'r-foreigner', label: 'load' },
    { source: 'rs-save', target: 'r-status', label: 'load' },
    { source: 'rs-save', target: 'r-deal', label: 'load' },
    { source: 'rs-save', target: 'r-adv', label: 'load' },

    { source: 'r-info', target: 'bulk', label: '→ c_symbol_info' },
    { source: 'r-oddlot', target: 'bulk', label: '→ odd-lot' },
    { source: 'r-daily', target: 'bulk', label: '→ c_symbol_daily' },
    { source: 'r-foreigner', target: 'bulk', label: '→ c_foreigner_daily' },
    { source: 'r-status', target: 'bulk', label: '→ c_market_session_status' },
    { source: 'r-deal', target: 'bulk', label: '→ c_deal_notice' },
    { source: 'r-adv', target: 'bulk', label: '→ c_advertise' },

    { source: 'bulk', target: 'm-info', label: 'upsert' },
    { source: 'bulk', target: 'm-oddlot', label: 'upsert' },
    { source: 'bulk', target: 'm-daily', label: 'upsert' },
    { source: 'bulk', target: 'm-foreigner', label: 'upsert' },
    { source: 'bulk', target: 'm-status', label: 'upsert' },
    { source: 'bulk', target: 'm-deal', label: 'upsert' },
    { source: 'bulk', target: 'm-adv', label: 'upsert' },

    { source: 'rs-save', target: 'prev', label: 'updateSymbolPrevious()' },
    { source: 'prev', target: 'm-prev', label: 'upsert' },

    { source: 'inactive-quote', target: 'rs-save', label: 'flags=false → skip 3 nhánh' },
  ],
};

// ─────────────────────────────────────────────────────────────────────────
// 8. QUERY API FLOW
// ─────────────────────────────────────────────────────────────────────────
const queryApiFlow = {
  id: 'query-api-flow',
  title: 'QUERY API — market-query-v2 catalog (Kafka RPC + Redis-first)',
  subtitle:
    '35+ endpoints, transport Kafka request/response pattern · RequestHandler.ts route theo message.uri · Redis primary, Mongo fallback, Lotte REST cho một số historical flows',
  accent: '#38bdf8',
  nodes: [
    {
      id: 'client',
      kind: 'client',
      layer: 'Client',
      title: 'Mobile / Web / BFF',
      subtitle: 'TradeX clients',
      position: { x: 0, y: ROW * 5 },
      inputs: [{ name: 'User action', type: 'UI', description: 'Page load / refresh / lazy fetch' }],
      outputs: [{ name: 'Kafka RPC request', type: 'Kafka', description: '' }],
      details: 'Client gateway (BFF) build message { uri, payload, replyTopic } → publish Kafka.',
    },
    {
      id: 'kafka-req',
      kind: 'kafka',
      layer: 'Kafka RPC',
      title: 'topic market-query-v2.request',
      subtitle: 'Request/Response pattern',
      position: { x: COL, y: ROW * 5 },
      inputs: [{ name: 'BFF producer', type: 'Kafka', description: '' }],
      outputs: [{ name: 'market-query-v2 consumer', type: 'Kafka', description: '' }],
      details: '',
    },
    {
      id: 'request-handler',
      kind: 'logic',
      layer: 'market-query-v2',
      title: 'RequestHandler.ts',
      subtitle: 'Route theo message.uri',
      position: { x: COL * 2, y: ROW * 5 },
      inputs: [{ name: 'Kafka Message<Request>', type: 'object', description: '{ uri, payload, requestId, replyTopic }' }],
      outputs: [{ name: 'dispatch(uri) → 12 service groups', type: 'call', description: '' }],
      details:
        'File: market-query-v2/src/consumers/RequestHandler.ts — controller tập trung, parse payload → invoke service method tương ứng → build response → publish Kafka reply.',
    },

    // ─── 12 service groups ────────────────────────────────────────────
    {
      id: 'grp-realtime',
      kind: 'logic',
      layer: '§2.1 Symbol Realtime',
      title: 'Symbol realtime group',
      subtitle: '12 endpoints',
      position: { x: COL * 3, y: 0 },
      inputs: [{ name: 'codes / symbol / time range', type: 'payload', description: '' }],
      outputs: [
        { name: 'querySymbolLatestNormal', type: 'endpoint', description: 'HMGET SYMBOL_INFO' },
        { name: 'querySymbolLatestOddLot', type: 'endpoint', description: 'HMGET SYMBOL_INFO_ODD_LOT' },
        { name: 'queryPriceBoard', type: 'endpoint', description: 'Board snapshot' },
        { name: 'querySymbolStaticInfo', type: 'endpoint', description: '' },
        { name: 'querySymbolQuote / queryQuoteData', type: 'endpoint', description: 'Tick page theo volume/meta' },
        { name: 'querySymbolQuoteTick', type: 'endpoint', description: 'Tick grouped theo sequence' },
        { name: 'querySymbolQuoteMinutes / queryMinuteChart', type: 'endpoint', description: 'Minute grouped' },
        { name: 'querySymbolStatistics', type: 'endpoint', description: 'HGET SYMBOL_STATISTICS' },
        { name: 'querySymbolTickSizeMatch', type: 'endpoint', description: '' },
        { name: 'queryMarketSessionStatus', type: 'endpoint', description: 'HGET MARKET_STATUS' },
      ],
      details:
        '§2.1 — realtime symbol data từ Redis hot state.\n' +
        'querySymbolQuote flow: 1) đọc SYMBOL_QUOTE_META → 2) chọn partition theo lastTradingVolume → 3) LRANGE SYMBOL_QUOTE_{code}[_p] → 4) SymbolQuoteResponse[].',
    },
    {
      id: 'grp-history',
      kind: 'logic',
      layer: '§2.2 Symbol History',
      title: 'Historical & Analytics',
      subtitle: '5 endpoints',
      position: { x: COL * 3, y: ROW * 1 },
      inputs: [{ name: 'symbol + period', type: 'payload', description: '' }],
      outputs: [
        { name: 'querySymbolPeriod', type: 'endpoint', description: 'HGET SYMBOL_DAILY + c_symbol_daily historical' },
        { name: 'querySymbolForeignerDaily', type: 'endpoint', description: 'HGET FOREIGNER_DAILY' },
        { name: 'querySymbolRight', type: 'endpoint', description: 'GET market_right_info_{code}' },
        { name: 'querySymbolDailyReturns', type: 'endpoint', description: '' },
        { name: 'initSymbolDailyReturns', type: 'endpoint', description: 'Compute + cache returns' },
      ],
      details: 'Hỗn hợp Redis (intraday) + Mongo (historical).',
    },
    {
      id: 'grp-ranking',
      kind: 'logic',
      layer: '§2.3 Ranking',
      title: 'Ranking & Sorting',
      subtitle: '7 endpoints',
      position: { x: COL * 3, y: ROW * 2 },
      inputs: [{ name: 'market + ranking + period', type: 'payload', description: '' }],
      outputs: [
        { name: 'querySymbolRankingTrade', type: 'endpoint', description: '' },
        { name: 'queryStockRankingUpDown', type: 'endpoint', description: '' },
        { name: 'queryStockRankingTop', type: 'endpoint', description: '' },
        { name: 'queryStockRankingPeriod', type: 'endpoint', description: 'GET market_rise_false_stock_ranking_{market}_{ranking}_{period}' },
        { name: 'queryForeignerRanking', type: 'endpoint', description: '' },
        { name: 'queryTopForeignerTrading', type: 'endpoint', description: '' },
        { name: 'queryTopAiRating', type: 'endpoint', description: '' },
      ],
      details: 'Ranking cached dạng String (JSON) trong Redis key STOCK_RANKING_PERIOD.',
    },
    {
      id: 'grp-index',
      kind: 'logic',
      layer: '§2.4 Index & Market',
      title: 'Index & Market meta',
      subtitle: '7 endpoints',
      position: { x: COL * 3, y: ROW * 3 },
      inputs: [{ name: 'market / index code', type: 'payload', description: '' }],
      outputs: [
        { name: 'queryIndexList', type: 'endpoint', description: '' },
        { name: 'queryIndexStockList', type: 'endpoint', description: 'Mã trong rổ index' },
        { name: 'queryMarketLiquidity', type: 'endpoint', description: '' },
        { name: 'getLastTradingDate', type: 'endpoint', description: '' },
        { name: 'getCurrentDividendList', type: 'endpoint', description: '' },
        { name: 'getDailyAccumulativeVNIndex', type: 'endpoint', description: '' },
        { name: 'queryForeignerSummary', type: 'endpoint', description: 'Aggregate nước ngoài theo sàn' },
      ],
      details: '',
    },
    {
      id: 'grp-pt',
      kind: 'logic',
      layer: '§2.5 Put-through',
      title: 'Thỏa thuận',
      subtitle: '3 endpoints',
      position: { x: COL * 3, y: ROW * 4 },
      inputs: [{ name: 'market + time range', type: 'payload', description: '' }],
      outputs: [
        { name: 'queryPutThroughAdvertise', type: 'endpoint', description: 'LRANGE ADVERTISED_{market}' },
        { name: 'queryPutThroughDeal', type: 'endpoint', description: 'LRANGE DEAL_NOTICE_{market}' },
        { name: 'queryPtDealTotal', type: 'endpoint', description: '' },
      ],
      details: '',
    },
    {
      id: 'grp-etf',
      kind: 'logic',
      layer: '§2.6 ETF',
      title: 'ETF',
      subtitle: '2 endpoints',
      position: { x: COL * 3, y: ROW * 5 },
      inputs: [{ name: 'etfCode + from/to', type: 'payload', description: '' }],
      outputs: [
        { name: 'queryEtfNavDaily', type: 'endpoint', description: '' },
        { name: 'queryEtfIndexDaily', type: 'endpoint', description: '' },
      ],
      details: '',
    },
    {
      id: 'grp-tv',
      kind: 'logic',
      layer: '§2.7 TradingView',
      title: 'TradingView (Chart widget)',
      subtitle: '5 endpoints',
      position: { x: COL * 3, y: ROW * 6 },
      inputs: [{ name: 'UDF params', type: 'payload', description: 'symbol, resolution, from, to' }],
      outputs: [
        { name: 'queryConfig', type: 'endpoint', description: '' },
        { name: 'querySymbolInfo', type: 'endpoint', description: '' },
        { name: 'querySymbolSearch', type: 'endpoint', description: '' },
        { name: 'queryTradingViewHistory', type: 'endpoint', description: 'Bars cho chart' },
        { name: 'querySymbolHistoryEvents', type: 'endpoint', description: 'Dividend / split events' },
      ],
      details: '',
    },
    {
      id: 'grp-chart',
      kind: 'logic',
      layer: '§2.8 Chart save/load',
      title: 'Chart CRUD',
      subtitle: '5 endpoints',
      position: { x: COL * 3, y: ROW * 7 },
      inputs: [{ name: 'accountId + chartId', type: 'payload', description: '' }],
      outputs: [
        { name: 'saveChart', type: 'endpoint', description: 'insert Mongo' },
        { name: 'updateChart', type: 'endpoint', description: '' },
        { name: 'listChart', type: 'endpoint', description: '' },
        { name: 'loadChart', type: 'endpoint', description: '' },
        { name: 'deleteChart', type: 'endpoint', description: '' },
      ],
      details: 'Thuần Mongo (c_chart).',
    },
    {
      id: 'grp-watchlist',
      kind: 'logic',
      layer: '§2.9 WatchList',
      title: 'WatchList CRUD',
      subtitle: '9 endpoints',
      position: { x: COL * 3, y: ROW * 8 },
      inputs: [{ name: 'accountId + watchListId + code', type: 'payload', description: '' }],
      outputs: [
        { name: 'createWatchList / editWatchList / deleteWatchList', type: 'endpoint', description: '' },
        { name: 'getWatchList / getWatchListSymbols / getWatchListIncludeSymbol', type: 'endpoint', description: '' },
        { name: 'addSymbolToWatchList / removeSymbolFromWatchList', type: 'endpoint', description: '' },
        { name: 'updateOrderSymbolWatchList', type: 'endpoint', description: '' },
      ],
      details: 'Thuần Mongo (c_watchlist).',
    },
    {
      id: 'grp-fix',
      kind: 'logic',
      layer: '§2.10 FIX',
      title: 'FIX Protocol',
      subtitle: '1 endpoint',
      position: { x: COL * 3, y: ROW * 9 },
      inputs: [{ name: 'filter list', type: 'payload', description: '' }],
      outputs: [{ name: 'queryFixSymbolList', type: 'endpoint', description: '' }],
      details: '',
    },
    {
      id: 'grp-admin',
      kind: 'logic',
      layer: '§2.11 Admin',
      title: 'Admin / Crawl',
      subtitle: '1 endpoint',
      position: { x: COL * 3, y: ROW * 10 },
      inputs: [{ name: 'admin token + chart params', type: 'payload', description: '' }],
      outputs: [{ name: 'crawlChartData', type: 'endpoint', description: 'Trigger crawl → Lotte REST + Mongo persist' }],
      details: 'Endpoint vận hành — gọi REST Lotte để refresh chart data vào Mongo.',
    },
    {
      id: 'grp-noti',
      kind: 'logic',
      layer: '§2.12 Notification',
      title: 'Notification',
      subtitle: '1 endpoint',
      position: { x: COL * 3, y: ROW * 11 },
      inputs: [{ name: 'accountId + type + paging', type: 'payload', description: '' }],
      outputs: [{ name: 'queryAccountNotification', type: 'endpoint', description: 'HGET notice_{type}' }],
      details: '',
    },

    // ─── Data sources ─────────────────────────────────────────────────
    {
      id: 'redis-primary',
      kind: 'redis',
      layer: 'Primary store',
      title: 'Redis (primary)',
      subtitle: 'Intraday hot state + cached aggregates',
      position: { x: COL * 4.5, y: ROW * 3 },
      inputs: [{ name: 'từ các service group', type: 'HGET/LRANGE/GET', description: '' }],
      outputs: [{ name: 'hot data', type: 'Redis', description: '' }],
      details:
        'REDIS_KEY coverage (file RedisService.ts):\n' +
        '  SYMBOL_INFO, SYMBOL_INFO_ODD_LOT, SYMBOL_DAILY, FOREIGNER_DAILY,\n' +
        '  SYMBOL_QUOTE, SYMBOL_QUOTE_META, SYMBOL_QUOTE_MINUTE, SYMBOL_STATISTICS,\n' +
        '  SYMBOL_BID_OFFER, DEAL_NOTICE, ADVERTISED, MARKET_STATUS,\n' +
        '  SYMBOL_INFO_EXTEND, STOCK_RANKING_PERIOD, SYMBOL_STOCK_RIGHT, NOTIFICATION.',
    },
    {
      id: 'mongo-fb',
      kind: 'mongo',
      layer: 'Fallback / history',
      title: 'MongoDB',
      subtitle: 'Day-level + domain CRUD',
      position: { x: COL * 4.5, y: ROW * 7 },
      inputs: [{ name: 'find() / insert() / update()', type: 'Mongo', description: '' }],
      outputs: [{ name: 'rows', type: 'Mongo', description: '' }],
      details:
        'Active collections:\n' +
        '  c_symbol_info, c_symbol_daily, c_foreigner_daily, c_market_session_status,\n' +
        '  c_deal_notice, c_advertise, c_symbol_previous,\n' +
        '  c_chart, c_watchlist, c_notification, ...\n' +
        'KHÔNG ghi runtime: c_symbol_quote, c_symbol_quote_minute, c_bid_offer (flags off).',
    },
    {
      id: 'lotte-rest',
      kind: 'source',
      layer: 'External',
      title: 'Lotte REST',
      subtitle: 'Historical / chart crawl',
      position: { x: COL * 4.5, y: ROW * 10 },
      inputs: [{ name: 'admin trigger (crawlChartData)', type: 'call', description: '' }],
      outputs: [{ name: 'chart history rows', type: 'REST', description: '' }],
      details: '',
    },

    // ─── Response ─────────────────────────────────────────────────────
    {
      id: 'response',
      kind: 'logic',
      layer: 'Response builder',
      title: 'Build response + Kafka reply',
      subtitle: '',
      position: { x: COL * 6, y: ROW * 5 },
      inputs: [{ name: 'data từ Redis / Mongo / Lotte', type: 'object', description: '' }],
      outputs: [
        { name: 'Kafka reply { requestId, data }', type: 'Kafka', description: 'Gửi về replyTopic từ request' },
      ],
      details: '',
    },
    {
      id: 'kafka-reply',
      kind: 'kafka',
      layer: 'Kafka RPC',
      title: 'topic <replyTopic>',
      subtitle: 'Phản hồi bất đồng bộ',
      position: { x: COL * 7, y: ROW * 5 },
      inputs: [{ name: 'producer market-query-v2', type: 'Kafka', description: '' }],
      outputs: [{ name: 'BFF consumer', type: 'Kafka', description: '' }],
      details: '',
    },
    {
      id: 'client-render',
      kind: 'client',
      layer: 'Client',
      title: 'Render UI',
      subtitle: 'Board / chart / order book / watchlist',
      position: { x: COL * 8, y: ROW * 5 },
      inputs: [{ name: 'JSON response', type: 'REST/WS', description: 'BFF proxy lại client' }],
      outputs: [{ name: 'UI', type: 'render', description: '' }],
      details: '',
    },
  ],
  edges: [
    { source: 'client', target: 'kafka-req', label: 'publish RPC', animated: true },
    { source: 'kafka-req', target: 'request-handler', label: 'consume', animated: true },

    { source: 'request-handler', target: 'grp-realtime', label: '§2.1 uri' },
    { source: 'request-handler', target: 'grp-history', label: '§2.2 uri' },
    { source: 'request-handler', target: 'grp-ranking', label: '§2.3 uri' },
    { source: 'request-handler', target: 'grp-index', label: '§2.4 uri' },
    { source: 'request-handler', target: 'grp-pt', label: '§2.5 uri' },
    { source: 'request-handler', target: 'grp-etf', label: '§2.6 uri' },
    { source: 'request-handler', target: 'grp-tv', label: '§2.7 uri' },
    { source: 'request-handler', target: 'grp-chart', label: '§2.8 uri' },
    { source: 'request-handler', target: 'grp-watchlist', label: '§2.9 uri' },
    { source: 'request-handler', target: 'grp-fix', label: '§2.10 uri' },
    { source: 'request-handler', target: 'grp-admin', label: '§2.11 uri' },
    { source: 'request-handler', target: 'grp-noti', label: '§2.12 uri' },

    { source: 'grp-realtime', target: 'redis-primary', label: 'HGET / LRANGE' },
    { source: 'grp-history', target: 'redis-primary', label: 'HGET intraday' },
    { source: 'grp-history', target: 'mongo-fb', label: 'find historical' },
    { source: 'grp-ranking', target: 'redis-primary', label: 'GET cached' },
    { source: 'grp-index', target: 'redis-primary', label: 'HGET' },
    { source: 'grp-index', target: 'mongo-fb', label: 'find history' },
    { source: 'grp-pt', target: 'redis-primary', label: 'LRANGE' },
    { source: 'grp-pt', target: 'mongo-fb', label: 'find history' },
    { source: 'grp-etf', target: 'mongo-fb', label: 'find' },
    { source: 'grp-tv', target: 'mongo-fb', label: 'find bars' },
    { source: 'grp-chart', target: 'mongo-fb', label: 'CRUD' },
    { source: 'grp-watchlist', target: 'mongo-fb', label: 'CRUD' },
    { source: 'grp-fix', target: 'mongo-fb', label: 'find' },
    { source: 'grp-admin', target: 'lotte-rest', label: 'crawl' },
    { source: 'grp-admin', target: 'mongo-fb', label: 'persist' },
    { source: 'grp-noti', target: 'redis-primary', label: 'HGET notice_*' },

    { source: 'redis-primary', target: 'response', label: 'data' },
    { source: 'mongo-fb', target: 'response', label: 'data' },
    { source: 'lotte-rest', target: 'response', label: 'data' },
    { source: 'response', target: 'kafka-reply', label: 'publish', animated: true },
    { source: 'kafka-reply', target: 'client-render', label: 'deliver', animated: true },
  ],
};

// ─────────────────────────────────────────────────────────────────────────
// 9. WS-V2 BROADCAST FLOW
// ─────────────────────────────────────────────────────────────────────────
const wsFlow = {
  id: 'ws-flow',
  title: 'WS-V2 BROADCAST — Kafka direct → SocketCluster channels',
  subtitle:
    'ws-v2 consume Kafka trực tiếp, KHÔNG chờ Mongo · compact payload qua parser.js · publish + snapshot on subscribe',
  accent: '#c084fc',
  nodes: [
    {
      id: 'kafka',
      kind: 'kafka',
      layer: 'Kafka',
      title: 'Market topics',
      subtitle: 'quote / bidoffer / extra / status / dealNotice / advertised / statistic',
      position: { x: 0, y: ROW * 2 },
      inputs: [{ name: 'producer collector + realtime-v2', type: 'Kafka', description: '' }],
      outputs: [{ name: 'consume bởi market.js', type: 'Kafka', description: '' }],
      details: '',
    },
    {
      id: 'market-js',
      kind: 'logic',
      layer: 'ws-v2',
      title: 'market.js processDataPublishV2(msg)',
      subtitle: 'Pipeline entry',
      position: { x: COL, y: ROW * 2 },
      inputs: [{ name: 'Kafka message', type: 'object', description: '' }],
      outputs: [{ name: 'mapTopicToPublishV2 → channel', type: 'route', description: '' }],
      details: '',
    },
    {
      id: 'topic-map',
      kind: 'logic',
      layer: 'ws-v2',
      title: 'mapTopicToPublishV2',
      subtitle: 'Topic → channel pattern',
      position: { x: COL * 2, y: ROW * 2 },
      inputs: [{ name: 'kafka topic name', type: 'string', description: '' }],
      outputs: [
        { name: 'quoteUpdate → market.quote.{code}', type: 'channel', description: '' },
        { name: 'quoteUpdateDR → market.quote.dr.{code}', type: 'channel', description: '' },
        { name: 'quoteOddLotUpdate → market.quoteOddLot.{code}', type: 'channel', description: 'Nhánh odd-lot riêng' },
        { name: 'bidOfferUpdate → market.bidoffer.{code}', type: 'channel', description: '' },
        { name: 'bidOfferUpdateDR → market.bidoffer.dr.{code}', type: 'channel', description: '' },
        { name: 'bidOfferOddLotUpdate → market.bidofferOddLot.{code}', type: 'channel', description: 'Nhánh odd-lot riêng' },
        { name: 'extraUpdate / calExtraUpdate → market.extra.{code}', type: 'channel', description: '' },
        { name: 'marketStatus → market.status', type: 'channel', description: '' },
        { name: 'dealNoticeUpdate → market.putthrough.deal.{market}', type: 'channel', description: '' },
        { name: 'advertisedUpdate → market.putthrough.advertise.{market}', type: 'channel', description: '' },
        { name: 'statisticUpdate → market.statistic.{code}', type: 'channel', description: '' },
      ],
      details:
        'File: ws-v2/market.js → processDataPublishV2().\n' +
        'Topic odd-lot dùng parser riêng (convertDataPublishV2BidOfferOddLot, convertDataPublishV2QuoteOddLot) nên payload chỉ chứa các field phù hợp cho lô lẻ.',
    },
    {
      id: 'parser',
      kind: 'logic',
      layer: 'ws-v2',
      title: 'parser.js convertDataPublishV2*',
      subtitle: 'Compact payload',
      position: { x: COL * 3, y: ROW * 2 },
      inputs: [
        { name: 'full payload từ Kafka', type: 'object', description: 'verbose field names' },
      ],
      outputs: [
        {
          name: 'Quote compact',
          type: 'object',
          description: 'code→s, time→ti, open→o, high→h, low→l, last→c, change→ch, rate→ra, tradingVolume→vo, tradingValue→va, matchingVolume→mv, averagePrice→a, matchedBy→mb, foreigner→fr',
        },
        {
          name: 'BidOffer compact',
          type: 'object',
          description:
            'Sample output:\n{ s:"VNM", ss:"ATO", bb:[{p,v,c},…], bo:[{p,v,c},…], tb:50000, to:45000, ep:85050, exc:550, exr:0.65 }',
        },
        {
          name: 'BidOffer Odd-lot compact',
          type: 'object',
          description: 'convertDataPublishV2BidOfferOddLot — giữ oddlotBidOfferList + time, bỏ các field main session',
        },
        {
          name: 'Quote Odd-lot compact',
          type: 'object',
          description: 'convertDataPublishV2QuoteOddLot — giữ OHLC + volume đơn giản cho lô lẻ',
        },
        { name: 'Extra compact', type: 'object', description: 'convertDataPublishV2Extra' },
      ],
      details: 'Mục tiêu: giảm bandwidth qua wire bằng key ngắn 1-2 ký tự.',
    },
    {
      id: 'cache',
      kind: 'redis',
      layer: 'In-memory cache',
      title: 'cacheInfo / cacheOddlot / cacheStatistic / cacheMarketStatus',
      subtitle: 'In-process JS cache',
      position: { x: COL * 4, y: ROW * 1 },
      inputs: [{ name: 'setToCacheInfo(code, payload)', type: 'set', description: 'Sau parse' }],
      outputs: [{ name: 'phục vụ snapshot on subscribe', type: 'cache', description: '' }],
      details: 'Không phải Redis — là in-process memory của ws-v2. Dùng cho returnSnapshot=true.',
    },
    {
      id: 'sc-publish',
      kind: 'ws',
      layer: 'SocketCluster',
      title: 'SocketCluster publish(channel, payload)',
      subtitle: 'Fan-out to subscribers',
      position: { x: COL * 4, y: ROW * 2.5 },
      inputs: [{ name: 'channel + compact payload', type: 'broker call', description: '' }],
      outputs: [{ name: 'message tới các subscriber', type: 'WS frame', description: '' }],
      details: '',
    },
    {
      id: 'subscribe',
      kind: 'logic',
      layer: 'SocketCluster',
      title: 'channelSubscribeHandler()',
      subtitle: 'On subscribe',
      position: { x: COL * 5, y: ROW * 0.5 },
      inputs: [
        { name: 'subscribe(channel, {returnSnapShot})', type: 'WS', description: 'từ client' },
      ],
      outputs: [
        { name: 'checkingReturnSnapShotInfo(req)', type: 'call', description: 'Lookup cache' },
        { name: 'reply snapshot trước khi attach stream', type: 'WS', description: '' },
      ],
      details: 'Nếu req.data.returnSnapShot===true → trả snapshot từ cache ngay lúc subscribe.',
    },
    {
      id: 'client',
      kind: 'client',
      layer: 'Client',
      title: 'Mobile / Web subscriber',
      subtitle: 'TradeX client',
      position: { x: COL * 6, y: ROW * 2 },
      inputs: [
        { name: 'subscribe market.quote.{code} ...', type: 'WS', description: '' },
        { name: 'snapshot + stream', type: 'WS', description: '' },
      ],
      outputs: [{ name: 'render realtime UI', type: 'UI', description: '' }],
      details: '',
    },
  ],
  edges: [
    { source: 'kafka', target: 'market-js', label: 'consume', animated: true },
    { source: 'market-js', target: 'topic-map', label: 'route' },
    { source: 'topic-map', target: 'parser', label: 'compact' },
    { source: 'parser', target: 'cache', label: 'setToCache*' },
    { source: 'parser', target: 'sc-publish', label: 'publish payload', animated: true },
    { source: 'sc-publish', target: 'client', label: 'fan-out', animated: true },
    { source: 'client', target: 'subscribe', label: 'subscribe + snapshot?' },
    { source: 'cache', target: 'subscribe', label: 'lookup snapshot' },
    { source: 'subscribe', target: 'client', label: 'snapshot reply' },
  ],
};

// ─────────────────────────────────────────────────────────────────────────
// Export
// ─────────────────────────────────────────────────────────────────────────
import { lifecycles } from './lifecycles.js';

const businessFlows = [
  overview,
  initJobFlow,
  quoteFlow,
  bidOfferFlow,
  indexStatusFlow,
  extraUpdateFlow,
  resetFlow,
  persistFlow,
  queryApiFlow,
  wsFlow,
].map((f) => ({ ...f, category: 'business' }));

export const flows = [...businessFlows, ...lifecycles];

export const flowCategories = [
  {
    id: 'business',
    label: 'Business Flow',
    description: 'Góc nhìn theo luồng nghiệp vụ / topic / service',
    flows: businessFlows,
  },
  {
    id: 'lifecycle',
    label: 'Data Flow',
    description: 'Góc nhìn theo vòng đời từng object',
    flows: lifecycles,
  },
];
