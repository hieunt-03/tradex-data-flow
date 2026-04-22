// ============================================================================
// TradeX Market Data — Flow Definitions (rebuilt from context/06)
// ============================================================================
// Each flow contains:
//   - meta: id, title, subtitle, accent
//   - nodes[]: { id, kind, layer, title, subtitle, inputs[], outputs[],
//               position: {x,y}, details }
//   - edges[]: { source, target, label?, animated? }
//
// kind controls visual styling:
//   source   – external WS / API source (Lotte)
//   service  – Java/Node service (collector, realtime-v2, query-v2, ws-v2)
//   logic    – processing step / business logic inside a service
//   kafka    – Kafka topic
//   redis    – Redis hot state key
//   mongo    – MongoDB collection
//   api      – REST / RPC endpoint
//   ws       – Gateway / SocketCluster channel
//   client   – mobile / web client
//   schedule – cron job trigger
//   config   – feature flag / runtime config
// ============================================================================

// Node width = 320px, height ≈ 140-170px depending on content
// To keep generous gaps between nodes:
//   - COL = 480 → horizontal gap ≈ 160px
//   - ROW = 280 → vertical gap ≈ 110-140px (even with 0.7 vertical fanout multiplier)
const COL = 480;
const ROW = 280;

// ─────────────────────────────────────────────────────────────────────────
// 0. OVERVIEW
// ─────────────────────────────────────────────────────────────────────────
const overview = {
  id: 'overview',
  title: 'OVERVIEW — Market Data runtime at a glance',
  subtitle:
    'Init from REST · Ingest realtime from WebSocket · Merge state in Redis · Selective snapshot to Mongo · Redis-first query · Realtime broadcast via ws-v2',
  accent: '#60a5fa',
  nodes: [
    {
      id: 'lotte-rest',
      kind: 'source',
      layer: 'Data source',
      title: 'Lotte REST API',
      subtitle: 'tsol/apikey/tuxsvc/market/*',
      position: { x: 0, y: 0 },
      inputs: [{ name: 'HTTP GET', type: 'REST', description: 'Init job + recover' }],
      outputs: [
        { name: 'securities-name / securities-price', type: 'JSON paged', description: 'Symbol list & prices' },
        { name: 'best-bid-offer', type: 'JSON', description: 'Start-of-day order book snapshot' },
        { name: 'indexs-list / index-daily / DR APIs', type: 'JSON', description: 'Index + futures metadata' },
      ],
      details:
        'Source for the INIT JOB that runs at start of day (downloadSymbol) to build the baseline market state. ' +
        'Paginated via nextKey, batch ≤20 symbols/request for securities-price, 1 symbol/request for best-bid-offer.',
    },
    {
      id: 'lotte-ws',
      kind: 'source',
      layer: 'Data source',
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
        'Active runtime ingest path (deploy scripts set accounts:[], websocketConnections only). ' +
        'Some UAT nodes also carry dr.qt and dr.bo for futures.',
    },
    {
      id: 'collector',
      kind: 'service',
      layer: 'Collector layer',
      title: 'market-collector-lotte',
      subtitle: 'Java / Spring Boot',
      position: { x: COL, y: ROW },
      inputs: [
        { name: 'WsConnection.handleMessage()', type: 'raw text', description: 'parts[] from Lotte WS' },
        { name: 'LotteApiSymbolInfoService', type: 'REST', description: 'Init/recover via REST' },
      ],
      outputs: [
        { name: 'quoteUpdate', type: 'Kafka', description: 'Equity / Index / CW / ETF quote (underlying)' },
        { name: 'quoteUpdateDR', type: 'Kafka', description: 'DR / Futures quote (derivatives)' },
        { name: 'quoteOddLotUpdate', type: 'Kafka', description: 'Odd lot (separate topic)' },
        { name: 'bidOfferUpdate', type: 'Kafka', description: 'Order book Equity / CW / ETF' },
        { name: 'bidOfferUpdateDR', type: 'Kafka', description: 'Order book DR / Futures' },
        { name: 'bidOfferOddLotUpdate', type: 'Kafka', description: 'Odd lot (separate topic)' },
        { name: 'extraUpdate / calExtraUpdate', type: 'Kafka', description: 'Basis / breakEven / pt' },
        { name: 'marketStatus', type: 'Kafka', description: 'ATO/LO/INTERMISSION/ATC/PLO/CLOSED' },
        { name: 'dealNoticeUpdate / advertisedUpdate', type: 'Kafka', description: 'Put-through' },
        { name: 'statisticUpdate', type: 'Kafka', description: '' },
        { name: 'symbolInfoUpdate', type: 'Kafka', description: 'Distributed init batch' },
      ],
      details:
        'StartupService.run() → RealTimeService.run() → start() → forEach websocketConnections → WsConnection.start(). ' +
        'Convert raw text into QuoteUpdate / BidOfferUpdate / MarketStatusData then RequestSender.sendMessageSafe → Kafka.',
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
        { name: 'producer: realtime-v2', type: 'Kafka', description: 'calExtraUpdate when high/low year changes' },
      ],
      outputs: [
        { name: 'realtime-v2 consumers', type: 'Kafka', description: 'QuoteUpdate / BidOffer / Extra / MarketStatus / SymbolInfoUpdate' },
        { name: 'ws-v2 consumers', type: 'Kafka', description: 'Direct fan-out to clients' },
      ],
      details:
        'Topics: quoteUpdate, quoteUpdateDR, quoteOddLotUpdate, ' +
        'bidOfferUpdate, bidOfferUpdateDR, bidOfferOddLotUpdate, ' +
        'extraUpdate, calExtraUpdate, marketStatus, symbolInfoUpdate, ' +
        'dealNoticeUpdate, advertisedUpdate, statisticUpdate.\n\n' +
        'Odd-lot stream always goes through its own topic — NEVER mixed with the main session.',
    },
    {
      id: 'realtime',
      kind: 'service',
      layer: 'Realtime processing',
      title: 'realtime-v2',
      subtitle: 'Java / Spring Boot',
      position: { x: COL * 3, y: 0 },
      inputs: [{ name: 'Kafka market topics', type: 'Kafka', description: 'All market events' }],
      outputs: [
        { name: 'Redis hot state', type: 'Redis HSET/RPUSH', description: 'mapSymbolInfo / Daily / Quote / Statistic' },
        { name: 'Mongo snapshot', type: 'MongoDB bulk', description: 'saveRedisToDatabase 6 times/day' },
        { name: 'calExtraUpdate', type: 'Kafka', description: 'When high/low year changes' },
      ],
      details:
        'Merges realtime state, builds minute bars, statistics, market status. ' +
        'Current runtime flags: enableSaveQuote=false, enableSaveQuoteMinute=false, enableSaveBidAsk=false → no per-event persistence of tick/minute/bid-offer.',
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
        { name: 'listDealNotice_{market} / listAdvertised_{market}', type: 'List', description: 'Put-through history per exchange' },
        { name: 'symbolInfoExtend', type: 'Hash', description: 'Auxiliary metadata (right info, etc.)' },
        { name: 'market_rise_false_stock_ranking_{market}_{ranking}_{period}', type: 'String', description: 'Pre-computed ranking snapshot' },
        { name: 'market_right_info_{code}', type: 'String', description: 'Issue rights / dividends' },
        { name: 'notice_{type}', type: 'Hash', description: 'Notification by type' },
      ],
      details:
        'PRIMARY store for intraday. Reset by crons removeAutoData (00:55), refreshSymbolInfo (01:35), clearOldSymbolDaily (22:50).\n\n' +
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
      outputs: [{ name: 'Fallback for query-v2', type: 'find()', description: 'When Redis misses (very rare)' }],
      details:
        'Active collections: c_symbol_info, c_symbol_daily, c_foreigner_daily, c_market_session_status, c_deal_notice, c_advertise, c_symbol_previous. ' +
        'NOT written: c_symbol_quote, c_symbol_quote_minute, c_bid_offer (flags off).',
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
        { name: 'Mongo fallback', type: 'find()', description: 'Historical or when Redis lacks data' },
      ],
      outputs: [{ name: 'JSON response', type: 'HTTP 200', description: 'Board, tick, minute, statistic, session' }],
      details:
        'Redis-first for intraday. Endpoints: querySymbolLatest, priceBoard, querySymbolQuote, querySymbolQuoteTick, querySymbolQuoteMinutes, queryMinuteChartBySymbol, querySymbolStatistics, MarketSessionStatusService.',
    },
    {
      id: 'wsv2',
      kind: 'ws',
      layer: 'Realtime delivery',
      title: 'ws-v2 (SocketCluster)',
      subtitle: 'Node.js gateway',
      position: { x: COL * 5, y: ROW * 3 },
      inputs: [{ name: 'Kafka market topics', type: 'consume', description: 'Direct, bypassing Mongo' }],
      outputs: [{ name: 'SocketCluster publish', type: 'channel', description: 'market.quote.{code}, market.bidoffer.{code}, market.status, ...' }],
      details:
        'market.js processDataPublishV2() → mapTopicToPublishV2 → parser.js compact payload → cache → publish. ' +
        'Snapshot on subscribe when req.data.returnSnapShot=true.',
    },
    {
      id: 'client',
      kind: 'client',
      layer: 'Client',
      title: 'Mobile / Web App',
      subtitle: 'TradeX clients',
      position: { x: COL * 6, y: ROW * 2 },
      inputs: [
        { name: 'REST from query-v2', type: 'HTTPS', description: 'Page load + lazy fetch' },
        { name: 'WS from ws-v2', type: 'SocketCluster', description: 'Realtime channels + snapshot' },
      ],
      outputs: [{ name: 'Render board / chart / order book', type: 'UI', description: '' }],
      details: 'Page load: query-v2 for initial snapshot. Subscribe ws-v2 for realtime stream + optional snapshot.',
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
        { name: 'saveRedisToDatabase', type: '0 15,29 10,11,14 * * MON-FRI', description: 'Snapshot Mongo 6 times/day' },
      ],
      details:
        'realtime-v2 lifecycle: 00:55 reset hot state → 01:35 refresh symbol info → 6 snapshots during the day → 22:50 clean daily.',
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
// 1. INIT JOB — downloadSymbol start-of-day baseline
// ─────────────────────────────────────────────────────────────────────────
const initJobFlow = {
  id: 'init-job',
  title: 'INIT JOB — downloadSymbol start-of-day baseline',
  subtitle:
    'Cron / startup → LotteApiSymbolInfoService → REST APIs → merge → 2 init modes (direct or via Kafka symbolInfoUpdate)',
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
        { name: 'Spring cron', type: 'cron', description: 'Start-of-day trigger' },
        { name: 'StartupService.run()', type: 'JVM boot', description: 'RealTimeService → downloadResource()' },
      ],
      outputs: [{ name: 'symbolInfoService.downloadSymbol("JobScheduler")', type: 'call', description: 'Kick off init' }],
      details: 'File: services/market-collector-lotte/.../job/JobService.java and .../services/StartupService.java.',
    },
    {
      id: 'orch',
      kind: 'service',
      layer: 'Collector orchestration',
      title: 'LotteApiSymbolInfoService.downloadSymbol(id)',
      subtitle: 'Build full market universe',
      position: { x: COL, y: ROW * 2.5 },
      inputs: [{ name: 'logical init request', type: 'string id', description: 'Source: cron or startup' }],
      outputs: [{ name: 'orchestration', type: 'calls 5 download steps', description: 'list → idx → info → idxInfo → DR' }],
      details: 'Orchestrates 5 download steps then merges into a complete SymbolInfo, finally picks the init mode based on enableInitMarket.',
    },

    // ─── 5 steps at COL*2 (vertical stack) ─────────────────────────
    {
      id: 'step-list',
      kind: 'logic',
      layer: 'Step 1',
      title: 'downloadSymbolList()',
      subtitle: 'Stock / CW / ETF / bond',
      position: { x: COL * 2, y: 0 },
      inputs: [{ name: 'GET /securities-name', type: 'paginated', description: 'Loop until hasNext=false' }],
      outputs: [{ name: 'Map<String, SymbolNameResponse.Item>', type: 'in-memory', description: 'Aggregated symbol name/type/exchange across all pages' }],
      details: 'Accumulate every page into the Map before moving on to price and bid/ask queries.',
    },
    {
      id: 'step-idx',
      kind: 'logic',
      layer: 'Step 2',
      title: 'downloadIndexList()',
      subtitle: 'Index list',
      position: { x: COL * 2, y: ROW },
      inputs: [{ name: 'GET /indexs-list', type: 'paginated REST', description: 'Load index codes from Lotte' }],
      outputs: [{ name: 'index code map', type: 'in-memory', description: 'For downloadIndexInfo() and runtime 09401→VNSI mapping' }],
      details: 'This step prepares input for downloadIndexInfo() and for handleIndexQuote() at WebSocket runtime.',
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
        { name: 'securities-price batch', type: 'REST', description: 'Price baseline' },
      ],
      outputs: [{ name: 'Map<String, SymbolInfo>', type: 'in-memory', description: 'SymbolInfo for stock/CW/ETF/bond' }],
      details: 'Query batch prices + per-code bid/offer then merge into SymbolInfo.',
    },
    {
      id: 'step-idx-info',
      kind: 'logic',
      layer: 'Step 4',
      title: 'downloadIndexInfo()',
      subtitle: 'Index info',
      position: { x: COL * 2, y: ROW * 4 },
      inputs: [{ name: 'index APIs', type: 'REST', description: 'Per index code (no raw sample log yet)' }],
      outputs: [{ name: 'SymbolInfo(type=INDEX)', type: 'in-memory', description: 'Index info for merge' }],
      details: 'Uses the index code map from step-idx to fetch detailed info per index.',
    },
    {
      id: 'step-dr',
      kind: 'logic',
      layer: 'Step 5',
      title: 'downloadDerivatives()',
      subtitle: 'Futures',
      position: { x: COL * 2, y: ROW * 5 },
      inputs: [{ name: 'DR APIs', type: 'REST', description: 'Derivatives endpoints (no raw sample log yet)' }],
      outputs: [{ name: 'SymbolInfo(type=FUTURES)', type: 'in-memory', description: 'Futures info for merge' }],
      details: 'Fetch futures metadata; VN30F* codes also get a refCode mapping at runtime.',
    },

    // ─── APIs at COL*3 paired with each step ───────────────────────
    {
      id: 'api-name',
      kind: 'api',
      layer: 'Lotte REST API',
      title: 'GET /securities-name',
      subtitle: 'Paginated via nextKey',
      position: { x: COL * 3, y: 0 },
      inputs: [{ name: 'paginated request', type: 'REST', description: 'nextKey, hasNext' }],
      outputs: [{ name: 'list[]', type: 'JSON', description: 'symbol, code, exchange, type, names' }],
      details:
        'Sample log 2026-04-20: page nextKey=1200 contained stock SBV/SC5/SHB/SSB; page nextKey=1900 contained coveredwarrant CMSN2606/CMWG2601/CSHB2505/CSTB2601. ' +
        'Each page can mix multiple types (stock + coveredwarrant).',
    },
    {
      id: 'api-idx-list',
      kind: 'api',
      layer: 'Lotte REST API',
      title: 'GET /indexs-list',
      subtitle: 'Index codes',
      position: { x: COL * 3, y: ROW },
      inputs: [{ name: 'paginated request', type: 'REST', description: 'Paginated like securities-name' }],
      outputs: [{ name: 'list[] index', type: 'JSON', description: 'idxCode → name (e.g. 09401 → VN Sustainability Index → VNSI)' }],
      details: 'Used for the 09401 → VNSI mapping in handleIndexQuote at runtime. No raw sample log in the current bundle.',
    },
    {
      id: 'api-bbo',
      kind: 'api',
      layer: 'Lotte REST API',
      title: 'GET /best-bid-offer',
      subtitle: '1 symbol / request',
      position: { x: COL * 3, y: ROW * 2.1 },
      inputs: [{ name: '{stk_cd: code, bo_cnt: "10"}', type: 'REST', description: 'Per code' }],
      outputs: [
        { name: 'ceiling/floor/refPrice/last', type: 'JSON', description: 'Price band baseline' },
        { name: 'bidOfferList[10]', type: 'JSON', description: 'Order book; typically all zeros at start of day' },
      ],
      details:
        'Sample log SHB: ceiling=16500, floor=14400, refPrice=18100, last=18100, matchedVol=0, bidOfferList all {bid:0, bidSize:0, offer:0, offerSize:0}. ' +
        'Sample CW CSHB2505 is similar. Rows with all-zero bid/offer are filtered out during merge → SymbolInfo.bidOfferList can be empty.',
    },
    {
      id: 'api-price',
      kind: 'api',
      layer: 'Lotte REST API',
      title: 'GET /securities-price',
      subtitle: 'Batch ≤20 symbols',
      position: { x: COL * 3, y: ROW * 2.9 },
      inputs: [{ name: 'list code (batch ≤20)', type: 'REST', description: 'After symbol list is available' }],
      outputs: [{ name: 'SymbolPriceResponse', type: 'JSON batch', description: 'Price + foreigner + listedQty + ...' }],
      details: 'No raw sample log in the current bundle yet, but the code path is confirmed.',
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
        { name: 'symbolPrice', type: 'object', description: 'OHLC + foreigner + price band' },
        { name: 'bidAskResponse', type: 'object', description: 'Order book' },
      ],
      outputs: [{ name: 'Complete SymbolInfo', type: 'object', description: 'allSymbols list' }],
      details:
        'Map each group: price (open/high/low/last/change/rate/tradingVolume/Value), time (time/highTime/lowTime), band (ceiling/floor/refPrice), ' +
        'intraday (averagePrice/turnoverRate/matchingVolume/bidOfferList/totalBid+OfferVolume/expectedPrice), ' +
        'foreigner (buy/sell/totalRoom/currentRoom), metadata (code/name/type/exchange/marketType/listedQuantity/controlCode/underlyingSymbol/highLowYearData).',
    },
    {
      id: 'flag-init',
      kind: 'config',
      layer: 'Feature flag',
      title: 'enableInitMarket',
      subtitle: 'Picks the mode',
      position: { x: COL * 5, y: ROW * 2.5 },
      inputs: [{ name: 'application config', type: 'boolean', description: 'true / false' }],
      outputs: [
        { name: 'true → direct init', type: 'branch', description: 'Write baseline directly' },
        { name: 'false → distributed init', type: 'branch', description: 'Via Kafka to realtime-v2' },
      ],
      details: 'Switch between direct init (write right away) or distributed init (via Kafka for realtime-v2 init).',
    },
    {
      id: 'init-direct',
      kind: 'logic',
      layer: 'Mode A',
      title: 'marketInit.init(allSymbols)',
      subtitle: 'Direct init',
      position: { x: COL * 6, y: ROW * 0.8 },
      inputs: [{ name: 'List<SymbolInfo>', type: 'object', description: 'Full universe' }],
      outputs: [
        { name: 'Redis baseline', type: 'HSET', description: 'realtime_mapSymbolInfo' },
        { name: 'Mongo baseline', type: 'upsert', description: 'c_symbol_info' },
        { name: 'symbol_static_data.json', type: 'file', description: 'uploadMarketDataFile()' },
      ],
      details: 'Runs when enableInitMarket=true. The MarketInit source lives outside this workspace so field-level details are not fully enumerated.',
    },
    {
      id: 'kafka-symbol-info',
      kind: 'kafka',
      layer: 'Mode B',
      title: 'Kafka symbolInfoUpdate',
      subtitle: 'Distributed init',
      position: { x: COL * 6, y: ROW * 4.2 },
      inputs: [{ name: 'sendSymbolInfoUpdate(groupId, allSymbols)', type: 'producer', description: 'Split / group messages' }],
      outputs: [{ name: 'realtime-v2 InitService consume', type: 'Kafka', description: 'Buffer per groupId' }],
      details: 'Runs when enableInitMarket=false. Messages are grouped by groupId so realtime-v2 can batch init.',
    },
    {
      id: 'init-service',
      kind: 'service',
      layer: 'Realtime init',
      title: 'realtime-v2 InitService',
      subtitle: 'Buffer + apply',
      position: { x: COL * 7, y: ROW * 4.2 },
      inputs: [{ name: 'SymbolInfoUpdate messages', type: 'Kafka', description: 'Grouped by groupId' }],
      outputs: [
        { name: 'monitorService.pauseAll()', type: 'control', description: 'Pause consumer threads' },
        { name: 'cacheService clean', type: 'control', description: 'Clean cache per command' },
        { name: 'symbolInfoService.updateBySymbolInfoUpdate()', type: 'apply', description: 'Apply batch update' },
        { name: 'marketInit.init(cache.values())', type: 'apply', description: 'Re-init from cache' },
        { name: 'cacheService.reset() + resume', type: 'control', description: 'Resume threads' },
      ],
      details:
        'Lifecycle: 1) receive all messages or time out after 60s · 2) pauseAll · 3) clean cache · 4) updateBySymbolInfoUpdate · 5) marketInit.init · 6) cacheService.reset() · 7) resume threads.',
    },
    {
      id: 'redis-baseline',
      kind: 'redis',
      layer: 'Output',
      title: 'realtime_mapSymbolInfo',
      subtitle: 'Start-of-day baseline',
      position: { x: COL * 8, y: ROW * 1.5 },
      inputs: [{ name: 'marketInit.init', type: 'HSET', description: 'Direct or via InitService' }],
      outputs: [{ name: 'Ready for QuoteService.updateQuote()', type: 'Hash', description: 'Ticks are only accepted once the baseline exists' }],
      details: 'The baseline must be in place before the first tick arrives, because reCalculate() validates that SymbolInfo exists before accepting a quote.',
    },
    {
      id: 'mongo-baseline',
      kind: 'mongo',
      layer: 'Output',
      title: 'c_symbol_info baseline',
      subtitle: 'Persisted master',
      position: { x: COL * 8, y: ROW * 3.5 },
      inputs: [{ name: 'marketInit.init', type: 'upsert', description: 'Bulk upsert from allSymbols' }],
      outputs: [{ name: 'Daily master data', type: 'collection', description: 'Daily symbol info snapshot' }],
      details: 'Guarantees a symbol info snapshot exists once init completes, independent of the saveRedisToDatabase cron.',
    },
  ],
  edges: [
    { source: 'trigger', target: 'orch', label: 'downloadSymbol(id)' },
    { source: 'orch', target: 'step-list', label: 'step 1' },
    { source: 'orch', target: 'step-idx', label: 'step 2' },
    { source: 'orch', target: 'step-info', label: 'step 3' },
    { source: 'orch', target: 'step-idx-info', label: 'step 4' },
    { source: 'orch', target: 'step-dr', label: 'step 5' },

    // step ↔ API: bidirectional (call + response) for every pair
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
      details: 'Raw time 93020 = HH:mm:ss in Lotte local time (VN timezone).',
    },
    {
      id: 'handle-msg',
      kind: 'logic',
      layer: 'WsConnection',
      title: 'handleMessage(payload)',
      subtitle: 'Dispatch by prefix',
      position: { x: COL, y: ROW * 1.5 },
      inputs: [{ name: 'raw text', type: 'string', description: 'split into parts[]' }],
      outputs: [
        { name: 'handleStockQuote(parts)', type: 'route', description: 'auto.qt.* and auto.idxqt.* after check' },
        { name: 'handleStockBidAsk(parts)', type: 'route', description: 'auto.bo.* (see BidOffer flow)' },
      ],
      details: 'Main dispatcher in WsConnection.',
    },
    {
      id: 'handle-quote',
      kind: 'logic',
      layer: 'WsConnection',
      title: 'handleStockQuote(parts)',
      subtitle: 'Build QuoteUpdate',
      position: { x: COL * 2, y: ROW * 1.5 },
      inputs: [{ name: 'parts[]', type: 'string[]', description: 'split by |' }],
      outputs: [
        {
          name: 'QuoteUpdate',
          type: 'object',
          description:
            'time (parts[2], VN→UTC), code (parts[3]), highTime (parts[4]), lowTime (parts[5]), open (parts[6]), high (parts[8]), low (parts[10]), last (parts[12]), change (parts[14]), rate (parts[16]), turnoverRate (parts[17]), averagePrice (parts[18]), referencePrice (parts[20]), tradingValue (parts[21]), tradingVolume (parts[22]), matchingVolume (parts[23]), matchedBy (parts[24] 83=ASK 66=BID), foreigner Buy/Sell/TotalRoom/CurrentRoom (parts[25..28]), activeSell/BuyVolume (parts[33..34])',
        },
      ],
      details:
        'Time-conversion nuance: time is parsed as VN → converted to UTC before being formatted → "023020". highTime/lowTime are parsed as VN but NOT converted to UTC → "091500"/"091903". ' +
        'So the runtime log mixes two different time representations for the same quote object.',
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
      details: 'WsConnectionThread.run() picks the topic based on the object type.',
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
        { name: 'ws-v2 consumer', type: 'Kafka', description: 'Direct broadcast (see WS flow)' },
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
      inputs: [{ name: 'rcv(symbolQuote)', type: 'enqueue', description: 'Queue per code' }],
      outputs: [{ name: 'handler() → updateQuote()', type: 'dispatch', description: 'By type' }],
      details: 'Ensures per-code ordering so ticks for the same symbol never race each other.',
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
        { name: 'Kafka calExtraUpdate', type: 'producer', description: 'when high/low year changes' },
      ],
      details:
        'Validates that SymbolInfo exists in cache + tradingVolume>=0. If volume is out of order and enableCheckOrderQuote=true → add wrong-order Redis entry (if enabled) and return false.',
    },
    {
      id: 'flag-quote',
      kind: 'config',
      layer: 'Feature flag',
      title: 'enableSaveQuote / Minute / BidAsk',
      subtitle: 'false in current runtime',
      position: { x: COL * 7, y: ROW * 3 },
      inputs: [{ name: 'application config', type: 'boolean', description: '' }],
      outputs: [{ name: 'Tick/minute events NOT persisted to Mongo', type: 'branch', description: '' }],
      details: 'Consequence: no event path writes to c_symbol_quote / c_symbol_quote_minute / c_bid_offer.',
    },
    {
      id: 'redis-stat',
      kind: 'redis',
      layer: 'Redis writes',
      title: 'realtime_mapSymbolStatistic[code]',
      subtitle: 'Hash',
      position: { x: COL * 8, y: 0 },
      inputs: [{ name: 'matched buy/sell/unknown', type: 'compute', description: 'by matchedBy (ASK/BID/UNKNOWN)' }],
      outputs: [{ name: 'latest statistic', type: 'Hash', description: 'Aggregated per price level' }],
      details:
        'Only applied when type != INDEX.\n\n' +
        '─── SHB runtime sample ───\n' +
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
      inputs: [{ name: 'merge quote into SymbolInfo', type: 'merge', description: 'Merge fields from SymbolQuote into the existing SymbolInfo' }],
      outputs: [{ name: 'latest snapshot', type: 'Hash', description: 'Single source of truth for priceBoard / querySymbolLatest' }],
      details:
        'Each hash entry is a complete SymbolInfo: metadata + OHLC + band + bidOfferList + foreigner + session + ...\n\n' +
        '─── SHB runtime sample ───\n' +
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
      inputs: [{ name: 'merge foreigner data', type: 'merge', description: 'From foreignerBuy/Sell/TotalRoom/CurrentRoom on the quote' }],
      outputs: [{ name: 'foreigner daily', type: 'Hash', description: 'Foreigner room + hold/buyable ratios per day' }],
      details:
        '─── SHB runtime sample ───\n' +
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
        'When the snapshot cron runs (saveRedisToDatabase), id is set = code + "_" + yyyyMMdd (today) before bulk-writing to Mongo c_foreigner_daily.',
    },
    {
      id: 'redis-daily',
      kind: 'redis',
      layer: 'Redis writes',
      title: 'realtime_mapSymbolDaily[code]',
      subtitle: 'Hash',
      position: { x: COL * 8, y: ROW * 2.1 },
      inputs: [{ name: 'upsertSymbolDaily(quote, info)', type: 'compute', description: 'Build the daily bar from the current tick' }],
      outputs: [{ name: 'daily OHLCV', type: 'Hash', description: 'Daily OHLC + volume/value — consumed by querySymbolDaily' }],
      details:
        '─── SHB runtime sample ───\n' +
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
      inputs: [{ name: 'minute bar create/update', type: 'compute', description: 'new minute → create bar · same minute → update' }],
      outputs: [{ name: 'SymbolQuoteMinute[]', type: 'List', description: 'Each element is one minute bar + periodTradingVolume' }],
      details:
        '─── Sample of one element from the SHB list ───\n' +
        '{\n' +
        '  "code":"SHB","time":"074500","milliseconds":27900000,\n' +
        '  "open":15300.0,"high":15300.0,"low":15300.0,"last":15300.0,\n' +
        '  "tradingVolume":47390400,\n' +
        '  "tradingValue":7.2155262E11,\n' +
        '  "periodTradingVolume":8363800,\n' +
        '  "date":1776671100000\n' +
        '}\n\n' +
        'periodTradingVolume = trading volume within this minute only (delta vs the previous minute).',
    },
    {
      id: 'redis-tick',
      kind: 'redis',
      layer: 'Redis writes',
      title: 'realtime_listQuote_{code}',
      subtitle: 'List append',
      position: { x: COL * 8, y: ROW * 3.5 },
      inputs: [{ name: 'append tick', type: 'RPUSH', description: 'After reCalculate() succeeds' }],
      outputs: [{ name: 'SymbolQuote[]', type: 'List', description: 'Full tick history — consumed by querySymbolQuote / Tick' }],
      details:
        '─── SHB sample tick ───\n' +
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
        'Enriched fields (holdVolume/holdRatio/buyAbleRatio/foreignerMatch*) are computed by QuoteService.reCalculate() before the append.',
    },
    {
      id: 'redis-meta',
      kind: 'redis',
      layer: 'Redis writes',
      title: 'realtime_listQuoteMeta_{code}',
      subtitle: 'String/encoded',
      position: { x: COL * 8, y: ROW * 4.2 },
      inputs: [{ name: 'partition meta', type: 'encode', description: 'Updated when appending a tick' }],
      outputs: [
        {
          name: 'List<QuotePartition>',
          type: 'encoded',
          description: 'partition|fromVolume|toVolume|totalItems · partition=-1 default',
        },
      ],
      details:
        'market-query-v2 uses this metadata to page ticks by lastTradingVolume or lastIndex.\n\n' +
        'Format of each partition: partition|fromVolume|toVolume|totalItems\n' +
        'Example: "-1|0|50000000|8928" — default partition, volume range 0 → 50M, total 8928 ticks.',
    },

    // ─── Odd-lot Quote branch (SEPARATE topic quoteOddLotUpdate) ──────
    {
      id: 'ws-qt-odd',
      kind: 'source',
      layer: 'Lotte WS',
      title: 'auto.qt.oddlot.<code>',
      subtitle: 'Odd-lot quote',
      position: { x: 0, y: ROW * 5.5 },
      inputs: [{ name: 'separate odd-lot channel from Lotte', type: 'WS', description: '' }],
      outputs: [{ name: 'raw odd-lot quote line', type: 'string', description: '' }],
      details: '',
    },
    {
      id: 'parse-qt-odd',
      kind: 'logic',
      layer: 'Collector · Parse',
      title: 'SymbolQuoteOddLot.parse(item)',
      subtitle: 'Dedicated parse branch',
      position: { x: COL * 2, y: ROW * 5.5 },
      inputs: [{ name: 'odd-lot quote item', type: 'object', description: '' }],
      outputs: [
        {
          name: 'SymbolQuoteOddLot',
          type: 'object',
          description: 'OHLC + tradingVolume/Value + foreigner summary for odd lots',
        },
      ],
      details: '',
    },
    {
      id: 'kafka-qt-odd',
      kind: 'kafka',
      layer: 'Kafka',
      title: 'topic quoteOddLotUpdate',
      subtitle: 'SEPARATE (not quoteUpdate)',
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
      subtitle: 'Dedicated handler',
      position: { x: COL * 5, y: ROW * 5.5 },
      inputs: [{ name: 'Message<SymbolQuoteOddLot>', type: 'Kafka payload', description: '' }],
      outputs: [{ name: 'monitorService.rcv(SymbolQuoteOddLot)', type: 'call', description: '' }],
      details: '',
    },
    {
      id: 'qs-update-odd',
      kind: 'logic',
      layer: 'realtime-v2',
      title: 'QuoteService.updateQuote() — OddLot branch',
      subtitle: 'instanceof SymbolQuoteOddLot',
      position: { x: COL * 6, y: ROW * 5.5 },
      inputs: [
        { name: 'SymbolQuoteOddLot', type: 'object', description: '' },
        { name: 'cacheService.getMapSymbolInfoOddLot()[code]', type: 'SymbolInfo|null', description: '' },
      ],
      outputs: [
        { name: 'merge into SymbolInfoOddLot', type: 'merge', description: 'Does NOT touch the main SymbolInfo' },
        { name: 'setSymbolInfoOddLot() → HSET realtime_mapSymbolInfoOddLot[code]', type: 'Redis', description: '' },
      ],
      details:
        'Same QuoteService but re-routed to the odd-lot cache; does NOT write tick/minute/stat/daily/foreigner.\n' +
        'updatedBy = "SymbolQuoteOddLot" on the hash.',
    },
    {
      id: 'redis-info-odd',
      kind: 'redis',
      layer: 'Redis writes',
      title: 'realtime_mapSymbolInfoOddLot[code]',
      subtitle: 'Shared with BidOfferOddLot',
      position: { x: COL * 8, y: ROW * 5.5 },
      inputs: [{ name: 'QuoteOddLot + BidOfferOddLot merge', type: 'HSET', description: 'updatedBy = "SymbolQuoteOddLot" or "BidOfferOddLot"' }],
      outputs: [{ name: 'querySymbolLatestOddLot', type: 'Hash', description: '' }],
      details: 'This hash key is shared with the BidOfferOddLot branch (see BidOffer flow).',
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
    { source: 'monitor', target: 'qs-update-odd', label: 'odd-lot branch' },
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
    '3 branches: Stock BO (BidOfferData) · Futures BO (FuturesBidOfferData, price=double) · Odd-lot BO (separate topic). Collector computes expectedChange/Rate before publishing.',
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
      inputs: [{ name: 'subscribe sub/pro.pub.auto.bo./...', type: 'WS', description: 'Stocks on HOSE/HNX/UPCOM + CW + ETF' }],
      outputs: [
        {
          name: 'raw line',
          type: 'string',
          description:
            'auto.bo.BCM|1|93020|BCM|O|55800.0|2|55700.0|3|2800|55800.0|2|1800|55700.0|3|2800|...|14900|12500|...',
        },
      ],
      details: 'parts[4]=controlCode, parts[5]=expectedPrice (ATO/ATC), parts[13..]=3 price levels of bid/offer.',
    },
    {
      id: 'parse-bo',
      kind: 'logic',
      layer: 'Collector · Parse',
      title: 'BidOfferData.parse(item)',
      subtitle: 'handleStockBidAsk(parts)',
      position: { x: COL, y: 0 },
      inputs: [{ name: 'BidOfferAutoItem', type: 'object', description: 'Raw struct from Lotte WS' }],
      outputs: [
        {
          name: 'BidOfferData',
          type: 'object',
          description:
            'code, time(HHmmss), bidPrice/offerPrice(int), bidVolume/offerVolume, bidOfferList (3 PriceItem), totalBid/OfferVolume, totalBid/OfferCount, diffBidOffer, expectedPrice (null when not ATO/ATC), session',
        },
      ],
      details:
        'session = sessionControlMap.get(controlCode):\n' +
        '  P → ATO · A → ATC · O → CONTINUOUS · I → INTERMISSION · C → PLO · K/G → CLOSED\n\n' +
        '⚠ Naming alias across services:\n' +
        '  • Collector / BidOfferData.session = "CONTINUOUS"\n' +
        '  • MarketStatus hash (realtime_mapMarketStatus).status = "LO" (legacy)\n' +
        '  • Client-facing payload (ws-v2 parser) = keeps the upstream field as-is\n' +
        '"CONTINUOUS" ≡ "LO" ≡ continuous-matching trading hours.\n\n' +
        'expectedPrice = round1Decimal(projectOpen) when session=ATO/ATC AND projectOpen>0, otherwise null.\n' +
        'PriceItem: bidPrice, offerPrice, bidVolume, offerVolume, bidVolumeChange, offerVolumeChange.',
    },
    {
      id: 'handle-auto-bo',
      kind: 'logic',
      layer: 'Collector · handleAutoData',
      title: 'handleAutoData(BidOfferData)',
      subtitle: 'Compute expectedChange / expectedRate',
      position: { x: COL * 2, y: 0 },
      inputs: [
        { name: 'BidOfferData', type: 'object', description: 'Has expectedPrice' },
        { name: 'cacheService.getMapSymbolInfo()[code].referencePrice', type: 'Double', description: 'Reference price from the SymbolInfo cache' },
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
        'Computed only when expectedPrice != null (during ATO/ATC) and referencePrice > 0.\n' +
        'After enrichment → kafkaPublishRealtime("bidOfferUpdate", bidOfferData).',
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
          description: 'Same format as stock but prices are decimal (e.g. 1285.70).',
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
            'Same shape as BidOfferData but bidPrice/offerPrice = double (round2DecimalFloatToDouble). PriceItem also uses double.',
        },
      ],
      details:
        'Shares sessionControlMap. Same expectedPrice logic but rounded to 2 decimals.\n' +
        'One key difference from stock: every price field is double.',
    },
    {
      id: 'handle-auto-bo-dr',
      kind: 'logic',
      layer: 'Collector · handleAutoData',
      title: 'handleAutoData(FuturesBidOfferData)',
      subtitle: 'Same logic as stock',
      position: { x: COL * 2, y: ROW },
      inputs: [
        { name: 'FuturesBidOfferData', type: 'object', description: '' },
        { name: 'futures referencePrice', type: 'double', description: 'From SymbolInfo cache (futures)' },
      ],
      outputs: [
        { name: 'FuturesBidOfferData enriched', type: 'object', description: 'expectedChange/Rate rounded to 2 decimals' },
      ],
      details: 'Publishes to the same topic: kafkaPublishRealtime("bidOfferUpdate", data) — there is no dedicated topic for futures.',
    },

    // ─── Row 2: Odd-lot BidOffer ──────────────────────────────────────
    {
      id: 'ws-bo-odd',
      kind: 'source',
      layer: 'Lotte WS',
      title: 'auto.bo.oddlot.<code>',
      subtitle: 'Odd-lot BidOffer',
      position: { x: 0, y: ROW * 2.3 },
      inputs: [{ name: 'separate odd-lot channel from Lotte', type: 'WS', description: '' }],
      outputs: [{ name: 'raw odd-lot line', type: 'string', description: '' }],
      details: 'In the current runtime odd-lot is always enabled (unlike the main session, where history can be turned off).',
    },
    {
      id: 'parse-bo-odd',
      kind: 'logic',
      layer: 'Collector · Parse',
      title: 'BidOfferOddLotData.parse(item)',
      subtitle: 'Dedicated TransformData branch',
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
      subtitle: 'SEPARATE topic (not bidOfferUpdate)',
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
      subtitle: 'Stock + Futures share this topic',
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
      subtitle: 'SEPARATE odd-lot topic',
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
      subtitle: 'Dedicated odd-lot handler',
      position: { x: COL * 4, y: ROW * 2.3 },
      inputs: [{ name: 'Message<BidOfferOddLot>', type: 'Kafka payload', description: '' }],
      outputs: [{ name: 'monitorService.rcv(bidOfferOddLot)', type: 'call', description: '' }],
      details: 'Does not share the handler with the main bidOfferUpdate.',
    },
    {
      id: 'monitor',
      kind: 'logic',
      layer: 'realtime-v2',
      title: 'MonitorService.handler()',
      subtitle: 'Dispatch by instanceof',
      position: { x: COL * 5, y: ROW * 1.4 },
      inputs: [
        { name: 'BidOffer', type: 'object', description: 'from handler-bo' },
        { name: 'BidOfferOddLot', type: 'object', description: 'from handler-bo-odd' },
      ],
      outputs: [
        { name: 'BidOfferService.updateBidOffer(bidOffer)', type: 'call', description: 'main branch' },
        { name: 'BidOfferService.updateBidOfferOddLot(bidOfferOddLot)', type: 'call', description: 'odd-lot branch' },
      ],
      details: 'Same MonitorService but two separate methods → state is not shared.',
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
        { name: 'bidAskSequence++ on SymbolInfo', type: 'counter', description: '' },
        { name: 'id = code + "_" + datetime + "_" + sequence', type: 'string', description: '' },
      ],
      details:
        'The merge branch only runs when enableAutoData=true.\n' +
        'When enableSaveBidOffer=true → marketRedisDao.addBidOffer() (RUNTIME=false → skip).\n' +
        'Mongo c_bid_offer is always off (enableSaveBidAsk=false).',
    },
    {
      id: 'bs-update-odd',
      kind: 'logic',
      layer: 'realtime-v2 · BidOfferService',
      title: 'updateBidOfferOddLot()',
      subtitle: 'Dedicated method — always writes both keys',
      position: { x: COL * 6, y: ROW * 2.3 },
      inputs: [
        { name: 'BidOfferOddLot', type: 'object', description: '' },
        { name: 'cacheService.getMapSymbolInfoOddLot()[code]', type: 'SymbolInfo|null', description: 'Creates a new one if null (sequence=1)' },
      ],
      outputs: [
        { name: 'ConvertUtils.updateByBidOfferOddLot(symbolInfo, bidOfferOddLot)', type: 'merge', description: '' },
        { name: 'setSymbolInfoOddLot() → HSET realtime_mapSymbolInfoOddLot[code]', type: 'Redis', description: '' },
        { name: 'sequence = symbolInfo.bidAskSequence + 1', type: 'counter', description: '' },
        { name: 'id = code + "_" + datetime + "_" + sequence', type: 'string', description: '' },
        { name: 'addBidOfferOddLot() → RPUSH realtime_listBidOfferOddLot_{code}', type: 'Redis', description: 'Independent of save flags' },
      ],
      details: 'Does not check enableSaveBidOffer — odd-lot history is always kept in Redis.',
    },

    // ─── Column 7: Redis output ───────────────────────────────────────
    {
      id: 'flag-save',
      kind: 'config',
      layer: 'Feature flag',
      title: 'enableSaveBidOffer / enableSaveBidAsk',
      subtitle: 'false at runtime',
      position: { x: COL * 6, y: ROW * 3.6 },
      inputs: [{ name: 'application config', type: 'boolean', description: '' }],
      outputs: [
        { name: 'Skip realtime_listBidOffer_{code}', type: 'branch', description: '' },
        { name: 'Skip Mongo c_bid_offer', type: 'branch', description: '' },
      ],
      details: 'Applies ONLY to the main session. Odd-lot is unaffected.',
    },
    {
      id: 'redis-info',
      kind: 'redis',
      layer: 'Redis output',
      title: 'realtime_mapSymbolInfo[code]',
      subtitle: 'Main top book',
      position: { x: COL * 7, y: 0 },
      inputs: [{ name: 'BidOfferService merge', type: 'HSET', description: '' }],
      outputs: [{ name: 'query-v2 reads latest book via HGET', type: 'Hash', description: 'Fields: bidPrice/offerPrice/volume/session/expectedPrice+Change+Rate/totalBid+Offer' }],
      details: 'The ONLY place the current runtime keeps main-session bid/offer (no history list).',
    },
    {
      id: 'redis-list-skip',
      kind: 'redis',
      layer: 'Inactive',
      title: 'realtime_listBidOffer_{code}',
      subtitle: 'Code path exists, disabled at runtime',
      position: { x: COL * 7, y: ROW },
      inputs: [{ name: 'enableSaveBidOffer=false', type: 'flag', description: '' }],
      outputs: [{ name: 'not written', type: 'skip', description: '' }],
      details: '',
    },
    {
      id: 'redis-info-odd',
      kind: 'redis',
      layer: 'Redis output',
      title: 'realtime_mapSymbolInfoOddLot[code]',
      subtitle: 'Odd-lot top book',
      position: { x: COL * 7, y: ROW * 1.9 },
      inputs: [{ name: 'updateBidOfferOddLot merge', type: 'HSET', description: '' }],
      outputs: [{ name: 'query-v2: querySymbolLatestOddLot (HMGET)', type: 'Hash', description: '' }],
      details:
        '─── SHB sample ───\n' +
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
        'Unlike the main session (which only keeps the top book), odd-lot KEEPS the full history in Redis.\n\n' +
        '─── DGC sample element ───\n' +
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
      subtitle: 'Not persisted',
      position: { x: COL * 7, y: ROW * 3.7 },
      inputs: [{ name: 'enableSaveBidAsk=false', type: 'flag', description: '' }],
      outputs: [{ name: 'no Mongo bid/offer history', type: 'skip', description: '' }],
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
    'Index quote (no statistic) + session/market status events propagated to SymbolInfo of the same market on ATO/ATC',
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
            'code mapped via the indexList API (09401 → VNSI), plus ceilingCount, upCount, unchangedCount, downCount, floorCount',
        },
      ],
      details: 'Requires that indexList has already been initialized (see Init Job flow); otherwise the mapping is incorrect.',
    },
    {
      id: 'sender-idx',
      kind: 'logic',
      layer: 'Producer',
      title: 'sendMessageSafe("quoteUpdate")',
      subtitle: 'Same topic as equity quote',
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
      details: 'Does NOT write realtime_mapSymbolStatistic because type=INDEX.',
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
      details: 'parseStatus(statusMap) maps to the internal session state.',
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
          name: 'Propagate sessions=status to every SymbolInfo in the same market',
          type: 'broadcast',
          description: 'Only when status is ATO or ATC',
        },
        { name: 'HSET realtime_mapSymbolInfo[*]', type: 'Redis', description: 'after propagation' },
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
      inputs: [{ name: 'MarketStatusService', type: 'HSET', description: 'Written whenever a news/session change is received' }],
      outputs: [{ name: 'query-v2 + ws-v2', type: 'Hash', description: 'Read by MarketService.getCurrentStatus()' }],
      details:
        '─── HOSE_EQUITY runtime sample ───\n' +
        '{\n' +
        '  "id":"HOSE_EQUITY","market":"HOSE","type":"EQUITY",\n' +
        '  "status":"LO",\n' +
        '  "date":1745892901611,"time":"021501",\n' +
        '  "title":"(HOSE) Market Open"\n' +
        '}\n\n' +
        'Typical status lifecycle during one HOSE EQUITY session:\n' +
        'PRE_OPEN → ATO → LO (morning) → INTERMISSION → LO (afternoon) → ATC → PLO → CLOSED.\n' +
        'Each transition emits a news item → updates the matching hash key + publishes via ws-v2.\n\n' +
        '⚠ Alias: status="LO" in this hash is EQUIVALENT to session="CONTINUOUS" in BidOfferData/SymbolInfo. ' +
        'The client must normalize these when rendering the priceBoard so the session state is shown consistently.',
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
  title: 'EXTRA / DEAL / ADVERTISED — 4 trigger sources for ExtraUpdate',
  subtitle:
    'ExtraUpdate = intermediate object for basis/breakEven/pt · 4 emitters (VN30 · Futures · CW · DealNotice) + a calExtraUpdate branch from realtime-v2 when high/low year changes',
  accent: '#f472b6',
  nodes: [
    // ─── 4 sources of ExtraUpdate from the collector ────────────────
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
          description: 'For each VN30F*: basis = futuresLast − vn30Last',
        },
      ],
      details: 'When a VN30 tick arrives, the collector iterates the VN30F* futures symbols and emits an ExtraUpdate for each.',
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
        { name: 'ExtraUpdate', type: 'object', description: 'basis = futuresLast − vn30Last (vn30Last read from cache)' },
      ],
      details: 'Reverse of Source 1 — when a futures tick arrives, recompute basis for that symbol.',
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
      details: 'Applies only to covered warrants (CW). Formula lives in ConvertUtils / formula layer.',
    },
    {
      id: 'src-deal',
      kind: 'source',
      layer: 'Collector · Source 4/4',
      title: 'DealNoticeData → ExtraUpdate.fromDealNotice()',
      subtitle: 'Trigger: Deal notice (PT)',
      position: { x: 0, y: ROW * 2.7 },
      inputs: [{ name: 'DealNoticeData', type: 'object', description: 'Every new PT deal' }],
      outputs: [
        {
          name: 'ExtraUpdate',
          type: 'object',
          description: 'ptVolume (cumulative) + ptValue (cumulative)',
        },
      ],
      details: 'At the same time the deal notice is also published to the dedicated dealNoticeUpdate topic (see branch below).',
    },
    {
      id: 'publish-extra',
      kind: 'logic',
      layer: 'Collector · Producer',
      title: 'kafkaPublishRealtime("extraUpdate", extraUpdate)',
      subtitle: '4 sources converge here',
      position: { x: COL * 1.3, y: ROW * 1.35 },
      inputs: [
        {
          name: 'ExtraUpdate',
          type: 'object',
          description:
            'Fields: code, basis (Double), ptVolume (long), ptValue (double) — (breakEven is merged into symbolInfo via an extend field).',
        },
      ],
      outputs: [{ name: 'Kafka record topic extraUpdate', type: 'Kafka', description: '' }],
      details: '',
    },

    // ─── calExtraUpdate branch from realtime-v2 ──────────────────────
    {
      id: 'recalc-source',
      kind: 'logic',
      layer: 'realtime-v2 · Source 5/5',
      title: 'QuoteService.reCalculate()',
      subtitle: 'Detect high/low year change',
      position: { x: COL * 1.3, y: ROW * 3.6 },
      inputs: [{ name: 'SymbolQuote', type: 'object', description: 'from Quote flow' }],
      outputs: [{ name: 'emit Kafka topic calExtraUpdate', type: 'producer', description: '' }],
      details:
        'calExtraUpdate is an ACTIVE source in the websocket-only runtime: whenever high/low year changes vs the SymbolInfo cache, realtime-v2 emits this so other services can rebuild cached aggregates.',
    },

    // ─── Kafka topics ──────────────────────────────────────────────────
    {
      id: 'kafka-extra',
      kind: 'kafka',
      layer: 'Kafka',
      title: 'topic extraUpdate / calExtraUpdate',
      subtitle: 'Same consumer, different sources',
      position: { x: COL * 2.5, y: ROW * 1.8 },
      inputs: [
        { name: 'producer collector (extraUpdate)', type: 'Kafka', description: '4 sources: VN30/Futures/CW/Deal' },
        { name: 'producer realtime-v2 (calExtraUpdate)', type: 'Kafka', description: 'high/low year changed' },
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
      subtitle: 'Merge into 3 targets',
      position: { x: COL * 4.5, y: ROW * 1.8 },
      inputs: [
        { name: 'ExtraQuote', type: 'object', description: '' },
        { name: 'enableAutoData flag', type: 'boolean', description: 'false → return immediately' },
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
      details: 'Only runs when enableAutoData=true. All 3 targets are HSET to Redis.',
    },

    // ─── DealNotice branch (separate from ExtraUpdate) ──────────────
    {
      id: 'kafka-deal',
      kind: 'kafka',
      layer: 'Kafka',
      title: 'topic dealNoticeUpdate',
      subtitle: 'Put-through deals',
      position: { x: COL * 2.5, y: ROW * 4.5 },
      inputs: [{ name: 'producer collector', type: 'Kafka', description: 'Emitted alongside ExtraUpdate source 4' }],
      outputs: [{ name: 'realtime-v2 + ws-v2', type: 'Kafka', description: '' }],
      details: 'Raw DealNotice goes through its own topic at the same time fromDealNotice() emits an ExtraUpdate.',
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
        { name: 'ensure SymbolInfo exists', type: 'check', description: '' },
        { name: 'de-dup by confirmNumber', type: 'compute', description: '' },
        { name: 'merge PT value/volume into SymbolInfo', type: 'merge', description: '' },
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
      subtitle: 'Extra fields merged in',
      position: { x: COL * 6, y: ROW * 1.8 },
      inputs: [{ name: 'ExtraQuoteService → HSET (3 keys)', type: 'HSET', description: '' }],
      outputs: [{ name: 'query-v2 + ws-v2', type: 'Redis', description: '' }],
      details: 'basis/breakEven/pt values live inside SymbolInfo so query-v2 reads them through SYMBOL_INFO.',
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

    // DealNotice branch (raw topic emitted with source 4)
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
  subtitle: '3 daily lifecycle cron jobs in realtime-v2 that clean / reset Redis hot state',
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
      details: 'Runs at start of day to clean the previous day’s tick/minute data.',
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
      details: 'Resets a handful of intraday fields on SymbolInfo to prepare for the new session.',
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
      details: 'Cleans the daily map at end of day.',
    },
    {
      id: 'check-holiday',
      kind: 'logic',
      layer: 'Pre-check',
      title: 'check holiday / weekend',
      subtitle: 'Skip when not a trading day',
      position: { x: COL, y: 0 },
      inputs: [{ name: 'JobService.removeAutoData()', type: 'call', description: '' }],
      outputs: [{ name: 'continue or skip', type: 'branch', description: '' }],
      details: '',
    },
    {
      id: 'rs-remove',
      kind: 'logic',
      layer: 'realtime-v2',
      title: 'RedisService.removeAutoData()',
      subtitle: 'Bulk clear keys',
      position: { x: COL * 2, y: 0 },
      inputs: [{ name: 'none (pure clear)', type: 'call', description: '' }],
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
      subtitle: 'Reset fields per SymbolInfo',
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
      details: 'Does NOT delete SymbolInfo — only resets a handful of intraday fields.',
    },
    {
      id: 'rs-clear',
      kind: 'logic',
      layer: 'realtime-v2',
      title: 'RedisService.clearOldSymbolDaily()',
      subtitle: 'Clear daily',
      position: { x: COL * 2, y: ROW * 4 },
      inputs: [{ name: 'none', type: 'call', description: '' }],
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
      inputs: [{ name: 'after remove/refresh', type: 'call', description: '' }],
      outputs: [{ name: 'in-memory cache back to 0', type: 'reset', description: '' }],
      details: '',
    },
    {
      id: 'redis-cleared',
      kind: 'redis',
      layer: 'Redis after',
      title: 'DELETED',
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
      title: 'KEPT',
      subtitle: 'SymbolInfo · ForeignerDaily · MarketStatus',
      position: { x: COL * 4, y: ROW * 2 },
      inputs: [{ name: 'removeAutoData does not touch these', type: 'preserve', description: '' }],
      outputs: [
        { name: 'realtime_mapSymbolInfo', type: 'kept', description: '(intraday fields refreshed at 01:35)' },
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
      subtitle: 'Cleared at end of day',
      position: { x: COL * 4, y: ROW * 4 },
      inputs: [{ name: 'clearOldSymbolDaily', type: 'DEL', description: '' }],
      outputs: [{ name: 'clean slate for the next day', type: 'cleared', description: '' }],
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
    'Cron 6 times/day (10:15, 10:29, 11:15, 11:29, 14:15, 14:29) snapshots day-level state into Mongo. Tick/minute/bid-offer are NOT persisted (flags off).',
  accent: '#34d399',
  nodes: [
    {
      id: 'cron',
      kind: 'schedule',
      layer: 'Cron',
      title: 'JobService.saveRedisToDatabase()',
      subtitle: '0 15,29 10,11,14 * * MON-FRI',
      position: { x: 0, y: ROW * 2 },
      inputs: [{ name: '@Scheduled cron', type: 'cron', description: '6 times/day' }],
      outputs: [{ name: 'RedisService.saveRedisToDatabase(flags)', type: 'call', description: '' }],
      details: '10:15 · 10:29 · 11:15 · 11:29 · 14:15 · 14:29.',
    },
    {
      id: 'rs-save',
      kind: 'logic',
      layer: 'realtime-v2',
      title: 'RedisService.saveRedisToDatabase()',
      subtitle: 'Orchestrate bulk writes',
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
      inputs: [{ name: 'realtime_mapSymbolInfoOddLot', type: 'HGETALL', description: 'Separate key from mapSymbolInfo' }],
      outputs: [{ name: 'List<SymbolInfoOddLot>', type: 'list', description: 'Only odd-lot bidOfferList + foreigner summary' }],
      details:
        '─── SHB sample ───\n' +
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
        'Note: the key is kept separate because odd-lot does not share a sequence with the main session. ' +
        'Comes with the history list realtime_listBidOfferOddLot_<code> (see BidOffer flow).',
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
      outputs: [{ name: 'List<ForeignerDaily> (id mapped to today)', type: 'list', description: '' }],
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
      inputs: [{ name: '7 lists from Redis', type: 'list', description: '' }],
      outputs: [{ name: 'BulkWriteResult', type: 'Mongo', description: '' }],
      details: 'High-throughput bulk upsert rather than per-row insert.',
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
      inputs: [{ name: 'SymbolDaily for today', type: 'list', description: '' }],
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
      subtitle: 'Current runtime',
      position: { x: COL * 3, y: 0 },
      inputs: [{ name: 'application config', type: 'boolean', description: '' }],
      outputs: [
        { name: 'NO getAllSymbolQuote', type: 'skip', description: '' },
        { name: 'NO getAllSymbolQuoteMinute', type: 'skip', description: '' },
        { name: 'NO getAllBidOffer', type: 'skip', description: '' },
      ],
      details: 'Consequence: c_symbol_quote, c_symbol_quote_minute, c_bid_offer are NOT persisted at runtime.',
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

    { source: 'inactive-quote', target: 'rs-save', label: 'flags=false → skip 3 branches' },
  ],
};

// ─────────────────────────────────────────────────────────────────────────
// 8. QUERY API FLOW
// ─────────────────────────────────────────────────────────────────────────
const queryApiFlow = {
  id: 'query-api-flow',
  title: 'QUERY API — market-query-v2 catalog (Kafka RPC + Redis-first)',
  subtitle:
    '35+ endpoints, transport is a Kafka request/response pattern · RequestHandler.ts routes by message.uri · Redis primary, Mongo fallback, Lotte REST for some historical flows',
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
      details: 'Client gateway (BFF) builds a message { uri, payload, replyTopic } → publishes to Kafka.',
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
      subtitle: 'Route by message.uri',
      position: { x: COL * 2, y: ROW * 5 },
      inputs: [{ name: 'Kafka Message<Request>', type: 'object', description: '{ uri, payload, requestId, replyTopic }' }],
      outputs: [{ name: 'dispatch(uri) → 12 service groups', type: 'call', description: '' }],
      details:
        'File: market-query-v2/src/consumers/RequestHandler.ts — central controller, parses the payload → invokes the matching service method → builds the response → publishes the Kafka reply.',
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
        { name: 'querySymbolQuote / queryQuoteData', type: 'endpoint', description: 'Tick page by volume/meta' },
        { name: 'querySymbolQuoteTick', type: 'endpoint', description: 'Ticks grouped by sequence' },
        { name: 'querySymbolQuoteMinutes / queryMinuteChart', type: 'endpoint', description: 'Minute grouped' },
        { name: 'querySymbolStatistics', type: 'endpoint', description: 'HGET SYMBOL_STATISTICS' },
        { name: 'querySymbolTickSizeMatch', type: 'endpoint', description: '' },
        { name: 'queryMarketSessionStatus', type: 'endpoint', description: 'HGET MARKET_STATUS' },
      ],
      details:
        '§2.1 — realtime symbol data from Redis hot state.\n' +
        'querySymbolQuote flow: 1) read SYMBOL_QUOTE_META → 2) pick partition by lastTradingVolume → 3) LRANGE SYMBOL_QUOTE_{code}[_p] → 4) SymbolQuoteResponse[].',
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
        { name: 'querySymbolPeriod', type: 'endpoint', description: 'HGET SYMBOL_DAILY + historical c_symbol_daily' },
        { name: 'querySymbolForeignerDaily', type: 'endpoint', description: 'HGET FOREIGNER_DAILY' },
        { name: 'querySymbolRight', type: 'endpoint', description: 'GET market_right_info_{code}' },
        { name: 'querySymbolDailyReturns', type: 'endpoint', description: '' },
        { name: 'initSymbolDailyReturns', type: 'endpoint', description: 'Compute + cache returns' },
      ],
      details: 'Mix of Redis (intraday) + Mongo (historical).',
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
      details: 'Rankings cached as Strings (JSON) under the Redis key STOCK_RANKING_PERIOD.',
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
        { name: 'queryIndexStockList', type: 'endpoint', description: 'Symbols in the index basket' },
        { name: 'queryMarketLiquidity', type: 'endpoint', description: '' },
        { name: 'getLastTradingDate', type: 'endpoint', description: '' },
        { name: 'getCurrentDividendList', type: 'endpoint', description: '' },
        { name: 'getDailyAccumulativeVNIndex', type: 'endpoint', description: '' },
        { name: 'queryForeignerSummary', type: 'endpoint', description: 'Foreigner aggregate per exchange' },
      ],
      details: '',
    },
    {
      id: 'grp-pt',
      kind: 'logic',
      layer: '§2.5 Put-through',
      title: 'Put-through',
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
        { name: 'queryTradingViewHistory', type: 'endpoint', description: 'Bars for the chart' },
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
      details: 'Pure Mongo (c_chart).',
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
      details: 'Pure Mongo (c_watchlist).',
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
      details: 'Operations endpoint — calls Lotte REST to refresh chart data into Mongo.',
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
      inputs: [{ name: 'from the service groups', type: 'HGET/LRANGE/GET', description: '' }],
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
        'NOT written at runtime: c_symbol_quote, c_symbol_quote_minute, c_bid_offer (flags off).',
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
      inputs: [{ name: 'data from Redis / Mongo / Lotte', type: 'object', description: '' }],
      outputs: [
        { name: 'Kafka reply { requestId, data }', type: 'Kafka', description: 'Sent back on the replyTopic from the request' },
      ],
      details: '',
    },
    {
      id: 'kafka-reply',
      kind: 'kafka',
      layer: 'Kafka RPC',
      title: 'topic <replyTopic>',
      subtitle: 'Asynchronous response',
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
      inputs: [{ name: 'JSON response', type: 'REST/WS', description: 'BFF proxies it back to the client' }],
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
    'ws-v2 consumes Kafka directly and does NOT wait on Mongo · compact payload via parser.js · publish + snapshot on subscribe',
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
      outputs: [{ name: 'consumed by market.js', type: 'Kafka', description: '' }],
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
        { name: 'quoteOddLotUpdate → market.quoteOddLot.{code}', type: 'channel', description: 'Separate odd-lot branch' },
        { name: 'bidOfferUpdate → market.bidoffer.{code}', type: 'channel', description: '' },
        { name: 'bidOfferUpdateDR → market.bidoffer.dr.{code}', type: 'channel', description: '' },
        { name: 'bidOfferOddLotUpdate → market.bidofferOddLot.{code}', type: 'channel', description: 'Separate odd-lot branch' },
        { name: 'extraUpdate / calExtraUpdate → market.extra.{code}', type: 'channel', description: '' },
        { name: 'marketStatus → market.status', type: 'channel', description: '' },
        { name: 'dealNoticeUpdate → market.putthrough.deal.{market}', type: 'channel', description: '' },
        { name: 'advertisedUpdate → market.putthrough.advertise.{market}', type: 'channel', description: '' },
        { name: 'statisticUpdate → market.statistic.{code}', type: 'channel', description: '' },
      ],
      details:
        'File: ws-v2/market.js → processDataPublishV2().\n' +
        'Odd-lot topics use dedicated parsers (convertDataPublishV2BidOfferOddLot, convertDataPublishV2QuoteOddLot) so the payload only contains the fields relevant to odd lots.',
    },
    {
      id: 'parser',
      kind: 'logic',
      layer: 'ws-v2',
      title: 'parser.js convertDataPublishV2*',
      subtitle: 'Compact payload',
      position: { x: COL * 3, y: ROW * 2 },
      inputs: [
        { name: 'full payload from Kafka', type: 'object', description: 'verbose field names' },
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
          description: 'convertDataPublishV2BidOfferOddLot — keeps oddlotBidOfferList + time, drops main-session fields',
        },
        {
          name: 'Quote Odd-lot compact',
          type: 'object',
          description: 'convertDataPublishV2QuoteOddLot — keeps OHLC + simple volume for odd lots',
        },
        { name: 'Extra compact', type: 'object', description: 'convertDataPublishV2Extra' },
      ],
      details: 'Goal: reduce wire bandwidth by using short 1-2 character keys.',
    },
    {
      id: 'cache',
      kind: 'redis',
      layer: 'In-memory cache',
      title: 'cacheInfo / cacheOddlot / cacheStatistic / cacheMarketStatus',
      subtitle: 'In-process JS cache',
      position: { x: COL * 4, y: ROW * 1 },
      inputs: [{ name: 'setToCacheInfo(code, payload)', type: 'set', description: 'After parsing' }],
      outputs: [{ name: 'serves snapshot on subscribe', type: 'cache', description: '' }],
      details: 'Not Redis — this is the in-process memory of ws-v2. Used for returnSnapshot=true.',
    },
    {
      id: 'sc-publish',
      kind: 'ws',
      layer: 'SocketCluster',
      title: 'SocketCluster publish(channel, payload)',
      subtitle: 'Fan-out to subscribers',
      position: { x: COL * 4, y: ROW * 2.5 },
      inputs: [{ name: 'channel + compact payload', type: 'broker call', description: '' }],
      outputs: [{ name: 'message to subscribers', type: 'WS frame', description: '' }],
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
        { name: 'subscribe(channel, {returnSnapShot})', type: 'WS', description: 'from client' },
      ],
      outputs: [
        { name: 'checkingReturnSnapShotInfo(req)', type: 'call', description: 'Lookup cache' },
        { name: 'reply with snapshot before attaching the stream', type: 'WS', description: '' },
      ],
      details: 'When req.data.returnSnapShot===true → reply with a snapshot from the cache right at subscribe time.',
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
import { vietstockFlows, vietstockSections } from './vietstockFlows.js';

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

export const flows = [...businessFlows, ...lifecycles, ...vietstockFlows];

export const flowCategories = [
  {
    id: 'business',
    label: 'Business Flow',
    description: 'View by business flow / topic / service',
    icon: 'bars',
    flows: businessFlows,
  },
  {
    id: 'lifecycle',
    label: 'Data Flow',
    description: 'View by individual object lifecycle',
    icon: 'circles',
    flows: lifecycles,
  },
  {
    id: 'vietstock',
    label: 'Vietstock Bridge',
    description: 'Data ingestion from Vietstock (viet-stock-bridge)',
    icon: 'globe',
    flows: vietstockFlows,
    sections: vietstockSections,
  },
];
