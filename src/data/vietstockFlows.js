// ============================================================================
// Vietstock Bridge — Data Flow Definitions
// ----------------------------------------------------------------------------
// 3 independent categories:
//   1. vsApiOnDemand  — On-demand API via Vietstock (cache-first REST → fallback Vietstock)
//   2. vsApiInternal  — Internal Data API (reads Redis / Mongo / MySQL only, NEVER touches Vietstock)
//   3. vsJobs         — Background Sync Jobs (run on primary instance, write MySQL/Mongo)
// ============================================================================

const COL = 480;
const ROW = 280;

// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║ 1. ON-DEMAND API VIA VIETSTOCK                                            ║
// ║    Cache-first Redis → on miss call Vietstock → mapper → SET cache        ║
// ╚═══════════════════════════════════════════════════════════════════════════╝

// ─── 1.1 Company Info ───────────────────────────────────────────────────────
const vsCompanyFlow = {
  id: 'vs-company',
  title: 'Company Info — /company/transactionHistory · profile · ownershipStructure · majorShareholders',
  subtitle:
    '4 endpoints following cache-first pattern: validate → GET Redis → on miss call Vietstock → map → SET Redis TTL 86400s → return',
  accent: '#0ea5e9',
  nodes: [
    {
      id: 'client',
      kind: 'client',
      layer: 'Client',
      title: 'NHSV Web / Mobile',
      subtitle: '/company/*',
      position: { x: 0, y: ROW * 1.2 },
      inputs: [{ name: 'User opens company profile', type: 'UI', description: 'Select symbol on Company screen' }],
      outputs: [
        { name: 'GET /company/transactionHistory', type: 'REST', description: 'stockCode + language' },
        { name: 'GET /company/profile', type: 'REST', description: 'stockCode + language' },
        { name: 'GET /company/ownershipStructure', type: 'REST', description: 'stockCode + language' },
        { name: 'GET /company/majorShareholders', type: 'REST', description: 'stockCode + language' },
      ],
      details:
        'Accept-Language determines cache key variant (vi / en). ' +
        'All 4 endpoints are mostly static within a day → TTL 86400s is sufficient.',
    },
    {
      id: 'gateway',
      kind: 'api',
      layer: 'Gateway',
      title: 'NHSV REST Gateway',
      subtitle: 'REST ↔ Kafka bridge',
      position: { x: COL, y: ROW * 1.2 },
      inputs: [{ name: 'HTTP request', type: 'JWT', description: 'Bearer token required' }],
      outputs: [{ name: 'Kafka request', type: 'Kafka', description: 'message.uri = path + query' }],
      details:
        'Gateway validates JWT, packs into Kafka message with message.uri so viet-stock-bridge can route by method. ' +
        'Nothing else — all business logic lives in the service.',
    },
    {
      id: 'service',
      kind: 'service',
      layer: 'Service',
      title: 'CompanyInfoService',
      subtitle: '4 on-demand methods',
      position: { x: COL * 2, y: ROW * 1.2 },
      inputs: [
        { name: 'validate(stockCode, language)', type: 'logic', description: 'Reject if missing or malformed' },
        { name: 'Redis GET', type: 'cache', description: 'Always try cache first' },
        { name: 'Vietstock response', type: 'REST', description: 'Fallback on miss' },
      ],
      outputs: [
        { name: 'Redis SET TTL 86400s', type: 'cache write', description: 'Write after successful mapping' },
        { name: 'Response object', type: 'Kafka', description: 'Reply to gateway' },
      ],
      details:
        'Method → Vietstock endpoint:\n' +
        '  • getTransactionHistory → /NHSV/transferdata\n' +
        '  • getProfile             → /NHSV/companyinfo\n' +
        '  • getOwnershipStructure  → /NHSV/stockownership\n' +
        '  • getMajorShareholders   → /NHSV/stockshareholders\n\n' +
        'Common flow: validate → build key → GET Redis → (miss) call Vietstock → map → SET Redis → return. ' +
        'No retry, no circuit-breaker at this layer — Vietstock errors bubble up to the client.',
    },
    {
      id: 'redis',
      kind: 'redis',
      layer: 'Cache',
      title: 'Redis · catVietStock{CompanyProfile | Ownership | Shareholders | TransactionHistory}',
      subtitle: 'TTL 86400s',
      position: { x: COL * 3, y: 0 },
      inputs: [{ name: 'SET after mapping', type: 'cache write', description: '1 day' }],
      outputs: [{ name: 'GET · hit → return directly', type: 'cache read', description: 'Does not touch Vietstock' }],
      details:
        'Key pattern: ${clusterId}_catVietStockCompanyProfile_<code>_<lang>.\n' +
        'Value has type-prefix "4" (JSON) normalized by RedisService on SET.\n\n' +
        'No warm-up mechanism, cache is filled only when a user hits the endpoint for the first time that day.',
    },
    {
      id: 'vietstock',
      kind: 'source',
      layer: 'External',
      title: 'Vietstock · /NHSV/{transferdata | companyinfo | stockownership | stockshareholders}',
      subtitle: 'api2.vietstock.vn',
      position: { x: COL * 3, y: ROW * 2.4 },
      inputs: [{ name: 'GET', type: 'REST', description: 'stockCode + languageID' }],
      outputs: [
        { name: 'transferdata', type: 'JSON', description: 'Insider transaction history' },
        { name: 'companyinfo', type: 'JSON', description: 'introduction / listingDate / industry / ...' },
        { name: 'stockownership', type: 'JSON', description: 'Ownership breakdown' },
        { name: 'stockshareholders', type: 'JSON', description: 'Top shareholders' },
      ],
      details:
        'Base URL: https://api2.vietstock.vn/NHSV.\n' +
        'Bridge does NOT retry in the on-demand flow — fail fast to surface errors to the client quickly. ' +
        'Timeouts / 4xx / 5xx will skip cache write → next call will retry.',
    },
    {
      id: 'mapper',
      kind: 'logic',
      layer: 'Transform',
      title: 'Response mapper',
      subtitle: 'Vietstock raw → API schema',
      position: { x: COL * 4, y: ROW * 1.2 },
      inputs: [{ name: 'Vietstock raw JSON', type: 'logic', description: '' }],
      outputs: [
        { name: 'IGetTransactionHistoryResponse', type: 'object', description: 'transactionHistory' },
        { name: 'IGetCompanyProfileResponse', type: 'object', description: 'profile' },
        { name: 'IGetOwnershipStructureResponse', type: 'object', description: 'ownership' },
        { name: 'IGetMajorShareholdersResponse', type: 'object', description: 'majorShareholders' },
      ],
      details:
        'transactionHistory: name, position, executionDate, registerBuyQuantity, registerSellQuantity, ' +
        'buyQuantity, buyRate, sellQuantity, sellRate, holdingQuantityBefore, holdingRateBefore, ' +
        'holdingQuantityAfter, holdingRateAfter, affiliatedPersonPosition, affiliatedPerson, transferTypeId.\n\n' +
        'profile: introduction, listingDate, listingPrice, industryName, notes.\n' +
        'ownership: name, note, shares, rate.\n' +
        'majorShareholders: name, shares, hold.',
    },
  ],
  edges: [
    { source: 'client', target: 'gateway', label: 'GET' },
    { source: 'gateway', target: 'service', label: 'Kafka request', animated: true },
    { source: 'service', target: 'redis', label: 'GET' },
    { source: 'redis', target: 'service', label: 'hit', animated: true },
    { source: 'service', target: 'vietstock', label: 'miss → GET' },
    { source: 'vietstock', target: 'mapper', label: 'raw JSON' },
    { source: 'mapper', target: 'redis', label: 'SET TTL 86400s' },
    { source: 'mapper', target: 'service', label: 'mapped' },
    { source: 'service', target: 'gateway', label: 'Kafka response', animated: true },
    { source: 'gateway', target: 'client', label: 'HTTP JSON' },
  ],
};

// ─── 1.2 News (on-demand) ───────────────────────────────────────────────────
const vsNewsFlow = {
  id: 'vs-news-ondemand',
  title: 'News — /news/latest · /news/stockNews · /news/newsDetail',
  subtitle:
    'Cache-first Redis → Vietstock {latestnews, stocknews, article} → mapper → SET Redis · TTL 900s (list) / 3600s (detail) · no DB persistence',
  accent: '#8b5cf6',
  nodes: [
    {
      id: 'client',
      kind: 'client',
      layer: 'Client',
      title: 'Web / Mobile',
      subtitle: '/news/latest · stockNews · newsDetail',
      position: { x: 0, y: ROW * 1.2 },
      inputs: [{ name: 'Open news screen', type: 'UI', description: '' }],
      outputs: [
        { name: 'GET /news/latest', type: 'REST', description: 'paging + language' },
        { name: 'GET /news/stockNews', type: 'REST', description: 'stockCode + paging + language' },
        { name: 'GET /news/newsDetail', type: 'REST', description: 'newsId + language' },
      ],
      details:
        '3 on-demand endpoints, unrelated to watchlist. Returns article list / article detail — no MySQL, ' +
        'no many-to-many stocks[] returned.',
    },
    {
      id: 'gateway',
      kind: 'api',
      layer: 'Gateway',
      title: 'REST Gateway → Kafka',
      subtitle: '',
      position: { x: COL, y: ROW * 1.2 },
      inputs: [{ name: 'HTTP', type: 'JWT', description: '' }],
      outputs: [{ name: 'Kafka request', type: 'Kafka', description: '' }],
      details: 'No custom logic, just forwards → bridge.',
    },
    {
      id: 'service',
      kind: 'service',
      layer: 'Service',
      title: 'NewsService (on-demand)',
      subtitle: 'getLatest / getStockNews / getNewsDetail',
      position: { x: COL * 2, y: ROW * 1.2 },
      inputs: [
        { name: 'paging, language, (stockCode | newsId)', type: 'logic', description: '' },
        { name: 'Redis GET', type: 'cache', description: 'Cache-first' },
        { name: 'Vietstock latestnews/stocknews/article', type: 'REST', description: 'Miss fallback' },
      ],
      outputs: [
        { name: 'Redis SET', type: 'cache', description: 'TTL 900s list · 3600s detail' },
        { name: 'Response object', type: 'Kafka', description: '' },
      ],
      details:
        'Note: the same Vietstock /stocknews endpoint is used in 2 different flows, distinguish clearly:\n' +
        '  • /news/stockNews (on-demand, Redis cache, NO persistence)\n' +
        '  • Job queryStockNews() (ETL, writes to MySQL, see Background Sync Jobs tab)\n\n' +
        'Cache miss calls Vietstock directly, no retry. ' +
        'SET cache only when mapper runs successfully.',
    },
    {
      id: 'redis',
      kind: 'redis',
      layer: 'Cache',
      title: 'Redis · catVietStockLatestNews / StockNews / NewsDetail',
      subtitle: 'TTL 900s (list) / 3600s (detail)',
      position: { x: COL * 3, y: 0 },
      inputs: [{ name: 'SET after mapping', type: 'Redis', description: '' }],
      outputs: [{ name: 'Cached JSON', type: 'GET', description: '' }],
      details:
        'Key pattern:\n' +
        '  ${cluster}_catVietStockLatestNews_<pageSize>_<page>_<lang>\n' +
        '  ${cluster}_catVietStockStockNews_<code>_<page>_<lang>\n' +
        '  ${cluster}_catVietStockNewsDetail_<newsId>_<lang>\n\n' +
        'List TTL is short (15 min) to keep the feed fresh. Detail is longer (1h) since article content rarely changes.',
    },
    {
      id: 'vietstock',
      kind: 'source',
      layer: 'External',
      title: 'Vietstock · latestnews · stocknews · article',
      subtitle: 'api2.vietstock.vn',
      position: { x: COL * 3, y: ROW * 2.2 },
      inputs: [{ name: 'GET', type: 'REST', description: 'pageSize, page, stockCode, newsId, languageID' }],
      outputs: [
        { name: 'latestnews', type: 'JSON', description: 'Aggregated market-wide feed' },
        { name: 'stocknews', type: 'JSON', description: 'News per symbol' },
        { name: 'article', type: 'JSON', description: 'Single article detail' },
      ],
      details:
        '3 distinct endpoints, all accepting languageID=1 (vi) | 2 (en). ' +
        'Response contains an HTML content field (for stocknews / article only) — bridge passes through as-is.',
    },
    {
      id: 'mapper',
      kind: 'logic',
      layer: 'Transform',
      title: 'Response mapper',
      subtitle: '3 different schemas',
      position: { x: COL * 4, y: ROW * 1.2 },
      inputs: [{ name: 'Vietstock raw', type: 'logic', description: '' }],
      outputs: [
        { name: 'latest → id,title,head,publishTime,imageUrl,url,stocks[]', type: 'object', description: 'stocks[] = {stockCode, changeRate, colorId}' },
        { name: 'stockNews → id,title,head,url,publishTime,content,author,source', type: 'object', description: 'Keeps HTML content' },
        { name: 'newsDetail → title,head,publishTime,imageUrl,url,author,content,stocks[]', type: 'object', description: 'Includes stocks[] for badge rendering' },
      ],
      details:
        'Only `latest` and `newsDetail` include stocks[] so the client can render related-symbol chips. ' +
        '`stockNews` is already scoped to a specific symbol, so no stocks[] attached.',
    },
  ],
  edges: [
    { source: 'client', target: 'gateway', label: 'GET /news/*' },
    { source: 'gateway', target: 'service', label: 'Kafka request', animated: true },
    { source: 'service', target: 'redis', label: 'GET' },
    { source: 'redis', target: 'service', label: 'hit', animated: true },
    { source: 'service', target: 'vietstock', label: 'miss → GET' },
    { source: 'vietstock', target: 'mapper', label: 'raw JSON' },
    { source: 'mapper', target: 'redis', label: 'SET TTL 900s / 3600s' },
    { source: 'mapper', target: 'service', label: 'mapped' },
    { source: 'service', target: 'gateway', label: 'Kafka response', animated: true },
    { source: 'gateway', target: 'client', label: 'HTTP JSON' },
  ],
};

// ─── 1.3 Stock Events (on-demand) ───────────────────────────────────────────
const vsStockEventsFlow = {
  id: 'vs-stock-events',
  title: 'Stock Events — /stockEvents · /stockEvent',
  subtitle:
    'Two variants of the same Vietstock stockevents endpoint · /stockEvents caches in Redis 1h + filters EventTypeID=1 · /stockEvent is live, not cached',
  accent: '#ec4899',
  nodes: [
    {
      id: 'client',
      kind: 'client',
      layer: 'Client',
      title: 'Web / Mobile',
      subtitle: '',
      position: { x: 0, y: ROW * 1.5 },
      inputs: [{ name: 'Open events tab', type: 'UI', description: '' }],
      outputs: [
        { name: 'GET /stockEvents', type: 'REST', description: 'stockCode' },
        { name: 'GET /stockEvent', type: 'REST', description: 'stockCode + fromDate + toDate' },
      ],
      details:
        '/stockEvents → summary list, hit frequently by users → worth caching.\n' +
        '/stockEvent → details for user-selected date range → not cached to avoid stale data.',
    },
    {
      id: 'gateway',
      kind: 'api',
      layer: 'Gateway',
      title: 'REST Gateway → Kafka',
      subtitle: '',
      position: { x: COL, y: ROW * 1.5 },
      inputs: [{ name: 'HTTP', type: 'JWT', description: '' }],
      outputs: [{ name: 'Kafka request', type: 'Kafka', description: '' }],
      details: '',
    },
    {
      id: 'service',
      kind: 'service',
      layer: 'Service',
      title: 'StockService',
      subtitle: 'getStockEvents + getStockEvent',
      position: { x: COL * 2, y: ROW * 1.5 },
      inputs: [{ name: 'stockCode (+ fromDate/toDate)', type: 'logic', description: '' }],
      outputs: [
        { name: '/stockEvents → cache-first', type: 'logic', description: '' },
        { name: '/stockEvent → live', type: 'logic', description: '' },
      ],
      details:
        'Both methods share the same Vietstock endpoint but use different query-strings, mappers, and cache strategies. ' +
        'Branching happens directly in the service, not split across files.',
    },
    {
      id: 'redis',
      kind: 'redis',
      layer: 'Cache',
      title: 'Redis · catVietStockStockEvents',
      subtitle: 'TTL 3600s',
      position: { x: COL * 3, y: 0 },
      inputs: [{ name: 'SET after mapping', type: 'Redis', description: '/stockEvents branch only' }],
      outputs: [{ name: 'GET · hit → return directly', type: 'Redis', description: '' }],
      details:
        'Only /stockEvents uses this cache. /stockEvent bypasses Redis entirely.\n\n' +
        'Key: ${cluster}_catVietStockStockEvents_<code>',
    },
    {
      id: 'vietstock-a',
      kind: 'source',
      layer: 'External (summary)',
      title: 'Vietstock /stockevents — summary call',
      subtitle: '/stockEvents path',
      position: { x: COL * 3, y: ROW },
      inputs: [{ name: 'GET', type: 'REST', description: 'stockCode' }],
      outputs: [{ name: 'All events', type: 'JSON', description: 'Mixed EventTypeIDs' }],
      details:
        'Bridge filters EventTypeID === 1 (dividend / main corporate actions), then maps compactly + sorts dateOrder desc. ' +
        'Reason: the client list only needs major events, avoiding noise.',
    },
    {
      id: 'vietstock-b',
      kind: 'source',
      layer: 'External (detail)',
      title: 'Vietstock /stockevents — research call',
      subtitle: '/stockEvent path',
      position: { x: COL * 3, y: ROW * 2.5 },
      inputs: [{ name: 'GET', type: 'REST', description: 'stockCode + fromDate + toDate' }],
      outputs: [{ name: 'Event detail', type: 'JSON', description: 'Full fields' }],
      details:
        'Same endpoint as summary but with different query-string (adds fromDate/toDate). No EventTypeID filter. ' +
        'Not cached — returns mapped response directly.',
    },
    {
      id: 'mapper',
      kind: 'logic',
      layer: 'Transform',
      title: 'Events / Detail mapper',
      subtitle: 'Two different schemas',
      position: { x: COL * 4, y: ROW * 1.5 },
      inputs: [{ name: 'Vietstock raw', type: 'logic', description: '' }],
      outputs: [
        {
          name: '/stockEvents → title, exRightDate, recordDate, reportDate, effectiveDate, dividendRate, price, dateOrder',
          type: 'object',
          description: 'Filter EventTypeID=1 · sort dateOrder desc',
        },
        {
          name: '/stockEvent → eventId, stockCode, exRightDate, recordDate, exerciseDate, note, eventName, exchange, eventTitle, eventContent, fileUrl, dateOrder, eventType, publishDate, updateDate, lastUpdate, dividendRate, channelID, eventSequenceNumber, totalEvents, price',
          type: 'object',
          description: 'Full research schema',
        },
      ],
      details: 'Mapper is split into 2 separate functions because Vietstock returns the same raw shape but clients need 2 different shapes.',
    },
  ],
  edges: [
    { source: 'client', target: 'gateway', label: 'GET' },
    { source: 'gateway', target: 'service', label: 'Kafka request', animated: true },
    { source: 'service', target: 'redis', label: '/stockEvents · GET' },
    { source: 'redis', target: 'service', label: 'hit', animated: true },
    { source: 'service', target: 'vietstock-a', label: '/stockEvents · miss' },
    { source: 'vietstock-a', target: 'mapper', label: 'raw JSON' },
    { source: 'mapper', target: 'redis', label: 'SET TTL 3600s' },
    { source: 'service', target: 'vietstock-b', label: '/stockEvent · live' },
    { source: 'vietstock-b', target: 'mapper', label: 'raw JSON' },
    { source: 'mapper', target: 'service', label: 'mapped' },
    { source: 'service', target: 'gateway', label: 'Kafka response', animated: true },
    { source: 'gateway', target: 'client', label: 'HTTP JSON' },
  ],
};

// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║ 2. INTERNAL DATA API (Redis / Mongo / MySQL) — NEVER touches Vietstock    ║
// ╚═══════════════════════════════════════════════════════════════════════════╝

// ─── 2.1 News Read (MySQL) ──────────────────────────────────────────────────
const vsNewsReadFlow = {
  id: 'vs-news-read',
  title: 'News Read — /news/getLatestNewsByWatchList · /news/getLatestNewsByStocks',
  subtitle:
    'No Vietstock call, no Redis cache. Resolve symbols via Mongo watchlist (if needed) → JOIN MySQL → paging DESC publish_time',
  accent: '#10b981',
  nodes: [
    {
      id: 'client',
      kind: 'client',
      layer: 'Client',
      title: 'Web / Mobile',
      subtitle: '',
      position: { x: 0, y: ROW * 1.5 },
      inputs: [{ name: 'User opens news-by-watchlist / symbol-list tab', type: 'UI', description: '' }],
      outputs: [
        { name: 'GET /news/getLatestNewsByWatchList', type: 'REST', description: 'watchlistName + paging + language' },
        { name: 'GET /news/getLatestNewsByStocks', type: 'REST', description: 'stocks[] + paging + language' },
      ],
      details:
        'watchlist → client only sends the name, username is taken from the JWT. ' +
        'stocks → client sends the symbol array directly, skipping watchlist.',
    },
    {
      id: 'gateway',
      kind: 'api',
      layer: 'Gateway',
      title: 'REST Gateway → Kafka',
      subtitle: '',
      position: { x: COL, y: ROW * 1.5 },
      inputs: [{ name: 'HTTP + JWT', type: 'JWT', description: 'Username read from token' }],
      outputs: [{ name: 'Kafka request', type: 'Kafka', description: '' }],
      details: 'Username is injected into the message — bridge uses it directly, no re-validation.',
    },
    {
      id: 'service',
      kind: 'service',
      layer: 'Service',
      title: 'NewsService (reader)',
      subtitle: 'getLatestNewsByWatchList / getLatestNewsByStocks',
      position: { x: COL * 2, y: ROW * 1.5 },
      inputs: [{ name: 'username + watchlistName | stocks[]', type: 'logic', description: '' }],
      outputs: [
        { name: 'Mongo find', type: 'logic', description: 'watchlist branch only' },
        { name: 'MySQL SELECT JOIN', type: 'logic', description: 'Both branches' },
      ],
      details:
        'Differences:\n' +
        '  • watchlist → resolve symbols[] via Mongo t_watch_list first, then query MySQL\n' +
        '  • stocks    → skip the Mongo step, use the list provided by the user directly\n\n' +
        'Both branches STOP at MySQL, no fallback to Vietstock. If the DB has no data → returns empty list.',
    },
    {
      id: 'mongo',
      kind: 'mongo',
      layer: 'Persistence (watchlist)',
      title: 'Mongo · t_watch_list',
      subtitle: 'find({username, watchlistName})',
      position: { x: COL * 3, y: 0 },
      inputs: [{ name: 'find', type: 'MongoDB', description: '' }],
      outputs: [{ name: 'symbols[]', type: 'array', description: 'List of symbols followed by the user' }],
      details:
        'Schema: _id, username, watchlistName, symbols[], createdAt, updatedAt, deletedAt.\n' +
        'Only the watchlist branch touches this collection. If not found → symbols=[] → empty result.',
    },
    {
      id: 'sql',
      kind: 'logic',
      layer: 'Query build',
      title: 'JOIN query builder',
      subtitle: 'ORDER BY publish_time DESC · LIMIT/OFFSET',
      position: { x: COL * 3, y: ROW * 1.5 },
      inputs: [
        { name: 'symbols[] or stocks[]', type: 'array', description: '' },
        { name: 'language', type: 'string', description: 'vi | en' },
        { name: 'paging', type: 'object', description: '{pageSize, pageIndex}' },
      ],
      outputs: [{ name: 'Rows[]', type: 'array', description: 'Paginated articles' }],
      details:
        'SELECT n.* FROM t_stock_news n\n' +
        'JOIN t_stock_stock_news m ON m.stockNewsId = n.id\n' +
        'WHERE m.stockCode IN (...) AND n.language = ?\n' +
        'ORDER BY n.publish_time DESC\n' +
        'LIMIT ? OFFSET ?\n\n' +
        'No DISTINCT — an article tagged with multiple symbols will appear multiple times. Client must dedupe if needed.',
    },
    {
      id: 'mysql',
      kind: 'mysql',
      layer: 'Persistence (news)',
      title: 'MySQL · t_stock_news + t_stock_stock_news',
      subtitle: 'ETL-populated (see Background Sync Jobs)',
      position: { x: COL * 3, y: ROW * 3 },
      inputs: [{ name: 'SELECT + JOIN', type: 'SQL', description: '' }],
      outputs: [{ name: 'Rows', type: 'reader', description: '' }],
      details:
        't_stock_news: id, language, title, head, url, publish_time, content, author, source.\n' +
        't_stock_stock_news (mapping): stockNewsId, stockCode.\n\n' +
        'Written by the queryStockNews() job — there are no other writers.',
    },
    {
      id: 'mapper',
      kind: 'logic',
      layer: 'Transform',
      title: 'Row → Response',
      subtitle: '',
      position: { x: COL * 4, y: ROW * 1.5 },
      inputs: [{ name: 'Rows[]', type: 'array', description: '' }],
      outputs: [{ name: 'id, title, head, url, publishTime, author, source', type: 'object', description: '' }],
      details: 'No reverse JOIN to pick up stocks[] — only article metadata is returned.',
    },
  ],
  edges: [
    { source: 'client', target: 'gateway', label: 'GET' },
    { source: 'gateway', target: 'service', label: 'Kafka request', animated: true },
    { source: 'service', target: 'mongo', label: 'watchlist → find' },
    { source: 'mongo', target: 'service', label: 'symbols[]' },
    { source: 'service', target: 'sql', label: 'build query' },
    { source: 'sql', target: 'mysql', label: 'SELECT JOIN' },
    { source: 'mysql', target: 'sql', label: 'rows' },
    { source: 'sql', target: 'mapper', label: 'rows' },
    { source: 'mapper', target: 'service', label: 'response' },
    { source: 'service', target: 'gateway', label: 'Kafka response', animated: true },
    { source: 'gateway', target: 'client', label: 'HTTP JSON' },
  ],
};

// ─── 2.2 Financial Read (Mongo + Redis hash) ────────────────────────────────
const vsFinReadFlow = {
  id: 'vs-fin-read',
  title: 'Financial Read — /finance/incomeStatement · balanceSheet · cashFlow · latestFinancialRatio',
  subtitle:
    'No Vietstock call. Cache-first Redis hash (field=<code>_<period>) → on miss read Mongo going backward from the current period → map → HSET',
  accent: '#06b6d4',
  nodes: [
    {
      id: 'client',
      kind: 'client',
      layer: 'Client',
      title: 'Web / Mobile',
      subtitle: '',
      position: { x: 0, y: ROW * 1.5 },
      inputs: [{ name: 'Open financial tab', type: 'UI', description: '' }],
      outputs: [
        { name: 'GET /finance/incomeStatement', type: 'REST', description: 'code + period' },
        { name: 'GET /finance/balanceSheet', type: 'REST', description: 'code + period' },
        { name: 'GET /finance/cashFlow', type: 'REST', description: 'code + period' },
        { name: 'GET /financial/latestFinancialRatio', type: 'REST', description: 'code (latest quarter only)' },
      ],
      details: 'period ∈ {QUARTER, YEAR}. latestFinancialRatio always returns a single document for the latest quarter, ignoring period.',
    },
    {
      id: 'gateway',
      kind: 'api',
      layer: 'Gateway',
      title: 'REST Gateway → Kafka',
      subtitle: '',
      position: { x: COL, y: ROW * 1.5 },
      inputs: [{ name: 'HTTP', type: 'JWT', description: '' }],
      outputs: [{ name: 'Kafka request', type: 'Kafka', description: '' }],
      details: '',
    },
    {
      id: 'service',
      kind: 'service',
      layer: 'Service',
      title: 'FinancialService (reader)',
      subtitle: '4 read methods — no Vietstock call',
      position: { x: COL * 2, y: ROW * 1.5 },
      inputs: [
        { name: 'code + period', type: 'logic', description: '' },
        { name: 'Redis HGET hash', type: 'cache', description: '' },
        { name: 'Mongo find (backward by period)', type: 'DB', description: '' },
      ],
      outputs: [
        { name: 'Redis HSET hash', type: 'cache write', description: 'field=<code>_<period?>' },
        { name: 'Response object', type: 'Kafka', description: '' },
      ],
      details:
        'Data is entirely populated in Mongo beforehand by ETL jobs. Service only reads + maps. ' +
        'Latency depends on Mongo (find backward N periods) + Redis (HGET/HSET).',
    },
    {
      id: 'redis',
      kind: 'redis',
      layer: 'Cache',
      title: 'Redis hash cache',
      subtitle: 'catFinancialStatement{IS|BS|CF}{Quater|Year} · Ratio',
      position: { x: COL * 3, y: 0 },
      inputs: [{ name: 'HSET', type: 'Redis', description: 'No TTL' }],
      outputs: [{ name: 'HGET field=<code>_<...>', type: 'Redis', description: '' }],
      details:
        'No TTL — cache is only cleared by ETL jobs after a successful sync (see Background Sync Jobs tab).\n\n' +
        '6 main hashes:\n' +
        '  catFinancialStatementIncomeStatementQuater / Year\n' +
        '  catFinancialStatementBalanceSheetQuater   / Year\n' +
        '  catFinancialStatementCashFlowQuater       / Year\n' +
        '  catFinancialStatementRatio (latest quarter only · for /latestFinancialRatio)',
    },
    {
      id: 'mongo-q',
      kind: 'mongo',
      layer: 'Persistence (quarter)',
      title: 'Mongo · t_quarter_financial_statement',
      subtitle: 'Backward from the current quarter',
      position: { x: COL * 3, y: ROW * 1.5 },
      inputs: [{ name: 'find by _id', type: 'MongoDB', description: '<code>_<year>_<quarter>' }],
      outputs: [{ name: 'Docs[]', type: 'array', description: 'Exactly N records' }],
      details:
        'Reader computes the current (year, quarter) then builds a list of _id going backward until the requested count is reached. ' +
        'If any period is missing in Mongo, the response omits that period — it does NOT fall back to calling Vietstock.',
    },
    {
      id: 'mongo-y',
      kind: 'mongo',
      layer: 'Persistence (year)',
      title: 'Mongo · t_year_financial_statement',
      subtitle: 'Backward 4 most recent years',
      position: { x: COL * 3, y: ROW * 3 },
      inputs: [{ name: 'find by _id', type: 'MongoDB', description: '<code>_<year>' }],
      outputs: [{ name: 'Docs[]', type: 'array', description: '' }],
      details: 'Same backward mechanism but per year, defaulting to 4 years.',
    },
    {
      id: 'mapper',
      kind: 'logic',
      layer: 'Transform',
      title: 'Doc → Response',
      subtitle: 'snake_case → camelCase · split quarterly/yearly',
      position: { x: COL * 4, y: ROW * 1.5 },
      inputs: [{ name: 'Mongo docs', type: 'array', description: '' }],
      outputs: [
        { name: 'incomeStatement', type: 'object', description: 'quarterly[] + yearly[] · revenue, operatingIncome, netIncome, grossProfit' },
        { name: 'balanceSheet', type: 'object', description: 'totalAsset, totalEquity, totalLiablities' },
        { name: 'cashFlow', type: 'object', description: 'operatingCashFlow, financingCashFlow, investingCashFlow' },
        { name: 'latestFinancialRatio', type: 'object', description: 'pe, pb, eps (latest quarter)' },
      ],
      details: 'latestFinancialRatio only pulls a single document for the latest quarter, handled separately from the other three endpoints.',
    },
  ],
  edges: [
    { source: 'client', target: 'gateway', label: 'GET' },
    { source: 'gateway', target: 'service', label: 'Kafka request', animated: true },
    { source: 'service', target: 'redis', label: 'HGET' },
    { source: 'redis', target: 'service', label: 'hit', animated: true },
    { source: 'service', target: 'mongo-q', label: 'QUARTER · find backward' },
    { source: 'service', target: 'mongo-y', label: 'YEAR · find backward' },
    { source: 'mongo-q', target: 'mapper', label: 'docs' },
    { source: 'mongo-y', target: 'mapper', label: 'docs' },
    { source: 'mapper', target: 'redis', label: 'HSET' },
    { source: 'mapper', target: 'service', label: 'mapped' },
    { source: 'service', target: 'gateway', label: 'Kafka response', animated: true },
    { source: 'gateway', target: 'client', label: 'HTTP JSON' },
  ],
};

// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║ 3. BACKGROUND SYNC JOBS (primary instance)                                ║
// ║    3 separate jobs: News · Financial Quarter · Financial Year             ║
// ╚═══════════════════════════════════════════════════════════════════════════╝

// ─── 3.1 Stock News Sync (while-loop) ───────────────────────────────────────
const vsJobStockNewsFlow = {
  id: 'vs-job-stock-news',
  title: 'Job · Stock News Sync — queryStockNews()',
  subtitle:
    'While-loop running continuously on primary instance · reads symbols from Redis realtime_mapSymbolInfo · GET Vietstock /stocknews (vi + en) · INSERT MySQL',
  accent: '#f59e0b',
  nodes: [
    {
      id: 'trigger',
      kind: 'schedule',
      layer: 'Trigger',
      title: 'while (runQueryStockNews)',
      subtitle: 'Primary-only · continuous loop',
      position: { x: 0, y: ROW * 1.2 },
      inputs: [
        { name: 'conf.runQueryStockNews', type: 'flag', description: 'true only on primary instance' },
        { name: 'Kafka job:/vietstock/stockNews', type: 'Kafka', description: 'Manual kick — still respects the flag' },
      ],
      outputs: [{ name: 'for each code in codeList', type: 'loop', description: '' }],
      details:
        'Primary instance = TRADEX_ENV_NODE_ID=1 and INSTANCE_ID empty|1.\n' +
        'Other instances: conf.runQueryStockNews=false → while never enters the body, loop idles. ' +
        'Kafka manual trigger does not bypass the flag — primary stays primary.',
    },
    {
      id: 'redis-map',
      kind: 'redis',
      layer: 'Shared symbol source',
      title: 'Redis · realtime_mapSymbolInfo',
      subtitle: 'HGETALL → codeList',
      position: { x: COL, y: ROW * 1.2 },
      inputs: [{ name: 'market-realtime-v2 HSET', type: 'external write', description: 'Outside the viet-stock-bridge repo' }],
      outputs: [
        { name: 'ISymbolInfo[]', type: 'parse', description: 'Bridge only uses the `code` field' },
        { name: 'codeList: string[]', type: 'map', description: '' },
      ],
      details:
        'Bridge does NOT filter by exchange / instrument type — any symbol present in the hash will be synced. ' +
        'This hash is managed by market-realtime-v2, bridge only reads from it.',
    },
    {
      id: 'pace',
      kind: 'logic',
      layer: 'Rate limit',
      title: 'Batch by requestsPerSecond',
      subtitle: 'Parallel within a batch · 1s boundary wait',
      position: { x: COL * 2, y: ROW * 1.2 },
      inputs: [{ name: 'codeList', type: 'array', description: '' }],
      outputs: [{ name: '2 GET stocknews / symbol (vi + en)', type: 'fanout', description: '' }],
      details:
        'Each batch of N = requestsPerSecond symbols runs via Promise.all. After the batch, sleep until total elapsed ≥ 1s → ' +
        'ensures < N req/s to Vietstock.\n\n' +
        'Each symbol = 2 calls (languageID=1 & 2).',
    },
    {
      id: 'vs-news',
      kind: 'source',
      layer: 'External',
      title: 'Vietstock /stocknews',
      subtitle: 'stockCode=<code>&page=1&pageSize=<N>&languageID=<lang>',
      position: { x: COL * 3, y: ROW * 1.2 },
      inputs: [{ name: 'GET', type: 'REST', description: 'lang ∈ {vi, en}' }],
      outputs: [{ name: 'stocknews JSON', type: 'list', description: 'List of articles' }],
      details:
        'Same endpoint as the on-demand /news/stockNews, but here it is ETL: does NOT go through Redis cache, writes straight to MySQL. ' +
        'The while-true loop runs forever as long as conf.runQueryStockNews is true.',
    },
    {
      id: 'map-news',
      kind: 'logic',
      layer: 'Transform',
      title: 'Map → IStockNews[] + mapping[]',
      subtitle: 'Normalize to DB schema',
      position: { x: COL * 4, y: ROW * 1.2 },
      inputs: [{ name: 'Vietstock raw', type: 'logic', description: '' }],
      outputs: [
        { name: 'IStockNews[]', type: 'array', description: 'id, language, title, head, url, publish_time, content, author, source' },
        { name: '{stockCode, stockNewsId}[]', type: 'array', description: 'Many-to-many mapping' },
      ],
      details:
        'Each article × each language = 1 separate row. ' +
        'Effective primary key is (id + language), so multi-language articles do not conflict.',
    },
    {
      id: 'mysql-news',
      kind: 'mysql',
      layer: 'Persistence',
      title: 'MySQL · t_stock_news + t_stock_stock_news',
      subtitle: 'INSERT',
      position: { x: COL * 5, y: ROW * 1.2 },
      inputs: [
        { name: 'INSERT t_stock_news', type: 'SQL', description: 'Article store' },
        { name: 'INSERT t_stock_stock_news', type: 'SQL', description: 'Many-to-many mapping' },
      ],
      outputs: [{ name: 'Used by /news/getLatestNewsBy*', type: 'reader', description: 'See Internal Data API tab' }],
      details:
        't_stock_news: id, language, title, head, url, publish_time, content, author, source.\n' +
        't_stock_stock_news: stockNewsId, stockCode.\n\n' +
        'No cache invalidation step — because /news/getLatestNewsBy* does not use Redis cache.',
    },
  ],
  edges: [
    { source: 'trigger', target: 'redis-map', label: 'HGETALL', animated: true },
    { source: 'redis-map', target: 'pace', label: 'codeList' },
    { source: 'pace', target: 'vs-news', label: '2 GET/symbol', animated: true },
    { source: 'vs-news', target: 'map-news', label: 'raw JSON' },
    { source: 'map-news', target: 'mysql-news', label: 'INSERT' },
  ],
};

// ─── 3.2 Financial Quarter Sync (cron 14:00) ────────────────────────────────
const vsJobFinQuarterFlow = {
  id: 'vs-job-fin-quarter',
  title: 'Job · Financial Quarter Sync — queryQuarterFinancialStatement()',
  subtitle:
    'Cron 0 14 * * MON-FRI · primary-only · 4 GET /financeinfolastest (termtype=2) / symbol · merge by BusinessType · upsert Mongo · DEL Redis cache',
  accent: '#f97316',
  nodes: [
    {
      id: 'trigger',
      kind: 'schedule',
      layer: 'Trigger',
      title: 'Cron 0 14 * * MON-FRI',
      subtitle: 'Every business day at 14:00',
      position: { x: 0, y: ROW * 1.2 },
      inputs: [
        { name: '!conf.isRunQuarterFinancialStatement', type: 'flag', description: 'false only on primary instance' },
        { name: 'Kafka job:/vietstock/quarterFinancial', type: 'Kafka', description: 'Manual kick' },
      ],
      outputs: [{ name: 'for each code', type: 'loop', description: '' }],
      details:
        'Primary instance: conf.isRunQuarterFinancialStatement = false → cron is NOT skipped. ' +
        'Other instances: flag=true → cron returns early.\n\n' +
        'This lock is shared between the cron and the Kafka manual trigger.',
    },
    {
      id: 'redis-map',
      kind: 'redis',
      layer: 'Shared symbol source',
      title: 'Redis · realtime_mapSymbolInfo',
      subtitle: 'HGETALL → codeList',
      position: { x: COL, y: ROW * 1.2 },
      inputs: [{ name: 'market-realtime-v2 HSET', type: 'external write', description: '' }],
      outputs: [{ name: 'codeList: string[]', type: 'array', description: '' }],
      details: 'Same symbol source as the other 2 jobs. Bridge only reads, no filter.',
    },
    {
      id: 'pace',
      kind: 'logic',
      layer: 'Rate limit',
      title: 'Batch by requestsPerSecond',
      subtitle: '4 GET / symbol',
      position: { x: COL * 2, y: ROW * 1.2 },
      inputs: [{ name: 'codeList', type: 'array', description: '' }],
      outputs: [{ name: '4 calls /financeinfolastest / symbol', type: 'fanout', description: 'KQKD · CDKT · LCTT · CSTC' }],
      details:
        'This job is ~4x slower than the News job because each symbol calls 4 Vietstock endpoints. Still keeps the 1s batch boundary.',
    },
    {
      id: 'vs-fin-q',
      kind: 'source',
      layer: 'External',
      title: 'Vietstock /financeinfolastest (termtype=2)',
      subtitle: 'KQKD + CDKT + LCTT + CSTC · pageSize=4',
      position: { x: COL * 3, y: ROW * 1.2 },
      inputs: [{ name: 'GET × 4', type: 'REST', description: '' }],
      outputs: [{ name: 'IGetVietStockFinancialResponse × 4', type: 'JSON', description: 'Head[] + Content[]' }],
      details:
        'Common params: termtype=2 (quarter), page=1, pageSize=4, languageID=2 (en), unit=1.\n' +
        'Each type contains different indicators:\n' +
        '  • KQKD (Income Statement) → revenue, gross_profit, operating_income, net_income\n' +
        '  • CDKT (Balance Sheet) → total_assets, total_liablities, total_equity\n' +
        '  • LCTT (Cash Flow Indirect) → 3 cash-flow lines operating/investing/financing\n' +
        '  • CSTC (Valuation + Profitability) → pe, pb, bvps, eps, roe, roa',
    },
    {
      id: 'merge-q',
      kind: 'logic',
      layer: 'Transform',
      title: 'toQuarterFinancialStatement(...)',
      subtitle: 'Merge 4 responses · Head ↔ VALUE_MAP ID→Value1..4',
      position: { x: COL * 4, y: ROW * 1.2 },
      inputs: [{ name: '4 Vietstock responses', type: 'object', description: '' }],
      outputs: [{ name: '[{_id:<code>_<year>_<quarter>, ...}]', type: 'array', description: 'Quarterly document' }],
      details:
        'Head[] indicates which period each of Value1..Value4 maps to (YearPeriod + TermNameEN).\n' +
        'Content[] = list of indicators, each row carrying 4 values Value1..Value4.\n\n' +
        'Service uses BusinessType (CP / NH / BH / CK) + indicator-ID map (src/constants/enum.ts) ' +
        'to pick the right row and the right Value per Head. ' +
        'Example: revenue for regular companies is usually ID=3, but for banks the ID differs — so BusinessType must be distinguished.',
    },
    {
      id: 'mongo-q',
      kind: 'mongo',
      layer: 'Persistence',
      title: 'Mongo · t_quarter_financial_statement',
      subtitle: 'upsert _id=<code>_<year>_<quarter>',
      position: { x: COL * 5, y: ROW * 1.2 },
      inputs: [{ name: 'upsert', type: 'MongoDB', description: '' }],
      outputs: [{ name: 'Used by /finance/* quarter', type: 'reader', description: 'See Internal Data API tab' }],
      details:
        'Full schema: _id, stock, year, quarter, revenue, gross_profit, operating_income, net_income, eps, ' +
        'total_assets, total_liablities, total_equity, net_cash_from_operating_activities, ' +
        'net_cash_from_investing_activities, net_cash_from_financing_activities, pe, pb, roe, roa, bvps, ' +
        'created_at, updated_at.\n\n' +
        'New insert → set created_at. Every run updates updated_at.',
    },
    {
      id: 'del-q',
      kind: 'redis',
      layer: 'Cache invalidate',
      title: 'Redis DEL catFinancialStatement*Quater + Ratio',
      subtitle: 'Clear cache so read-API picks up fresh data',
      position: { x: COL * 6, y: ROW * 1.2 },
      inputs: [{ name: 'Job done', type: 'event', description: '' }],
      outputs: [
        { name: 'DEL catFinancialStatementIncomeStatementQuater', type: 'Redis', description: '' },
        { name: 'DEL catFinancialStatementBalanceSheetQuater', type: 'Redis', description: '' },
        { name: 'DEL catFinancialStatementCashFlowQuater', type: 'Redis', description: '' },
        { name: 'DEL catFinancialStatementRatio', type: 'Redis', description: 'Shares the ratio hash too' },
      ],
      details:
        'Hashes have no TTL → they never expire on their own. Only ETL invalidates them. ' +
        'The first request after DEL will miss cache → read Mongo → HSET again.',
    },
  ],
  edges: [
    { source: 'trigger', target: 'redis-map', label: 'HGETALL', animated: true },
    { source: 'redis-map', target: 'pace', label: 'codeList' },
    { source: 'pace', target: 'vs-fin-q', label: '4 GET/symbol', animated: true },
    { source: 'vs-fin-q', target: 'merge-q', label: '4 responses' },
    { source: 'merge-q', target: 'mongo-q', label: 'upsert' },
    { source: 'mongo-q', target: 'del-q', label: 'done → DEL' },
  ],
};

// ─── 3.3 Financial Year Sync (cron 15:00) ───────────────────────────────────
const vsJobFinYearFlow = {
  id: 'vs-job-fin-year',
  title: 'Job · Financial Year Sync — queryYearFinancialStatement()',
  subtitle:
    'Cron 0 15 * * MON-FRI · primary-only · 4 GET /financeinfolastest (termtype=1) / symbol · merge · upsert Mongo · DEL Redis cache',
  accent: '#eab308',
  nodes: [
    {
      id: 'trigger',
      kind: 'schedule',
      layer: 'Trigger',
      title: 'Cron 0 15 * * MON-FRI',
      subtitle: 'Runs right after the Quarter job',
      position: { x: 0, y: ROW * 1.2 },
      inputs: [
        { name: '!conf.isRunYearFinancialStatement', type: 'flag', description: 'false only on primary instance' },
        { name: 'Kafka job:/vietstock/yearFinancial', type: 'Kafka', description: 'Manual kick' },
      ],
      outputs: [{ name: 'for each code', type: 'loop', description: '' }],
      details:
        '⚠ Known bug: queryYearFinancialStatement() checks conf.isRunQuarterFinancialStatement at the top of the function ' +
        'instead of conf.isRunYearFinancialStatement → if the 14:00 Quarter job runs past 15:00, the Year cron gets unfairly skipped. ' +
        'The two locks need to be split.',
    },
    {
      id: 'redis-map',
      kind: 'redis',
      layer: 'Shared symbol source',
      title: 'Redis · realtime_mapSymbolInfo',
      subtitle: 'HGETALL → codeList',
      position: { x: COL, y: ROW * 1.2 },
      inputs: [{ name: 'market-realtime-v2 HSET', type: 'external write', description: '' }],
      outputs: [{ name: 'codeList: string[]', type: 'array', description: '' }],
      details: 'Shares the same hash as the News and Quarter jobs.',
    },
    {
      id: 'pace',
      kind: 'logic',
      layer: 'Rate limit',
      title: 'Batch by requestsPerSecond',
      subtitle: '4 GET / symbol',
      position: { x: COL * 2, y: ROW * 1.2 },
      inputs: [{ name: 'codeList', type: 'array', description: '' }],
      outputs: [{ name: '4 calls /financeinfolastest / symbol', type: 'fanout', description: '' }],
      details: 'Rate-limit logic is identical to the Quarter job.',
    },
    {
      id: 'vs-fin-y',
      kind: 'source',
      layer: 'External',
      title: 'Vietstock /financeinfolastest (termtype=1)',
      subtitle: 'KQKD + CDKT + LCTT + CSTC · pageSize=2',
      position: { x: COL * 3, y: ROW * 1.2 },
      inputs: [{ name: 'GET × 4', type: 'REST', description: '' }],
      outputs: [{ name: 'IGetVietStockFinancialResponse × 4', type: 'JSON', description: 'Yearly' }],
      details: 'Differs from Quarter: termtype=1 (year), pageSize=2. Response structure is identical, merger shares the same logic.',
    },
    {
      id: 'merge-y',
      kind: 'logic',
      layer: 'Transform',
      title: 'toYearFinancialStatement(...)',
      subtitle: 'Merge 4 responses · drop the quarter field',
      position: { x: COL * 4, y: ROW * 1.2 },
      inputs: [{ name: '4 Vietstock responses', type: 'object', description: '' }],
      outputs: [{ name: '[{_id:<code>_<year>, ...}]', type: 'array', description: 'Yearly document' }],
      details: 'Logic is the same as the Quarter merger, just drops the quarter field from _id and the schema.',
    },
    {
      id: 'mongo-y',
      kind: 'mongo',
      layer: 'Persistence',
      title: 'Mongo · t_year_financial_statement',
      subtitle: 'upsert _id=<code>_<year>',
      position: { x: COL * 5, y: ROW * 1.2 },
      inputs: [{ name: 'upsert', type: 'MongoDB', description: '' }],
      outputs: [{ name: 'Used by /finance/* year', type: 'reader', description: 'See Internal Data API tab' }],
      details: 'Schema is nearly identical to Quarter, just drops the quarter field. created_at / updated_at follow the same convention.',
    },
    {
      id: 'del-y',
      kind: 'redis',
      layer: 'Cache invalidate',
      title: 'Redis DEL catFinancialStatement*Year',
      subtitle: 'Does not touch Ratio (already DEL-ed in Quarter)',
      position: { x: COL * 6, y: ROW * 1.2 },
      inputs: [{ name: 'Job done', type: 'event', description: '' }],
      outputs: [
        { name: 'DEL catFinancialStatementIncomeStatementYear', type: 'Redis', description: '' },
        { name: 'DEL catFinancialStatementBalanceSheetYear', type: 'Redis', description: '' },
        { name: 'DEL catFinancialStatementCashFlowYear', type: 'Redis', description: '' },
      ],
      details:
        'Does not touch catFinancialStatementRatio (already DEL-ed by the earlier Quarter job, since Ratio only reflects the latest quarter).',
    },
  ],
  edges: [
    { source: 'trigger', target: 'redis-map', label: 'HGETALL', animated: true },
    { source: 'redis-map', target: 'pace', label: 'codeList' },
    { source: 'pace', target: 'vs-fin-y', label: '4 GET/symbol', animated: true },
    { source: 'vs-fin-y', target: 'merge-y', label: '4 responses' },
    { source: 'merge-y', target: 'mongo-y', label: 'upsert' },
    { source: 'mongo-y', target: 'del-y', label: 'done → DEL' },
  ],
};

// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║ Exports — 3 categories                                                    ║
// ╚═══════════════════════════════════════════════════════════════════════════╝

// 3 sections under the same 'vietstock' category
const ondemand = [vsCompanyFlow, vsNewsFlow, vsStockEventsFlow].map((f) => ({
  ...f,
  category: 'vietstock',
  section: 'ondemand',
}));

const internal = [vsNewsReadFlow, vsFinReadFlow].map((f) => ({
  ...f,
  category: 'vietstock',
  section: 'internal',
}));

const jobs = [vsJobStockNewsFlow, vsJobFinQuarterFlow, vsJobFinYearFlow].map((f) => ({
  ...f,
  category: 'vietstock',
  section: 'jobs',
}));

export const vietstockFlows = [...ondemand, ...internal, ...jobs];

export const vietstockSections = [
  {
    id: 'ondemand',
    label: 'On-demand API via Vietstock',
    description: 'Endpoints calling Vietstock on-demand · cache-first Redis',
  },
  {
    id: 'internal',
    label: 'Internal Data API',
    description: 'Endpoints reading only Redis / Mongo / MySQL — never Vietstock',
  },
  {
    id: 'jobs',
    label: 'Background Sync Jobs',
    description: 'Cron · while-loop primary instance · writes to MySQL / Mongo',
  },
];
