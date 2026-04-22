// ============================================================================
// TradeX Market Data — OBJECT LIFECYCLE DIAGRAMS
// ============================================================================
// Each lifecycle describes the lifecycle of 1 object: source · transform ·
// Redis/Mongo · delivery · reset/persist.
//
// details CONVENTION:
//   • Explain WHAT the function does (don't just repeat the function name)
//   • List input → main processing steps → output
//   • Important flag behavior (skip / branch / feature flag)
//
// category = 'lifecycle' so the App picks the correct parent tab.
// ============================================================================

const COL = 480;
const ROW = 320;

// ─────────────────────────────────────────────────────────────────────────
// 0. OBJECT RELATIONSHIP OVERVIEW — Map of 17 object relationships
// ─────────────────────────────────────────────────────────────────────────
// Goal: view EVERY object + dependency arrows on a single screen
// (what mutates what, what is derived from what).
//
// Split into 3 vertical lanes:
//   1. EVENT SOURCES  (x ≈ 0)      — objects coming from the Lotte feed
//   2. ENRICHMENT     (x ≈ COL*2)  — ExtraUpdate (fanout mutator)
//   3. TARGET STATE   (x ≈ COL*4)  — final objects persisted in Redis/Mongo
// ─────────────────────────────────────────────────────────────────────────
const lifecycleObjectMap = {
  id: 'lc-object-map',
  category: 'lifecycle',
  title: 'Object Map · Dependency graph of 17 objects',
  subtitle:
    'Overview of 17 objects + mutate/derive arrows · 3 lanes: Event Sources → Enrichment → Target State · Odd-lot isolated',
  accent: '#6366f1',
  nodes: [
    // ─── LANE 1 · EVENT SOURCES (from Lotte feed) ────────────────────
    {
      id: 'src-quote',
      kind: 'source',
      layer: 'Event source',
      title: 'SymbolQuote',
      subtitle: 'Trade match tick — auto.qt/idxqt/futures',
      position: { x: 0, y: 0 },
      inputs: [{ name: 'Lotte WS', type: 'event', description: '' }],
      outputs: [
        { name: '→ SymbolInfo (update)', type: 'mutate', description: '' },
        { name: '→ ForeignerDaily', type: 'mutate', description: '' },
        { name: '→ SymbolDaily', type: 'mutate', description: '' },
        { name: '→ SymbolQuoteMinute (derive)', type: 'derive', description: '' },
        { name: '→ SymbolStatistic (derive, non-INDEX)', type: 'derive', description: '' },
        { name: '→ ListQuoteMeta + realtime_listQuote_{code}', type: 'persist', description: '' },
        { name: '→ calExtraUpdate (when high/low year changes)', type: 'trigger', description: '' },
      ],
      details:
        'The "source" object with the highest impact — 1 SymbolQuote triggers 6 other objects to be mutated/derived simultaneously. This is why QuoteService.updateQuote is the most critical hot path.',
    },
    {
      id: 'src-bo',
      kind: 'source',
      layer: 'Event source',
      title: 'BidOffer',
      subtitle: 'Order book top 3 levels — auto.bo',
      position: { x: 0, y: ROW * 1.3 },
      inputs: [{ name: 'Lotte WS', type: 'event', description: '' }],
      outputs: [{ name: '→ SymbolInfo.bidOfferList (overwrite top book)', type: 'mutate', description: '' }],
      details:
        'BidOffer mutates ONLY SymbolInfo (replaces bidOfferList + increments bidAskSequence). Does not derive any separate object.\nHistory OFF at runtime (enableSaveBidOffer=false).',
    },
    {
      id: 'src-status',
      kind: 'source',
      layer: 'Event source',
      title: 'MarketStatus',
      subtitle: 'Session per market — auto.tickerNews',
      position: { x: 0, y: ROW * 2.4 },
      inputs: [{ name: 'Lotte WS', type: 'event', description: '' }],
      outputs: [
        { name: '→ MarketStatus state (self)', type: 'persist', description: '' },
        { name: '→ SymbolInfo.sessions (broadcast ATO/ATC)', type: 'broadcast', description: 'all symbols in the same market' },
      ],
      details:
        'Few events but wide impact — 1 ATO event can mutate thousands of SymbolInfo entries at once. It is "self-persisted" because it is both an event and a target state.',
    },
    {
      id: 'src-deal',
      kind: 'source',
      layer: 'Event source',
      title: 'DealNotice',
      subtitle: 'Put-through match — put-through feed',
      position: { x: 0, y: ROW * 3.5 },
      inputs: [{ name: 'Lotte WS', type: 'event', description: '' }],
      outputs: [
        { name: '→ SymbolInfo.ptTradingVolume / ptTradingValue', type: 'mutate', description: '' },
        { name: '→ DealNotice list per market', type: 'persist', description: '' },
        { name: '→ ExtraUpdate (PT summary)', type: 'trigger', description: '' },
      ],
      details:
        'Dual-role: both an event with its own history (list) and a trigger for ExtraUpdate to accumulate PT summary into SymbolInfo.',
    },
    {
      id: 'src-adv',
      kind: 'source',
      layer: 'Event source',
      title: 'Advertised',
      subtitle: 'Put-through advertise offer',
      position: { x: 0, y: ROW * 4.5 },
      inputs: [{ name: 'Lotte WS', type: 'event', description: '' }],
      outputs: [{ name: '→ Advertised list per market (history only)', type: 'persist', description: '' }],
      details:
        'The most "isolated" object — has only history list, does NOT mutate SymbolInfo because it has not been matched yet.',
    },
    {
      id: 'src-index',
      kind: 'source',
      layer: 'Event source',
      title: 'IndexStockList',
      subtitle: 'Index basket composition',
      position: { x: 0, y: ROW * 5.5 },
      inputs: [{ name: 'Admin job / collector init', type: 'trigger', description: '' }],
      outputs: [{ name: '→ IndexStockList Mongo collection', type: 'persist', description: '' }],
      details:
        'A "slow" event — only changes when the exchange reviews the basket (a few times per month). No hot state in Redis.',
    },

    // ─── LANE 1.5 · ODD-LOT (separated) ───────────────────────────
    {
      id: 'src-qt-odd',
      kind: 'source',
      layer: 'Event source · Odd-lot',
      title: 'SymbolQuoteOddLot',
      subtitle: 'Odd-lot quote — auto.qt.oddlot',
      position: { x: 0, y: ROW * 7 },
      inputs: [{ name: 'Lotte WS (separate channel)', type: 'event', description: '' }],
      outputs: [{ name: '→ SymbolInfoOddLot', type: 'mutate', description: '' }],
      details:
        'ISOLATED ODD-LOT branch — only mutates SymbolInfoOddLot, does NOT touch regular SymbolInfo, and does not derive minute/stat/daily/foreigner.',
    },
    {
      id: 'src-bo-odd',
      kind: 'source',
      layer: 'Event source · Odd-lot',
      title: 'BidOfferOddLot',
      subtitle: 'Odd-lot order book — auto.bo.oddlot',
      position: { x: 0, y: ROW * 8.1 },
      inputs: [{ name: 'Lotte WS (separate channel)', type: 'event', description: '' }],
      outputs: [
        { name: '→ SymbolInfoOddLot.bidOfferList', type: 'mutate', description: '' },
        { name: '→ BidOfferOddLot list (runtime ON)', type: 'persist', description: '' },
      ],
      details:
        'Different from regular BidOffer: history realtime_listBidOfferOddLot_{code} is always ON.',
    },

    // ─── LANE 2 · ENRICHMENT (fanout mutator) ───────────────────────
    {
      id: 'enrich-extra',
      kind: 'logic',
      layer: 'Enrichment event',
      title: 'ExtraUpdate / ExtraQuote',
      subtitle: 'Fanout mutator — 5 sources → 3 targets',
      position: { x: COL * 2, y: ROW * 3 },
      inputs: [
        { name: '← SymbolQuote (calExtraUpdate when high/low year changes)', type: 'trigger', description: '' },
        { name: '← IndexUpdateData VN30 (basis)', type: 'trigger', description: '' },
        { name: '← FuturesUpdateData (basis)', type: 'trigger', description: '' },
        { name: '← StockUpdateData CW (breakEven)', type: 'trigger', description: '' },
        { name: '← DealNoticeData (PT summary)', type: 'trigger', description: '' },
      ],
      outputs: [
        { name: '→ SymbolInfo (basis/breakEven/pt/highYear/lowYear)', type: 'mutate', description: '' },
        { name: '→ ForeignerDaily', type: 'mutate', description: '' },
        { name: '→ SymbolDaily (upsert)', type: 'mutate', description: '' },
      ],
      details:
        'ExtraUpdate is NOT a long-lived object — it only exists as a Kafka message. After mutating the 3 targets it disappears. Placed in the middle of lane 2 to clearly show its "bridge" role between multiple sources → multiple targets.',
    },

    // ─── LANE 3 · TARGET STATE (hot state Redis) ────────────────────
    {
      id: 'tgt-info',
      kind: 'redis',
      layer: 'Target · Central hub',
      title: 'SymbolInfo',
      subtitle: 'realtime_mapSymbolInfo[code] — 6 mutators',
      position: { x: COL * 4, y: ROW * 2.4 },
      inputs: [
        { name: '← Init (REST baseline)', type: 'mutate', description: '' },
        { name: '← SymbolQuote', type: 'mutate', description: '' },
        { name: '← BidOffer', type: 'mutate', description: '' },
        { name: '← ExtraUpdate', type: 'mutate', description: '' },
        { name: '← MarketStatus (broadcast)', type: 'mutate', description: '' },
        { name: '← DealNotice', type: 'mutate', description: '' },
      ],
      outputs: [
        { name: '→ query-v2 priceBoard / ranking / TV / FIX', type: 'read', description: '' },
        { name: '→ ws-v2 snapshot on subscribe', type: 'read', description: '' },
        { name: '→ Mongo c_symbol_info (6×/day)', type: 'persist', description: '' },
      ],
      details:
        'The MOST CENTRAL object in the system — all flows end up here. It is the "single source of truth" for read snapshots.',
    },
    {
      id: 'tgt-foreigner',
      kind: 'redis',
      layer: 'Target · Derived',
      title: 'ForeignerDaily',
      subtitle: 'realtime_mapForeignerDaily[code]',
      position: { x: COL * 4, y: 0 },
      inputs: [
        { name: '← SymbolQuote', type: 'mutate', description: '' },
        { name: '← ExtraUpdate', type: 'mutate', description: '' },
      ],
      outputs: [
        { name: '→ Mongo c_foreigner_daily', type: 'persist', description: 'id = code_yyyyMMdd' },
        { name: '→ /symbol/{code}/foreigner (overlay today)', type: 'read', description: '' },
      ],
      details: 'Intraday accumulated foreign investor state. Persisted to Mongo 6×/day.',
    },
    {
      id: 'tgt-daily',
      kind: 'redis',
      layer: 'Target · Derived',
      title: 'SymbolDaily',
      subtitle: 'realtime_mapSymbolDaily[code]',
      position: { x: COL * 4, y: ROW * 1.2 },
      inputs: [
        { name: '← SymbolQuote (OHLCV)', type: 'mutate', description: '' },
        { name: '← ExtraUpdate (pt accumulation)', type: 'mutate', description: '' },
      ],
      outputs: [
        { name: '→ SymbolPrevious (post-process)', type: 'derive', description: '' },
        { name: '→ Mongo c_symbol_daily', type: 'persist', description: '' },
      ],
      details: 'Daily OHLCV. Cleared at 22:50; Mongo retains historical data.',
    },
    {
      id: 'tgt-minute',
      kind: 'redis',
      layer: 'Target · Derived',
      title: 'SymbolQuoteMinute',
      subtitle: 'realtime_listQuoteMinute_{code}',
      position: { x: COL * 4, y: ROW * 3.6 },
      inputs: [{ name: '← SymbolQuote (3 branches create/update/skip)', type: 'derive', description: '' }],
      outputs: [
        { name: '→ queryMinuteChart / TV intraday', type: 'read', description: '' },
        { name: '→ Mongo (OFF runtime)', type: 'skip', description: 'enableSaveQuoteMinute=false' },
      ],
      details: 'Minute bars derived from Quote. Not persisted.',
    },
    {
      id: 'tgt-stat',
      kind: 'redis',
      layer: 'Target · Derived',
      title: 'SymbolStatistic',
      subtitle: 'realtime_mapSymbolStatistic[code]',
      position: { x: COL * 4, y: ROW * 4.7 },
      inputs: [{ name: '← SymbolQuote (non-INDEX)', type: 'derive', description: '' }],
      outputs: [
        { name: '→ querySymbolStatistics', type: 'read', description: '' },
        { name: '→ ws market.statistic.{code} (delta)', type: 'read', description: '' },
      ],
      details: 'Aggregate by price. INDEX is skipped because indices have no trade matching.',
    },
    {
      id: 'tgt-meta',
      kind: 'redis',
      layer: 'Target · Technical',
      title: 'ListQuoteMeta / QuotePartition',
      subtitle: 'realtime_listQuoteMeta_{code}',
      position: { x: COL * 4, y: ROW * 5.8 },
      inputs: [{ name: '← SymbolQuote.addSymbolQuote (append + rebalance)', type: 'derive', description: '' }],
      outputs: [{ name: '→ querySymbolQuote / queryQuoteData (paging)', type: 'read', description: '' }],
      details: 'Technical metadata to paginate realtime_listQuote_{code}. Partition overflows when the list exceeds the threshold.',
    },
    {
      id: 'tgt-status',
      kind: 'redis',
      layer: 'Target · Self',
      title: 'MarketStatus state',
      subtitle: 'realtime_mapMarketStatus',
      position: { x: COL * 4, y: ROW * 6.9 },
      inputs: [{ name: '← MarketStatus event (self)', type: 'persist', description: '' }],
      outputs: [
        { name: '→ /sessionStatus', type: 'read', description: '' },
        { name: '→ Mongo c_market_session_status', type: 'persist', description: '' },
      ],
      details: 'Both an event and a target — stores the current session snapshot of each market.',
    },
    {
      id: 'tgt-deal-list',
      kind: 'redis',
      layer: 'Target · History list',
      title: 'DealNotice list',
      subtitle: 'realtime_listDealNotice_{market}',
      position: { x: COL * 4, y: ROW * 8 },
      inputs: [{ name: '← DealNotice event', type: 'persist', description: '' }],
      outputs: [
        { name: '→ queryPutThroughDeal / queryPtDealTotal', type: 'read', description: '' },
        { name: '→ Mongo c_deal_notice', type: 'persist', description: '' },
      ],
      details: 'History per market. Deduplicated by confirmNumber.',
    },
    {
      id: 'tgt-adv-list',
      kind: 'redis',
      layer: 'Target · History list',
      title: 'Advertised list',
      subtitle: 'realtime_listAdvertised_{market}',
      position: { x: COL * 4, y: ROW * 9 },
      inputs: [{ name: '← Advertised event', type: 'persist', description: '' }],
      outputs: [{ name: '→ queryPutThroughAdvertise', type: 'read', description: '' }],
      details: 'Advertise history per market.',
    },

    // ─── LANE 3.5 · ODD-LOT TARGETS ─────────────────────────────────
    {
      id: 'tgt-info-odd',
      kind: 'redis',
      layer: 'Target · Odd-lot',
      title: 'SymbolInfoOddLot',
      subtitle: 'realtime_mapSymbolInfoOddLot[code]',
      position: { x: COL * 4, y: ROW * 10.5 },
      inputs: [
        { name: '← SymbolQuoteOddLot', type: 'mutate', description: '' },
        { name: '← BidOfferOddLot', type: 'mutate', description: '' },
      ],
      outputs: [
        { name: '→ /symbol/oddlotLatest', type: 'read', description: '' },
        { name: '→ Mongo odd-lot collection', type: 'persist', description: '' },
      ],
      details: 'Odd-lot snapshot — a single hash written to by 2 mutators.',
    },
    {
      id: 'tgt-bo-odd',
      kind: 'redis',
      layer: 'Target · Odd-lot',
      title: 'BidOfferOddLot list',
      subtitle: 'realtime_listBidOfferOddLot_{code}',
      position: { x: COL * 4, y: ROW * 11.7 },
      inputs: [{ name: '← BidOfferOddLot event', type: 'persist', description: '' }],
      outputs: [{ name: '→ queryBidOfferOddLotHistory', type: 'read', description: '' }],
      details: 'DIFFERENT from the stock version — runtime ON, full history kept.',
    },

    // ─── LANE 4 · POST-PROCESS & STATIC ─────────────────────────────
    {
      id: 'tgt-prev',
      kind: 'mongo',
      layer: 'Post-process',
      title: 'SymbolPrevious',
      subtitle: 'c_symbol_previous (Mongo only)',
      position: { x: COL * 6.5, y: ROW * 1.2 },
      inputs: [{ name: '← SymbolDaily (inside saveRedisToDatabase)', type: 'derive', description: '' }],
      outputs: [{ name: '→ Client computes change vs previous session', type: 'read', description: '' }],
      details:
        'Post-process — sameDate only updates close, different date → advance previousClose/previousTradingDate. No Redis hot state.',
    },
    {
      id: 'tgt-ext',
      kind: 'redis',
      layer: 'Static support',
      title: 'symbolInfoExtend',
      subtitle: 'Static hash (no realtime_ prefix)',
      position: { x: COL * 6.5, y: ROW * 2.4 },
      inputs: [{ name: '← Admin batch job (unclear in docs)', type: 'ingest', description: '' }],
      outputs: [{ name: '→ querySymbolStaticInfo (merge with SymbolInfo)', type: 'read', description: '' }],
      details:
        'Static data (listedQty/avgTradingVol10/reference/floor/ceiling). Merged with SymbolInfo when querying basic info.',
    },
  ],
  edges: [
    // Quote fanout (main mutate branch)
    { source: 'src-quote', target: 'tgt-info', label: 'mutate', animated: true },
    { source: 'src-quote', target: 'tgt-foreigner', label: 'mutate' },
    { source: 'src-quote', target: 'tgt-daily', label: 'mutate' },
    { source: 'src-quote', target: 'tgt-minute', label: 'derive' },
    { source: 'src-quote', target: 'tgt-stat', label: 'derive (non-INDEX)' },
    { source: 'src-quote', target: 'tgt-meta', label: 'persist + meta' },
    { source: 'src-quote', target: 'enrich-extra', label: 'calExtraUpdate', animated: true },

    // BidOffer
    { source: 'src-bo', target: 'tgt-info', label: 'mutate bidOfferList', animated: true },

    // MarketStatus
    { source: 'src-status', target: 'tgt-status', label: 'self-persist' },
    { source: 'src-status', target: 'tgt-info', label: 'broadcast sessions (ATO/ATC)', animated: true },

    // DealNotice
    { source: 'src-deal', target: 'tgt-info', label: 'mutate pt*', animated: true },
    { source: 'src-deal', target: 'tgt-deal-list', label: 'RPUSH history' },
    { source: 'src-deal', target: 'enrich-extra', label: 'PT summary', animated: true },

    // Advertised
    { source: 'src-adv', target: 'tgt-adv-list', label: 'RPUSH history' },

    // IndexStockList persist
    { source: 'src-index', target: 'tgt-info', label: 'join inside getIndexRanks' },

    // Extra fanout (3 targets)
    { source: 'enrich-extra', target: 'tgt-info', label: 'merge basis/pt/year', animated: true },
    { source: 'enrich-extra', target: 'tgt-foreigner', label: 'merge' },
    { source: 'enrich-extra', target: 'tgt-daily', label: 'upsert' },

    // Odd-lot (isolated)
    { source: 'src-qt-odd', target: 'tgt-info-odd', label: 'mutate', animated: true },
    { source: 'src-bo-odd', target: 'tgt-info-odd', label: 'mutate top book', animated: true },
    { source: 'src-bo-odd', target: 'tgt-bo-odd', label: 'RPUSH history' },

    // Post-process
    { source: 'tgt-daily', target: 'tgt-prev', label: 'derive in cron' },
    { source: 'tgt-ext', target: 'tgt-info', label: 'merge on query' },
  ],
};

// ─────────────────────────────────────────────────────────────────────────
// 1. SymbolInfo — Central snapshot object
// ─────────────────────────────────────────────────────────────────────────
const lifecycleSymbolInfo = {
  id: 'lc-symbol-info',
  category: 'lifecycle',
  title: 'Lifecycle · SymbolInfo',
  subtitle:
    'Central snapshot for 1 symbol · 6 mutating sources (Init + Quote + BidOffer + Extra + MarketStatus + DealNotice) → realtime_mapSymbolInfo[code] → query-v2 + ws-v2 + Mongo snapshot',
  accent: '#60a5fa',
  nodes: [
    // ─── 6 mutators ──────────────────────────────────────────────────
    {
      id: 'init',
      kind: 'logic',
      layer: 'Init (start of day)',
      title: 'LotteApiSymbolInfoService.downloadSymbol()',
      subtitle: 'Baseline SymbolInfo map from REST',
      position: { x: 0, y: 0 },
      inputs: [{ name: 'Lotte REST', type: 'REST', description: 'securities-name/price, indexs-list, info, derivatives' }],
      outputs: [{ name: 'Map<code, SymbolInfo> baseline', type: 'HSET', description: 'Via InitService' }],
      details:
        'At start of day the collector calls 5 Lotte REST endpoints (securities-name, securities-price, indexs-list, indexs-info, derivatives-info), normalizes each record into a SymbolInfo, then MERGES them into a single Map<code, SymbolInfo> according to priority order.\n\n' +
        'After the merge:\n' +
        '  • If marketInit is enabled → call marketInit.init(allSymbols) directly (in-process)\n' +
        '  • Otherwise → publish batch via Kafka topic symbolInfoUpdate for realtime-v2 to consume\n\n' +
        'The result is that realtime-v2 HSETs everything into realtime_mapSymbolInfo[code] as baseline before streaming quote/bidoffer.',
    },
    {
      id: 'quote',
      kind: 'logic',
      layer: 'Mutator · Quote',
      title: 'QuoteService.updateQuote()',
      subtitle: 'Merge tick fields into SymbolInfo',
      position: { x: 0, y: ROW },
      inputs: [{ name: 'SymbolQuote', type: 'Kafka quoteUpdate', description: '' }],
      outputs: [{ name: 'merge fields: OHLC, volume, matchedBy, foreigner, session, sequence...', type: 'merge', description: '' }],
      details:
        'After reCalculate() finishes enriching SymbolQuote, this method reads the current SymbolInfo from cache, calls ConvertUtils.updateByQuote(symbolInfo, symbolQuote) to merge the fields:\n' +
        '  • OHLC (open/high/low/last), tradingVolume/Value, matchingVolume, matchedBy\n' +
        '  • foreignerMatchBuy/Sell Volume/Value, holdVolume/Ratio, buyAbleRatio\n' +
        '  • session (if the quote carries session info), quoteSequence++\n' +
        '  • updatedBy = "SymbolQuote", updatedAt = now\n\n' +
        'Finally HSETs realtime_mapSymbolInfo[code] with the new snapshot.',
    },
    {
      id: 'bidoffer',
      kind: 'logic',
      layer: 'Mutator · BidOffer',
      title: 'BidOfferService.updateBidOffer()',
      subtitle: 'Replace top book (3 price levels) in SymbolInfo',
      position: { x: 0, y: ROW * 2 },
      inputs: [{ name: 'BidOffer', type: 'Kafka bidOfferUpdate', description: '' }],
      outputs: [{ name: 'merge fields: bidOfferList(3), expectedPrice/Change/Rate, session, totals, bidAskSequence', type: 'merge', description: '' }],
      details:
        'Consumes Message<BidOffer> from Kafka then:\n' +
        '  1. Loads current SymbolInfo from cache (on miss → Redis HGET)\n' +
        '  2. Calls ConvertUtils.updateByBidOffer(symbolInfo, bidOffer) to OVERWRITE symbolInfo.bidOfferList = latest top book (3 bid levels + 3 ask levels)\n' +
        '  3. Merges totalBidVolume / totalAskVolume, expectedPrice/expectedChange/expectedRate (for ATO/ATC sessions)\n' +
        '  4. If BidOffer carries session → overwrite symbolInfo.session\n' +
        '  5. Increments bidAskSequence (a separate counter for the order book)\n' +
        '  6. HSET realtime_mapSymbolInfo[code]',
    },
    {
      id: 'extra',
      kind: 'logic',
      layer: 'Mutator · Extra',
      title: 'ExtraQuoteService.updateExtraQuote()',
      subtitle: 'Enrich basis / breakEven / PT summary',
      position: { x: 0, y: ROW * 3 },
      inputs: [{ name: 'ExtraQuote', type: 'Kafka extraUpdate/calExtraUpdate', description: '' }],
      outputs: [{ name: 'merge fields: basis, breakEven, ptVolume, ptValue, highYear, lowYear', type: 'merge', description: '' }],
      details:
        'ExtraQuote is an "enrichment event" — it has no state of its own, only to mutate target objects. This method:\n' +
        '  1. Ensures SymbolInfo exists\n' +
        '  2. Calls ConvertUtils.updateByExtraQuote(symbolInfo, extraQuote) to merge:\n' +
        '     – basis (for futures, = futuresLast − vn30Last)\n' +
        '     – breakEven (for covered warrants, CW)\n' +
        '     – ptVolume / ptValue (accumulated from DealNotice)\n' +
        '     – highYear / lowYear (when reCalculate detects a new yearly high/low)\n' +
        '  3. HSET realtime_mapSymbolInfo[code]\n\n' +
        'Also mutates ForeignerDaily and upserts SymbolDaily (see their separate lifecycles).',
    },
    {
      id: 'status',
      kind: 'logic',
      layer: 'Mutator · MarketStatus',
      title: 'MarketStatusService.updateMarketStatus()',
      subtitle: 'Propagate sessions on ATO/ATC',
      position: { x: 0, y: ROW * 4 },
      inputs: [{ name: 'MarketStatus', type: 'Kafka marketStatus', description: '' }],
      outputs: [{ name: 'set sessions for ALL SymbolInfo in the same market', type: 'broadcast', description: 'null when not ATO/ATC' }],
      details:
        'This is the ONLY "broadcast" mutator — 1 event can touch thousands of SymbolInfo entries.\n\n' +
        'On receiving MarketStatus (HOSE ATO, HNX ATC...):\n' +
        '  1. HSET realtime_mapMarketStatus[market_type] to store session state\n' +
        '  2. IF status ∈ {ATO, ATC}:\n' +
        '     – Iterate all SymbolInfo in the same market\n' +
        '     – Write symbolInfo.sessions = status for each symbol\n' +
        '     – HSET realtime_mapSymbolInfo[code] for every one of them\n' +
        '  3. IF other status → sessions = null (clear session flag)\n\n' +
        'This is why the "sessions" flag in SymbolInfo is consistent across a market.',
    },
    {
      id: 'deal',
      kind: 'logic',
      layer: 'Mutator · DealNotice',
      title: 'DealNoticeService.updateDealNotice()',
      subtitle: 'Accumulate ptTradingVolume / ptTradingValue',
      position: { x: 0, y: ROW * 5 },
      inputs: [{ name: 'DealNotice', type: 'Kafka dealNoticeUpdate', description: '' }],
      outputs: [{ name: 'merge: ptTradingVolume, ptTradingValue', type: 'merge', description: 'dedupe by confirmNumber' }],
      details:
        'Each matched put-through deal triggers an update to the symbol\'s PT totals.\n\n' +
        '  1. Ensure SymbolInfo for the symbol exists\n' +
        '  2. Load all existing DealNotice entries to DEDUPE by confirmNumber (Lotte may resend)\n' +
        '  3. Call ConvertUtils.updateByDealNotice(symbolInfo, dealNotice):\n' +
        '     – symbolInfo.ptTradingVolume += deal.volume\n' +
        '     – symbolInfo.ptTradingValue += deal.value\n' +
        '  4. HSET realtime_mapSymbolInfo[code]\n' +
        '  5. RPUSH realtime_listDealNotice_{market} to keep history (see DealNotice lifecycle)',
    },

    // ─── Central Redis ────────────────────────────────────────────────
    {
      id: 'redis',
      kind: 'redis',
      layer: 'Primary hot-state',
      title: 'realtime_mapSymbolInfo[code]',
      subtitle: 'Hash — single source of truth',
      position: { x: COL * 2, y: ROW * 2.5 },
      inputs: [{ name: 'HSET from 6 mutators', type: 'Redis', description: '' }],
      outputs: [{ name: 'query-v2 + ws-v2 + snapshot cron', type: 'Hash', description: '' }],
      details:
        'Redis hash key = realtime_mapSymbolInfo, field = code (e.g. "SHB", "VIC"), value = JSON SymbolInfo.\n\n' +
        'Typical fields: code/type/name, OHLC, change/rate, volume/value, matchedBy, referencePrice/ceiling/floor, bidOfferList[3], foreignerMatchBuy/Sell*, sessions, expectedPrice/Change/Rate, basis, breakEven, ptTradingVolume/Value, quoteSequence, bidAskSequence, updatedBy, updatedAt.\n\n' +
        'This is the "single source of truth" for realtime snapshots — every read (priceBoard, ranking, ws snapshot) goes through this key.',
    },

    // ─── Delivery ────────────────────────────────────────────────────
    {
      id: 'query',
      kind: 'api',
      layer: 'Delivery · market-query-v2',
      title: 'Query endpoints',
      subtitle: 'Read path HMGET/HGETALL',
      position: { x: COL * 4, y: ROW * 1 },
      inputs: [{ name: 'HMGET/HGETALL realtime_mapSymbolInfo', type: 'Redis', description: '' }],
      outputs: [
        { name: 'querySymbolLatestNormal', type: 'endpoint', description: 'Snapshot for 1 symbol' },
        { name: 'queryPriceBoard', type: 'endpoint', description: 'Price board per market' },
        { name: 'Ranking APIs (UpDown/Top/Period...)', type: 'endpoint', description: 'Sort by rate/volume/value' },
        { name: 'TradingView querySymbolInfo / querySymbolSearch', type: 'endpoint', description: 'Search + meta for TV' },
        { name: 'FIX queryFixSymbolList', type: 'endpoint', description: 'List for FIX gateway' },
      ],
      details:
        'All "snapshot-style" APIs read directly from this hash. When many symbols are needed (priceBoard, ranking) → a single HMGET fetches all of them — no need to re-call Lotte REST.\n\n' +
        'For INDEX (VNINDEX, HNX30...) data is also in the same hash as stocks — distinguished by the "type" field.',
    },
    {
      id: 'wsv2',
      kind: 'ws',
      layer: 'Delivery · ws-v2',
      title: 'Snapshot on subscribe',
      subtitle: 'convertSymbolInfoV2()',
      position: { x: COL * 4, y: ROW * 3.5 },
      inputs: [{ name: 'subscribe channel + returnSnapShot=true', type: 'WS', description: '' }],
      outputs: [{ name: 'market.returnSnapshot', type: 'WS frame', description: 'compact payload' }],
      details:
        'When a client subscribes to market.quote.{code} / market.bidoffer.{code} with returnSnapShot=true:\n' +
        '  1. ws-v2 HGETs realtime_mapSymbolInfo[code]\n' +
        '  2. Calls convertSymbolInfoV2() to "compact" the payload (shorten field names to save bandwidth)\n' +
        '  3. Pushes a market.returnSnapshot frame only to that client\n\n' +
        'This way a newly joined client immediately sees the latest state without waiting for the next tick.',
    },

    // ─── Persist & reset ─────────────────────────────────────────────
    {
      id: 'cron-persist',
      kind: 'schedule',
      layer: 'Cron · Persist',
      title: 'saveRedisToDatabase()',
      subtitle: '10:15/10:29/11:15/11:29/14:15/14:29',
      position: { x: COL * 2, y: 0 },
      inputs: [{ name: 'getAllSymbolInfo()', type: 'HGETALL', description: '' }],
      outputs: [{ name: 'bulk write c_symbol_info', type: 'Mongo', description: '' }],
      details:
        'Cron runs 6×/day covering the pre/post lunch break and market close windows.\n\n' +
        'Pipeline:\n' +
        '  1. HGETALL realtime_mapSymbolInfo → all active SymbolInfo\n' +
        '  2. Bulk upsert into Mongo c_symbol_info (_id = code_date)\n' +
        '  3. Used as fallback when Redis is flushed or for intraday lookups later.',
    },
    {
      id: 'cron-refresh',
      kind: 'schedule',
      layer: 'Cron · Refresh',
      title: 'refreshSymbolInfo()',
      subtitle: '01:35 MON-FRI',
      position: { x: COL * 2, y: ROW * 5 },
      inputs: [{ name: 'Spring @Scheduled', type: 'cron', description: '' }],
      outputs: [
        { name: 'reset sequence / matchingVolume / matchedBy', type: 'reset', description: '' },
        { name: 'reset bidOfferList + oddlotBidOfferList', type: 'reset', description: '' },
        { name: 'KEEP SymbolInfo map', type: 'preserve', description: 'Do not clear the whole map' },
      ],
      details:
        'Runs nightly at 01:35 to "clean up" SymbolInfo for a new day BUT does NOT delete the whole map (unlike removeAutoData).\n\n' +
        'Resets intraday fields:\n' +
        '  • sequence = 0, bidAskSequence = 0\n' +
        '  • matchingVolume = 0, matchedBy = null\n' +
        '  • bidOfferList = [] (old order book no longer valid)\n' +
        '  • oddlotBidOfferList = [] (same for SymbolInfoOddLot)\n\n' +
        'Baseline fields (code/name/type/referencePrice/ceiling/floor/listedQty) are preserved so a new day does not need to re-init from REST. Also calls cacheService.reset() to clear in-memory cache and avoid stale data.',
    },
    {
      id: 'mongo',
      kind: 'mongo',
      layer: 'Persistence',
      title: 'c_symbol_info',
      subtitle: 'Day-level snapshot',
      position: { x: COL * 4, y: 0 },
      inputs: [{ name: 'saveRedisToDatabase bulk', type: 'Mongo', description: '' }],
      outputs: [{ name: 'Fallback on Redis miss', type: 'find', description: '' }],
      details:
        '_id = code_yyyyMMdd, indexed by { code, date }.\n\n' +
        'Role: a slow snapshot only — not serving hot traffic. Realtime queries always prefer Redis first, falling back to Mongo only on miss (rare during trading hours).',
    },
  ],
  edges: [
    { source: 'init', target: 'redis', label: 'HSET init', animated: true },
    { source: 'quote', target: 'redis', label: 'HSET' },
    { source: 'bidoffer', target: 'redis', label: 'HSET' },
    { source: 'extra', target: 'redis', label: 'HSET' },
    { source: 'status', target: 'redis', label: 'HSET (broadcast)' },
    { source: 'deal', target: 'redis', label: 'HSET' },
    { source: 'redis', target: 'query', label: 'HMGET/HGETALL' },
    { source: 'redis', target: 'wsv2', label: 'getSymbolInfo(code)' },
    { source: 'redis', target: 'cron-persist', label: 'getAllSymbolInfo' },
    { source: 'cron-persist', target: 'mongo', label: 'bulk write', animated: true },
    { source: 'cron-refresh', target: 'redis', label: 'reset partial fields' },
  ],
};

// ─────────────────────────────────────────────────────────────────────────
// 2. SymbolQuote — Intraday tick event
// ─────────────────────────────────────────────────────────────────────────
const lifecycleSymbolQuote = {
  id: 'lc-symbol-quote',
  category: 'lifecycle',
  title: 'Lifecycle · SymbolQuote',
  subtitle:
    'Intraday source tick · auto.qt/idxqt/futures → collector → Kafka → realtime-v2 · reCalculate enriches, then fans out to 6 Redis keys + calExtraUpdate',
  accent: '#34d399',
  nodes: [
    {
      id: 'ws',
      kind: 'source',
      layer: 'Lotte WS',
      title: 'auto.qt / auto.idxqt / futures quote',
      subtitle: 'Tick feed from Lotte',
      position: { x: 0, y: ROW * 1.5 },
      inputs: [{ name: 'subscribe', type: 'WS', description: '' }],
      outputs: [{ name: 'raw text pipe-delimited', type: 'string', description: '' }],
      details:
        'The collector subscribes to 3 separate channels:\n' +
        '  • auto.qt.<code>   → stock ticks\n' +
        '  • auto.idxqt.<code> → index ticks\n' +
        '  • futures quote feed → derivatives ticks\n\n' +
        'Each frame is a string delimited by "|" per the Lotte spec and must be parsed manually.',
    },
    {
      id: 'collector',
      kind: 'logic',
      layer: 'Collector',
      title: 'RealTimeConnectionHandler + ThreadHandler',
      subtitle: 'Receive → parse → enqueue',
      position: { x: COL, y: ROW * 1.5 },
      inputs: [{ name: 'receivePacket → handle()', type: 'call', description: '' }],
      outputs: [{ name: 'handleAutoData(Stock/Index/FuturesUpdateData)', type: 'call', description: '' }],
      details:
        'Processing pipeline in the collector:\n' +
        '  1. RealTimeConnectionHandler.receivePacket() receives raw frames from the Lotte WS\n' +
        '  2. ThreadHandler.handle() pushes into the thread pool partitioned per code to keep ordering\n' +
        '  3. parse(): split the fields by position\n' +
        '  4. validate(): check the code is valid and sequence does not go backwards\n' +
        '  5. formatTime(): convert time HHmmss → milliseconds + date\n' +
        '  6. formatRefCode(): for futures, set refCode (underlying contract code)\n' +
        '  7. Finally call the appropriate handleAutoData() (Stock/Index/Futures) to publish to Kafka',
    },
    {
      id: 'kafka',
      kind: 'kafka',
      layer: 'Kafka',
      title: 'quoteUpdate / quoteUpdateDR',
      subtitle: 'Message<SymbolQuote> · 2 topics split by market',
      position: { x: COL * 2, y: ROW * 1.5 },
      inputs: [{ name: 'producer collector — WsConnectionThread.run()', type: 'Kafka', description: 'sendMessageSafe, picks topic by object type' }],
      outputs: [{ name: 'realtime-v2 + ws-v2 consume', type: 'Kafka', description: '' }],
      details:
        'The collector splits quotes into 2 topics by market type:\n' +
        '  • quoteUpdate     → Equity / Index / CW / ETF (cash market)\n' +
        '  • quoteUpdateDR   → DR / Futures (derivatives, VN30F*, VN30F2503, ...)\n\n' +
        'DR = Derivatives. Both topics share the Message<SymbolQuote> schema, split in order to:\n' +
        '  • Have separate partitions for derivatives (different tick rate / pattern from cash)\n' +
        '  • Let ws-v2 map to 2 separate channels: market.quote.{code} and market.quote.dr.{code}\n' +
        '  • Consumers that only care about one type can subscribe to just one topic\n\n' +
        'Partition key = code so ticks for the same symbol land on the same partition (preserving order).',
    },
    {
      id: 'handler',
      kind: 'logic',
      layer: 'realtime-v2',
      title: 'QuoteUpdateHandler → MonitorService',
      subtitle: 'Enqueue per-code',
      position: { x: COL * 3, y: ROW * 1.5 },
      inputs: [{ name: 'rcv(symbolQuote)', type: 'enqueue', description: '' }],
      outputs: [{ name: 'QuoteService.updateQuote(symbolQuote)', type: 'call', description: '' }],
      details:
        'QuoteUpdateHandler consumes Kafka then pushes into MonitorService — a separate queue per code so ticks for the same symbol are processed SEQUENTIALLY (no race condition when updating statistic/daily/foreigner concurrently).\n\n' +
        'MonitorService.handler() pops the event → calls QuoteService.updateQuote().',
    },
    {
      id: 'recalc',
      kind: 'logic',
      layer: 'QuoteService',
      title: 'reCalculate(symbolQuote)',
      subtitle: 'Validate + enrich tick',
      position: { x: COL * 4, y: ROW * 1.5 },
      inputs: [{ name: 'SymbolQuote', type: 'object', description: '' }],
      outputs: [
        { name: '1) validate SymbolInfo + wrong-order volume', type: 'check', description: '' },
        { name: '2) date/createdAt/updatedAt/milliseconds', type: 'set', description: '' },
        { name: '3) id = code + "_" + date + "_" + tradingVolume', type: 'set', description: '' },
        { name: '4) STOCK: foreignerMatchBuy/Sell + holdVolume/Ratio + buyAbleRatio', type: 'compute', description: '' },
        { name: '5) FUTURES: set refCode', type: 'set', description: '' },
        { name: '6) IF high/low year changes → publish calExtraUpdate', type: 'producer', description: '' },
      ],
      details:
        'Critical "gatekeeper" step — any tick not passing this step is dropped.\n\n' +
        'Logic:\n' +
        '  1. Check that SymbolInfo for the code is already loaded (if not → skip)\n' +
        '  2. Check the new tick\'s tradingVolume MUST be ≥ the volume seen so far (avoid wrong-order — Lotte sometimes resends out of order)\n' +
        '  3. Normalize time: tick.time (HHmmss) → milliseconds, set date, createdAt, updatedAt\n' +
        '  4. Build id = code_date_tradingVolume (unique, idempotent)\n' +
        '  5. For type=STOCK: also compute foreignerMatchBuy/SellVolume, holdVolume = foreignerTotalRoom − foreignerCurrentRoom, holdRatio = holdVolume / listedQty, buyAbleRatio = foreignerCurrentRoom / listedQty\n' +
        '  6. For type=FUTURES: set refCode = underlying contract code (VN30F2501 → VN30F)\n' +
        '  7. If tick.last creates a new yearly HIGH/LOW → also publish calExtraUpdate to update highYear/lowYear (handled by ExtraQuoteService)',
    },
    {
      id: 'update',
      kind: 'logic',
      layer: 'QuoteService',
      title: 'updateQuote() fanout',
      subtitle: 'Distribute the enriched tick',
      position: { x: COL * 5, y: ROW * 1.5 },
      inputs: [{ name: 'enriched SymbolQuote', type: 'object', description: '' }],
      outputs: [
        { name: '→ SymbolStatistic', type: 'update', description: '' },
        { name: '→ SymbolInfo', type: 'update', description: '' },
        { name: '→ ForeignerDaily', type: 'update', description: '' },
        { name: '→ SymbolDaily', type: 'update', description: '' },
        { name: '→ SymbolQuoteMinute (create/update)', type: 'update', description: '' },
        { name: '→ RPUSH realtime_listQuote_{code}', type: 'append', description: '' },
        { name: '→ update realtime_listQuoteMeta_{code}', type: 'update', description: '' },
      ],
      details:
        'After reCalculate() succeeds, the tick is "fanned out" into 7 write paths in the same logical transaction:\n\n' +
        '  • SymbolStatistic: add to the price bucket (non-INDEX)\n' +
        '  • SymbolInfo: merge OHLC/volume/matchedBy via ConvertUtils.updateByQuote\n' +
        '  • ForeignerDaily: foreignerDaily.updateByQuote()\n' +
        '  • SymbolDaily: ConvertUtils.updateDailyByQuote()\n' +
        '  • SymbolQuoteMinute: create a new bar if the minute advanced, update high/low/close/volume if same minute\n' +
        '  • realtime_listQuote_{code}: RPUSH the enriched tick for history querying\n' +
        '  • realtime_listQuoteMeta_{code}: update partition meta for paging',
    },

    // ─── Redis keys destination ──────────────────────────────────────
    {
      id: 'r-tick',
      kind: 'redis',
      layer: 'Redis',
      title: 'realtime_listQuote_{code}',
      subtitle: 'List<SymbolQuote>',
      position: { x: COL * 6, y: 0 },
      inputs: [{ name: 'RPUSH', type: 'Redis', description: '' }],
      outputs: [{ name: 'query tick pagination', type: 'list', description: '' }],
      details:
        'Redis list holding ALL enriched ticks of the symbol for the day. The key may have a _partition suffix when the list exceeds the threshold — see ListQuoteMeta lifecycle.\n\n' +
        'Used by querySymbolQuote/queryQuoteData (client scrolling trade-match history).',
    },
    {
      id: 'r-meta',
      kind: 'redis',
      layer: 'Redis',
      title: 'realtime_listQuoteMeta_{code}',
      subtitle: 'Encoded partition meta',
      position: { x: COL * 6, y: ROW * 0.7 },
      inputs: [{ name: 'SET encoded', type: 'Redis', description: '' }],
      outputs: [{ name: 'paging key for queries', type: 'string', description: '' }],
      details:
        'An encoded string of the form "partition|fromVolume|toVolume|totalItems;..." — stores the list of partitions and volume range for each partition.\n\n' +
        'Queries need only read this single meta key to know which list to LRANGE.',
    },
    {
      id: 'r-info',
      kind: 'redis',
      layer: 'Redis',
      title: 'realtime_mapSymbolInfo[code]',
      subtitle: 'Hash snapshot',
      position: { x: COL * 6, y: ROW * 1.4 },
      inputs: [{ name: 'HSET', type: 'Redis', description: '' }],
      outputs: [{ name: 'priceBoard + ws snapshot', type: 'hash', description: '' }],
      details:
        'See SymbolInfo lifecycle. Each tick updates: last, high/low, volume, value, matchedBy, foreigner*, quoteSequence++, updatedBy="SymbolQuote".',
    },
    {
      id: 'r-foreigner',
      kind: 'redis',
      layer: 'Redis',
      title: 'realtime_mapForeignerDaily[code]',
      subtitle: 'Hash',
      position: { x: COL * 6, y: ROW * 2.1 },
      inputs: [{ name: 'HSET', type: 'Redis', description: '' }],
      outputs: [{ name: 'foreigner intraday', type: 'hash', description: '' }],
      details:
        'Intraday foreign investor state for the symbol. Each tick → foreignerDaily.updateByQuote(quote) accumulates foreignerBuy/SellVolume/Value + updates foreignerCurrentRoom.',
    },
    {
      id: 'r-daily',
      kind: 'redis',
      layer: 'Redis',
      title: 'realtime_mapSymbolDaily[code]',
      subtitle: 'Daily OHLCV hash',
      position: { x: COL * 6, y: ROW * 2.8 },
      inputs: [{ name: 'HSET', type: 'Redis', description: '' }],
      outputs: [{ name: 'today\'s daily OHLCV', type: 'hash', description: '' }],
      details:
        'Today\'s daily is upserted on every tick via ConvertUtils.updateDailyByQuote. At end of trading, saveRedisToDatabase() bulk-writes to c_symbol_daily.',
    },
    {
      id: 'r-minute',
      kind: 'redis',
      layer: 'Redis',
      title: 'realtime_listQuoteMinute_{code}',
      subtitle: 'Minute bars list',
      position: { x: COL * 6, y: ROW * 3.5 },
      inputs: [{ name: 'create/update', type: 'Redis', description: '' }],
      outputs: [{ name: 'minute chart', type: 'list', description: '' }],
      details:
        'Each tick checks the current minute bar:\n' +
        '  • New minute → RPUSH a new bar\n' +
        '  • Same minute → LSET the last element with high/low/close/volume update\n' +
        '  • Tick older than current minute → skip',
    },
    {
      id: 'r-stat',
      kind: 'redis',
      layer: 'Redis',
      title: 'realtime_mapSymbolStatistic[code]',
      subtitle: 'Hash aggregated by price',
      position: { x: COL * 6, y: ROW * 4.2 },
      inputs: [{ name: 'HSET (non-INDEX)', type: 'Redis', description: '' }],
      outputs: [{ name: 'matched aggregate', type: 'hash', description: '' }],
      details:
        'Aggregates matched volume per price level. NOT applied to INDEX (indices have no trade match).\n\n' +
        'Each tick adds to the price bucket = tick.last: matchedVolume += tick.matchingVolume, matchedBuy/Sell depending on matchedBy.',
    },

    // ─── Delivery ────────────────────────────────────────────────────
    {
      id: 'query',
      kind: 'api',
      layer: 'Delivery',
      title: 'market-query-v2 endpoints',
      subtitle: 'Tick history query',
      position: { x: COL * 7.5, y: ROW * 1 },
      inputs: [{ name: 'LRANGE + meta', type: 'Redis', description: '' }],
      outputs: [
        { name: 'querySymbolQuote / queryQuoteData', type: 'endpoint', description: 'paging by volume/index' },
        { name: 'querySymbolQuoteTick', type: 'endpoint', description: 'last N ticks' },
        { name: 'querySymbolTickSizeMatch', type: 'endpoint', description: 'matched statistics by tickSize' },
      ],
      details:
        'All tick queries for today go through realtime_listQuote_* + meta. Mongo is not read because enableSaveQuote=false.',
    },
    {
      id: 'wsv2',
      kind: 'ws',
      layer: 'Delivery',
      title: 'ws-v2 broadcast',
      subtitle: 'convertDataPublishV2Quote()',
      position: { x: COL * 7.5, y: ROW * 3 },
      inputs: [{ name: 'consume quoteUpdate', type: 'Kafka', description: 'direct' }],
      outputs: [{ name: 'publish market.quote.{code}', type: 'channel', description: '' }],
      details:
        'ws-v2 consumes Kafka quoteUpdate directly (does not wait for realtime-v2 enrichment), calls convertDataPublishV2Quote() to compact the payload (short field names), then publishes the market.quote.{code} channel to all subscribers.',
    },

    // ─── Reset ────────────────────────────────────────────────────────
    {
      id: 'cron-reset',
      kind: 'schedule',
      layer: 'Cron',
      title: 'removeAutoData() 00:55',
      subtitle: 'End-of-day clear',
      position: { x: COL * 6, y: ROW * 5 },
      inputs: [{ name: '@Scheduled', type: 'cron', description: '' }],
      outputs: [
        { name: 'clear realtime_listQuote_*', type: 'del', description: '' },
        { name: 'clear realtime_listQuoteMeta_*', type: 'del', description: '' },
        { name: 'clear wrong-order quote', type: 'del', description: '' },
      ],
      details:
        'Runs 00:55 MON-FRI — deletes all previous-day ticks + meta to make room for the new day.\n\n' +
        'Note: enableSaveQuote=false → no persist step to Mongo before deletion. That means after 00:55 previous-day ticks are completely gone.',
    },
  ],
  edges: [
    { source: 'ws', target: 'collector', label: 'raw', animated: true },
    { source: 'collector', target: 'kafka', label: 'sendMessageSafe', animated: true },
    { source: 'kafka', target: 'handler', label: 'consume', animated: true },
    { source: 'handler', target: 'recalc', label: 'updateQuote()' },
    { source: 'recalc', target: 'update', label: 'enriched' },
    { source: 'recalc', target: 'kafka', label: 'calExtraUpdate (high/low year)', animated: true },
    { source: 'update', target: 'r-tick', label: 'RPUSH' },
    { source: 'update', target: 'r-meta', label: 'SET' },
    { source: 'update', target: 'r-info', label: 'HSET' },
    { source: 'update', target: 'r-foreigner', label: 'HSET' },
    { source: 'update', target: 'r-daily', label: 'HSET' },
    { source: 'update', target: 'r-minute', label: 'create/update' },
    { source: 'update', target: 'r-stat', label: 'HSET (non-INDEX)' },
    { source: 'r-tick', target: 'query', label: 'LRANGE' },
    { source: 'r-meta', target: 'query', label: 'partition' },
    { source: 'kafka', target: 'wsv2', label: 'consume direct', animated: true },
    { source: 'cron-reset', target: 'r-tick', label: 'clear' },
    { source: 'cron-reset', target: 'r-meta', label: 'clear' },
  ],
};

// ─────────────────────────────────────────────────────────────────────────
// 3. ListQuoteMeta / QuotePartition
// ─────────────────────────────────────────────────────────────────────────
const lifecycleListQuoteMeta = {
  id: 'lc-list-quote-meta',
  category: 'lifecycle',
  title: 'Lifecycle · ListQuoteMeta / QuotePartition',
  subtitle:
    'Technical metadata for paginating large tick lists · produced by QuoteService.addSymbolQuote · consumed by querySymbolQuote/queryQuoteData',
  accent: '#fbbf24',
  nodes: [
    {
      id: 'src-quote',
      kind: 'logic',
      layer: 'Producer',
      title: 'QuoteService.addSymbolQuote(symbolQuote)',
      subtitle: 'Append tick + rebalance partition',
      position: { x: 0, y: ROW },
      inputs: [{ name: 'SymbolQuote (validated)', type: 'object', description: '' }],
      outputs: [
        { name: 'append tick to default / overflow partition', type: 'RPUSH', description: '' },
        { name: 'update ListQuoteMeta { partitions[] }', type: 'update', description: '' },
      ],
      details:
        'Called at the final step of updateQuote(), responsible for writing the tick to the correct partition:\n\n' +
        '  1. Read current ListQuoteMeta (if missing → create default partition=-1 with fromVolume=0)\n' +
        '  2. Determine the active (last) partition\n' +
        '  3. If len(partition) < LIMIT → RPUSH into the current partition\n' +
        '  4. If len(partition) ≥ LIMIT → create a new overflow partition with fromVolume = tick.tradingVolume\n' +
        '  5. Update partitions[] with the new totalItems + persist meta\n\n' +
        'Goal: bound the size of each Redis list so LRANGE stays fast.',
    },
    {
      id: 'r-meta',
      kind: 'redis',
      layer: 'Redis · Meta',
      title: 'realtime_listQuoteMeta_{code}',
      subtitle: 'SET encoded string',
      position: { x: COL * 1.5, y: ROW * 0.5 },
      inputs: [{ name: 'SET', type: 'Redis', description: '' }],
      outputs: [{ name: 'encoded format: partition|fromVolume|toVolume|totalItems;...', type: 'string', description: 'e.g. "-1|0|50000000|8928"' }],
      details:
        'Uses SET (not HSET) — 1 key = 1 encoded string readable with a single GET.\n\n' +
        'Parsed on the client/service side: split(";") → each entry split("|") into { partition, fromVolume, toVolume, totalItems }.\n\n' +
        'partition = -1 is the "default", positive numbers are overflow.',
    },
    {
      id: 'r-tick',
      kind: 'redis',
      layer: 'Redis · Data',
      title: 'realtime_listQuote_{code}[_partition]',
      subtitle: 'List<SymbolQuote>',
      position: { x: COL * 1.5, y: ROW * 1.5 },
      inputs: [{ name: 'RPUSH per partition', type: 'Redis', description: '' }],
      outputs: [{ name: 'LRANGE per partition', type: 'list', description: '' }],
      details:
        'Key naming:\n' +
        '  • realtime_listQuote_SHB      → default partition (-1)\n' +
        '  • realtime_listQuote_SHB_1    → overflow partition #1\n' +
        '  • realtime_listQuote_SHB_2    → overflow partition #2\n' +
        '  ...\n\n' +
        'Each element is a fully enriched SymbolQuote JSON.',
    },

    {
      id: 'q-symbol',
      kind: 'api',
      layer: 'Query',
      title: 'querySymbolQuote()',
      subtitle: 'Paging by lastTradingVolume',
      position: { x: COL * 3, y: 0 },
      inputs: [
        { name: 'symbol', type: 'string', description: '' },
        { name: 'lastTradingVolume', type: 'long', description: '' },
      ],
      outputs: [
        { name: '1) read meta', type: 'GET', description: '' },
        { name: '2) if missing → pseudo default partition -1', type: 'fallback', description: '' },
        { name: '3) pick partition by fromVolume/toVolume', type: 'lookup', description: '' },
        { name: '4) LRANGE realtime_listQuote_{symbol}[_p]', type: 'Redis', description: '' },
        { name: '5) filter by lastTradingVolume', type: 'compute', description: '' },
        { name: '6) return SymbolQuoteResponse[]', type: 'response', description: '' },
      ],
      details:
        'Main use-case: client scrolls the tick feed — each call passes lastTradingVolume = the volume of the last tick shown; service returns ticks with volume > that value.\n\n' +
        'Thanks to meta, the service does not LRANGE the entire list — only the partition that contains the required volume range.',
    },
    {
      id: 'q-data',
      kind: 'api',
      layer: 'Query',
      title: 'queryQuoteData()',
      subtitle: 'Paging by lastIndex',
      position: { x: COL * 3, y: ROW * 1.4 },
      inputs: [
        { name: 'symbol', type: 'string', description: '' },
        { name: 'lastIndex', type: 'int', description: '' },
      ],
      outputs: [{ name: 'Same meta, paginate by index instead of volume', type: 'compute', description: '' }],
      details:
        'Variant of querySymbolQuote for clients paginating by INDEX (tick ordinal) instead of volume.\n\n' +
        'Uses the same meta but accumulates totalItems to determine which partition contains lastIndex.',
    },

    {
      id: 'cron-reset',
      kind: 'schedule',
      layer: 'Cron',
      title: 'removeAutoData() 00:55',
      subtitle: 'Clear meta + ticks',
      position: { x: COL * 1.5, y: ROW * 2.8 },
      inputs: [{ name: '@Scheduled', type: 'cron', description: '' }],
      outputs: [{ name: 'clear realtime_listQuoteMeta_*', type: 'del', description: '' }],
      details:
        'Delete all meta + tick lists so the new day starts clean. If meta is not cleared while new-day ticks arrive → paging becomes completely wrong.',
    },
  ],
  edges: [
    { source: 'src-quote', target: 'r-tick', label: 'RPUSH' },
    { source: 'src-quote', target: 'r-meta', label: 'SET meta' },
    { source: 'r-meta', target: 'q-symbol', label: 'read' },
    { source: 'r-tick', target: 'q-symbol', label: 'LRANGE' },
    { source: 'r-meta', target: 'q-data', label: 'read' },
    { source: 'r-tick', target: 'q-data', label: 'LRANGE' },
    { source: 'cron-reset', target: 'r-meta', label: 'clear' },
    { source: 'cron-reset', target: 'r-tick', label: 'clear' },
  ],
};

// ─────────────────────────────────────────────────────────────────────────
// 4. SymbolQuoteMinute
// ─────────────────────────────────────────────────────────────────────────
const lifecycleSymbolQuoteMinute = {
  id: 'lc-symbol-quote-minute',
  category: 'lifecycle',
  title: 'Lifecycle · SymbolQuoteMinute',
  subtitle:
    'Minute bars — not from a direct feed but derived from SymbolQuote inside QuoteService.updateQuote',
  accent: '#a78bfa',
  nodes: [
    {
      id: 'src',
      kind: 'logic',
      layer: 'Derived from Quote',
      title: 'QuoteService.updateQuote()',
      subtitle: 'On each new tick → evaluate the minute bar',
      position: { x: 0, y: ROW },
      inputs: [{ name: 'SymbolQuote (enriched)', type: 'object', description: '' }],
      outputs: [{ name: 'fetch current minute bar from cache/Redis', type: 'read', description: '' }],
      details:
        'When a new tick arrives, the service reads the currently OPEN minute bar (last element of realtime_listQuoteMinute_{code}) to decide create/update/skip.\n\n' +
        'There is no dedicated feed for minute bars — all minute bars are derived state from SymbolQuote.',
    },
    {
      id: 'decide',
      kind: 'logic',
      layer: 'Decision',
      title: 'Evaluate minute bar',
      subtitle: '3 branches based on tick time',
      position: { x: COL, y: ROW },
      inputs: [{ name: 'currentMinute + quote', type: 'object', description: '' }],
      outputs: [
        { name: 'currentMinute==null or new minute → CREATE', type: 'branch', description: 'from quote' },
        { name: 'same minute → UPDATE high/low/close/volume/value', type: 'branch', description: '' },
        { name: 'quote older than current minute → SKIP', type: 'branch', description: '' },
      ],
      details:
        'Logic compares tick.time (HHmm) vs currentMinute.time:\n\n' +
        '  • CREATE: when no bar exists OR tick.time > currentMinute.time\n' +
        '    – open = tick.last, high = tick.last, low = tick.last, close = tick.last\n' +
        '    – volume = tick.matchingVolume, value = tick.matchingValue\n' +
        '    – periodTradingVolume = delta volume vs previous minute\n\n' +
        '  • UPDATE: when tick.time == currentMinute.time\n' +
        '    – high = max(high, tick.last)\n' +
        '    – low = min(low, tick.last)\n' +
        '    – close = tick.last (always overwrite)\n' +
        '    – volume/value accumulate\n\n' +
        '  • SKIP: tick.time < currentMinute.time (old tick, likely a Lotte resend) → skip to avoid overwriting a closed bar.',
    },
    {
      id: 'r-minute',
      kind: 'redis',
      layer: 'Redis output',
      title: 'realtime_listQuoteMinute_{code}',
      subtitle: 'List<SymbolQuoteMinute>',
      position: { x: COL * 2.2, y: ROW },
      inputs: [{ name: 'RPUSH or LSET last', type: 'Redis', description: '' }],
      outputs: [{ name: 'ordered minute bars', type: 'list', description: '' }],
      details:
        'Each SymbolQuoteMinute element:\n' +
        '  { code, time (HHmmss), milliseconds, open, high, low, last, tradingVolume, tradingValue, periodTradingVolume, date }\n\n' +
        'periodTradingVolume = delta volume for this minute (not accumulated). Used to draw the volume column below the candle.\n' +
        'tradingVolume = accumulated volume since start of day.',
    },
    {
      id: 'q',
      kind: 'api',
      layer: 'Delivery',
      title: 'market-query-v2',
      subtitle: 'Minute chart endpoints',
      position: { x: COL * 3.5, y: 0 },
      inputs: [{ name: 'LRANGE realtime_listQuoteMinute_{code}', type: 'Redis', description: '' }],
      outputs: [
        { name: 'querySymbolQuoteMinutes', type: 'endpoint', description: 'raw bars' },
        { name: 'queryMinuteChartBySymbol', type: 'endpoint', description: 'for minute chart UI' },
        { name: 'queryTradingViewHistory intraday', type: 'endpoint', description: 'UDF for TradingView' },
      ],
      details:
        'Reads from Redis only — NO Mongo fallback for minute bars because persistence is disabled (see cron-persist).\n\n' +
        'The TradingView history endpoint only returns minute bars within today; timeframes > 1 day switch to SymbolDaily.',
    },
    {
      id: 'wsv2',
      kind: 'ws',
      layer: 'Delivery',
      title: 'ws-v2 broadcast',
      subtitle: 'No dedicated channel',
      position: { x: COL * 3.5, y: ROW * 1.4 },
      inputs: [{ name: 'quoteUpdate parser computes minute', type: 'Kafka', description: '' }],
      outputs: [{ name: 'no dedicated channel for minute', type: 'note', description: 'Client aggregates from market.quote.{code}' }],
      details:
        'ws-v2 does NOT publish a dedicated channel for minute bars — the client subscribes to market.quote.{code} and aggregates into minutes on the UI for the lowest realtime latency.\n\n' +
        'Redis minute bars only serve history load when the chart opens.',
    },
    {
      id: 'cron-reset',
      kind: 'schedule',
      layer: 'Cron',
      title: 'removeAutoData() 00:55',
      subtitle: 'Clear minute list',
      position: { x: COL * 2.2, y: ROW * 2.3 },
      inputs: [{ name: '@Scheduled', type: 'cron', description: '' }],
      outputs: [{ name: 'clear realtime_listQuoteMinute_*', type: 'del', description: '' }],
      details:
        'Deletes all previous-day minute bars. Along with the tick list, these are intraday data not kept overnight.',
    },
    {
      id: 'cron-persist',
      kind: 'schedule',
      layer: 'Cron',
      title: 'saveRedisToDatabase()',
      subtitle: 'Code path exists but disabled',
      position: { x: COL * 2.2, y: ROW * 3.2 },
      inputs: [{ name: '@Scheduled', type: 'cron', description: '' }],
      outputs: [{ name: 'OFF runtime (enableSaveQuoteMinute=false)', type: 'skip', description: '' }],
      details:
        'The code contains a persist branch for minute → c_symbol_quote_minute, but the current runtime config enableSaveQuoteMinute=false so it is skipped.\n\n' +
        'Consequence: today\'s minute bars exist only in Redis; minute bars for prior days cannot be retrieved from the DB — historical minute data must be aggregated from SymbolDaily via TradingView or requested from Lotte.',
    },
  ],
  edges: [
    { source: 'src', target: 'decide', label: 'evaluate' },
    { source: 'decide', target: 'r-minute', label: 'create/update/skip' },
    { source: 'r-minute', target: 'q', label: 'LRANGE' },
    { source: 'cron-reset', target: 'r-minute', label: 'clear' },
    { source: 'cron-persist', target: 'r-minute', label: 'read (skipped)' },
  ],
};

// ─────────────────────────────────────────────────────────────────────────
// 5. SymbolStatistic
// ─────────────────────────────────────────────────────────────────────────
const lifecycleSymbolStatistic = {
  id: 'lc-symbol-statistic',
  category: 'lifecycle',
  title: 'Lifecycle · SymbolStatistic',
  subtitle:
    'Intraday aggregate by price level · updated on every tick (non-INDEX) · publishes statisticUpdate with 1 price entry',
  accent: '#f472b6',
  nodes: [
    {
      id: 'src',
      kind: 'logic',
      layer: 'Derived from Quote',
      title: 'QuoteService.updateQuote()',
      subtitle: 'Gate: type != INDEX',
      position: { x: 0, y: ROW },
      inputs: [{ name: 'SymbolQuote', type: 'object', description: '' }],
      outputs: [{ name: 'lookup current statistic for code', type: 'read', description: '' }],
      details:
        'Before computing statistics, the service checks the symbol type:\n' +
        '  • type ∈ { STOCK, CW, ETF, FUTURES } → perform aggregation\n' +
        '  • type == INDEX → SKIP (indices have no price-level trade matching)\n\n' +
        'If qualified, read current realtime_mapSymbolStatistic[code] from cache/Redis.',
    },
    {
      id: 'bucket',
      kind: 'logic',
      layer: 'Compute',
      title: 'Price bucket merge',
      subtitle: 'Accumulate into bucket = quote.last',
      position: { x: COL, y: ROW },
      inputs: [{ name: 'current statistic + quote', type: 'object', description: '' }],
      outputs: [
        { name: 'add matchedVolume', type: 'compute', description: '' },
        { name: 'matchedBy=BID → matchedBuyVolume', type: 'compute', description: '' },
        { name: 'matchedBy=ASK → matchedSellVolume', type: 'compute', description: '' },
        { name: 'matchedBy=null → matchedUnknownVolume', type: 'compute', description: '' },
        { name: 'recompute matchedRatio / buyRatio / sellRatio', type: 'compute', description: '' },
        { name: 'update totalBuyVolume / totalSellVolume', type: 'compute', description: '' },
      ],
      details:
        'Bucket logic (bucket is identified by price = tick.last):\n\n' +
        '  1. Find bucket with price == tick.last; if none → create new\n' +
        '  2. bucket.matchedVolume += tick.matchingVolume\n' +
        '  3. Classify by matchedBy:\n' +
        '     – BID → matchedBuyVolume += matchingVolume\n' +
        '     – ASK → matchedSellVolume += matchingVolume\n' +
        '     – null → matchedUnknownVolume += matchingVolume (when Lotte does not specify)\n' +
        '  4. Recompute ratios inside the bucket: matchedRaito/buyRaito/sellRaito = volume/matchedVolume\n' +
        '  5. Aggregate at the symbol level: totalBuyVolume = sum(matchedBuyVolume over all buckets), same for totalSellVolume',
    },
    {
      id: 'r',
      kind: 'redis',
      layer: 'Redis output',
      title: 'realtime_mapSymbolStatistic[code]',
      subtitle: 'Hash — aggregate snapshot',
      position: { x: COL * 2.2, y: ROW },
      inputs: [{ name: 'HSET', type: 'Redis', description: '' }],
      outputs: [{ name: 'statistic snapshot', type: 'hash', description: '' }],
      details:
        'Shape:\n' +
        '{\n' +
        '  code, type, time, tradingVolume,\n' +
        '  totalBuyVolume, totalBuyRaito,\n' +
        '  totalSellVolume, totalSellRaito,\n' +
        '  prices: [\n' +
        '    { price, matchedVolume, matchedRaito,\n' +
        '      matchedBuyVolume, buyRaito,\n' +
        '      matchedSellVolume, sellRaito }, ...\n' +
        '  ]\n' +
        '}\n\n' +
        'Note: Raito is a legacy typo (should be Ratio).',
    },
    {
      id: 'kafka-stat',
      kind: 'kafka',
      layer: 'Kafka',
      title: 'topic statisticUpdate',
      subtitle: 'Delta event — 1 price entry',
      position: { x: COL * 2.2, y: ROW * 2 },
      inputs: [{ name: 'publish delta of 1 price entry', type: 'Kafka', description: '' }],
      outputs: [{ name: 'ws-v2 consumer', type: 'Kafka', description: '' }],
      details:
        'Instead of publishing the whole statistic (could be dozens of price buckets), the service publishes only the bucket that just changed (1 price entry) via statisticUpdate.\n\n' +
        'ws-v2 merges this delta into the payload before pushing to the client to reduce bandwidth.',
    },
    {
      id: 'q',
      kind: 'api',
      layer: 'Delivery',
      title: 'market-query-v2',
      subtitle: 'querySymbolStatistics',
      position: { x: COL * 3.5, y: ROW },
      inputs: [{ name: 'HGET realtime_mapSymbolStatistic', type: 'Redis', description: '' }],
      outputs: [{ name: 'querySymbolStatistics', type: 'endpoint', description: '' }],
      details:
        'Client loads the "Matched statistics by price" modal — a single HGET fetches the whole snapshot.',
    },
    {
      id: 'wsv2',
      kind: 'ws',
      layer: 'Delivery',
      title: 'ws-v2',
      subtitle: 'market.statistic.{code}',
      position: { x: COL * 3.5, y: ROW * 2 },
      inputs: [{ name: 'consume statisticUpdate', type: 'Kafka', description: '' }],
      outputs: [{ name: 'publish market.statistic.{code}', type: 'channel', description: '' }],
      details:
        'Client subscribes to this channel to receive realtime deltas to update the currently viewed bucket without reloading the entire modal.',
    },
    {
      id: 'cron-reset',
      kind: 'schedule',
      layer: 'Cron',
      title: 'removeAutoData() 00:55',
      subtitle: '',
      position: { x: COL * 2.2, y: ROW * 3.1 },
      inputs: [{ name: '@Scheduled', type: 'cron', description: '' }],
      outputs: [{ name: 'clear market statistic', type: 'del', description: '' }],
      details:
        'Delete realtime_mapSymbolStatistic so the new day starts with empty statistics. Not persisted to Mongo.',
    },
  ],
  edges: [
    { source: 'src', target: 'bucket', label: 'compute' },
    { source: 'bucket', target: 'r', label: 'HSET' },
    { source: 'bucket', target: 'kafka-stat', label: 'publish delta', animated: true },
    { source: 'r', target: 'q', label: 'HGET' },
    { source: 'kafka-stat', target: 'wsv2', label: 'consume', animated: true },
    { source: 'cron-reset', target: 'r', label: 'clear' },
  ],
};

// ─────────────────────────────────────────────────────────────────────────
// 6. BidOffer
// ─────────────────────────────────────────────────────────────────────────
const lifecycleBidOffer = {
  id: 'lc-bid-offer',
  category: 'lifecycle',
  title: 'Lifecycle · BidOffer',
  subtitle:
    'Order book top 3 levels · auto.bo → Kafka → BidOfferService.updateBidOffer → merge into SymbolInfo · history RUNTIME OFF',
  accent: '#a855f7',
  nodes: [
    {
      id: 'ws',
      kind: 'source',
      layer: 'Lotte WS',
      title: 'auto.bo.<code>',
      subtitle: 'Bid/Ask feed',
      position: { x: 0, y: ROW },
      inputs: [{ name: 'subscribe', type: 'WS', description: '' }],
      outputs: [{ name: 'raw bid/ask line', type: 'string', description: '' }],
      details:
        'Lotte channel per symbol, pushed whenever the top-3 order book changes. Pipe-delimited format with 3 bid (price/volume) + 3 ask (price/volume) + session + totals.',
    },
    {
      id: 'collector',
      kind: 'logic',
      layer: 'Collector',
      title: 'handleStockBidAsk(parts)',
      subtitle: 'Parse → build BidOfferData',
      position: { x: COL, y: ROW },
      inputs: [{ name: 'parts[]', type: 'string[]', description: '' }],
      outputs: [{ name: 'BidOfferData (+ handleAutoData: expectedChange/Rate)', type: 'object', description: '' }],
      details:
        'Pipeline:\n' +
        '  1. Parse parts[] → build BidOfferData { code, bidPrice1/2/3, bidVolume1/2/3, askPrice1/2/3, askVolume1/2/3, totalBidVolume, totalAskVolume, session, time }\n' +
        '  2. If the symbol is futures → build FuturesBidOfferData (adds expectedChange, expectedRate vs vn30)\n' +
        '  3. In ATO/ATC sessions: handleAutoData() computes expectedPrice/Change/Rate based on projected match\n' +
        '  4. sendMessageSafe("bidOfferUpdate", bidOffer)',
    },
    {
      id: 'kafka',
      kind: 'kafka',
      layer: 'Kafka',
      title: 'bidOfferUpdate',
      subtitle: 'Main topic',
      position: { x: COL * 2, y: ROW },
      inputs: [{ name: 'sendMessageSafe', type: 'Kafka', description: '' }],
      outputs: [{ name: 'realtime-v2 + ws-v2', type: 'Kafka', description: '' }],
      details:
        'Partition key = code. ws-v2 consumes directly for low-latency broadcast; realtime-v2 consumes to merge into SymbolInfo.',
    },
    {
      id: 'handler',
      kind: 'logic',
      layer: 'realtime-v2',
      title: 'BidOfferUpdateHandler → MonitorService',
      subtitle: 'Enqueue per-code',
      position: { x: COL * 3, y: ROW },
      inputs: [{ name: 'Message<BidOffer>', type: 'Kafka', description: '' }],
      outputs: [{ name: 'BidOfferService.updateBidOffer()', type: 'call', description: '' }],
      details:
        'The handler pushes events into MonitorService partitioned by code — ensuring bidoffer events for the same symbol do not race with quote events for the same symbol (shared queue).',
    },
    {
      id: 'service',
      kind: 'logic',
      layer: 'BidOfferService',
      title: 'updateBidOffer(bidOffer)',
      subtitle: '8 main steps',
      position: { x: COL * 4, y: ROW },
      inputs: [{ name: 'BidOffer', type: 'object', description: '' }],
      outputs: [
        { name: '1) set createdAt / updatedAt', type: 'set', description: '' },
        { name: '2) load current SymbolInfo', type: 'read', description: '' },
        { name: '3) ConvertUtils.updateByBidOffer()', type: 'merge', description: '' },
        { name: '4) SymbolInfo.bidOfferList = new top book', type: 'set', description: '' },
        { name: '5) increment bidAskSequence', type: 'counter', description: '' },
        { name: '6) HSET realtime_mapSymbolInfo[code]', type: 'Redis', description: '' },
        { name: '7) set bidOffer.id', type: 'set', description: '' },
        { name: '8) IF enableSaveBidOffer=true → append realtime_listBidOffer_{code}', type: 'branch', description: 'RUNTIME OFF' },
      ],
      details:
        'Step-by-step:\n\n' +
        '  1. bidOffer.createdAt / updatedAt = now\n' +
        '  2. HGET realtime_mapSymbolInfo[code] → current SymbolInfo (on miss → skip the entire update)\n' +
        '  3. ConvertUtils.updateByBidOffer(symbolInfo, bidOffer) merges:\n' +
        '     – bidOfferList = [ask3, ask2, ask1, bid1, bid2, bid3]\n' +
        '     – totalBidVolume, totalAskVolume\n' +
        '     – session (when BidOffer carries a session flag)\n' +
        '     – expectedPrice/expectedChange/expectedRate (ATO/ATC)\n' +
        '  4. Overwrite bidOfferList (does not accumulate, replaces top book)\n' +
        '  5. symbolInfo.bidAskSequence++\n' +
        '  6. HSET realtime_mapSymbolInfo[code] with the merged SymbolInfo\n' +
        '  7. bidOffer.id = code_yyyyMMddHHmmss_bidAskSequence (used when persisting)\n' +
        '  8. Feature flag enableSaveBidOffer (ENV) — currently RUNTIME OFF → skip RPUSH realtime_listBidOffer_*',
    },
    {
      id: 'r-info',
      kind: 'redis',
      layer: 'Redis (active)',
      title: 'realtime_mapSymbolInfo[code]',
      subtitle: 'The only top book',
      position: { x: COL * 5.5, y: 0 },
      inputs: [{ name: 'HSET', type: 'Redis', description: '' }],
      outputs: [{ name: 'the ONLY place with main-session bid/offer', type: 'hash', description: '' }],
      details:
        'Because history is OFF, the current top book lives only in SymbolInfo.bidOfferList. All bid/offer reads (priceBoard, snapshot) go through SymbolInfo.',
    },
    {
      id: 'r-list',
      kind: 'redis',
      layer: 'Redis (inactive)',
      title: 'realtime_listBidOffer_{code}',
      subtitle: 'enableSaveBidOffer=false',
      position: { x: COL * 5.5, y: ROW },
      inputs: [{ name: 'skipped', type: 'skip', description: '' }],
      outputs: [{ name: 'no writes', type: 'none', description: '' }],
      details:
        'If the feature flag were enabled this would be the BidOffer history list per symbol. Currently NO data — any API needing bid/offer history (if any) would see it empty.',
    },
    {
      id: 'mongo',
      kind: 'mongo',
      layer: 'Mongo (inactive)',
      title: 'c_bid_offer',
      subtitle: 'enableSaveBidAsk=false',
      position: { x: COL * 5.5, y: ROW * 2 },
      inputs: [{ name: 'no runtime writes', type: 'skip', description: '' }],
      outputs: [],
      details:
        'The collection has a schema but receives no runtime writes. To audit the order book, you must reconstruct it from SymbolInfo snapshots in c_symbol_info.',
    },
    {
      id: 'q',
      kind: 'api',
      layer: 'Delivery',
      title: 'market-query-v2',
      subtitle: 'No dedicated BidOffer history query',
      position: { x: COL * 7, y: 0 },
      inputs: [{ name: 'indirect via SymbolInfo', type: 'Redis', description: '' }],
      outputs: [
        { name: '/symbol/latest', type: 'endpoint', description: 'returns SymbolInfo with bidOfferList' },
        { name: '/priceBoard', type: 'endpoint', description: 'price board with top book' },
      ],
      details:
        'The client does not call a dedicated "getBidOffer" API — always reads it inside SymbolInfo. Saves one round-trip.',
    },
    {
      id: 'wsv2',
      kind: 'ws',
      layer: 'Delivery',
      title: 'ws-v2',
      subtitle: 'convertDataPublishV2BidOffer()',
      position: { x: COL * 7, y: ROW },
      inputs: [{ name: 'consume bidOfferUpdate', type: 'Kafka', description: '' }],
      outputs: [{ name: 'publish market.bidoffer.{code}', type: 'channel', description: '' }],
      details:
        'Compacts payload (short field names) then broadcasts on market.bidoffer.{code}. The client renders realtime bid/ask charts without reading Redis.',
    },
  ],
  edges: [
    { source: 'ws', target: 'collector', label: 'raw', animated: true },
    { source: 'collector', target: 'kafka', label: 'publish', animated: true },
    { source: 'kafka', target: 'handler', label: 'consume', animated: true },
    { source: 'handler', target: 'service', label: 'updateBidOffer()' },
    { source: 'service', target: 'r-info', label: 'HSET' },
    { source: 'service', target: 'r-list', label: 'skipped' },
    { source: 'service', target: 'mongo', label: 'skipped' },
    { source: 'r-info', target: 'q', label: 'HGET indirect' },
    { source: 'kafka', target: 'wsv2', label: 'consume direct', animated: true },
  ],
};

// ─────────────────────────────────────────────────────────────────────────
// 7. OddLot (combined: SymbolInfoOddLot / BidOfferOddLot / SymbolQuoteOddLot)
// ─────────────────────────────────────────────────────────────────────────
const lifecycleOddLot = {
  id: 'lc-odd-lot',
  category: 'lifecycle',
  title: 'Lifecycle · OddLot (SymbolInfoOddLot / BidOfferOddLot / SymbolQuoteOddLot)',
  subtitle:
    'Odd-lot branch ISOLATED from the main snapshot · 2 dedicated feeds (bidOfferOddLotUpdate, quoteOddLotUpdate) · runtime always ON for history',
  accent: '#fb923c',
  nodes: [
    // Branch 1: BidOffer odd-lot
    {
      id: 'ws-bo',
      kind: 'source',
      layer: 'Lotte WS (BO odd-lot)',
      title: 'auto.bo.oddlot.<code>',
      subtitle: 'Odd-lot bid/ask feed',
      position: { x: 0, y: 0 },
      inputs: [{ name: 'subscribe', type: 'WS', description: '' }],
      outputs: [{ name: 'raw odd-lot bid/ask line', type: 'string', description: '' }],
      details:
        'Dedicated channel for the odd-lot market (< 100 shares/lot). Same format as auto.bo but volume is in odd shares.',
    },
    {
      id: 'kafka-bo',
      kind: 'kafka',
      layer: 'Kafka',
      title: 'bidOfferOddLotUpdate',
      subtitle: 'DEDICATED topic',
      position: { x: COL, y: 0 },
      inputs: [{ name: 'collector producer', type: 'Kafka', description: '' }],
      outputs: [{ name: 'realtime-v2 + ws-v2', type: 'Kafka', description: '' }],
      details:
        'Separated from bidOfferUpdate so consumers that do not need odd-lot can skip it. ws-v2 consumes both but publishes on different channels.',
    },
    {
      id: 'svc-bo',
      kind: 'logic',
      layer: 'BidOfferService',
      title: 'updateBidOfferOddLot()',
      subtitle: 'Separate method for odd-lot',
      position: { x: COL * 2, y: 0 },
      inputs: [{ name: 'BidOfferOddLot', type: 'object', description: '' }],
      outputs: [
        { name: 'get SymbolInfoOddLot from cache (or create new, sequence=1)', type: 'ensure', description: '' },
        { name: 'ConvertUtils.updateByBidOfferOddLot()', type: 'merge', description: '' },
        { name: 'HSET realtime_mapSymbolInfoOddLot[code]', type: 'Redis', description: '' },
        { name: 'set sequence + id = code_datetime_seq', type: 'set', description: '' },
        { name: 'RPUSH realtime_listBidOfferOddLot_{code}', type: 'Redis', description: '' },
      ],
      details:
        'Differences from regular updateBidOffer:\n' +
        '  • Works with SymbolInfoOddLot (separate object) — on cache miss CREATES a new one with sequence=1 (no REST init required)\n' +
        '  • Same fields but volume values are in odd shares\n' +
        '  • ALWAYS RPUSH into realtime_listBidOfferOddLot_{code} (no skip feature flag like the stock version)\n' +
        '  • id format: code_yyyyMMddHHmmss_sequence so the client can paginate by time.',
    },

    // Branch 2: Quote odd-lot
    {
      id: 'ws-qt',
      kind: 'source',
      layer: 'Lotte WS (Quote odd-lot)',
      title: 'auto.qt.oddlot.<code>',
      subtitle: 'Odd-lot quote feed',
      position: { x: 0, y: ROW * 2 },
      inputs: [{ name: 'subscribe', type: 'WS', description: '' }],
      outputs: [{ name: 'raw odd-lot quote line', type: 'string', description: '' }],
      details:
        'Quote channel for odd-lot symbols, emitted only on odd-lot matches. Lower frequency than regular quotes.',
    },
    {
      id: 'kafka-qt',
      kind: 'kafka',
      layer: 'Kafka',
      title: 'quoteOddLotUpdate',
      subtitle: 'DEDICATED topic',
      position: { x: COL, y: ROW * 2 },
      inputs: [{ name: 'collector producer', type: 'Kafka', description: '' }],
      outputs: [{ name: 'realtime-v2 + ws-v2', type: 'Kafka', description: '' }],
      details:
        'Message = SymbolQuoteOddLot (subtype of SymbolQuote). The realtime-v2 consumer uses instanceof to route the processing branch.',
    },
    {
      id: 'svc-qt',
      kind: 'logic',
      layer: 'QuoteService',
      title: 'updateQuote() — SymbolQuoteOddLot branch',
      subtitle: 'Reuses method but with if-instanceof',
      position: { x: COL * 2, y: ROW * 2 },
      inputs: [{ name: 'SymbolQuoteOddLot', type: 'object', description: '' }],
      outputs: [
        { name: 'update SymbolInfoOddLot (does NOT touch regular SymbolInfo)', type: 'merge', description: '' },
        { name: 'HSET realtime_mapSymbolInfoOddLot[code]', type: 'Redis', description: '' },
      ],
      details:
        'QuoteService.updateQuote() checks instanceof:\n' +
        '  • SymbolQuote (regular) → full 7-way fanout as in the Quote lifecycle\n' +
        '  • SymbolQuoteOddLot → ONLY updates SymbolInfoOddLot\n\n' +
        'The odd-lot branch does NOT write to:\n' +
        '  – realtime_listQuote_* (no tick history kept)\n' +
        '  – realtime_listQuoteMinute_* (no minute bars)\n' +
        '  – realtime_mapSymbolStatistic (no price buckets)\n' +
        '  – realtime_mapSymbolDaily (no separate daily OHLCV)\n' +
        '  – realtime_mapForeignerDaily (no separate foreign investor tracking for odd-lot)\n\n' +
        'Reason: odd-lot market data is sparse and does not need complex derived state.',
    },

    // Shared Redis keys
    {
      id: 'r-info',
      kind: 'redis',
      layer: 'Redis (shared)',
      title: 'realtime_mapSymbolInfoOddLot[code]',
      subtitle: 'Shared hash for both branches',
      position: { x: COL * 3.2, y: ROW },
      inputs: [
        { name: 'HSET from BidOfferService (updatedBy=BidOfferOddLot)', type: 'Redis', description: '' },
        { name: 'HSET from QuoteService (updatedBy=SymbolQuoteOddLot)', type: 'Redis', description: '' },
      ],
      outputs: [{ name: 'query-v2 + ws-v2', type: 'hash', description: '' }],
      details:
        'A single hash written to by two different mutators. The updatedBy field indicates which source last wrote (BidOfferOddLot or SymbolQuoteOddLot).\n\n' +
        'Shape similar to SymbolInfo but bidOfferList is in odd shares.',
    },
    {
      id: 'r-list',
      kind: 'redis',
      layer: 'Redis (BO history)',
      title: 'realtime_listBidOfferOddLot_{code}',
      subtitle: 'List — runtime ON',
      position: { x: COL * 3.2, y: 0 },
      inputs: [{ name: 'RPUSH from updateBidOfferOddLot', type: 'Redis', description: '' }],
      outputs: [{ name: 'odd-lot order book history', type: 'list', description: 'id = code_yyyyMMddHHmmss_seq' }],
      details:
        'DIFFERENT from the stock version (enableSaveBidOffer=false) — the odd-lot branch is always ON, keeping each odd-lot order book snapshot to display the evolution to the client.',
    },

    // Delivery
    {
      id: 'q',
      kind: 'api',
      layer: 'Delivery',
      title: 'market-query-v2',
      subtitle: 'OddLot endpoints',
      position: { x: COL * 4.8, y: 0 },
      inputs: [{ name: 'HMGET / LRANGE', type: 'Redis', description: '' }],
      outputs: [
        { name: 'querySymbolLatestOddLot', type: 'endpoint', description: 'HMGET SYMBOL_INFO_ODD_LOT' },
        { name: '/symbol/oddlotLatest', type: 'endpoint', description: 'Snapshot + odd-lot bid/offer' },
      ],
      details:
        'When the client opens the "Odd lot" tab a dedicated endpoint is called — the service HMGETs realtime_mapSymbolInfoOddLot for multiple symbols at once. Bid/offer history is read from realtime_listBidOfferOddLot_{code}.',
    },
    {
      id: 'wsv2',
      kind: 'ws',
      layer: 'Delivery',
      title: 'ws-v2 channels',
      subtitle: 'Dedicated OddLot channels',
      position: { x: COL * 4.8, y: ROW * 1.5 },
      inputs: [{ name: 'consume 2 odd-lot topics', type: 'Kafka', description: '' }],
      outputs: [
        { name: 'market.bidofferOddLot.{code}', type: 'channel', description: '' },
        { name: 'market.quoteOddLot.{code}', type: 'channel', description: '' },
      ],
      details:
        'Dedicated channels so clients can optionally subscribe without receiving the regular stream. Payload uses convertDataPublishV2BidOfferOddLot / convertDataPublishV2QuoteOddLot to compact.',
    },

    // Persist + reset
    {
      id: 'cron-persist',
      kind: 'schedule',
      layer: 'Cron',
      title: 'saveRedisToDatabase()',
      subtitle: '6×/day',
      position: { x: COL * 3.2, y: ROW * 3 },
      inputs: [{ name: '@Scheduled', type: 'cron', description: '' }],
      outputs: [{ name: 'getAllSymbolInfoOddLot() → Mongo odd-lot collection', type: 'bulk', description: '' }],
      details:
        'Same saveRedisToDatabase cron — adds a getAllSymbolInfoOddLot() step bulk-writing to the odd-lot collection (a different name from c_symbol_info).',
    },
    {
      id: 'cron-reset',
      kind: 'schedule',
      layer: 'Cron',
      title: 'removeAutoData / refreshSymbolInfo',
      subtitle: '00:55 / 01:35',
      position: { x: COL * 3.2, y: ROW * 4 },
      inputs: [{ name: '@Scheduled', type: 'cron', description: '' }],
      outputs: [
        { name: 'clear realtime_listBidOfferOddLot_*', type: 'del', description: '' },
        { name: 'reset oddlotBidOfferList inside SymbolInfoOddLot', type: 'reset', description: '' },
      ],
      details:
        '00:55 removeAutoData deletes the odd-lot bid/offer history list.\n' +
        '01:35 refreshSymbolInfo resets oddlotBidOfferList inside SymbolInfoOddLot — like the stock version, does not delete the snapshot, only resets intraday fields.',
    },
  ],
  edges: [
    { source: 'ws-bo', target: 'kafka-bo', label: 'publish', animated: true },
    { source: 'kafka-bo', target: 'svc-bo', label: 'consume', animated: true },
    { source: 'svc-bo', target: 'r-info', label: 'HSET' },
    { source: 'svc-bo', target: 'r-list', label: 'RPUSH' },

    { source: 'ws-qt', target: 'kafka-qt', label: 'publish', animated: true },
    { source: 'kafka-qt', target: 'svc-qt', label: 'consume', animated: true },
    { source: 'svc-qt', target: 'r-info', label: 'HSET' },

    { source: 'r-info', target: 'q', label: 'HMGET' },
    { source: 'r-list', target: 'q', label: 'LRANGE' },
    { source: 'kafka-bo', target: 'wsv2', label: 'consume', animated: true },
    { source: 'kafka-qt', target: 'wsv2', label: 'consume', animated: true },

    { source: 'r-info', target: 'cron-persist', label: 'getAll' },
    { source: 'cron-reset', target: 'r-list', label: 'clear' },
    { source: 'cron-reset', target: 'r-info', label: 'reset partial' },
  ],
};

// ─────────────────────────────────────────────────────────────────────────
// 8. SymbolDaily
// ─────────────────────────────────────────────────────────────────────────
const lifecycleSymbolDaily = {
  id: 'lc-symbol-daily',
  category: 'lifecycle',
  title: 'Lifecycle · SymbolDaily',
  subtitle:
    'Daily OHLCV bridging intraday and historical · upsert from Quote + Extra · snapshot 6×/day to Mongo · cleared 22:50',
  accent: '#22d3ee',
  nodes: [
    {
      id: 'q',
      kind: 'logic',
      layer: 'Source 1 · Quote',
      title: 'QuoteService.updateQuote()',
      subtitle: 'ConvertUtils.updateDailyByQuote()',
      position: { x: 0, y: 0 },
      inputs: [{ name: 'SymbolQuote', type: 'object', description: '' }],
      outputs: [{ name: 'build/patch SymbolDaily from tick', type: 'compute', description: '' }],
      details:
        'From each new tick, the service computes SymbolDaily for the current day:\n' +
        '  • If missing → create new { open = tick.last (first tick), high=low=close=tick.last, volume/value = tick.matching* }\n' +
        '  • If existing → high = max(high, tick.last), low = min(low, tick.last), close = tick.last, volume/value += tick.matching*\n\n' +
        'id = code_yyyyMMdd — idempotent, safe to upsert.',
    },
    {
      id: 'e',
      kind: 'logic',
      layer: 'Source 2 · Extra',
      title: 'ExtraQuoteService.updateExtraQuote()',
      subtitle: 'upsertSymbolDaily(extraQuote, symbolInfo)',
      position: { x: 0, y: ROW },
      inputs: [{ name: 'ExtraQuote', type: 'object', description: '' }],
      outputs: [{ name: 'upsert SymbolDaily', type: 'upsert', description: '' }],
      details:
        'ExtraQuote (special, from DealNotice and calExtraUpdate) carries fields that regular Quote does not:\n' +
        '  • ptTradingVolume/Value (accumulated put-through)\n' +
        '  • foreignerMatch* (sometimes)\n\n' +
        'upsertSymbolDaily merges these fields into the current SymbolDaily while preserving OHLCV.',
    },
    {
      id: 'r',
      kind: 'redis',
      layer: 'Redis intraday',
      title: 'realtime_mapSymbolDaily[code]',
      subtitle: 'Daily OHLCV hash',
      position: { x: COL * 1.5, y: ROW * 0.5 },
      inputs: [{ name: 'HSET', type: 'Redis', description: '' }],
      outputs: [{ name: 'today\'s daily OHLCV', type: 'hash', description: 'id = code_yyyyMMdd' }],
      details:
        'Shape:\n' +
        '{ code, date, open, high, low, close/last, tradingVolume, tradingValue, ptTradingVolume/Value, foreigner..., updatedAt }',
    },
    {
      id: 'mongo',
      kind: 'mongo',
      layer: 'Mongo historical',
      title: 'c_symbol_daily',
      subtitle: 'Day-level history',
      position: { x: COL * 3, y: ROW * 1.7 },
      inputs: [{ name: 'saveRedisToDatabase → getAllSymbolDaily', type: 'bulk', description: '' }],
      outputs: [{ name: 'find() for querySymbolPeriod', type: 'read', description: '' }],
      details:
        'Indexed by { code, date }. Each day has 1 document per symbol.\n\n' +
        'Used as the historical source for period queries and TradingView history when timeframe > 1 day.',
    },
    {
      id: 'q-today',
      kind: 'api',
      layer: 'Delivery · today',
      title: 'market-query-v2 · today',
      subtitle: 'Redis-first',
      position: { x: COL * 3, y: 0 },
      inputs: [
        { name: 'Redis mapSymbolInfo or mapSymbolDaily', type: 'Redis', description: '' },
      ],
      outputs: [{ name: 'querySymbolPeriod (today slice)', type: 'endpoint', description: '' }],
      details:
        'When toDate = today, the service does NOT read Mongo — it reads realtime_mapSymbolDaily directly for the latest OHLCV. If the key is missing, falls back to realtime_mapSymbolInfo (SymbolInfo also carries today\'s OHLC).',
    },
    {
      id: 'q-past',
      kind: 'api',
      layer: 'Delivery · past',
      title: 'market-query-v2 · historical',
      subtitle: 'Mongo',
      position: { x: COL * 4.5, y: ROW * 1.7 },
      inputs: [{ name: 'find c_symbol_daily', type: 'Mongo', description: '' }],
      outputs: [
        { name: 'querySymbolPeriod', type: 'endpoint', description: 'range [from, to]' },
        { name: 'querySymbolDailyReturns', type: 'endpoint', description: 'returns %' },
        { name: 'TradingView history', type: 'endpoint', description: 'daily bars' },
      ],
      details:
        'Full historical ranges → query Mongo by { code, date ∈ [from, to] }. If toDate ≥ today, the service also merges in the realtime snapshot for a seamless response.',
    },
    {
      id: 'cron-persist',
      kind: 'schedule',
      layer: 'Cron',
      title: 'saveRedisToDatabase()',
      subtitle: '6×/day',
      position: { x: COL * 1.5, y: ROW * 2.4 },
      inputs: [{ name: '@Scheduled', type: 'cron', description: '' }],
      outputs: [{ name: 'getAllSymbolDaily → bulk write', type: 'Mongo', description: '' }],
      details:
        'At each cron run, HGETALL realtime_mapSymbolDaily → bulk upsert c_symbol_daily keyed by (code, date). Running 6×/day ensures that even on a crash at most ~2 hours of daily data can be lost.',
    },
    {
      id: 'cron-clear',
      kind: 'schedule',
      layer: 'Cron',
      title: 'clearOldSymbolDaily() 22:50',
      subtitle: 'Clear before the new day',
      position: { x: COL * 1.5, y: ROW * 3.3 },
      inputs: [{ name: '@Scheduled', type: 'cron', description: '' }],
      outputs: [
        { name: 'clear realtime_mapSymbolDaily', type: 'del', description: '' },
        { name: 'clear cache mapSymbolDaily', type: 'del', description: '' },
      ],
      details:
        'At 22:50 (long after trading) clears the daily hash + in-memory cache. By the time 01:35 refreshSymbolInfo runs, the first tick of the new day will re-create the record.',
    },
  ],
  edges: [
    { source: 'q', target: 'r', label: 'HSET' },
    { source: 'e', target: 'r', label: 'HSET (upsert)' },
    { source: 'r', target: 'q-today', label: 'HGET' },
    { source: 'r', target: 'cron-persist', label: 'getAll' },
    { source: 'cron-persist', target: 'mongo', label: 'bulk write', animated: true },
    { source: 'mongo', target: 'q-past', label: 'find historical' },
    { source: 'cron-clear', target: 'r', label: 'clear' },
  ],
};

// ─────────────────────────────────────────────────────────────────────────
// 9. ForeignerDaily
// ─────────────────────────────────────────────────────────────────────────
const lifecycleForeignerDaily = {
  id: 'lc-foreigner-daily',
  category: 'lifecycle',
  title: 'Lifecycle · ForeignerDaily',
  subtitle:
    'Intraday foreign investor state · updated from Quote and Extra · Redis overlay when query includes today · snapshot to Mongo 6×/day',
  accent: '#fde047',
  nodes: [
    {
      id: 'q',
      kind: 'logic',
      layer: 'Source 1 · Quote',
      title: 'QuoteService.updateQuote()',
      subtitle: 'foreignerDaily.updateByQuote(quote)',
      position: { x: 0, y: 0 },
      inputs: [{ name: 'SymbolQuote', type: 'object', description: '' }],
      outputs: [{ name: 'merge foreignerBuy/Sell/TotalRoom/CurrentRoom', type: 'merge', description: '' }],
      details:
        'On each tick, the service:\n' +
        '  1. Fetches current ForeignerDaily (if missing → create new with baseline from SymbolInfo)\n' +
        '  2. foreignerDaily.updateByQuote(quote) accumulates:\n' +
        '     – foreignerBuyVolume += quote.foreignerMatchBuyVolume\n' +
        '     – foreignerSellVolume += quote.foreignerMatchSellVolume\n' +
        '     – foreignerBuyValue/SellValue similarly\n' +
        '     – foreignerCurrentRoom from quote (snapshot)\n' +
        '     – holdVolume/Ratio/buyAbleRatio recomputed\n' +
        '  3. HSET realtime_mapForeignerDaily[code]',
    },
    {
      id: 'e',
      kind: 'logic',
      layer: 'Source 2 · Extra',
      title: 'ExtraQuoteService.updateExtraQuote()',
      subtitle: 'ConvertUtils.updateByExtraQuote(foreignerDaily, extra)',
      position: { x: 0, y: ROW },
      inputs: [{ name: 'ExtraQuote', type: 'object', description: '' }],
      outputs: [{ name: 'merge foreigner enrichment', type: 'merge', description: '' }],
      details:
        'Extra carries foreign-investor fields pre-aggregated by the collector (e.g. when a DealNotice is from a foreign investor). The service merges those fields into the current ForeignerDaily and HSETs it back.',
    },
    {
      id: 'r',
      kind: 'redis',
      layer: 'Redis intraday',
      title: 'realtime_mapForeignerDaily[code]',
      subtitle: 'Hash',
      position: { x: COL * 1.5, y: ROW * 0.5 },
      inputs: [{ name: 'HSET', type: 'Redis', description: '' }],
      outputs: [{ name: 'today\'s foreigner', type: 'hash', description: '' }],
      details:
        'Shape: { code, symbolType, date, foreignerBuy/SellValue/Volume, foreignerTotalRoom, foreignerCurrentRoom, foreignerBuyAbleRatio, foreignerHoldVolume, foreignerHoldRatio, listedQuantity, createdAt, updatedAt }',
    },
    {
      id: 'q-api',
      kind: 'api',
      layer: 'Delivery',
      title: 'market-query-v2',
      subtitle: 'Overlay today with Redis',
      position: { x: COL * 3, y: 0 },
      inputs: [
        { name: '/symbol/{symbol}/foreigner', type: 'endpoint', description: '' },
        { name: 'Mongo ForeignerDaily historical', type: 'Mongo', description: '' },
      ],
      outputs: [{ name: 'if toDate ≥ today → overlay with realtime_mapForeignerDaily', type: 'merge', description: '' }],
      details:
        'Query logic:\n' +
        '  1. Always query Mongo c_foreigner_daily by { code, date ∈ [from, to] } first\n' +
        '  2. If toDate ≥ today → also fetch realtime_mapForeignerDaily[code] and overwrite the today record in the result (the Mongo today record may be a few minutes stale)\n' +
        '  3. Return a seamless timeseries',
    },
    {
      id: 'cron-persist',
      kind: 'schedule',
      layer: 'Cron',
      title: 'saveRedisToDatabase()',
      subtitle: '6×/day',
      position: { x: COL * 1.5, y: ROW * 2 },
      inputs: [{ name: '@Scheduled', type: 'cron', description: '' }],
      outputs: [
        { name: 'getAllForeignerDaily()', type: 'HGETALL', description: '' },
        { name: 'set id = code_yyyyMMdd', type: 'set', description: '' },
        { name: 'bulk write c_foreigner_daily', type: 'Mongo', description: '' },
      ],
      details:
        'Pipeline: HGETALL realtime_mapForeignerDaily → each doc set id = code_yyyyMMdd → bulk upsert into c_foreigner_daily (idempotent).',
    },
    {
      id: 'mongo',
      kind: 'mongo',
      layer: 'Mongo',
      title: 'c_foreigner_daily',
      subtitle: 'Foreign-investor history',
      position: { x: COL * 3, y: ROW * 2 },
      inputs: [{ name: 'bulk write', type: 'Mongo', description: '' }],
      outputs: [{ name: 'historical source', type: 'read', description: '' }],
      details:
        'Indexed by { code, date }. Stores the full foreign-investor timeseries for all prior days. Used when the client views 1M/3M/1Y foreign buy/sell charts.',
    },
  ],
  edges: [
    { source: 'q', target: 'r', label: 'HSET' },
    { source: 'e', target: 'r', label: 'HSET' },
    { source: 'r', target: 'q-api', label: 'overlay' },
    { source: 'r', target: 'cron-persist', label: 'getAll' },
    { source: 'cron-persist', target: 'mongo', label: 'bulk write', animated: true },
    { source: 'mongo', target: 'q-api', label: 'find historical' },
  ],
};

// ─────────────────────────────────────────────────────────────────────────
// 10. MarketStatus
// ─────────────────────────────────────────────────────────────────────────
const lifecycleMarketStatus = {
  id: 'lc-market-status',
  category: 'lifecycle',
  title: 'Lifecycle · MarketStatus',
  subtitle:
    'Per-market session state · auto.tickerNews → Kafka → updateMarketStatus · broadcasts sessions to every SymbolInfo in the same market on ATO/ATC',
  accent: '#f87171',
  nodes: [
    {
      id: 'ws',
      kind: 'source',
      layer: 'Lotte WS',
      title: 'auto.tickerNews.<market>',
      subtitle: 'Ticker news feed',
      position: { x: 0, y: ROW },
      inputs: [{ name: 'subscribe', type: 'WS', description: '' }],
      outputs: [{ name: 'raw news text', type: 'string', description: '' }],
      details:
        'Lotte emits an event whenever the exchange changes session (HOSE PRE → ATO → CONTINUOUS → ATC → POST, similar for HNX/UPCOM). The format is a natural-language title that the collector must parse.',
    },
    {
      id: 'collector',
      kind: 'logic',
      layer: 'Collector',
      title: 'handleSessionEvent(parts)',
      subtitle: 'parseStatus(title → market/status)',
      position: { x: COL, y: ROW },
      inputs: [{ name: 'parts[]', type: 'string[]', description: '' }],
      outputs: [{ name: 'MarketStatusData', type: 'object', description: '' }],
      details:
        'Pipeline:\n' +
        '  1. Parse the title to extract market (HOSE/HNX/UPCOM/DERIVATIVE) and status (PRE/ATO/CONTINUOUS/LO/INTERMISSION/ATC/POST/CLOSE)\n' +
        '  2. parseStatus() normalizes aliases: "LO" in news ↔ "CONTINUOUS" in SymbolInfo\n' +
        '  3. Build MarketStatusData { market, status, type, date, time }\n' +
        '  4. publish Kafka marketStatus',
    },
    {
      id: 'kafka',
      kind: 'kafka',
      layer: 'Kafka',
      title: 'marketStatus',
      subtitle: '',
      position: { x: COL * 2, y: ROW },
      inputs: [{ name: 'sendMessageSafe', type: 'Kafka', description: '' }],
      outputs: [{ name: 'realtime-v2 + ws-v2', type: 'Kafka', description: '' }],
      details:
        'Very low frequency (a few events/day/market) — no need for high throughput.',
    },
    {
      id: 'handler',
      kind: 'logic',
      layer: 'realtime-v2',
      title: 'MarketStatusUpdateHandler',
      subtitle: '',
      position: { x: COL * 3, y: ROW },
      inputs: [{ name: 'Message<MarketStatus>', type: 'Kafka', description: '' }],
      outputs: [{ name: 'updateMarketStatus()', type: 'call', description: '' }],
      details:
        'Simple handler — does not go through MonitorService; forwards directly to MarketStatusService because events are infrequent and market-wide, so no per-code ordering is required.',
    },
    {
      id: 'service',
      kind: 'logic',
      layer: 'MarketStatusService',
      title: 'updateMarketStatus()',
      subtitle: 'The only broadcast mutator',
      position: { x: COL * 4, y: ROW },
      inputs: [{ name: 'MarketStatus', type: 'object', description: '' }],
      outputs: [
        { name: '1) set id = market + "_" + type', type: 'set', description: '' },
        { name: '2) set date', type: 'set', description: '' },
        { name: '3) HSET realtime_mapMarketStatus[id]', type: 'Redis', description: '' },
        { name: '4) IF ATO/ATC → broadcast sessions=status to ALL SymbolInfo in the same market', type: 'broadcast', description: '' },
        { name: '5) ELSE sessions = null', type: 'set', description: '' },
      ],
      details:
        'This is an "expensive" method — 1 event can trigger updates to thousands of SymbolInfo entries.\n\n' +
        'Step 4 in detail:\n' +
        '  • IF status ∈ {ATO, ATC}:\n' +
        '      a. HGETALL realtime_mapSymbolInfo → filter symbols where market = event.market\n' +
        '      b. For each symbol: set symbolInfo.sessions = status\n' +
        '      c. HSET realtime_mapSymbolInfo[code] for all of them\n' +
        '  • ELSE (CONTINUOUS/POST/CLOSE…):\n' +
        '      – sessions = null (client UI does not highlight a special session)\n\n' +
        'Note: alias status="LO" (in the Redis hash) ≡ session="CONTINUOUS" in SymbolInfo/BidOffer.',
    },
    {
      id: 'r-status',
      kind: 'redis',
      layer: 'Redis',
      title: 'realtime_mapMarketStatus',
      subtitle: 'Hash by market_type',
      position: { x: COL * 5.2, y: 0 },
      inputs: [{ name: 'HSET', type: 'Redis', description: '' }],
      outputs: [{ name: 'session map', type: 'hash', description: '' }],
      details:
        'Field keys like "HOSE_STOCK", "HNX_STOCK", "DERIVATIVE_FUTURES"... so the client can query the session per market type.',
    },
    {
      id: 'r-info',
      kind: 'redis',
      layer: 'Redis (broadcast side-effect)',
      title: 'realtime_mapSymbolInfo[*]',
      subtitle: 'sessions field overwritten',
      position: { x: COL * 5.2, y: ROW * 1.5 },
      inputs: [{ name: 'HSET again on propagate', type: 'Redis', description: 'only ATO/ATC' }],
      outputs: [{ name: 'sessions = ATO|ATC|null', type: 'field', description: '' }],
      details:
        'Important side-effect: no other mutator sets the sessions field on SymbolInfo except MarketStatusService. Other mutators (Quote/BidOffer) CAN write session, but that is the session carried by the tick, which differs from the sessions field (snapshot of the whole market\'s session state).',
    },
    {
      id: 'q',
      kind: 'api',
      layer: 'Delivery',
      title: 'market-query-v2',
      subtitle: '',
      position: { x: COL * 6.5, y: 0 },
      inputs: [{ name: 'HGETALL realtime_mapMarketStatus', type: 'Redis', description: '' }],
      outputs: [
        { name: '/sessionStatus', type: 'endpoint', description: '' },
        { name: 'queryMarketSessionStatus', type: 'endpoint', description: '' },
      ],
      details:
        'Client hits a single endpoint to know the status of all markets (HOSE in CONTINUOUS, HNX in INTERMISSION, ...). Requires only one HGETALL.',
    },
    {
      id: 'wsv2',
      kind: 'ws',
      layer: 'Delivery',
      title: 'ws-v2',
      subtitle: 'market.status',
      position: { x: COL * 6.5, y: ROW * 1.5 },
      inputs: [{ name: 'consume marketStatus', type: 'Kafka', description: '' }],
      outputs: [{ name: 'publish market.status', type: 'channel', description: '' }],
      details:
        'The market.status channel is not keyed by code — broadcast to all clients. Clients receive events to update the top-screen ticker UI ("HOSE in ATO, 2 minutes left...").',
    },
    {
      id: 'cron-persist',
      kind: 'schedule',
      layer: 'Cron',
      title: 'saveRedisToDatabase()',
      subtitle: '6×/day',
      position: { x: COL * 5.2, y: ROW * 2.5 },
      inputs: [{ name: '@Scheduled', type: 'cron', description: '' }],
      outputs: [{ name: 'getAllMarketStatus → c_market_session_status', type: 'Mongo', description: '' }],
      details:
        'Historical snapshot of every session change — useful for auditing when session transitions occurred during the day.',
    },
  ],
  edges: [
    { source: 'ws', target: 'collector', label: 'raw', animated: true },
    { source: 'collector', target: 'kafka', label: 'publish', animated: true },
    { source: 'kafka', target: 'handler', label: 'consume', animated: true },
    { source: 'handler', target: 'service', label: 'updateMarketStatus()' },
    { source: 'service', target: 'r-status', label: 'HSET' },
    { source: 'service', target: 'r-info', label: 'HSET broadcast (ATO/ATC)' },
    { source: 'r-status', target: 'q', label: 'HGETALL' },
    { source: 'kafka', target: 'wsv2', label: 'consume direct', animated: true },
    { source: 'r-status', target: 'cron-persist', label: 'getAll' },
  ],
};

// ─────────────────────────────────────────────────────────────────────────
// 11. ExtraUpdate / ExtraQuote
// ─────────────────────────────────────────────────────────────────────────
const lifecycleExtraUpdate = {
  id: 'lc-extra-update',
  category: 'lifecycle',
  title: 'Lifecycle · ExtraUpdate / ExtraQuote',
  subtitle:
    'Enrichment event · 5 producing sources (VN30/Futures/CW/DealNotice/calExtraUpdate) · NOT a long-lived object · mutates SymbolInfo + ForeignerDaily + SymbolDaily then disappears',
  accent: '#ec4899',
  nodes: [
    {
      id: 's1',
      kind: 'source',
      layer: 'Source 1/5',
      title: 'handleAutoData(IndexUpdateData VN30)',
      subtitle: 'Compute basis for futures',
      position: { x: 0, y: 0 },
      inputs: [{ name: 'VN30 tick', type: 'object', description: '' }],
      outputs: [{ name: 'ExtraUpdate { basis }', type: 'object', description: 'for each VN30F* futures symbol' }],
      details:
        'When a VN30 index tick arrives, the collector iterates the active VN30F* futures symbols:\n' +
        '  • basis = futuresLast − vn30.last\n' +
        '  • Publish an ExtraUpdate for each futures symbol (can be many events simultaneously)',
    },
    {
      id: 's2',
      kind: 'source',
      layer: 'Source 2/5',
      title: 'handleAutoData(FuturesUpdateData)',
      subtitle: 'basis = futuresLast − vn30Last',
      position: { x: 0, y: ROW * 0.8 },
      inputs: [{ name: 'Futures tick', type: 'object', description: '' }],
      outputs: [{ name: 'ExtraUpdate { basis }', type: 'object', description: '' }],
      details:
        'Inverse of s1: when a futures tick arrives, compute basis against the latest cached vn30.last. The result is an ExtraUpdate only for that futures symbol.',
    },
    {
      id: 's3',
      kind: 'source',
      layer: 'Source 3/5',
      title: 'handleAutoData(StockUpdateData CW)',
      subtitle: 'Compute breakEven for covered warrants',
      position: { x: 0, y: ROW * 1.6 },
      inputs: [{ name: 'CW tick', type: 'object', description: '' }],
      outputs: [{ name: 'ExtraUpdate { breakEven }', type: 'object', description: '' }],
      details:
        'When a stock tick arrives and the symbol is a covered warrant (CW), the collector computes breakEven = strikePrice + CW.last × exerciseRatio (depending on CW type). Publishes ExtraUpdate only for that CW.',
    },
    {
      id: 's4',
      kind: 'source',
      layer: 'Source 4/5',
      title: 'DealNoticeData',
      subtitle: 'ExtraUpdate.fromDealNotice()',
      position: { x: 0, y: ROW * 2.4 },
      inputs: [{ name: 'New deal notice', type: 'object', description: '' }],
      outputs: [{ name: 'ExtraUpdate { ptVolume, ptValue }', type: 'object', description: 'accumulated' }],
      details:
        'Every matched put-through adds to the symbol\'s PT summary:\n' +
        '  • ptVolume accumulated\n' +
        '  • ptValue accumulated\n\n' +
        'The collector publishes 2 Kafka messages IN PARALLEL: dealNoticeUpdate (raw) + extraUpdate (PT summary).',
    },
    {
      id: 's5',
      kind: 'source',
      layer: 'Source 5/5',
      title: 'QuoteService.reCalculate()',
      subtitle: 'When high/low year changes',
      position: { x: 0, y: ROW * 3.4 },
      inputs: [{ name: 'SymbolQuote', type: 'object', description: '' }],
      outputs: [{ name: 'publish calExtraUpdate', type: 'Kafka', description: 'dedicated topic but same consumer' }],
      details:
        'Inside reCalculate, if tick.last exceeds the 52-week (1-year) high/low, publishes calExtraUpdate with { highYear, lowYear } to update SymbolInfo (highYear/lowYear are fields shown on the price board).',
    },
    {
      id: 'kafka',
      kind: 'kafka',
      layer: 'Kafka',
      title: 'extraUpdate / calExtraUpdate',
      subtitle: '2 topics → same consumer',
      position: { x: COL * 1.3, y: ROW * 1.7 },
      inputs: [{ name: '4 collector sources + 1 realtime-v2 source', type: 'Kafka', description: '' }],
      outputs: [{ name: 'ExtraQuoteUpdateHandler + ws-v2', type: 'Kafka', description: '' }],
      details:
        'Split into 2 topics for routing clarity but the consumer handles both together. extraUpdate carries basis/breakEven/pt, calExtraUpdate carries highYear/lowYear (self-produced from QuoteService in realtime-v2).',
    },
    {
      id: 'handler',
      kind: 'logic',
      layer: 'realtime-v2',
      title: 'ExtraQuoteUpdateHandler',
      subtitle: '→ ExtraQuoteService',
      position: { x: COL * 2.5, y: ROW * 1.7 },
      inputs: [{ name: 'Message<ExtraQuote>', type: 'Kafka', description: '' }],
      outputs: [{ name: 'updateExtraQuote()', type: 'call', description: '' }],
      details:
        'The handler does not go through MonitorService — forwards directly to ExtraQuoteService because enrichment events have a lower frequency than quote/bidoffer.',
    },
    {
      id: 'service',
      kind: 'logic',
      layer: 'ExtraQuoteService',
      title: 'updateExtraQuote()',
      subtitle: 'Mutates 3 target objects',
      position: { x: COL * 3.7, y: ROW * 1.7 },
      inputs: [{ name: 'ExtraQuote', type: 'object', description: '' }],
      outputs: [
        { name: '① SymbolInfo (basis/breakEven/pt/highYear/lowYear)', type: 'merge', description: '' },
        { name: '② ForeignerDaily', type: 'merge', description: '' },
        { name: '③ SymbolDaily (upsert)', type: 'upsert', description: '' },
      ],
      details:
        'This method is a "fanout mutator" — 1 ExtraQuote mutates 3 targets:\n\n' +
        '  1. SymbolInfo:\n' +
        '     – ConvertUtils.updateByExtraQuote merges basis, breakEven, ptVolume/Value, highYear, lowYear\n' +
        '     – HSET realtime_mapSymbolInfo\n\n' +
        '  2. ForeignerDaily:\n' +
        '     – ConvertUtils.updateByExtraQuote(foreignerDaily, extra) merges additional foreign-investor fields\n' +
        '     – HSET realtime_mapForeignerDaily\n\n' +
        '  3. SymbolDaily:\n' +
        '     – upsertSymbolDaily merges ptTradingVolume/Value\n' +
        '     – HSET realtime_mapSymbolDaily\n\n' +
        'After processing, the ExtraQuote is not stored anywhere — it simply vanishes.',
    },
    {
      id: 't1',
      kind: 'redis',
      layer: 'Target 1',
      title: 'realtime_mapSymbolInfo',
      subtitle: '',
      position: { x: COL * 5, y: 0 },
      inputs: [{ name: 'HSET', type: 'Redis', description: '' }],
      outputs: [],
      details:
        'Same hash as in the SymbolInfo lifecycle — see its diagram. ExtraQuote is 1 of 6 mutators.',
    },
    {
      id: 't2',
      kind: 'redis',
      layer: 'Target 2',
      title: 'realtime_mapForeignerDaily',
      subtitle: '',
      position: { x: COL * 5, y: ROW * 1.2 },
      inputs: [{ name: 'HSET', type: 'Redis', description: '' }],
      outputs: [],
      details:
        'Same hash as in the ForeignerDaily lifecycle — ExtraQuote is 1 of 2 sources (along with Quote).',
    },
    {
      id: 't3',
      kind: 'redis',
      layer: 'Target 3',
      title: 'realtime_mapSymbolDaily',
      subtitle: '',
      position: { x: COL * 5, y: ROW * 2.4 },
      inputs: [{ name: 'HSET', type: 'Redis', description: '' }],
      outputs: [],
      details:
        'Same hash as in the SymbolDaily lifecycle — ExtraQuote is 1 of 2 sources (along with Quote).',
    },
    {
      id: 'wsv2',
      kind: 'ws',
      layer: 'Delivery',
      title: 'ws-v2',
      subtitle: 'market.extra.{code}',
      position: { x: COL * 5, y: ROW * 3.6 },
      inputs: [{ name: 'consume extraUpdate', type: 'Kafka', description: '' }],
      outputs: [{ name: 'publish market.extra.{code}', type: 'channel', description: '' }],
      details:
        'Dedicated channel so the client can update enrichment fields without reloading SymbolInfo. Useful for realtime display of "basis/breakEven/PT summary" widgets.',
    },
    {
      id: 'note',
      kind: 'config',
      layer: 'Note',
      title: 'NOT persisted independently',
      subtitle: 'An event, not an entity',
      position: { x: COL * 2.5, y: ROW * 3.6 },
      inputs: [],
      outputs: [],
      details:
        'ExtraUpdate/ExtraQuote has no dedicated Redis/Mongo store — it exists only to mutate 3 other targets (SymbolInfo, ForeignerDaily, SymbolDaily). After processing, the object disappears — individual events cannot be retrieved later.\n\nIf auditing is needed, inspect SymbolInfo\'s updatedBy="ExtraUpdate" field or Kafka __consumer_offsets.',
    },
  ],
  edges: [
    { source: 's1', target: 'kafka', label: 'extraUpdate', animated: true },
    { source: 's2', target: 'kafka', label: 'extraUpdate', animated: true },
    { source: 's3', target: 'kafka', label: 'extraUpdate', animated: true },
    { source: 's4', target: 'kafka', label: 'extraUpdate', animated: true },
    { source: 's5', target: 'kafka', label: 'calExtraUpdate', animated: true },
    { source: 'kafka', target: 'handler', label: 'consume', animated: true },
    { source: 'handler', target: 'service', label: 'call' },
    { source: 'service', target: 't1', label: 'HSET' },
    { source: 'service', target: 't2', label: 'HSET' },
    { source: 'service', target: 't3', label: 'HSET upsert' },
    { source: 'kafka', target: 'wsv2', label: 'consume direct', animated: true },
  ],
};

// ─────────────────────────────────────────────────────────────────────────
// 12. DealNotice
// ─────────────────────────────────────────────────────────────────────────
const lifecycleDealNotice = {
  id: 'lc-deal-notice',
  category: 'lifecycle',
  title: 'Lifecycle · DealNotice',
  subtitle:
    'Matched put-through deals · also a PT summary source · raw dealNoticeUpdate + emits ExtraUpdate · history per market',
  accent: '#14b8a6',
  nodes: [
    {
      id: 'ws',
      kind: 'source',
      layer: 'Lotte WS',
      title: 'put-through matched feed',
      subtitle: 'Matched deal',
      position: { x: 0, y: ROW },
      inputs: [{ name: 'subscribe', type: 'WS', description: '' }],
      outputs: [{ name: 'raw deal line', type: 'string', description: '' }],
      details:
        'Lotte emits an event each time a put-through (large-volume negotiated buy/sell) is officially matched. Each event carries a unique confirmNumber issued by the exchange.',
    },
    {
      id: 'collector',
      kind: 'logic',
      layer: 'Collector',
      title: 'DealNoticeData + ExtraUpdate.fromDealNotice()',
      subtitle: '2 parallel publishes',
      position: { x: COL, y: ROW },
      inputs: [{ name: 'raw', type: 'string', description: '' }],
      outputs: [
        { name: 'dealNoticeUpdate (raw)', type: 'Kafka', description: '' },
        { name: 'extraUpdate { ptVolume, ptValue }', type: 'Kafka', description: 'accumulated' },
      ],
      details:
        'The collector turns 1 deal into 2 messages:\n\n' +
        '  1. DealNoticeData raw:\n' +
        '     – publish dealNoticeUpdate so realtime-v2 records history + ws-v2 broadcasts\n' +
        '  2. ExtraUpdate.fromDealNotice():\n' +
        '     – build ExtraUpdate with ptVolume=deal.volume, ptValue=deal.value\n' +
        '     – publish extraUpdate so ExtraQuoteService accumulates into SymbolInfo.ptTradingVolume/Value\n\n' +
        'Split across 2 topics to avoid coupling: a consumer needing only one type can skip the other.',
    },
    {
      id: 'kafka-deal',
      kind: 'kafka',
      layer: 'Kafka',
      title: 'dealNoticeUpdate',
      subtitle: '',
      position: { x: COL * 2, y: ROW * 0.5 },
      inputs: [{ name: 'collector producer', type: 'Kafka', description: '' }],
      outputs: [{ name: 'realtime-v2 + ws-v2', type: 'Kafka', description: '' }],
      details:
        'Raw deal — realtime-v2 writes history, ws-v2 broadcasts.',
    },
    {
      id: 'kafka-extra',
      kind: 'kafka',
      layer: 'Kafka',
      title: 'extraUpdate',
      subtitle: 'Goes into the Extra lifecycle',
      position: { x: COL * 2, y: ROW * 1.8 },
      inputs: [{ name: 'collector producer', type: 'Kafka', description: '' }],
      outputs: [{ name: '→ ExtraQuoteService', type: 'link', description: '' }],
      details:
        'ExtraQuote from a deal — see the ExtraUpdate lifecycle (source 4/5). Will mutate SymbolInfo.ptTradingVolume/Value.',
    },
    {
      id: 'service',
      kind: 'logic',
      layer: 'DealNoticeService',
      title: 'updateDealNotice()',
      subtitle: '7 steps — dedupe is critical',
      position: { x: COL * 3.2, y: ROW * 0.5 },
      inputs: [{ name: 'DealNotice', type: 'object', description: '' }],
      outputs: [
        { name: '1) ensure SymbolInfo exists', type: 'check', description: '' },
        { name: '2) load all existing DealNotice entries', type: 'read', description: '' },
        { name: '3) dedupe by confirmNumber', type: 'compute', description: '' },
        { name: '4) ConvertUtils.updateByDealNotice(symbolInfo, deal)', type: 'merge', description: '' },
        { name: '5) HSET realtime_mapSymbolInfo[code]', type: 'Redis', description: '' },
        { name: '6) set dealNotice.id / date / timestamps', type: 'set', description: '' },
        { name: '7) RPUSH realtime_listDealNotice_{market}', type: 'Redis', description: '' },
      ],
      details:
        'Details:\n\n' +
        '  1. SymbolInfo must already be loaded (the deal must belong to a known symbol); otherwise → skip\n' +
        '  2. Read realtime_listDealNotice_{market} to check whether the deal already exists\n' +
        '  3. Dedupe: Lotte may resend the same deal (same confirmNumber) — only process if NOT already present\n' +
        '  4. ConvertUtils.updateByDealNotice merges into SymbolInfo:\n' +
        '     – symbolInfo.ptTradingVolume += deal.volume\n' +
        '     – symbolInfo.ptTradingValue += deal.value\n' +
        '     (realtime-v2 also recomputes independently from the collector to guard against duplicates)\n' +
        '  5-7. HSET SymbolInfo + set metadata + RPUSH history list',
    },
    {
      id: 'r-list',
      kind: 'redis',
      layer: 'Redis',
      title: 'realtime_listDealNotice_{market}',
      subtitle: 'List per market',
      position: { x: COL * 4.6, y: 0 },
      inputs: [{ name: 'RPUSH', type: 'Redis', description: '' }],
      outputs: [{ name: 'deal history', type: 'list', description: '' }],
      details:
        'Key is per market (HOSE/HNX/UPCOM), not per code — client viewing "latest deals across the exchange" needs only 1 LRANGE.\n\n' +
        'Some docs describe a per-code key — for absolute accuracy verify against the actual code.',
    },
    {
      id: 'r-info',
      kind: 'redis',
      layer: 'Redis',
      title: 'realtime_mapSymbolInfo[code]',
      subtitle: 'ptTradingVolume / ptTradingValue',
      position: { x: COL * 4.6, y: ROW * 1.2 },
      inputs: [{ name: 'HSET', type: 'Redis', description: '' }],
      outputs: [{ name: 'via the SymbolInfo lifecycle', type: 'link', description: '' }],
      details:
        'See SymbolInfo lifecycle. DealNotice is the 6th mutator (along with Init/Quote/BidOffer/Extra/MarketStatus).',
    },
    {
      id: 'q',
      kind: 'api',
      layer: 'Delivery',
      title: 'market-query-v2',
      subtitle: 'Put-through endpoints',
      position: { x: COL * 6, y: 0 },
      inputs: [{ name: 'LRANGE realtime_listDealNotice', type: 'Redis', description: '' }],
      outputs: [
        { name: 'queryPutThroughDeal', type: 'endpoint', description: 'deal list' },
        { name: 'queryPtDealTotal', type: 'endpoint', description: 'market-wide PT totals' },
      ],
      details:
        'When the client opens the Put-through tab — 1 LRANGE fetches the last N deals, or aggregate ptVolume/Value across the market from the same list.',
    },
    {
      id: 'wsv2',
      kind: 'ws',
      layer: 'Delivery',
      title: 'ws-v2',
      subtitle: 'market.putthrough.deal.{market}',
      position: { x: COL * 6, y: ROW * 1.2 },
      inputs: [{ name: 'consume dealNoticeUpdate', type: 'Kafka', description: '' }],
      outputs: [{ name: 'publish market.putthrough.deal.{market}', type: 'channel', description: '' }],
      details:
        'Per-market channel so the Put-through tab receives new deals in realtime without reloading.',
    },
    {
      id: 'cron-persist',
      kind: 'schedule',
      layer: 'Cron',
      title: 'saveRedisToDatabase()',
      subtitle: '',
      position: { x: COL * 4.6, y: ROW * 2.4 },
      inputs: [{ name: '@Scheduled', type: 'cron', description: '' }],
      outputs: [{ name: 'deal lists → c_deal_notice', type: 'Mongo', description: '' }],
      details:
        'LRANGE all realtime_listDealNotice_* → bulk write c_deal_notice keyed by _id = confirmNumber (idempotent).',
    },
    {
      id: 'cron-reset',
      kind: 'schedule',
      layer: 'Cron',
      title: 'removeAutoData() 00:55',
      subtitle: '',
      position: { x: COL * 4.6, y: ROW * 3.3 },
      inputs: [{ name: '@Scheduled', type: 'cron', description: '' }],
      outputs: [{ name: 'clear deal notice lists', type: 'del', description: '' }],
      details:
        'Clears the list so the new day starts empty. Old deals have already been persisted to c_deal_notice in the earlier saveRedisToDatabase runs.',
    },
  ],
  edges: [
    { source: 'ws', target: 'collector', label: 'raw', animated: true },
    { source: 'collector', target: 'kafka-deal', label: 'publish raw', animated: true },
    { source: 'collector', target: 'kafka-extra', label: 'publish PT summary', animated: true },
    { source: 'kafka-deal', target: 'service', label: 'consume', animated: true },
    { source: 'service', target: 'r-list', label: 'RPUSH' },
    { source: 'service', target: 'r-info', label: 'HSET' },
    { source: 'r-list', target: 'q', label: 'LRANGE' },
    { source: 'kafka-deal', target: 'wsv2', label: 'consume direct', animated: true },
    { source: 'r-list', target: 'cron-persist', label: 'getAll' },
    { source: 'cron-reset', target: 'r-list', label: 'clear' },
  ],
};

// ─────────────────────────────────────────────────────────────────────────
// 13. Advertised
// ─────────────────────────────────────────────────────────────────────────
const lifecycleAdvertised = {
  id: 'lc-advertised',
  category: 'lifecycle',
  title: 'Lifecycle · Advertised',
  subtitle:
    'Put-through advertise offers · history list per market only · does not mutate SymbolInfo',
  accent: '#0ea5e9',
  nodes: [
    {
      id: 'ws',
      kind: 'source',
      layer: 'Lotte WS',
      title: 'advertised feed',
      subtitle: 'Advertise order',
      position: { x: 0, y: ROW },
      inputs: [{ name: 'subscribe', type: 'WS', description: '' }],
      outputs: [{ name: 'raw advertise line', type: 'string', description: '' }],
      details:
        'When a firm/person posts a large-volume advertise (not yet matched), Lotte emits an event. Unlike DealNotice (already matched), Advertised is just an offer awaiting a counterparty.',
    },
    {
      id: 'collector',
      kind: 'logic',
      layer: 'Collector',
      title: 'AdvertisedData + sendMessageSafe',
      subtitle: 'Build + publish',
      position: { x: COL, y: ROW },
      inputs: [{ name: 'raw', type: 'string', description: '' }],
      outputs: [{ name: 'advertisedUpdate', type: 'Kafka', description: '' }],
      details:
        'Parse raw → build AdvertisedData { code, market, side (BUY/SELL), price, volume, customer, time, ... } → sendMessageSafe("advertisedUpdate"). Does NOT publish ExtraUpdate because the offer is unmatched and does not affect PT summary.',
    },
    {
      id: 'kafka',
      kind: 'kafka',
      layer: 'Kafka',
      title: 'advertisedUpdate',
      subtitle: '',
      position: { x: COL * 2, y: ROW },
      inputs: [{ name: 'producer', type: 'Kafka', description: '' }],
      outputs: [{ name: 'realtime-v2 + ws-v2', type: 'Kafka', description: '' }],
      details: 'Low frequency — only when a new advertise order is posted.',
    },
    {
      id: 'service',
      kind: 'logic',
      layer: 'AdvertisedService',
      title: 'updateAdvertised()',
      subtitle: 'Only RPUSH',
      position: { x: COL * 3, y: ROW },
      inputs: [{ name: 'Advertised', type: 'object', description: '' }],
      outputs: [
        { name: 'set id / date / timestamps', type: 'set', description: '' },
        { name: 'RPUSH realtime_listAdvertised_{market}', type: 'Redis', description: '' },
      ],
      details:
        'The simplest service across all lifecycles:\n' +
        '  1. Set id = code_yyyyMMddHHmmss_random\n' +
        '  2. Set date + createdAt + updatedAt\n' +
        '  3. RPUSH realtime_listAdvertised_{market}\n\n' +
        'Does NOT mutate SymbolInfo because advertised offers are unmatched.',
    },
    {
      id: 'r',
      kind: 'redis',
      layer: 'Redis',
      title: 'realtime_listAdvertised_{market}',
      subtitle: 'List per market',
      position: { x: COL * 4, y: ROW },
      inputs: [{ name: 'RPUSH', type: 'Redis', description: '' }],
      outputs: [{ name: 'advertise history', type: 'list', description: '' }],
      details:
        'List per market — same as dealNotice. No per-code key because advertises are infrequent and the client views the exchange-wide aggregate.',
    },
    {
      id: 'q',
      kind: 'api',
      layer: 'Delivery',
      title: 'market-query-v2',
      subtitle: '',
      position: { x: COL * 5, y: 0 },
      inputs: [{ name: 'LRANGE', type: 'Redis', description: '' }],
      outputs: [{ name: 'queryPutThroughAdvertise', type: 'endpoint', description: '' }],
      details:
        'Client opens the Advertise tab — 1 LRANGE fetches today\'s advertises for the exchange.',
    },
    {
      id: 'wsv2',
      kind: 'ws',
      layer: 'Delivery',
      title: 'ws-v2',
      subtitle: '',
      position: { x: COL * 5, y: ROW * 1.4 },
      inputs: [{ name: 'consume advertisedUpdate', type: 'Kafka', description: '' }],
      outputs: [{ name: 'publish market.putthrough.advertise.{market}', type: 'channel', description: '' }],
      details:
        'Realtime channel so the "Advertise" tab doesn\'t need reloading.',
    },
    {
      id: 'cron-persist',
      kind: 'schedule',
      layer: 'Cron',
      title: 'saveRedisToDatabase()',
      subtitle: '',
      position: { x: COL * 4, y: ROW * 2.3 },
      inputs: [{ name: '@Scheduled', type: 'cron', description: '' }],
      outputs: [{ name: 'advertise lists → c_advertise', type: 'Mongo', description: '' }],
      details:
        'LRANGE realtime_listAdvertised_* → bulk write c_advertise for audit.',
    },
    {
      id: 'cron-reset',
      kind: 'schedule',
      layer: 'Cron',
      title: 'removeAutoData() 00:55',
      subtitle: '',
      position: { x: COL * 4, y: ROW * 3.2 },
      inputs: [{ name: '@Scheduled', type: 'cron', description: '' }],
      outputs: [{ name: 'clear advertised lists', type: 'del', description: '' }],
      details:
        'Clears the list so the new day starts clean. Data has already been persisted to c_advertise in the previous saveRedisToDatabase cron runs.',
    },
  ],
  edges: [
    { source: 'ws', target: 'collector', label: 'raw', animated: true },
    { source: 'collector', target: 'kafka', label: 'publish', animated: true },
    { source: 'kafka', target: 'service', label: 'consume', animated: true },
    { source: 'service', target: 'r', label: 'RPUSH' },
    { source: 'r', target: 'q', label: 'LRANGE' },
    { source: 'kafka', target: 'wsv2', label: 'consume direct', animated: true },
    { source: 'r', target: 'cron-persist', label: 'getAll' },
    { source: 'cron-reset', target: 'r', label: 'clear' },
  ],
};

// ─────────────────────────────────────────────────────────────────────────
// 14. SymbolPrevious
// ─────────────────────────────────────────────────────────────────────────
const lifecycleSymbolPrevious = {
  id: 'lc-symbol-previous',
  category: 'lifecycle',
  title: 'Lifecycle · SymbolPrevious',
  subtitle:
    'Post-process — NOT from a feed · updateSymbolPrevious runs inside saveRedisToDatabase · bridges today\'s session ↔ previous session',
  accent: '#7dd3fc',
  nodes: [
    {
      id: 'daily',
      kind: 'redis',
      layer: 'Source',
      title: 'realtime_mapSymbolDaily',
      subtitle: 'Input for previous',
      position: { x: 0, y: ROW },
      inputs: [{ name: 'HGET today', type: 'Redis', description: '' }],
      outputs: [{ name: 'SymbolDaily.last + SymbolDaily.date', type: 'read', description: '' }],
      details:
        'SymbolPrevious LOOKS UP today\'s SymbolDaily to know the close price to update. Only read after the saveRedisToDatabase cron has run (daily is now the latest).',
    },
    {
      id: 'cron',
      kind: 'schedule',
      layer: 'Cron trigger',
      title: 'saveRedisToDatabase() → updateSymbolPrevious()',
      subtitle: '6×/day',
      position: { x: COL, y: ROW },
      inputs: [{ name: '@Scheduled', type: 'cron', description: '' }],
      outputs: [{ name: 'trigger compare logic', type: 'call', description: '' }],
      details:
        'updateSymbolPrevious() is the final step of the saveRedisToDatabase pipeline. After today\'s SymbolDaily has been bulk-written to Mongo, this method keeps SymbolPrevious in sync.',
    },
    {
      id: 'logic',
      kind: 'logic',
      layer: 'Compare logic',
      title: 'updateSymbolPrevious()',
      subtitle: 'Same date vs different date',
      position: { x: COL * 2, y: ROW },
      inputs: [
        { name: 'today\'s SymbolDaily', type: 'object', description: '' },
        { name: 'existing SymbolPrevious', type: 'object', description: '' },
      ],
      outputs: [
        { name: 'IF sameDate → only update close', type: 'branch', description: '' },
        { name: 'ELSE → previousClose = old close · previousTradingDate = old lastTradingDate · close = daily.last · lastTradingDate = daily.date', type: 'branch', description: '' },
      ],
      details:
        'Compare logic:\n\n' +
        '  • If SymbolPrevious.lastTradingDate == SymbolDaily.date (same trading day) → sameDate = true\n' +
        '      – ONLY update close = daily.last (done during intraday, cron runs multiple times/day)\n' +
        '      – Do not touch previousClose / previousTradingDate\n\n' +
        '  • If different day → BROADER:\n' +
        '      – previousClose   = old close (previous session\'s close)\n' +
        '      – previousTradingDate = old lastTradingDate\n' +
        '      – close           = daily.last (today)\n' +
        '      – lastTradingDate = daily.date (today)\n\n' +
        '  This is the "advance" session mechanism — triggered only when a new trading day is detected.',
    },
    {
      id: 'mongo',
      kind: 'mongo',
      layer: 'Persistence',
      title: 'c_symbol_previous',
      subtitle: 'Day-level',
      position: { x: COL * 3, y: ROW },
      inputs: [{ name: 'upsert', type: 'Mongo', description: '' }],
      outputs: [{ name: 'client computes change vs previous session', type: 'read', description: '' }],
      details:
        'Shape: { code, close, lastTradingDate, previousClose, previousTradingDate, updatedAt }.\n\n' +
        'Different from referencePrice (the exchange\'s reference, which may ≠ actual close in some dividend/split cases). previousClose is the ACTUAL close price from the previous session.',
    },
    {
      id: 'note',
      kind: 'config',
      layer: 'Note',
      title: 'No dedicated Redis key',
      subtitle: 'Mongo only',
      position: { x: COL * 2, y: ROW * 2.2 },
      inputs: [],
      outputs: [],
      details:
        'SymbolPrevious has NO hot state in Redis — it does not need a realtime update per tick. Updating 6×/day is sufficient.\n\nThe client queries Mongo directly when needed (typically joining with SymbolInfo to compute % change vs previous).',
    },
  ],
  edges: [
    { source: 'cron', target: 'logic', label: 'invoke' },
    { source: 'daily', target: 'logic', label: 'read today' },
    { source: 'logic', target: 'mongo', label: 'upsert' },
  ],
};

// ─────────────────────────────────────────────────────────────────────────
// 15. symbolInfoExtend
// ─────────────────────────────────────────────────────────────────────────
const lifecycleSymbolInfoExtend = {
  id: 'lc-symbol-info-extend',
  category: 'lifecycle',
  title: 'Lifecycle · symbolInfoExtend',
  subtitle:
    'Static extension data · does NOT mutate per tick · merged with realtime_mapSymbolInfo inside querySymbolStaticInfo',
  accent: '#94a3b8',
  nodes: [
    {
      id: 'src',
      kind: 'source',
      layer: 'Ingest (outside the main realtime flow)',
      title: 'Static feed / admin job',
      subtitle: 'listedQty / avgTradingVol10 / reference/floor/ceiling...',
      position: { x: 0, y: ROW },
      inputs: [{ name: 'realtime trigger unclear from context', type: 'note', description: '' }],
      outputs: [{ name: 'symbolInfoExtend record', type: 'object', description: '' }],
      details:
        'Docs do not clearly describe the per-tick mutation path. Assumption: this is static data (listedQty, 10-day avgTradingVol, daily reference/floor/ceiling, basicPrice...) loaded from:\n' +
        '  • Start-of-day admin batch job\n' +
        '  • Or ingested from another feed (Lotte batch, core system)\n\n' +
        'Currently treated as static support — no mutation code path in the main realtime flow.',
    },
    {
      id: 'r',
      kind: 'redis',
      layer: 'Redis',
      title: 'symbolInfoExtend',
      subtitle: 'Hash by code',
      position: { x: COL, y: ROW },
      inputs: [{ name: 'HSET (admin batch)', type: 'Redis', description: '' }],
      outputs: [{ name: 'static support fields', type: 'hash', description: '' }],
      details:
        'The key has no "realtime_" prefix — implying the data is not realtime-hot. Fields: listedQty, avgTradingVol10, referencePrice/floor/ceiling, basicPrice, tradingUnit, lotSize, ...',
    },
    {
      id: 'q',
      kind: 'api',
      layer: 'Delivery',
      title: 'querySymbolStaticInfo()',
      subtitle: 'Merge with realtime_mapSymbolInfo',
      position: { x: COL * 2, y: ROW },
      inputs: [
        { name: 'realtime_mapSymbolInfo[code]', type: 'Redis', description: '' },
        { name: 'symbolInfoExtend[code]', type: 'Redis', description: '' },
      ],
      outputs: [
        { name: 'merged static info response', type: 'endpoint', description: 'listedQty / avgTradingVol10 / reference/floor/ceiling / ...' },
      ],
      details:
        'Query logic:\n' +
        '  1. HMGET realtime_mapSymbolInfo (realtime fields)\n' +
        '  2. HMGET symbolInfoExtend (static fields)\n' +
        '  3. MERGE the two objects — fields from realtime_mapSymbolInfo take precedence on conflict\n' +
        '  4. Return to the client\'s "Basic info" screen for the symbol.',
    },
  ],
  edges: [
    { source: 'src', target: 'r', label: 'HSET (static)' },
    { source: 'r', target: 'q', label: 'merge with SymbolInfo' },
  ],
};

// ─────────────────────────────────────────────────────────────────────────
// 16. IndexStockList
// ─────────────────────────────────────────────────────────────────────────
const lifecycleIndexStockList = {
  id: 'lc-index-stock-list',
  category: 'lifecycle',
  title: 'Lifecycle · IndexStockList',
  subtitle:
    'Index basket composition · admin/collector publishes indexStockListUpdate · persisted in Mongo · getIndexRanks() joins with Redis SymbolInfo',
  accent: '#fde68a',
  nodes: [
    {
      id: 'src',
      kind: 'logic',
      layer: 'Collector / Admin job',
      title: 'publish indexStockListUpdate',
      subtitle: 'When the basket composition changes',
      position: { x: 0, y: ROW },
      inputs: [{ name: 'admin trigger or collector init', type: 'call', description: '' }],
      outputs: [{ name: 'IndexStockList payload', type: 'object', description: '' }],
      details:
        'The event is published when:\n' +
        '  • An admin updates the VN30/HNX30/VN100 basket after an exchange review\n' +
        '  • The start-of-day collector re-syncs from Lotte indexs-list if a composition change is detected\n\n' +
        'Not tick-triggered — very low frequency (a few times per month).',
    },
    {
      id: 'kafka',
      kind: 'kafka',
      layer: 'Kafka',
      title: 'indexStockListUpdate',
      subtitle: '',
      position: { x: COL, y: ROW },
      inputs: [{ name: 'producer', type: 'Kafka', description: '' }],
      outputs: [{ name: 'realtime-v2 consumer', type: 'Kafka', description: '' }],
      details:
        'Dedicated topic, separate from symbolInfoUpdate. Consumed only by realtime-v2, not ws-v2 (clients do not need realtime basket composition).',
    },
    {
      id: 'handler',
      kind: 'logic',
      layer: 'realtime-v2',
      title: 'IndexStockListUpdateHandler',
      subtitle: 'indexStockService.updateIndexList()',
      position: { x: COL * 2, y: ROW },
      inputs: [{ name: 'Message<IndexStockList>', type: 'Kafka', description: '' }],
      outputs: [
        { name: 'normalize indexCode', type: 'compute', description: '' },
        { name: 'upsert IndexStockList collection', type: 'Mongo', description: '' },
      ],
      details:
        'Logic:\n' +
        '  1. Normalize indexCode (e.g. "vn30" → "VN30", trim whitespace)\n' +
        '  2. Upsert into the IndexStockList collection keyed by _id = indexCode\n' +
        '  3. No HSET in Redis because the data is static; reading Mongo on each query is fine.',
    },
    {
      id: 'mongo',
      kind: 'mongo',
      layer: 'Persistence',
      title: 'IndexStockList',
      subtitle: 'Mongo collection',
      position: { x: COL * 3, y: ROW },
      inputs: [{ name: 'upsert', type: 'Mongo', description: '' }],
      outputs: [{ name: 'symbol list in the basket', type: 'read', description: '' }],
      details:
        'Shape: { _id: indexCode, codes: ["VIC","VHM","HPG",...], weights: [0.08, 0.07, ...], updatedAt }.',
    },
    {
      id: 'rank',
      kind: 'logic',
      layer: 'Delivery logic',
      title: 'IndexStockService.getIndexRanks()',
      subtitle: 'Join Mongo + Redis SymbolInfo',
      position: { x: COL * 4, y: 0 },
      inputs: [
        { name: 'IndexStockList (Mongo)', type: 'Mongo', description: '' },
        { name: 'realtime_mapSymbolInfo (Redis)', type: 'Redis', description: 'per symbol' },
      ],
      outputs: [
        { name: 'sort by rate / tradingValue', type: 'compute', description: '' },
        { name: 'return ranking within the index', type: 'response', description: '' },
      ],
      details:
        'Hot path when the client opens the "VN30 basket details" tab:\n' +
        '  1. Find IndexStockList by indexCode → get the codes[] array\n' +
        '  2. HMGET realtime_mapSymbolInfo with codes[] → get snapshots of every symbol in the basket\n' +
        '  3. Sort by the client criterion (rate desc, tradingValue desc, ...)\n' +
        '  4. Return a response with rank + compact SymbolInfo\n\n' +
        'This is a cross-store JOIN — round-trips are reduced by HMGETting all symbols in one call.',
    },
    {
      id: 'q',
      kind: 'api',
      layer: 'Delivery',
      title: 'market-query-v2',
      subtitle: 'Index endpoints',
      position: { x: COL * 4, y: ROW * 1.4 },
      inputs: [{ name: 'call getIndexRanks', type: 'call', description: '' }],
      outputs: [
        { name: 'queryIndexList', type: 'endpoint', description: 'available baskets' },
        { name: 'queryIndexStockList', type: 'endpoint', description: 'ranking inside a basket' },
      ],
      details:
        'queryIndexList returns basket metadata (VN30, HNX30, VN100...). queryIndexStockList returns the ranking within a chosen basket — delegating to IndexStockService.getIndexRanks().',
    },
  ],
  edges: [
    { source: 'src', target: 'kafka', label: 'publish', animated: true },
    { source: 'kafka', target: 'handler', label: 'consume', animated: true },
    { source: 'handler', target: 'mongo', label: 'upsert' },
    { source: 'mongo', target: 'rank', label: 'find basket' },
    { source: 'rank', target: 'q', label: 'response' },
  ],
};

// ─────────────────────────────────────────────────────────────────────────
// 17. Reset & Persist — Cross-cutting cron lifecycle
// ─────────────────────────────────────────────────────────────────────────
const lifecycleResetPersist = {
  id: 'lc-reset-persist',
  category: 'lifecycle',
  title: 'Lifecycle · Reset & Persist (cross-cutting)',
  subtitle:
    '4 cron jobs cutting across object lifecycles · removeAutoData (00:55) · refreshSymbolInfo (01:35) · clearOldSymbolDaily (22:50) · saveRedisToDatabase (6×/day)',
  accent: '#fb7185',
  nodes: [
    // Cron triggers
    {
      id: 'c1',
      kind: 'schedule',
      layer: 'Cron 00:55',
      title: 'removeAutoData()',
      subtitle: '0 55 0 * * MON-FRI',
      position: { x: 0, y: 0 },
      inputs: [{ name: '@Scheduled', type: 'cron', description: '' }],
      outputs: [
        { name: 'clear realtime_listQuoteMinute_*', type: 'del', description: '' },
        { name: 'clear realtime_listQuote_*', type: 'del', description: '' },
        { name: 'clear realtime_listQuoteMeta_*', type: 'del', description: '' },
        { name: 'clear wrong-order quote', type: 'del', description: '' },
        { name: 'clear bid-offer lists', type: 'del', description: '' },
        { name: 'clear deal notice lists', type: 'del', description: '' },
        { name: 'clear advertised lists', type: 'del', description: '' },
        { name: 'clear statistic', type: 'del', description: '' },
        { name: 'cacheService.reset()', type: 'reset', description: '' },
      ],
      details:
        'The LARGEST cleanup job — deletes all previous-day realtime intraday data.\n\n' +
        '00:55 is chosen to be far enough past close (15:00) that saveRedisToDatabase has finished, while still early enough before the next market open (09:00).\n\n' +
        'Finally cacheService.reset() clears the in-memory cache to avoid staleness after Redis is flushed.',
    },
    {
      id: 'c2',
      kind: 'schedule',
      layer: 'Cron 01:35',
      title: 'refreshSymbolInfo()',
      subtitle: '0 35 1 * * MON-FRI',
      position: { x: 0, y: ROW * 1.3 },
      inputs: [{ name: '@Scheduled', type: 'cron', description: '' }],
      outputs: [
        { name: 'reset SymbolInfo.sequence', type: 'reset', description: '' },
        { name: 'reset matchingVolume', type: 'reset', description: '' },
        { name: 'reset matchedBy', type: 'reset', description: '' },
        { name: 'reset bidOfferList', type: 'reset', description: '' },
        { name: 'reset oddlotBidOfferList', type: 'reset', description: '' },
        { name: 'cacheService.reset()', type: 'reset', description: '' },
      ],
      details:
        'A "soft reset" job — only resets intraday fields OF SymbolInfo without deleting the snapshot map.\n\n' +
        'Why NOT delete: the SymbolInfo baseline (code/name/type/referencePrice/ceiling/floor/listedQty/foreignerTotalRoom...) does not change day-over-day and does not need to be re-initialized from REST. Only intraday fields (sequence, matching*, bidOfferList) need reset.',
    },
    {
      id: 'c3',
      kind: 'schedule',
      layer: 'Cron 22:50',
      title: 'clearOldSymbolDaily()',
      subtitle: '0 50 22 * * MON-FRI',
      position: { x: 0, y: ROW * 2.6 },
      inputs: [{ name: '@Scheduled', type: 'cron', description: '' }],
      outputs: [
        { name: 'clear realtime_mapSymbolDaily', type: 'del', description: '' },
        { name: 'clear cache mapSymbolDaily', type: 'del', description: '' },
      ],
      details:
        'A small dedicated job for SymbolDaily — the 22:50 timing (after the 14:29 saveRedisToDatabase has written Mongo) is safe to clear Redis.\n\n' +
        'After this job the Redis mapSymbolDaily is empty. The first tick of the new day will re-create the record.',
    },
    {
      id: 'c4',
      kind: 'schedule',
      layer: 'Cron 6×/day',
      title: 'saveRedisToDatabase()',
      subtitle: '10:15/10:29/11:15/11:29/14:15/14:29',
      position: { x: 0, y: ROW * 3.9 },
      inputs: [{ name: '@Scheduled', type: 'cron', description: '' }],
      outputs: [
        { name: 'SymbolInfo → c_symbol_info', type: 'Mongo', description: '' },
        { name: 'SymbolInfoOddLot → odd-lot collection', type: 'Mongo', description: '' },
        { name: 'SymbolDaily → c_symbol_daily', type: 'Mongo', description: '' },
        { name: 'ForeignerDaily → c_foreigner_daily', type: 'Mongo', description: 'id = code_yyyyMMdd' },
        { name: 'MarketStatus → c_market_session_status', type: 'Mongo', description: '' },
        { name: 'DealNotice → c_deal_notice', type: 'Mongo', description: '' },
        { name: 'Advertised → c_advertise', type: 'Mongo', description: '' },
        { name: 'updateSymbolPrevious → c_symbol_previous', type: 'Mongo', description: '' },
        { name: 'quote/minute/bid-ask: RUNTIME OFF — not persisted', type: 'skip', description: '' },
      ],
      details:
        'A LARGE persist job — runs 6 times/day spread across 3 windows:\n' +
        '  • Pre-lunch:  10:15, 10:29\n' +
        '  • Pre-close-lunch: 11:15, 11:29\n' +
        '  • Pre-market-close: 14:15, 14:29\n\n' +
        'Each run executes sequentially:\n' +
        '  1. HGETALL realtime_mapSymbolInfo → bulk write c_symbol_info\n' +
        '  2. HGETALL realtime_mapSymbolInfoOddLot → bulk write odd-lot collection\n' +
        '  3. HGETALL realtime_mapSymbolDaily → bulk write c_symbol_daily\n' +
        '  4. HGETALL realtime_mapForeignerDaily → bulk write c_foreigner_daily (id=code_yyyyMMdd)\n' +
        '  5. HGETALL realtime_mapMarketStatus → bulk write c_market_session_status\n' +
        '  6. LRANGE realtime_listDealNotice_* → bulk write c_deal_notice\n' +
        '  7. LRANGE realtime_listAdvertised_* → bulk write c_advertise\n' +
        '  8. updateSymbolPrevious() → upsert c_symbol_previous\n\n' +
        'SKIPPED: quote ticks, minute bars, bid-offer history — due to OFF feature flags.',
    },

    // Target objects
    {
      id: 'obj-quote',
      kind: 'logic',
      layer: 'Object',
      title: 'SymbolQuote + Meta',
      subtitle: 'Cleared 00:55',
      position: { x: COL * 2, y: 0 },
      inputs: [{ name: 'cleared by removeAutoData', type: 'affected', description: '' }],
      outputs: [{ name: 'realtime_listQuote_* / realtime_listQuoteMeta_*', type: 'Redis', description: '' }],
      details:
        'Tick list + partition meta. Not persisted to Mongo, so previous-day ticks are completely gone after 00:55.',
    },
    {
      id: 'obj-minute',
      kind: 'logic',
      layer: 'Object',
      title: 'SymbolQuoteMinute',
      subtitle: 'Cleared 00:55',
      position: { x: COL * 2, y: ROW * 0.5 },
      inputs: [{ name: 'cleared by removeAutoData', type: 'affected', description: '' }],
      outputs: [{ name: 'realtime_listQuoteMinute_*', type: 'Redis', description: '' }],
      details:
        'Previous-day minute bars are deleted. enableSaveQuoteMinute=false means no minute history exists in the DB.',
    },
    {
      id: 'obj-stat',
      kind: 'logic',
      layer: 'Object',
      title: 'SymbolStatistic',
      subtitle: 'Cleared 00:55',
      position: { x: COL * 2, y: ROW },
      inputs: [{ name: 'cleared by removeAutoData', type: 'affected', description: '' }],
      outputs: [{ name: 'realtime_mapSymbolStatistic', type: 'Redis', description: '' }],
      details:
        'Price-level aggregate is deleted. The new day starts with empty price buckets.',
    },
    {
      id: 'obj-bo',
      kind: 'logic',
      layer: 'Object',
      title: 'BidOffer lists + OddLot',
      subtitle: 'Clear 00:55 + reset 01:35',
      position: { x: COL * 2, y: ROW * 1.5 },
      inputs: [{ name: 'cleared / partial reset', type: 'affected', description: '' }],
      outputs: [{ name: 'realtime_listBidOffer_* / realtime_listBidOfferOddLot_*', type: 'Redis', description: '' }],
      details:
        'The list is deleted at 00:55. refreshSymbolInfo at 01:35 additionally resets bidOfferList inside SymbolInfo and oddlotBidOfferList inside SymbolInfoOddLot.',
    },
    {
      id: 'obj-deal',
      kind: 'logic',
      layer: 'Object',
      title: 'DealNotice / Advertised',
      subtitle: 'Cleared 00:55',
      position: { x: COL * 2, y: ROW * 2 },
      inputs: [{ name: 'cleared by removeAutoData', type: 'affected', description: '' }],
      outputs: [{ name: 'realtime_listDealNotice_* / realtime_listAdvertised_*', type: 'Redis', description: '' }],
      details:
        'Lists are deleted. Data has already been persisted to c_deal_notice / c_advertise in prior saveRedisToDatabase runs — history remains queryable.',
    },
    {
      id: 'obj-info',
      kind: 'logic',
      layer: 'Object',
      title: 'SymbolInfo (partial reset)',
      subtitle: 'refreshSymbolInfo does NOT delete the map',
      position: { x: COL * 2, y: ROW * 2.5 },
      inputs: [{ name: 'reset intraday fields', type: 'affected', description: '' }],
      outputs: [{ name: 'keeps the snapshot map', type: 'preserve', description: '' }],
      details:
        'A SPECIAL object — the map is NOT entirely deleted. Only resets:\n' +
        '  • sequence, bidAskSequence\n' +
        '  • matchingVolume, matchedBy\n' +
        '  • bidOfferList (top book)\n\n' +
        'Preserves: code, name, type, referencePrice, ceiling, floor, listedQty, foreigner baseline... (no need to reload from REST every day).',
    },
    {
      id: 'obj-daily',
      kind: 'logic',
      layer: 'Object',
      title: 'SymbolDaily',
      subtitle: 'Cleared 22:50 (dedicated cron)',
      position: { x: COL * 2, y: ROW * 3.2 },
      inputs: [{ name: 'cleared by clearOldSymbolDaily', type: 'affected', description: '' }],
      outputs: [{ name: 'realtime_mapSymbolDaily', type: 'Redis', description: '' }],
      details:
        'Cleared at 22:50 because Daily has been persisted throughout the day and there is no need to keep it in Redis by the evening. Mongo c_symbol_daily has the full record.',
    },
    {
      id: 'obj-persist',
      kind: 'logic',
      layer: 'Object',
      title: 'Persistable objects',
      subtitle: 'Snapshot 6×/day',
      position: { x: COL * 2, y: ROW * 3.9 },
      inputs: [{ name: 'snapshot by saveRedisToDatabase', type: 'affected', description: '' }],
      outputs: [
        { name: 'SymbolInfo · SymbolInfoOddLot · SymbolDaily · ForeignerDaily · MarketStatus · DealNotice · Advertised · SymbolPrevious', type: 'Mongo', description: '' },
      ],
      details:
        '8 objects periodically snapshotted to Mongo to provide full query history. No quote ticks / minute bars / bidOffer history are persisted because of the OFF runtime flags.',
    },
  ],
  edges: [
    { source: 'c1', target: 'obj-quote', label: 'clear' },
    { source: 'c1', target: 'obj-minute', label: 'clear' },
    { source: 'c1', target: 'obj-stat', label: 'clear' },
    { source: 'c1', target: 'obj-bo', label: 'clear' },
    { source: 'c1', target: 'obj-deal', label: 'clear' },
    { source: 'c2', target: 'obj-info', label: 'reset partial fields' },
    { source: 'c2', target: 'obj-bo', label: 'reset bidOfferList' },
    { source: 'c3', target: 'obj-daily', label: 'clear' },
    { source: 'c4', target: 'obj-persist', label: 'bulk write', animated: true },
  ],
};

// ─────────────────────────────────────────────────────────────────────────
// Export
// ─────────────────────────────────────────────────────────────────────────
export const lifecycles = [
  lifecycleObjectMap,
  lifecycleSymbolInfo,
  lifecycleSymbolQuote,
  lifecycleListQuoteMeta,
  lifecycleSymbolQuoteMinute,
  lifecycleSymbolStatistic,
  lifecycleBidOffer,
  lifecycleOddLot,
  lifecycleSymbolDaily,
  lifecycleForeignerDaily,
  lifecycleMarketStatus,
  lifecycleExtraUpdate,
  lifecycleDealNotice,
  lifecycleAdvertised,
  lifecycleSymbolPrevious,
  lifecycleSymbolInfoExtend,
  lifecycleIndexStockList,
  lifecycleResetPersist,
];
