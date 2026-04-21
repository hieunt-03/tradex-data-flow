// ============================================================================
// TradeX Market Data — OBJECT LIFECYCLE DIAGRAMS
// ============================================================================
// Mỗi lifecycle mô tả vòng đời của 1 object: nguồn sinh · transform ·
// Redis/Mongo · delivery · reset/persist.
//
// QUY ƯỚC details:
//   • Giải thích hàm LÀM GÌ (không mô tả lại tên hàm)
//   • Liệt kê input → bước xử lý chính → output
//   • Flag behavior quan trọng (skip / branch / feature flag)
//
// category = 'lifecycle' để App chọn đúng parent tab.
// ============================================================================

const COL = 480;
const ROW = 320;

// ─────────────────────────────────────────────────────────────────────────
// 0. OBJECT RELATIONSHIP OVERVIEW — Bản đồ quan hệ 17 object
// ─────────────────────────────────────────────────────────────────────────
// Mục tiêu: ở 1 màn duy nhất nhìn thấy MỌI object + mũi tên phụ thuộc
// (cái gì mutate cái gì, cái gì derive từ cái gì).
//
// Phân 3 lane dọc:
//   1. EVENT SOURCES  (x ≈ 0)      — object đến từ feed Lotte
//   2. ENRICHMENT     (x ≈ COL*2)  — ExtraUpdate (fanout mutator)
//   3. TARGET STATE   (x ≈ COL*4)  — object cuối đọng ở Redis/Mongo
// ─────────────────────────────────────────────────────────────────────────
const lifecycleObjectMap = {
  id: 'lc-object-map',
  category: 'lifecycle',
  title: 'Object Map · Quan hệ phụ thuộc 17 object',
  subtitle:
    'Bản đồ tổng 17 object + mũi tên mutate/derive · 3 lane: Event Sources → Enrichment → Target State · Odd-lot cách ly',
  accent: '#6366f1',
  nodes: [
    // ─── LANE 1 · EVENT SOURCES (từ Lotte feed) ────────────────────
    {
      id: 'src-quote',
      kind: 'source',
      layer: 'Event source',
      title: 'SymbolQuote',
      subtitle: 'Tick khớp lệnh — auto.qt/idxqt/futures',
      position: { x: 0, y: 0 },
      inputs: [{ name: 'Lotte WS', type: 'event', description: '' }],
      outputs: [
        { name: '→ SymbolInfo (update)', type: 'mutate', description: '' },
        { name: '→ ForeignerDaily', type: 'mutate', description: '' },
        { name: '→ SymbolDaily', type: 'mutate', description: '' },
        { name: '→ SymbolQuoteMinute (derive)', type: 'derive', description: '' },
        { name: '→ SymbolStatistic (derive, non-INDEX)', type: 'derive', description: '' },
        { name: '→ ListQuoteMeta + realtime_listQuote_{code}', type: 'persist', description: '' },
        { name: '→ calExtraUpdate (khi high/low year đổi)', type: 'trigger', description: '' },
      ],
      details:
        'Object "nguồn" có impact lớn nhất — 1 SymbolQuote kéo theo 6 object khác bị mutate/derive trong cùng lúc. Đây là lý do QuoteService.updateQuote là hot path quan trọng nhất.',
    },
    {
      id: 'src-bo',
      kind: 'source',
      layer: 'Event source',
      title: 'BidOffer',
      subtitle: 'Sổ lệnh 3 bước giá — auto.bo',
      position: { x: 0, y: ROW * 1.3 },
      inputs: [{ name: 'Lotte WS', type: 'event', description: '' }],
      outputs: [{ name: '→ SymbolInfo.bidOfferList (ghi đè top book)', type: 'mutate', description: '' }],
      details:
        'BidOffer chỉ mutate DUY NHẤT SymbolInfo (thay bidOfferList + tăng bidAskSequence). Không derive object riêng nào.\nHistory OFF runtime (enableSaveBidOffer=false).',
    },
    {
      id: 'src-status',
      kind: 'source',
      layer: 'Event source',
      title: 'MarketStatus',
      subtitle: 'Phiên theo market — auto.tickerNews',
      position: { x: 0, y: ROW * 2.4 },
      inputs: [{ name: 'Lotte WS', type: 'event', description: '' }],
      outputs: [
        { name: '→ MarketStatus state (self)', type: 'persist', description: '' },
        { name: '→ SymbolInfo.sessions (broadcast ATO/ATC)', type: 'broadcast', description: 'toàn bộ mã cùng market' },
      ],
      details:
        'Event ít nhưng tác động rộng — 1 event ATO có thể mutate hàng nghìn SymbolInfo cùng lúc. Là "self-persisted" vì vừa là event vừa là target state.',
    },
    {
      id: 'src-deal',
      kind: 'source',
      layer: 'Event source',
      title: 'DealNotice',
      subtitle: 'Thỏa thuận khớp — put-through feed',
      position: { x: 0, y: ROW * 3.5 },
      inputs: [{ name: 'Lotte WS', type: 'event', description: '' }],
      outputs: [
        { name: '→ SymbolInfo.ptTradingVolume / ptTradingValue', type: 'mutate', description: '' },
        { name: '→ DealNotice list per market', type: 'persist', description: '' },
        { name: '→ ExtraUpdate (PT summary)', type: 'trigger', description: '' },
      ],
      details:
        'Dual-role: vừa là event có lịch sử riêng (list) vừa là trigger cho ExtraUpdate để cộng dồn PT summary vào SymbolInfo.',
    },
    {
      id: 'src-adv',
      kind: 'source',
      layer: 'Event source',
      title: 'Advertised',
      subtitle: 'Rao bán thỏa thuận',
      position: { x: 0, y: ROW * 4.5 },
      inputs: [{ name: 'Lotte WS', type: 'event', description: '' }],
      outputs: [{ name: '→ Advertised list per market (history only)', type: 'persist', description: '' }],
      details:
        'Object "cô lập" nhất — chỉ có list history, KHÔNG mutate SymbolInfo vì chưa khớp.',
    },
    {
      id: 'src-index',
      kind: 'source',
      layer: 'Event source',
      title: 'IndexStockList',
      subtitle: 'Cấu trúc rổ chỉ số',
      position: { x: 0, y: ROW * 5.5 },
      inputs: [{ name: 'Admin job / collector init', type: 'trigger', description: '' }],
      outputs: [{ name: '→ IndexStockList Mongo collection', type: 'persist', description: '' }],
      details:
        'Event "chậm" — chỉ thay đổi khi sàn review rổ (vài lần/tháng). Không có hot state Redis.',
    },

    // ─── LANE 1.5 · ODD-LOT (tách riêng) ───────────────────────────
    {
      id: 'src-qt-odd',
      kind: 'source',
      layer: 'Event source · Odd-lot',
      title: 'SymbolQuoteOddLot',
      subtitle: 'Quote lô lẻ — auto.qt.oddlot',
      position: { x: 0, y: ROW * 7 },
      inputs: [{ name: 'Lotte WS (channel riêng)', type: 'event', description: '' }],
      outputs: [{ name: '→ SymbolInfoOddLot', type: 'mutate', description: '' }],
      details:
        'Nhánh LÔ LẺ CÁCH LY — chỉ mutate SymbolInfoOddLot, KHÔNG chạm SymbolInfo thường, không derive minute/stat/daily/foreigner.',
    },
    {
      id: 'src-bo-odd',
      kind: 'source',
      layer: 'Event source · Odd-lot',
      title: 'BidOfferOddLot',
      subtitle: 'Sổ lệnh lô lẻ — auto.bo.oddlot',
      position: { x: 0, y: ROW * 8.1 },
      inputs: [{ name: 'Lotte WS (channel riêng)', type: 'event', description: '' }],
      outputs: [
        { name: '→ SymbolInfoOddLot.bidOfferList', type: 'mutate', description: '' },
        { name: '→ BidOfferOddLot list (runtime ON)', type: 'persist', description: '' },
      ],
      details:
        'Khác BidOffer thường: luôn ON ghi history realtime_listBidOfferOddLot_{code}.',
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
        { name: '← SymbolQuote (calExtraUpdate khi high/low year đổi)', type: 'trigger', description: '' },
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
        'ExtraUpdate KHÔNG phải object lưu lâu — chỉ tồn tại như message Kafka. Sau khi mutate 3 target xong là tan biến. Đặt ở giữa lane 2 để nhìn rõ vai trò "cầu nối" giữa nhiều source → nhiều target.',
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
        'Object TRUNG TÂM nhất trong hệ thống — mọi flow đều đổ về. Là "single source of truth" cho read snapshot.',
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
      details: 'State NĐTNN cộng dồn intraday. Persist 6×/day sang Mongo.',
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
        { name: '← ExtraUpdate (pt cộng dồn)', type: 'mutate', description: '' },
      ],
      outputs: [
        { name: '→ SymbolPrevious (hậu xử lý)', type: 'derive', description: '' },
        { name: '→ Mongo c_symbol_daily', type: 'persist', description: '' },
      ],
      details: 'Daily OHLCV. Cleared 22:50, Mongo giữ historical.',
    },
    {
      id: 'tgt-minute',
      kind: 'redis',
      layer: 'Target · Derived',
      title: 'SymbolQuoteMinute',
      subtitle: 'realtime_listQuoteMinute_{code}',
      position: { x: COL * 4, y: ROW * 3.6 },
      inputs: [{ name: '← SymbolQuote (3 nhánh create/update/skip)', type: 'derive', description: '' }],
      outputs: [
        { name: '→ queryMinuteChart / TV intraday', type: 'read', description: '' },
        { name: '→ Mongo (OFF runtime)', type: 'skip', description: 'enableSaveQuoteMinute=false' },
      ],
      details: 'Nến phút derive từ Quote. Không persist.',
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
      details: 'Aggregate theo giá. INDEX bị skip vì không có khớp lệnh.',
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
      details: 'Metadata kỹ thuật để paginate realtime_listQuote_{code}. Partition overflow khi list vượt ngưỡng.',
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
      details: 'Vừa là event vừa là target — lưu snapshot phiên hiện tại của mỗi market.',
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
      details: 'History theo market. Dedupe theo confirmNumber.',
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
      details: 'History rao bán theo market.',
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
      details: 'Snapshot lô lẻ — single hash nhận ghi từ 2 mutator.',
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
      details: 'KHÁC bản stock — runtime ON, có history đầy đủ.',
    },

    // ─── LANE 4 · POST-PROCESS & STATIC ─────────────────────────────
    {
      id: 'tgt-prev',
      kind: 'mongo',
      layer: 'Post-process',
      title: 'SymbolPrevious',
      subtitle: 'c_symbol_previous (Mongo only)',
      position: { x: COL * 6.5, y: ROW * 1.2 },
      inputs: [{ name: '← SymbolDaily (trong saveRedisToDatabase)', type: 'derive', description: '' }],
      outputs: [{ name: '→ Client tính biến động so với phiên trước', type: 'read', description: '' }],
      details:
        'Hậu xử lý — sameDate chỉ update close, khác date → advance previousClose/previousTradingDate. Không có Redis hot state.',
    },
    {
      id: 'tgt-ext',
      kind: 'redis',
      layer: 'Static support',
      title: 'symbolInfoExtend',
      subtitle: 'Hash static (không prefix realtime_)',
      position: { x: COL * 6.5, y: ROW * 2.4 },
      inputs: [{ name: '← Admin batch job (unclear trong docs)', type: 'ingest', description: '' }],
      outputs: [{ name: '→ querySymbolStaticInfo (merge với SymbolInfo)', type: 'read', description: '' }],
      details:
        'Data static (listedQty/avgTradingVol10/reference/floor/ceiling). Merge cùng SymbolInfo khi query info cơ bản.',
    },
  ],
  edges: [
    // Quote fanout (nhánh mutate chính)
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
    { source: 'src-index', target: 'tgt-info', label: 'join trong getIndexRanks' },

    // Extra fanout (3 target)
    { source: 'enrich-extra', target: 'tgt-info', label: 'merge basis/pt/year', animated: true },
    { source: 'enrich-extra', target: 'tgt-foreigner', label: 'merge' },
    { source: 'enrich-extra', target: 'tgt-daily', label: 'upsert' },

    // Odd-lot (cách ly)
    { source: 'src-qt-odd', target: 'tgt-info-odd', label: 'mutate', animated: true },
    { source: 'src-bo-odd', target: 'tgt-info-odd', label: 'mutate top book', animated: true },
    { source: 'src-bo-odd', target: 'tgt-bo-odd', label: 'RPUSH history' },

    // Post-process
    { source: 'tgt-daily', target: 'tgt-prev', label: 'derive trong cron' },
    { source: 'tgt-ext', target: 'tgt-info', label: 'merge khi query' },
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
    'Snapshot trung tâm 1 mã · 6 nguồn mutate (Init + Quote + BidOffer + Extra + MarketStatus + DealNotice) → realtime_mapSymbolInfo[code] → query-v2 + ws-v2 + Mongo snapshot',
  accent: '#60a5fa',
  nodes: [
    // ─── 6 mutators ──────────────────────────────────────────────────
    {
      id: 'init',
      kind: 'logic',
      layer: 'Init (đầu ngày)',
      title: 'LotteApiSymbolInfoService.downloadSymbol()',
      subtitle: 'Baseline SymbolInfo map từ REST',
      position: { x: 0, y: 0 },
      inputs: [{ name: 'Lotte REST', type: 'REST', description: 'securities-name/price, indexs-list, info, derivatives' }],
      outputs: [{ name: 'Map<code, SymbolInfo> baseline', type: 'HSET', description: 'Qua InitService' }],
      details:
        'Đầu ngày collector gọi 5 REST endpoint Lotte (securities-name, securities-price, indexs-list, indexs-info, derivatives-info), chuẩn hoá mỗi record thành SymbolInfo rồi MERGE vào 1 Map<code, SymbolInfo> theo thứ tự ưu tiên.\n\n' +
        'Sau khi merge xong:\n' +
        '  • Nếu marketInit được bật → gọi trực tiếp marketInit.init(allSymbols) (in-process)\n' +
        '  • Nếu không → publish batch qua Kafka topic symbolInfoUpdate cho realtime-v2 consume\n\n' +
        'Kết quả realtime-v2 HSET toàn bộ vào realtime_mapSymbolInfo[code] làm baseline trước khi stream quote/bidoffer.',
    },
    {
      id: 'quote',
      kind: 'logic',
      layer: 'Mutator · Quote',
      title: 'QuoteService.updateQuote()',
      subtitle: 'Merge field tick vào SymbolInfo',
      position: { x: 0, y: ROW },
      inputs: [{ name: 'SymbolQuote', type: 'Kafka quoteUpdate', description: '' }],
      outputs: [{ name: 'merge fields: OHLC, volume, matchedBy, foreigner, session, sequence...', type: 'merge', description: '' }],
      details:
        'Sau khi reCalculate() enrich xong SymbolQuote, method này đọc SymbolInfo hiện tại từ cache, gọi ConvertUtils.updateByQuote(symbolInfo, symbolQuote) để merge các field:\n' +
        '  • OHLC (open/high/low/last), tradingVolume/Value, matchingVolume, matchedBy\n' +
        '  • foreignerMatchBuy/Sell Volume/Value, holdVolume/Ratio, buyAbleRatio\n' +
        '  • session (nếu quote mang thông tin phiên), quoteSequence++\n' +
        '  • updatedBy = "SymbolQuote", updatedAt = now\n\n' +
        'Cuối cùng HSET realtime_mapSymbolInfo[code] với snapshot mới.',
    },
    {
      id: 'bidoffer',
      kind: 'logic',
      layer: 'Mutator · BidOffer',
      title: 'BidOfferService.updateBidOffer()',
      subtitle: 'Thay top book 3 bước giá vào SymbolInfo',
      position: { x: 0, y: ROW * 2 },
      inputs: [{ name: 'BidOffer', type: 'Kafka bidOfferUpdate', description: '' }],
      outputs: [{ name: 'merge fields: bidOfferList(3), expectedPrice/Change/Rate, session, totals, bidAskSequence', type: 'merge', description: '' }],
      details:
        'Consume Message<BidOffer> từ Kafka rồi:\n' +
        '  1. Load SymbolInfo hiện tại từ cache (nếu miss → Redis HGET)\n' +
        '  2. Gọi ConvertUtils.updateByBidOffer(symbolInfo, bidOffer) để GHI ĐÈ symbolInfo.bidOfferList = top book mới nhất (3 mức giá bid + 3 mức giá ask)\n' +
        '  3. Merge totalBidVolume / totalAskVolume, expectedPrice/expectedChange/expectedRate (cho phiên ATO/ATC)\n' +
        '  4. Nếu BidOffer mang session → ghi đè symbolInfo.session\n' +
        '  5. Tăng bidAskSequence (counter riêng cho order book)\n' +
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
        'ExtraQuote là "event enrichment" — không có state riêng, chỉ để mutate các object đích. Method này:\n' +
        '  1. Ensure SymbolInfo tồn tại\n' +
        '  2. Gọi ConvertUtils.updateByExtraQuote(symbolInfo, extraQuote) để merge:\n' +
        '     – basis (với futures, = futuresLast − vn30Last)\n' +
        '     – breakEven (với chứng quyền CW)\n' +
        '     – ptVolume / ptValue (lũy kế từ DealNotice)\n' +
        '     – highYear / lowYear (khi reCalculate phát hiện đỉnh/đáy năm đổi)\n' +
        '  3. HSET realtime_mapSymbolInfo[code]\n\n' +
        'Đồng thời cũng mutate ForeignerDaily và upsert SymbolDaily (xem lifecycle riêng).',
    },
    {
      id: 'status',
      kind: 'logic',
      layer: 'Mutator · MarketStatus',
      title: 'MarketStatusService.updateMarketStatus()',
      subtitle: 'Propagate sessions khi ATO/ATC',
      position: { x: 0, y: ROW * 4 },
      inputs: [{ name: 'MarketStatus', type: 'Kafka marketStatus', description: '' }],
      outputs: [{ name: 'set sessions cho MỌI SymbolInfo cùng market', type: 'broadcast', description: 'null khi khác ATO/ATC' }],
      details:
        'Đây là mutator DUY NHẤT "broadcast" — 1 event đụng tới hàng nghìn SymbolInfo.\n\n' +
        'Khi nhận MarketStatus (HOSE ATO, HNX ATC...):\n' +
        '  1. HSET realtime_mapMarketStatus[market_type] để lưu state phiên\n' +
        '  2. NẾU status ∈ {ATO, ATC}:\n' +
        '     – Iterate toàn bộ SymbolInfo thuộc cùng market\n' +
        '     – Ghi symbolInfo.sessions = status cho từng mã\n' +
        '     – HSET lại realtime_mapSymbolInfo[code] cho tất cả\n' +
        '  3. NẾU status khác → sessions = null (clear cờ phiên)\n\n' +
        'Đây cũng là lý do flag "sessions" trong SymbolInfo nhất quán theo market.',
    },
    {
      id: 'deal',
      kind: 'logic',
      layer: 'Mutator · DealNotice',
      title: 'DealNoticeService.updateDealNotice()',
      subtitle: 'Cộng ptTradingVolume / ptTradingValue',
      position: { x: 0, y: ROW * 5 },
      inputs: [{ name: 'DealNotice', type: 'Kafka dealNoticeUpdate', description: '' }],
      outputs: [{ name: 'merge: ptTradingVolume, ptTradingValue', type: 'merge', description: 'dedupe theo confirmNumber' }],
      details:
        'Mỗi thỏa thuận khớp (put-through matched) kéo theo cập nhật số tổng PT cho mã.\n\n' +
        '  1. Ensure SymbolInfo của mã tồn tại\n' +
        '  2. Load toàn bộ DealNotice đã có để DEDUPE theo confirmNumber (Lotte có thể resend)\n' +
        '  3. Gọi ConvertUtils.updateByDealNotice(symbolInfo, dealNotice):\n' +
        '     – symbolInfo.ptTradingVolume += deal.volume\n' +
        '     – symbolInfo.ptTradingValue += deal.value\n' +
        '  4. HSET realtime_mapSymbolInfo[code]\n' +
        '  5. RPUSH realtime_listDealNotice_{market} để giữ history (xem lifecycle DealNotice)',
    },

    // ─── Central Redis ────────────────────────────────────────────────
    {
      id: 'redis',
      kind: 'redis',
      layer: 'Primary hot-state',
      title: 'realtime_mapSymbolInfo[code]',
      subtitle: 'Hash — single source of truth',
      position: { x: COL * 2, y: ROW * 2.5 },
      inputs: [{ name: 'HSET từ 6 mutators', type: 'Redis', description: '' }],
      outputs: [{ name: 'query-v2 + ws-v2 + snapshot cron', type: 'Hash', description: '' }],
      details:
        'Redis hash key = realtime_mapSymbolInfo, field = code (VD "SHB", "VIC"), value = JSON SymbolInfo.\n\n' +
        'Fields tiêu biểu: code/type/name, OHLC, change/rate, volume/value, matchedBy, referencePrice/ceiling/floor, bidOfferList[3], foreignerMatchBuy/Sell*, sessions, expectedPrice/Change/Rate, basis, breakEven, ptTradingVolume/Value, quoteSequence, bidAskSequence, updatedBy, updatedAt.\n\n' +
        'Là "single source of truth" cho snapshot realtime — mọi read (priceBoard, ranking, ws snapshot) đều đi qua key này.',
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
        { name: 'querySymbolLatestNormal', type: 'endpoint', description: 'Snapshot 1 mã' },
        { name: 'queryPriceBoard', type: 'endpoint', description: 'Bảng giá theo market' },
        { name: 'Ranking APIs (UpDown/Top/Period...)', type: 'endpoint', description: 'Sort theo rate/volume/value' },
        { name: 'TradingView querySymbolInfo / querySymbolSearch', type: 'endpoint', description: 'Search + meta cho TV' },
        { name: 'FIX queryFixSymbolList', type: 'endpoint', description: 'List cho gateway FIX' },
      ],
      details:
        'Mọi API "snapshot-style" đều đọc trực tiếp hash này. Khi cần nhiều mã (priceBoard, ranking) → 1 HMGET duy nhất lấy đủ — không cần gọi lại REST Lotte.\n\n' +
        'Với INDEX (VNINDEX, HNX30...) data cũng nằm trong cùng hash chung với cổ phiếu — phân biệt bằng field "type".',
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
        'Khi client subscribe market.quote.{code} / market.bidoffer.{code} với flag returnSnapShot=true:\n' +
        '  1. ws-v2 HGET realtime_mapSymbolInfo[code]\n' +
        '  2. Gọi convertSymbolInfoV2() để "compact" payload (rút gọn field name để tiết kiệm băng thông)\n' +
        '  3. Push frame market.returnSnapshot chỉ cho riêng client đó\n\n' +
        'Nhờ vậy client mới join thấy ngay trạng thái mới nhất mà không phải chờ tick kế tiếp.',
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
        'Cron 6 lần/ngày bao phủ khung trước/sau nghỉ trưa và khung đóng cửa.\n\n' +
        'Pipeline:\n' +
        '  1. HGETALL realtime_mapSymbolInfo → toàn bộ SymbolInfo đang active\n' +
        '  2. Bulk upsert vào Mongo c_symbol_info (_id = code_date)\n' +
        '  3. Dùng làm fallback khi Redis bị flush hoặc cần tra lại intraday sau đó.',
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
        { name: 'GIỮ LẠI SymbolInfo map', type: 'preserve', description: 'Không clear toàn bộ' },
      ],
      details:
        'Chạy đêm 01:35 để "dọn" SymbolInfo cho ngày mới NHƯNG KHÔNG xoá toàn bộ map (khác removeAutoData).\n\n' +
        'Reset các field intraday:\n' +
        '  • sequence = 0, bidAskSequence = 0\n' +
        '  • matchingVolume = 0, matchedBy = null\n' +
        '  • bidOfferList = [] (order book cũ không còn hợp lệ)\n' +
        '  • oddlotBidOfferList = [] (tương tự cho SymbolInfoOddLot)\n\n' +
        'Các field baseline (code/name/type/referencePrice/ceiling/floor/listedQty) vẫn được giữ nên ngày mới không cần init lại từ REST. Gọi cacheService.reset() để xoá in-memory cache tránh stale.',
    },
    {
      id: 'mongo',
      kind: 'mongo',
      layer: 'Persistence',
      title: 'c_symbol_info',
      subtitle: 'Day-level snapshot',
      position: { x: COL * 4, y: 0 },
      inputs: [{ name: 'saveRedisToDatabase bulk', type: 'Mongo', description: '' }],
      outputs: [{ name: 'Fallback khi Redis miss', type: 'find', description: '' }],
      details:
        '_id = code_yyyyMMdd, index theo { code, date }.\n\n' +
        'Vai trò: chỉ là snapshot chậm — không serve traffic hot. Realtime query luôn ưu tiên Redis trước, chỉ fallback Mongo khi Redis miss (hiếm khi xảy ra trong giờ giao dịch).',
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
// 2. SymbolQuote — Tick intraday event
// ─────────────────────────────────────────────────────────────────────────
const lifecycleSymbolQuote = {
  id: 'lc-symbol-quote',
  category: 'lifecycle',
  title: 'Lifecycle · SymbolQuote',
  subtitle:
    'Tick gốc intraday · auto.qt/idxqt/futures → collector → Kafka → realtime-v2 · reCalculate enrich, rồi fanout sang 6 Redis keys + calExtraUpdate',
  accent: '#34d399',
  nodes: [
    {
      id: 'ws',
      kind: 'source',
      layer: 'Lotte WS',
      title: 'auto.qt / auto.idxqt / futures quote',
      subtitle: 'Tick feed từ Lotte',
      position: { x: 0, y: ROW * 1.5 },
      inputs: [{ name: 'subscribe', type: 'WS', description: '' }],
      outputs: [{ name: 'raw text pipe-delimited', type: 'string', description: '' }],
      details:
        'Collector subscribe 3 channel tách biệt:\n' +
        '  • auto.qt.<code>   → tick cổ phiếu\n' +
        '  • auto.idxqt.<code> → tick chỉ số\n' +
        '  • futures quote feed → tick phái sinh\n\n' +
        'Mỗi frame là 1 chuỗi phân tách bằng "|" theo spec Lotte, cần parse tay.',
    },
    {
      id: 'collector',
      kind: 'logic',
      layer: 'Collector',
      title: 'RealTimeConnectionHandler + ThreadHandler',
      subtitle: 'Nhận → parse → enqueue',
      position: { x: COL, y: ROW * 1.5 },
      inputs: [{ name: 'receivePacket → handle()', type: 'call', description: '' }],
      outputs: [{ name: 'handleAutoData(Stock/Index/FuturesUpdateData)', type: 'call', description: '' }],
      details:
        'Pipeline xử lý trong collector:\n' +
        '  1. RealTimeConnectionHandler.receivePacket() nhận raw frame từ Lotte WS\n' +
        '  2. ThreadHandler.handle() push vào thread pool theo partition để đảm bảo thứ tự theo code\n' +
        '  3. parse(): tách các field theo vị trí\n' +
        '  4. validate(): kiểm tra mã hợp lệ, sequence không tụt\n' +
        '  5. formatTime(): đổi time HHmmss → milliseconds + date\n' +
        '  6. formatRefCode(): với futures, set refCode (mã hợp đồng gốc)\n' +
        '  7. Cuối cùng gọi handleAutoData() đúng loại (Stock/Index/Futures) để publish Kafka',
    },
    {
      id: 'kafka',
      kind: 'kafka',
      layer: 'Kafka',
      title: 'quoteUpdate / quoteUpdateDR',
      subtitle: 'Message<SymbolQuote> · 2 topic chia theo thị trường',
      position: { x: COL * 2, y: ROW * 1.5 },
      inputs: [{ name: 'producer collector — WsConnectionThread.run()', type: 'Kafka', description: 'sendMessageSafe, chọn topic theo type của object' }],
      outputs: [{ name: 'realtime-v2 + ws-v2 consume', type: 'Kafka', description: '' }],
      details:
        'Collector chia quote thành 2 topic theo loại thị trường:\n' +
        '  • quoteUpdate     → Equity / Index / CW / ETF (cơ sở)\n' +
        '  • quoteUpdateDR   → DR / Futures (phái sinh, VN30F*, VN30F2503, ...)\n\n' +
        'DR = Derivatives. Hai topic cùng schema Message<SymbolQuote>, tách ra để:\n' +
        '  • Partition riêng cho phái sinh (tick rate / pattern khác cơ sở)\n' +
        '  • ws-v2 map sang 2 channel riêng: market.quote.{code} và market.quote.dr.{code}\n' +
        '  • Consumer chỉ quan tâm 1 loại có thể subscribe 1 topic\n\n' +
        'Key partition = code để các tick cùng mã về cùng partition (giữ thứ tự).',
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
        'QuoteUpdateHandler consume Kafka rồi đẩy vào MonitorService — 1 queue riêng theo code để các tick cùng mã được xử lý TUẦN TỰ (không race condition khi cập nhật statistic/daily/foreigner cùng lúc).\n\n' +
        'MonitorService.handler() pop event → gọi QuoteService.updateQuote().',
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
        { name: '6) IF high/low year đổi → publish calExtraUpdate', type: 'producer', description: '' },
      ],
      details:
        'Bước "gatekeeper" quan trọng — tick NÀO không qua bước này sẽ bị drop.\n\n' +
        'Logic:\n' +
        '  1. Kiểm tra SymbolInfo của mã đã load chưa (nếu chưa → bỏ qua)\n' +
        '  2. Kiểm tra tradingVolume tick mới PHẢI ≥ volume đã thấy (tránh wrong-order — Lotte đôi khi resend sai thứ tự)\n' +
        '  3. Chuẩn hoá thời gian: tick.time (HHmmss) → milliseconds, set date, createdAt, updatedAt\n' +
        '  4. Tạo id = code_date_tradingVolume (unique idempotent)\n' +
        '  5. Với type=STOCK: compute thêm foreignerMatchBuy/SellVolume, holdVolume = foreignerTotalRoom − foreignerCurrentRoom, holdRatio = holdVolume / listedQty, buyAbleRatio = foreignerCurrentRoom / listedQty\n' +
        '  6. Với type=FUTURES: gán refCode = mã hợp đồng gốc (VN30F2501 → VN30F)\n' +
        '  7. Nếu tick.last tạo ĐỈNH/ĐÁY NĂM mới → publish thêm calExtraUpdate để cập nhật highYear/lowYear (handled by ExtraQuoteService)',
    },
    {
      id: 'update',
      kind: 'logic',
      layer: 'QuoteService',
      title: 'updateQuote() fanout',
      subtitle: 'Phân phối tick đã enrich',
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
        'Sau reCalculate() thành công, tick được "fanout" vào 7 hướng ghi trong cùng 1 transaction logic:\n\n' +
        '  • SymbolStatistic: cộng vào bucket giá (non-INDEX)\n' +
        '  • SymbolInfo: merge OHLC/volume/matchedBy qua ConvertUtils.updateByQuote\n' +
        '  • ForeignerDaily: foreignerDaily.updateByQuote()\n' +
        '  • SymbolDaily: ConvertUtils.updateDailyByQuote()\n' +
        '  • SymbolQuoteMinute: create bar mới nếu sang phút, update high/low/close/volume nếu cùng phút\n' +
        '  • realtime_listQuote_{code}: RPUSH tick enrich để query history\n' +
        '  • realtime_listQuoteMeta_{code}: update partition meta cho paging',
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
        'Redis list giữ TẤT CẢ tick enrich trong ngày của mã. Key có thể có hậu tố _partition khi list vượt ngưỡng — xem lifecycle ListQuoteMeta.\n\n' +
        'Dùng cho querySymbolQuote/queryQuoteData (client scroll lịch sử khớp lệnh).',
    },
    {
      id: 'r-meta',
      kind: 'redis',
      layer: 'Redis',
      title: 'realtime_listQuoteMeta_{code}',
      subtitle: 'Partition meta encoded',
      position: { x: COL * 6, y: ROW * 0.7 },
      inputs: [{ name: 'SET encoded', type: 'Redis', description: '' }],
      outputs: [{ name: 'paging key cho query', type: 'string', description: '' }],
      details:
        'String encoded dạng "partition|fromVolume|toVolume|totalItems;..." — lưu danh sách partition và range volume của mỗi partition.\n\n' +
        'Query chỉ cần đọc 1 key meta này để biết cần LRANGE list nào.',
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
        'Xem lifecycle SymbolInfo. Mỗi tick cập nhật: last, high/low, volume, value, matchedBy, foreigner*, quoteSequence++, updatedBy="SymbolQuote".',
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
        'State NĐTNN trong ngày cho mã. Mỗi tick → foreignerDaily.updateByQuote(quote) cộng dồn foreignerBuy/SellVolume/Value + update foreignerCurrentRoom.',
    },
    {
      id: 'r-daily',
      kind: 'redis',
      layer: 'Redis',
      title: 'realtime_mapSymbolDaily[code]',
      subtitle: 'Hash OHLCV ngày',
      position: { x: COL * 6, y: ROW * 2.8 },
      inputs: [{ name: 'HSET', type: 'Redis', description: '' }],
      outputs: [{ name: 'daily OHLCV hôm nay', type: 'hash', description: '' }],
      details:
        'Daily hôm nay được upsert từ mỗi tick qua ConvertUtils.updateDailyByQuote. Cuối giờ giao dịch, saveRedisToDatabase() bulk-write sang c_symbol_daily.',
    },
    {
      id: 'r-minute',
      kind: 'redis',
      layer: 'Redis',
      title: 'realtime_listQuoteMinute_{code}',
      subtitle: 'List bars phút',
      position: { x: COL * 6, y: ROW * 3.5 },
      inputs: [{ name: 'create/update', type: 'Redis', description: '' }],
      outputs: [{ name: 'minute chart', type: 'list', description: '' }],
      details:
        'Mỗi tick kiểm tra minute bar hiện tại:\n' +
        '  • Sang phút mới → RPUSH bar mới\n' +
        '  • Cùng phút → LSET phần tử cuối với high/low/close/volume update\n' +
        '  • Tick cũ hơn phút hiện tại → bỏ qua',
    },
    {
      id: 'r-stat',
      kind: 'redis',
      layer: 'Redis',
      title: 'realtime_mapSymbolStatistic[code]',
      subtitle: 'Hash aggregate theo giá',
      position: { x: COL * 6, y: ROW * 4.2 },
      inputs: [{ name: 'HSET (non-INDEX)', type: 'Redis', description: '' }],
      outputs: [{ name: 'matched aggregate', type: 'hash', description: '' }],
      details:
        'Aggregate khớp lệnh theo từng mức giá. KHÔNG áp dụng cho INDEX (chỉ số không có khớp lệnh).\n\n' +
        'Mỗi tick cộng vào bucket giá = tick.last: matchedVolume += tick.matchingVolume, matchedBuy/Sell tuỳ matchedBy.',
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
        { name: 'querySymbolQuote / queryQuoteData', type: 'endpoint', description: 'paging theo volume/index' },
        { name: 'querySymbolQuoteTick', type: 'endpoint', description: 'last N tick' },
        { name: 'querySymbolTickSizeMatch', type: 'endpoint', description: 'thống kê matched theo tickSize' },
      ],
      details:
        'Tất cả query tick của 1 mã hôm nay đều đi qua realtime_listQuote_* + meta. Không đọc Mongo vì enableSaveQuote=false.',
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
        'ws-v2 consume Kafka quoteUpdate (không cần chờ realtime-v2 enrich), gọi convertDataPublishV2Quote() để rút gọn payload (rename field ngắn), rồi publish channel market.quote.{code} cho mọi subscriber.',
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
        'Chạy 00:55 MON-FRI — xoá toàn bộ tick + meta của ngày trước để dọn chỗ cho ngày mới.\n\n' +
        'Lưu ý: enableSaveQuote=false → không có bước persist tick sang Mongo trước khi xoá. Nghĩa là sau 00:55 tick hôm trước biến mất hoàn toàn.',
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
    'Metadata kỹ thuật để paginate tick list lớn · sinh bởi QuoteService.addSymbolQuote · tiêu thụ bởi querySymbolQuote/queryQuoteData',
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
        { name: 'append tick vào default / overflow partition', type: 'RPUSH', description: '' },
        { name: 'cập nhật ListQuoteMeta { partitions[] }', type: 'update', description: '' },
      ],
      details:
        'Được gọi ở bước cuối của updateQuote(), chịu trách nhiệm ghi tick vào đúng partition:\n\n' +
        '  1. Đọc ListQuoteMeta hiện tại (nếu chưa có → tạo default partition=-1 với fromVolume=0)\n' +
        '  2. Xác định partition đang active (cái cuối)\n' +
        '  3. Nếu len(partition) < LIMIT → RPUSH vào partition hiện tại\n' +
        '  4. Nếu len(partition) ≥ LIMIT → tạo overflow partition mới với fromVolume = tradingVolume của tick này\n' +
        '  5. Cập nhật partitions[] với totalItems mới + lưu meta\n\n' +
        'Mục tiêu: giới hạn kích thước mỗi Redis list để LRANGE không bị chậm.',
    },
    {
      id: 'r-meta',
      kind: 'redis',
      layer: 'Redis · Meta',
      title: 'realtime_listQuoteMeta_{code}',
      subtitle: 'SET encoded string',
      position: { x: COL * 1.5, y: ROW * 0.5 },
      inputs: [{ name: 'SET', type: 'Redis', description: '' }],
      outputs: [{ name: 'encoded format: partition|fromVolume|toVolume|totalItems;...', type: 'string', description: 'VD: "-1|0|50000000|8928"' }],
      details:
        'Dùng SET (không HSET) — 1 key = 1 string encoded để đọc nhanh bằng GET duy nhất.\n\n' +
        'Parse ở phía client/service: split(";") → mỗi entry split("|") thành { partition, fromVolume, toVolume, totalItems }.\n\n' +
        'partition = -1 là "default", partition số dương là overflow.',
    },
    {
      id: 'r-tick',
      kind: 'redis',
      layer: 'Redis · Data',
      title: 'realtime_listQuote_{code}[_partition]',
      subtitle: 'List<SymbolQuote>',
      position: { x: COL * 1.5, y: ROW * 1.5 },
      inputs: [{ name: 'RPUSH per partition', type: 'Redis', description: '' }],
      outputs: [{ name: 'LRANGE theo partition', type: 'list', description: '' }],
      details:
        'Key naming:\n' +
        '  • realtime_listQuote_SHB      → default partition (-1)\n' +
        '  • realtime_listQuote_SHB_1    → overflow partition #1\n' +
        '  • realtime_listQuote_SHB_2    → overflow partition #2\n' +
        '  ...\n\n' +
        'Mỗi element là 1 JSON SymbolQuote enrich đầy đủ.',
    },

    {
      id: 'q-symbol',
      kind: 'api',
      layer: 'Query',
      title: 'querySymbolQuote()',
      subtitle: 'Paging theo lastTradingVolume',
      position: { x: COL * 3, y: 0 },
      inputs: [
        { name: 'symbol', type: 'string', description: '' },
        { name: 'lastTradingVolume', type: 'long', description: '' },
      ],
      outputs: [
        { name: '1) đọc meta', type: 'GET', description: '' },
        { name: '2) nếu chưa có → pseudo default partition -1', type: 'fallback', description: '' },
        { name: '3) chọn partition theo fromVolume/toVolume', type: 'lookup', description: '' },
        { name: '4) LRANGE realtime_listQuote_{symbol}[_p]', type: 'Redis', description: '' },
        { name: '5) filter theo lastTradingVolume', type: 'compute', description: '' },
        { name: '6) trả SymbolQuoteResponse[]', type: 'response', description: '' },
      ],
      details:
        'Use-case chính: client scroll tick feed — mỗi lần gọi truyền lastTradingVolume = volume của tick cuối đã hiển thị, service trả các tick có volume > giá trị đó.\n\n' +
        'Nhờ meta, service không cần LRANGE toàn bộ list — chỉ LRANGE đúng partition chứa range volume cần.',
    },
    {
      id: 'q-data',
      kind: 'api',
      layer: 'Query',
      title: 'queryQuoteData()',
      subtitle: 'Paging theo lastIndex',
      position: { x: COL * 3, y: ROW * 1.4 },
      inputs: [
        { name: 'symbol', type: 'string', description: '' },
        { name: 'lastIndex', type: 'int', description: '' },
      ],
      outputs: [{ name: 'Cùng meta, paginate theo index thay vì volume', type: 'compute', description: '' }],
      details:
        'Biến thể của querySymbolQuote cho trường hợp client paginate theo INDEX (số thứ tự tick) thay vì volume.\n\n' +
        'Cùng meta nhưng cộng dồn totalItems để tính được lastIndex thuộc partition nào.',
    },

    {
      id: 'cron-reset',
      kind: 'schedule',
      layer: 'Cron',
      title: 'removeAutoData() 00:55',
      subtitle: 'Clear meta + tick',
      position: { x: COL * 1.5, y: ROW * 2.8 },
      inputs: [{ name: '@Scheduled', type: 'cron', description: '' }],
      outputs: [{ name: 'clear realtime_listQuoteMeta_*', type: 'del', description: '' }],
      details:
        'Xoá toàn bộ meta + tick list để ngày mới bắt đầu sạch. Nếu không xoá meta trong khi có tick ngày mới → paging sẽ sai hoàn toàn.',
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
    'Nến phút — không đến từ feed trực tiếp mà được dẫn xuất từ SymbolQuote trong QuoteService.updateQuote',
  accent: '#a78bfa',
  nodes: [
    {
      id: 'src',
      kind: 'logic',
      layer: 'Derived from Quote',
      title: 'QuoteService.updateQuote()',
      subtitle: 'Mỗi tick mới → evaluate minute bar',
      position: { x: 0, y: ROW },
      inputs: [{ name: 'SymbolQuote (enriched)', type: 'object', description: '' }],
      outputs: [{ name: 'lấy current minute bar từ cache/Redis', type: 'read', description: '' }],
      details:
        'Khi có tick mới, service đọc minute bar ĐANG MỞ (phần tử cuối của realtime_listQuoteMinute_{code}) để quyết định create/update/skip.\n\n' +
        'Không có feed riêng cho minute — toàn bộ nến phút là derived state từ SymbolQuote.',
    },
    {
      id: 'decide',
      kind: 'logic',
      layer: 'Decision',
      title: 'Evaluate minute bar',
      subtitle: '3 nhánh dựa trên thời gian tick',
      position: { x: COL, y: ROW },
      inputs: [{ name: 'currentMinute + quote', type: 'object', description: '' }],
      outputs: [
        { name: 'currentMinute==null hoặc sang phút mới → CREATE', type: 'branch', description: 'từ quote' },
        { name: 'cùng phút → UPDATE high/low/close/volume/value', type: 'branch', description: '' },
        { name: 'quote cũ hơn phút hiện tại → SKIP', type: 'branch', description: '' },
      ],
      details:
        'Logic so sánh tick.time (HHmm) vs currentMinute.time:\n\n' +
        '  • CREATE: khi chưa có bar nào HOẶC tick.time > currentMinute.time\n' +
        '    – open = tick.last, high = tick.last, low = tick.last, close = tick.last\n' +
        '    – volume = tick.matchingVolume, value = tick.matchingValue\n' +
        '    – periodTradingVolume = delta volume so với minute trước\n\n' +
        '  • UPDATE: khi tick.time == currentMinute.time\n' +
        '    – high = max(high, tick.last)\n' +
        '    – low = min(low, tick.last)\n' +
        '    – close = tick.last (luôn đè)\n' +
        '    – volume/value cộng dồn\n\n' +
        '  • SKIP: tick.time < currentMinute.time (tick cũ, có thể do resend Lotte) → bỏ qua để tránh ghi đè bar đã đóng.',
    },
    {
      id: 'r-minute',
      kind: 'redis',
      layer: 'Redis output',
      title: 'realtime_listQuoteMinute_{code}',
      subtitle: 'List<SymbolQuoteMinute>',
      position: { x: COL * 2.2, y: ROW },
      inputs: [{ name: 'RPUSH hoặc LSET last', type: 'Redis', description: '' }],
      outputs: [{ name: 'minute bars ordered', type: 'list', description: '' }],
      details:
        'Mỗi element SymbolQuoteMinute:\n' +
        '  { code, time (HHmmss), milliseconds, open, high, low, last, tradingVolume, tradingValue, periodTradingVolume, date }\n\n' +
        'periodTradingVolume = delta volume của phút này (không phải cộng dồn). Dùng để vẽ cột volume bên dưới nến.\n' +
        'tradingVolume = cộng dồn volume từ đầu ngày.',
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
        { name: 'queryMinuteChartBySymbol', type: 'endpoint', description: 'cho minute chart UI' },
        { name: 'queryTradingViewHistory intraday', type: 'endpoint', description: 'UDF cho TradingView' },
      ],
      details:
        'Chỉ đọc Redis — KHÔNG có Mongo fallback cho minute bar vì persist bị disable (xem cron-persist).\n\n' +
        'TradingView history endpoint chỉ trả minute bars trong phạm vi hôm nay; khung thời gian > 1 ngày chuyển qua SymbolDaily.',
    },
    {
      id: 'wsv2',
      kind: 'ws',
      layer: 'Delivery',
      title: 'ws-v2 broadcast',
      subtitle: 'Không có channel riêng',
      position: { x: COL * 3.5, y: ROW * 1.4 },
      inputs: [{ name: 'quoteUpdate parser compute minute', type: 'Kafka', description: '' }],
      outputs: [{ name: 'không có channel riêng cho minute', type: 'note', description: 'Client tự aggregate từ market.quote.{code}' }],
      details:
        'ws-v2 KHÔNG publish channel riêng cho minute bar — client subscribe market.quote.{code} rồi tự aggregate thành minute trên UI để realtime với độ trễ thấp nhất.\n\n' +
        'Minute bar từ Redis chỉ phục vụ load history khi mở chart.',
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
        'Xoá toàn bộ minute bars của ngày trước. Cùng với tick list, đây là các data intraday không giữ qua đêm.',
    },
    {
      id: 'cron-persist',
      kind: 'schedule',
      layer: 'Cron',
      title: 'saveRedisToDatabase()',
      subtitle: 'Code path có nhưng disabled',
      position: { x: COL * 2.2, y: ROW * 3.2 },
      inputs: [{ name: '@Scheduled', type: 'cron', description: '' }],
      outputs: [{ name: 'OFF runtime (enableSaveQuoteMinute=false)', type: 'skip', description: '' }],
      details:
        'Trong code có branch persist minute → c_symbol_quote_minute, nhưng runtime hiện tại config enableSaveQuoteMinute=false nên bị skip.\n\n' +
        'Hệ quả: minute bar hôm nay chỉ tồn tại trong Redis, KHÔNG tra được minute bar các ngày trước qua DB — muốn lịch sử minute phải dùng TradingView aggregated từ SymbolDaily hoặc request Lotte.',
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
    'Aggregate intraday theo từng mức giá · update mỗi tick (non-INDEX) · publish statisticUpdate với 1 price entry',
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
      outputs: [{ name: 'lookup statistic hiện tại cho code', type: 'read', description: '' }],
      details:
        'Trước khi tính statistic, service check type của mã:\n' +
        '  • type ∈ { STOCK, CW, ETF, FUTURES } → thực hiện aggregate\n' +
        '  • type == INDEX → SKIP (chỉ số không có khớp lệnh theo giá)\n\n' +
        'Nếu qualified, đọc realtime_mapSymbolStatistic[code] hiện tại từ cache/Redis.',
    },
    {
      id: 'bucket',
      kind: 'logic',
      layer: 'Compute',
      title: 'Price bucket merge',
      subtitle: 'Cộng dồn vào bucket = quote.last',
      position: { x: COL, y: ROW },
      inputs: [{ name: 'current statistic + quote', type: 'object', description: '' }],
      outputs: [
        { name: 'cộng matchedVolume', type: 'compute', description: '' },
        { name: 'matchedBy=BID → matchedBuyVolume', type: 'compute', description: '' },
        { name: 'matchedBy=ASK → matchedSellVolume', type: 'compute', description: '' },
        { name: 'matchedBy=null → matchedUnknownVolume', type: 'compute', description: '' },
        { name: 'tính lại matchedRatio / buyRatio / sellRatio', type: 'compute', description: '' },
        { name: 'cập nhật totalBuyVolume / totalSellVolume', type: 'compute', description: '' },
      ],
      details:
        'Logic bucket (bucket được định danh bằng price = tick.last):\n\n' +
        '  1. Tìm bucket có price == tick.last; nếu chưa có → tạo mới\n' +
        '  2. bucket.matchedVolume += tick.matchingVolume\n' +
        '  3. Phân loại theo matchedBy:\n' +
        '     – BID → matchedBuyVolume += matchingVolume\n' +
        '     – ASK → matchedSellVolume += matchingVolume\n' +
        '     – null → matchedUnknownVolume += matchingVolume (khi Lotte không xác định)\n' +
        '  4. Recompute ratio trong bucket: matchedRaito/buyRaito/sellRaito = volume/matchedVolume\n' +
        '  5. Aggregate mức toàn mã: totalBuyVolume = sum(matchedBuyVolume over all buckets), tương tự totalSellVolume',
    },
    {
      id: 'r',
      kind: 'redis',
      layer: 'Redis output',
      title: 'realtime_mapSymbolStatistic[code]',
      subtitle: 'Hash — snapshot aggregate',
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
        'Lưu ý Raito (typo lịch sử), không phải Ratio.',
    },
    {
      id: 'kafka-stat',
      kind: 'kafka',
      layer: 'Kafka',
      title: 'topic statisticUpdate',
      subtitle: 'Delta event — 1 price entry',
      position: { x: COL * 2.2, y: ROW * 2 },
      inputs: [{ name: 'publish delta 1 price entry', type: 'Kafka', description: '' }],
      outputs: [{ name: 'ws-v2 consumer', type: 'Kafka', description: '' }],
      details:
        'Thay vì publish lại toàn bộ statistic (có thể vài chục bucket giá), service chỉ publish bucket vừa thay đổi (1 price entry) qua statisticUpdate.\n\n' +
        'ws-v2 merge delta này vào payload trước khi push client để giảm băng thông.',
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
        'Client load modal "Thống kê khớp lệnh theo giá" — HGET 1 key lấy toàn bộ snapshot.',
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
        'Client subscribe channel nhận delta realtime để update bucket đang nhìn mà không reload cả modal.',
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
        'Xoá realtime_mapSymbolStatistic để ngày mới bắt đầu với statistic rỗng. Không persist sang Mongo.',
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
    'Sổ lệnh 3 bước giá · auto.bo → Kafka → BidOfferService.updateBidOffer → merge vào SymbolInfo · history RUNTIME OFF',
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
        'Channel Lotte cho mỗi mã, push mỗi khi top-3 order book thay đổi. Format pipe-delimited chứa 3 bid (price/volume) + 3 ask (price/volume) + session + totals.',
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
        '  2. Nếu mã là futures → build FuturesBidOfferData (kế thừa thêm expectedChange, expectedRate so với vn30)\n' +
        '  3. Trong phiên ATO/ATC: handleAutoData() compute expectedPrice/Change/Rate dựa trên khớp lệnh dự kiến\n' +
        '  4. sendMessageSafe("bidOfferUpdate", bidOffer)',
    },
    {
      id: 'kafka',
      kind: 'kafka',
      layer: 'Kafka',
      title: 'bidOfferUpdate',
      subtitle: 'Topic chính',
      position: { x: COL * 2, y: ROW },
      inputs: [{ name: 'sendMessageSafe', type: 'Kafka', description: '' }],
      outputs: [{ name: 'realtime-v2 + ws-v2', type: 'Kafka', description: '' }],
      details:
        'Partition key = code. ws-v2 consume trực tiếp để broadcast độ trễ thấp, realtime-v2 consume để merge vào SymbolInfo.',
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
        'Handler đẩy event vào MonitorService theo partition code — đảm bảo các bidoffer cùng mã không race với quote cùng mã (cùng queue).',
    },
    {
      id: 'service',
      kind: 'logic',
      layer: 'BidOfferService',
      title: 'updateBidOffer(bidOffer)',
      subtitle: '8 bước chính',
      position: { x: COL * 4, y: ROW },
      inputs: [{ name: 'BidOffer', type: 'object', description: '' }],
      outputs: [
        { name: '1) set createdAt / updatedAt', type: 'set', description: '' },
        { name: '2) load SymbolInfo hiện tại', type: 'read', description: '' },
        { name: '3) ConvertUtils.updateByBidOffer()', type: 'merge', description: '' },
        { name: '4) SymbolInfo.bidOfferList = top book mới', type: 'set', description: '' },
        { name: '5) tăng bidAskSequence', type: 'counter', description: '' },
        { name: '6) HSET realtime_mapSymbolInfo[code]', type: 'Redis', description: '' },
        { name: '7) set bidOffer.id', type: 'set', description: '' },
        { name: '8) IF enableSaveBidOffer=true → append realtime_listBidOffer_{code}', type: 'branch', description: 'RUNTIME OFF' },
      ],
      details:
        'Chi tiết từng bước:\n\n' +
        '  1. bidOffer.createdAt / updatedAt = now\n' +
        '  2. HGET realtime_mapSymbolInfo[code] → SymbolInfo hiện tại (nếu miss → skip toàn bộ update)\n' +
        '  3. ConvertUtils.updateByBidOffer(symbolInfo, bidOffer) merge:\n' +
        '     – bidOfferList = [ask3, ask2, ask1, bid1, bid2, bid3]\n' +
        '     – totalBidVolume, totalAskVolume\n' +
        '     – session (khi BidOffer mang cờ phiên)\n' +
        '     – expectedPrice/expectedChange/expectedRate (ATO/ATC)\n' +
        '  4. Ghi đè bidOfferList (không cộng dồn, thay top book)\n' +
        '  5. symbolInfo.bidAskSequence++\n' +
        '  6. HSET realtime_mapSymbolInfo[code] với SymbolInfo đã merge\n' +
        '  7. bidOffer.id = code_yyyyMMddHHmmss_bidAskSequence (dùng khi persist)\n' +
        '  8. Feature flag enableSaveBidOffer (ENV) — RUNTIME hiện OFF → bỏ qua RPUSH realtime_listBidOffer_*',
    },
    {
      id: 'r-info',
      kind: 'redis',
      layer: 'Redis (active)',
      title: 'realtime_mapSymbolInfo[code]',
      subtitle: 'Top book duy nhất',
      position: { x: COL * 5.5, y: 0 },
      inputs: [{ name: 'HSET', type: 'Redis', description: '' }],
      outputs: [{ name: 'chỗ DUY NHẤT có bid/offer main session', type: 'hash', description: '' }],
      details:
        'Vì history OFF → top book hiện tại chỉ nằm trong SymbolInfo.bidOfferList. Mọi read bid/offer (priceBoard, snapshot) đều đi qua SymbolInfo.',
    },
    {
      id: 'r-list',
      kind: 'redis',
      layer: 'Redis (inactive)',
      title: 'realtime_listBidOffer_{code}',
      subtitle: 'enableSaveBidOffer=false',
      position: { x: COL * 5.5, y: ROW },
      inputs: [{ name: 'skipped', type: 'skip', description: '' }],
      outputs: [{ name: 'không ghi', type: 'none', description: '' }],
      details:
        'Nếu bật feature flag thì đây sẽ là list history BidOffer theo mã. Hiện tại KHÔNG có data — mọi API cần history bid/offer (nếu có) sẽ thấy rỗng.',
    },
    {
      id: 'mongo',
      kind: 'mongo',
      layer: 'Mongo (inactive)',
      title: 'c_bid_offer',
      subtitle: 'enableSaveBidAsk=false',
      position: { x: COL * 5.5, y: ROW * 2 },
      inputs: [{ name: 'không ghi runtime', type: 'skip', description: '' }],
      outputs: [],
      details:
        'Collection có schema nhưng không có write runtime. Khi cần audit order book phải khôi phục lại từ snapshot SymbolInfo trong c_symbol_info.',
    },
    {
      id: 'q',
      kind: 'api',
      layer: 'Delivery',
      title: 'market-query-v2',
      subtitle: 'Không có query BidOffer history riêng',
      position: { x: COL * 7, y: 0 },
      inputs: [{ name: 'gián tiếp qua SymbolInfo', type: 'Redis', description: '' }],
      outputs: [
        { name: '/symbol/latest', type: 'endpoint', description: 'trả SymbolInfo có bidOfferList' },
        { name: '/priceBoard', type: 'endpoint', description: 'bảng giá có top book' },
      ],
      details:
        'Client không gọi riêng API "getBidOffer" — luôn đọc kèm trong SymbolInfo. Giảm được 1 round-trip.',
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
        'Compact payload (rút gọn field name) rồi broadcast cho subscriber channel market.bidoffer.{code}. Client vẽ đồ thị bid/ask realtime mà không cần đọc Redis.',
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
    { source: 'r-info', target: 'q', label: 'HGET gián tiếp' },
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
    'Nhánh lô lẻ CÁCH LY với snapshot chính · 2 feeds riêng (bidOfferOddLotUpdate, quoteOddLotUpdate) · runtime luôn ON ghi history',
  accent: '#fb923c',
  nodes: [
    // Branch 1: BidOffer odd-lot
    {
      id: 'ws-bo',
      kind: 'source',
      layer: 'Lotte WS (BO odd-lot)',
      title: 'auto.bo.oddlot.<code>',
      subtitle: 'Feed bid/ask lô lẻ',
      position: { x: 0, y: 0 },
      inputs: [{ name: 'subscribe', type: 'WS', description: '' }],
      outputs: [{ name: 'raw odd-lot bid/ask line', type: 'string', description: '' }],
      details:
        'Channel riêng cho thị trường lô lẻ (< 100 cp/lô). Format giống auto.bo nhưng volume tính theo cổ phiếu lẻ.',
    },
    {
      id: 'kafka-bo',
      kind: 'kafka',
      layer: 'Kafka',
      title: 'bidOfferOddLotUpdate',
      subtitle: 'Topic RIÊNG',
      position: { x: COL, y: 0 },
      inputs: [{ name: 'collector producer', type: 'Kafka', description: '' }],
      outputs: [{ name: 'realtime-v2 + ws-v2', type: 'Kafka', description: '' }],
      details:
        'Tách riêng topic với bidOfferUpdate để consumer nào không cần lô lẻ có thể bỏ qua. Ws-v2 consume cả 2 nhưng publish qua channel khác nhau.',
    },
    {
      id: 'svc-bo',
      kind: 'logic',
      layer: 'BidOfferService',
      title: 'updateBidOfferOddLot()',
      subtitle: 'Method riêng cho lô lẻ',
      position: { x: COL * 2, y: 0 },
      inputs: [{ name: 'BidOfferOddLot', type: 'object', description: '' }],
      outputs: [
        { name: 'lấy SymbolInfoOddLot từ cache (hoặc tạo mới, sequence=1)', type: 'ensure', description: '' },
        { name: 'ConvertUtils.updateByBidOfferOddLot()', type: 'merge', description: '' },
        { name: 'HSET realtime_mapSymbolInfoOddLot[code]', type: 'Redis', description: '' },
        { name: 'set sequence + id = code_datetime_seq', type: 'set', description: '' },
        { name: 'RPUSH realtime_listBidOfferOddLot_{code}', type: 'Redis', description: '' },
      ],
      details:
        'Khác updateBidOffer thường:\n' +
        '  • Làm việc với SymbolInfoOddLot (object riêng) — nếu cache miss sẽ TẠO MỚI với sequence=1 (không cần init từ REST)\n' +
        '  • Field giống nhưng giá trị volume tính theo cổ phiếu lẻ\n' +
        '  • LUÔN RPUSH vào realtime_listBidOfferOddLot_{code} (không có feature flag skip như bản stock)\n' +
        '  • id format: code_yyyyMMddHHmmss_sequence để client paginate theo thời gian.',
    },

    // Branch 2: Quote odd-lot
    {
      id: 'ws-qt',
      kind: 'source',
      layer: 'Lotte WS (Quote odd-lot)',
      title: 'auto.qt.oddlot.<code>',
      subtitle: 'Feed quote lô lẻ',
      position: { x: 0, y: ROW * 2 },
      inputs: [{ name: 'subscribe', type: 'WS', description: '' }],
      outputs: [{ name: 'raw odd-lot quote line', type: 'string', description: '' }],
      details:
        'Channel quote cho mã lô lẻ, chỉ phát khi có khớp lô lẻ. Tần suất thấp hơn quote thường.',
    },
    {
      id: 'kafka-qt',
      kind: 'kafka',
      layer: 'Kafka',
      title: 'quoteOddLotUpdate',
      subtitle: 'Topic RIÊNG',
      position: { x: COL, y: ROW * 2 },
      inputs: [{ name: 'collector producer', type: 'Kafka', description: '' }],
      outputs: [{ name: 'realtime-v2 + ws-v2', type: 'Kafka', description: '' }],
      details:
        'Message = SymbolQuoteOddLot (subtype của SymbolQuote). Consumer realtime-v2 nhận diện qua instanceof để rẽ nhánh xử lý.',
    },
    {
      id: 'svc-qt',
      kind: 'logic',
      layer: 'QuoteService',
      title: 'updateQuote() — nhánh SymbolQuoteOddLot',
      subtitle: 'Reuse method nhưng if-instanceof',
      position: { x: COL * 2, y: ROW * 2 },
      inputs: [{ name: 'SymbolQuoteOddLot', type: 'object', description: '' }],
      outputs: [
        { name: 'update SymbolInfoOddLot (KHÔNG chạm SymbolInfo thường)', type: 'merge', description: '' },
        { name: 'HSET realtime_mapSymbolInfoOddLot[code]', type: 'Redis', description: '' },
      ],
      details:
        'QuoteService.updateQuote() check instanceof:\n' +
        '  • SymbolQuote (thường) → full fanout 7 hướng như lifecycle Quote\n' +
        '  • SymbolQuoteOddLot → CHỈ update SymbolInfoOddLot\n\n' +
        'Nhánh odd-lot KHÔNG ghi vào:\n' +
        '  – realtime_listQuote_* (không giữ tick history)\n' +
        '  – realtime_listQuoteMinute_* (không có minute bar)\n' +
        '  – realtime_mapSymbolStatistic (không có bucket giá)\n' +
        '  – realtime_mapSymbolDaily (không có daily OHLCV riêng)\n' +
        '  – realtime_mapForeignerDaily (không track NĐTNN riêng cho lô lẻ)\n\n' +
        'Lý do: thị trường lô lẻ dữ liệu thưa, không cần derived state phức tạp.',
    },

    // Shared Redis keys
    {
      id: 'r-info',
      kind: 'redis',
      layer: 'Redis (shared)',
      title: 'realtime_mapSymbolInfoOddLot[code]',
      subtitle: 'Hash chung cho 2 nhánh',
      position: { x: COL * 3.2, y: ROW },
      inputs: [
        { name: 'HSET từ BidOfferService (updatedBy=BidOfferOddLot)', type: 'Redis', description: '' },
        { name: 'HSET từ QuoteService (updatedBy=SymbolQuoteOddLot)', type: 'Redis', description: '' },
      ],
      outputs: [{ name: 'query-v2 + ws-v2', type: 'hash', description: '' }],
      details:
        'Single hash nhận ghi từ 2 mutator khác nhau. Field updatedBy cho biết lần update cuối đến từ nguồn nào (BidOfferOddLot hay SymbolQuoteOddLot).\n\n' +
        'Shape tương tự SymbolInfo nhưng bidOfferList tính theo lô lẻ.',
    },
    {
      id: 'r-list',
      kind: 'redis',
      layer: 'Redis (BO history)',
      title: 'realtime_listBidOfferOddLot_{code}',
      subtitle: 'List — runtime ON',
      position: { x: COL * 3.2, y: 0 },
      inputs: [{ name: 'RPUSH từ updateBidOfferOddLot', type: 'Redis', description: '' }],
      outputs: [{ name: 'history đầu sổ odd-lot', type: 'list', description: 'id = code_yyyyMMddHHmmss_seq' }],
      details:
        'KHÁC bản stock (enableSaveBidOffer=false) — nhánh odd-lot luôn ON, giữ lại mỗi snapshot order book lô lẻ để hiển thị diễn biến cho client.',
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
        { name: '/symbol/oddlotLatest', type: 'endpoint', description: 'Snapshot + bidOffer lô lẻ' },
      ],
      details:
        'Client mở tab "Lô lẻ" gọi endpoint riêng — service HMGET realtime_mapSymbolInfoOddLot cho nhiều mã cùng lúc. History bid/offer đọc thêm từ realtime_listBidOfferOddLot_{code}.',
    },
    {
      id: 'wsv2',
      kind: 'ws',
      layer: 'Delivery',
      title: 'ws-v2 channels',
      subtitle: 'OddLot channels riêng',
      position: { x: COL * 4.8, y: ROW * 1.5 },
      inputs: [{ name: 'consume 2 topics odd-lot', type: 'Kafka', description: '' }],
      outputs: [
        { name: 'market.bidofferOddLot.{code}', type: 'channel', description: '' },
        { name: 'market.quoteOddLot.{code}', type: 'channel', description: '' },
      ],
      details:
        'Channel riêng để client tuỳ chọn subscribe mà không nhận cả stream thường. Payload dùng convertDataPublishV2BidOfferOddLot / convertDataPublishV2QuoteOddLot để compact.',
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
        'Cùng cron saveRedisToDatabase — thêm bước getAllSymbolInfoOddLot() bulk-write sang collection odd-lot (tên khác c_symbol_info).',
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
        { name: 'reset oddlotBidOfferList trong SymbolInfoOddLot', type: 'reset', description: '' },
      ],
      details:
        '00:55 removeAutoData xoá history list bid/offer lô lẻ.\n' +
        '01:35 refreshSymbolInfo reset oddlotBidOfferList trong SymbolInfoOddLot — giống bản stock, không xoá snapshot mà chỉ reset field intraday.',
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
    'Daily OHLCV nối intraday và historical · upsert từ Quote + Extra · snapshot 6×/day sang Mongo · 22:50 clear',
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
      outputs: [{ name: 'build/patch SymbolDaily từ tick', type: 'compute', description: '' }],
      details:
        'Từ tick mới, service compute SymbolDaily cho ngày hiện tại:\n' +
        '  • Nếu chưa có → tạo mới { open = tick.last (tick đầu tiên), high=low=close=tick.last, volume/value = tick.matching* }\n' +
        '  • Nếu đã có → high = max(high, tick.last), low = min(low, tick.last), close = tick.last, volume/value += tick.matching*\n\n' +
        'id = code_yyyyMMdd — idempotent, upsert an toàn.',
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
        'ExtraQuote (đặc biệt từ DealNotice và calExtraUpdate) mang field mà Quote thường không có:\n' +
        '  • ptTradingVolume/Value (put-through cộng dồn)\n' +
        '  • foreignerMatch* (đôi khi)\n\n' +
        'upsertSymbolDaily merge các field này vào SymbolDaily hiện tại, giữ nguyên OHLCV.',
    },
    {
      id: 'r',
      kind: 'redis',
      layer: 'Redis intraday',
      title: 'realtime_mapSymbolDaily[code]',
      subtitle: 'Hash OHLCV ngày',
      position: { x: COL * 1.5, y: ROW * 0.5 },
      inputs: [{ name: 'HSET', type: 'Redis', description: '' }],
      outputs: [{ name: 'daily OHLCV hôm nay', type: 'hash', description: 'id = code_yyyyMMdd' }],
      details:
        'Shape:\n' +
        '{ code, date, open, high, low, close/last, tradingVolume, tradingValue, ptTradingVolume/Value, foreigner..., updatedAt }',
    },
    {
      id: 'mongo',
      kind: 'mongo',
      layer: 'Mongo historical',
      title: 'c_symbol_daily',
      subtitle: 'Day-level lịch sử',
      position: { x: COL * 3, y: ROW * 1.7 },
      inputs: [{ name: 'saveRedisToDatabase → getAllSymbolDaily', type: 'bulk', description: '' }],
      outputs: [{ name: 'find() cho querySymbolPeriod', type: 'read', description: '' }],
      details:
        'Index { code, date }. Mỗi ngày có 1 document cho mỗi mã.\n\n' +
        'Dùng làm nguồn historical cho period query và TradingView history khi timeframe > 1 ngày.',
    },
    {
      id: 'q-today',
      kind: 'api',
      layer: 'Delivery · today',
      title: 'market-query-v2 · today',
      subtitle: 'Redis-first',
      position: { x: COL * 3, y: 0 },
      inputs: [
        { name: 'Redis mapSymbolInfo hoặc mapSymbolDaily', type: 'Redis', description: '' },
      ],
      outputs: [{ name: 'querySymbolPeriod (today slice)', type: 'endpoint', description: '' }],
      details:
        'Khi toDate = today, service KHÔNG đọc Mongo — đọc thẳng realtime_mapSymbolDaily để có OHLCV mới nhất. Nếu key miss fallback sang realtime_mapSymbolInfo (SymbolInfo cũng có OHLC ngày).',
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
        { name: 'TradingView history', type: 'endpoint', description: 'bars daily' },
      ],
      details:
        'Range toàn quá khứ → query Mongo by { code, date ∈ [from, to] }. Nếu toDate ≥ today, service gộp thêm snapshot realtime để trả về liền mạch.',
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
        'Tại mỗi cron run, HGETALL realtime_mapSymbolDaily → bulk upsert c_symbol_daily theo key (code, date). 6 lần/ngày đảm bảo ngay cả khi crash cũng chỉ mất tối đa ~2 giờ daily.',
    },
    {
      id: 'cron-clear',
      kind: 'schedule',
      layer: 'Cron',
      title: 'clearOldSymbolDaily() 22:50',
      subtitle: 'Clear trước khi ngày mới',
      position: { x: COL * 1.5, y: ROW * 3.3 },
      inputs: [{ name: '@Scheduled', type: 'cron', description: '' }],
      outputs: [
        { name: 'clear realtime_mapSymbolDaily', type: 'del', description: '' },
        { name: 'clear cache mapSymbolDaily', type: 'del', description: '' },
      ],
      details:
        '22:50 (sau giờ giao dịch xa) xoá daily hash + in-memory cache. Đến 01:35 ngày mới refreshSymbolInfo chạy xong, tick đầu tiên của ngày sẽ tạo lại record.',
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
    'State NĐTNN trong ngày · update từ Quote và Extra · overlay Redis khi query bao gồm today · snapshot sang Mongo 6×/day',
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
        'Mỗi tick, service:\n' +
        '  1. Lấy ForeignerDaily hiện tại (nếu chưa có → tạo mới với baseline từ SymbolInfo)\n' +
        '  2. foreignerDaily.updateByQuote(quote) cộng dồn:\n' +
        '     – foreignerBuyVolume += quote.foreignerMatchBuyVolume\n' +
        '     – foreignerSellVolume += quote.foreignerMatchSellVolume\n' +
        '     – foreignerBuyValue/SellValue tương tự\n' +
        '     – foreignerCurrentRoom từ quote (snapshot)\n' +
        '     – holdVolume/Ratio/buyAbleRatio compute lại\n' +
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
      outputs: [{ name: 'merge enrichment foreigner', type: 'merge', description: '' }],
      details:
        'Extra mang field NĐTNN đã được collector tính toán tổng hợp (ví dụ lúc có DealNotice từ NĐTNN). Service merge các field này vào ForeignerDaily hiện tại rồi HSET lại.',
    },
    {
      id: 'r',
      kind: 'redis',
      layer: 'Redis intraday',
      title: 'realtime_mapForeignerDaily[code]',
      subtitle: 'Hash',
      position: { x: COL * 1.5, y: ROW * 0.5 },
      inputs: [{ name: 'HSET', type: 'Redis', description: '' }],
      outputs: [{ name: 'foreigner hôm nay', type: 'hash', description: '' }],
      details:
        'Shape: { code, symbolType, date, foreignerBuy/SellValue/Volume, foreignerTotalRoom, foreignerCurrentRoom, foreignerBuyAbleRatio, foreignerHoldVolume, foreignerHoldRatio, listedQuantity, createdAt, updatedAt }',
    },
    {
      id: 'q-api',
      kind: 'api',
      layer: 'Delivery',
      title: 'market-query-v2',
      subtitle: 'Overlay today với Redis',
      position: { x: COL * 3, y: 0 },
      inputs: [
        { name: '/symbol/{symbol}/foreigner', type: 'endpoint', description: '' },
        { name: 'Mongo ForeignerDaily historical', type: 'Mongo', description: '' },
      ],
      outputs: [{ name: 'nếu toDate ≥ today → overlay bằng realtime_mapForeignerDaily', type: 'merge', description: '' }],
      details:
        'Logic query:\n' +
        '  1. Luôn query Mongo c_foreigner_daily theo { code, date ∈ [from, to] } trước\n' +
        '  2. Nếu toDate ≥ today → lấy thêm realtime_mapForeignerDaily[code], ghi đè record của today trong kết quả (vì Mongo record today có thể outdated vài phút)\n' +
        '  3. Trả về timeseries liền mạch',
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
        'Pipeline: HGETALL realtime_mapForeignerDaily → mỗi doc set id = code_yyyyMMdd → bulk upsert vào c_foreigner_daily (idempotent).',
    },
    {
      id: 'mongo',
      kind: 'mongo',
      layer: 'Mongo',
      title: 'c_foreigner_daily',
      subtitle: 'Historical NĐTNN',
      position: { x: COL * 3, y: ROW * 2 },
      inputs: [{ name: 'bulk write', type: 'Mongo', description: '' }],
      outputs: [{ name: 'historical source', type: 'read', description: '' }],
      details:
        'Index { code, date }. Lưu timeseries NĐTNN đủ các ngày trước. Dùng khi client xem chart 1M/3M/1Y khối ngoại mua/bán.',
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
    'State phiên theo market · auto.tickerNews → Kafka → updateMarketStatus · broadcast sessions cho mọi SymbolInfo cùng market khi ATO/ATC',
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
        'Lotte bắn event mỗi khi sàn chuyển phiên (HOSE PRE → ATO → CONTINUOUS → ATC → POST, tương tự HNX/UPCOM). Format là chuỗi title dạng natural language mà collector phải parse.',
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
        '  1. Parse title để tách market (HOSE/HNX/UPCOM/DERIVATIVE) và status (PRE/ATO/CONTINUOUS/LO/INTERMISSION/ATC/POST/CLOSE)\n' +
        '  2. parseStatus() chuẩn hoá alias: "LO" trong news ↔ "CONTINUOUS" trong SymbolInfo\n' +
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
        'Tần suất rất thấp (vài event/ngày/market) — không cần throughput cao.',
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
        'Handler đơn giản, không qua MonitorService — forward trực tiếp đến MarketStatusService vì event ít và ảnh hưởng toàn market nên không cần sort theo code.',
    },
    {
      id: 'service',
      kind: 'logic',
      layer: 'MarketStatusService',
      title: 'updateMarketStatus()',
      subtitle: 'Mutator duy nhất broadcast',
      position: { x: COL * 4, y: ROW },
      inputs: [{ name: 'MarketStatus', type: 'object', description: '' }],
      outputs: [
        { name: '1) set id = market + "_" + type', type: 'set', description: '' },
        { name: '2) set date', type: 'set', description: '' },
        { name: '3) HSET realtime_mapMarketStatus[id]', type: 'Redis', description: '' },
        { name: '4) IF ATO/ATC → broadcast sessions=status sang MỌI SymbolInfo cùng market', type: 'broadcast', description: '' },
        { name: '5) ELSE sessions = null', type: 'set', description: '' },
      ],
      details:
        'Đây là method "expensive" — 1 event có thể trigger update hàng nghìn SymbolInfo.\n\n' +
        'Bước 4 chi tiết:\n' +
        '  • IF status ∈ {ATO, ATC}:\n' +
        '      a. HGETALL realtime_mapSymbolInfo → lọc các mã có market = event.market\n' +
        '      b. Với mỗi mã: set symbolInfo.sessions = status\n' +
        '      c. HSET lại realtime_mapSymbolInfo[code] cho tất cả\n' +
        '  • ELSE (CONTINUOUS/POST/CLOSE…):\n' +
        '      – sessions = null (client UI sẽ không highlight phiên đặc biệt)\n\n' +
        'Lưu ý: alias status="LO" (trong Redis hash) ≡ session="CONTINUOUS" trong SymbolInfo/BidOffer.',
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
        'Key field dạng "HOSE_STOCK", "HNX_STOCK", "DERIVATIVE_FUTURES"... để client query session của từng loại thị trường.',
    },
    {
      id: 'r-info',
      kind: 'redis',
      layer: 'Redis (broadcast side-effect)',
      title: 'realtime_mapSymbolInfo[*]',
      subtitle: 'Field sessions bị đè',
      position: { x: COL * 5.2, y: ROW * 1.5 },
      inputs: [{ name: 'HSET lại khi propagate', type: 'Redis', description: 'chỉ ATO/ATC' }],
      outputs: [{ name: 'sessions = ATO|ATC|null', type: 'field', description: '' }],
      details:
        'Side-effect quan trọng: SymbolInfo không được mutator nào khác set field sessions trừ MarketStatusService. Các mutator khác (Quote/BidOffer) CÓ THỂ ghi session nhưng đó là session đi kèm tick, khác với field sessions (snapshot trạng thái phiên của cả market).',
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
        'Client query 1 endpoint để biết trạng thái tất cả market (HOSE đang CONTINUOUS, HNX đang INTERMISSION...). Chỉ cần 1 HGETALL.',
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
        'Channel market.status không theo code — broadcast cho mọi client. Client nhận event để cập nhật UI ticker top screen ("HOSE đang ATO, còn 2 phút...").',
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
        'Snapshot lịch sử các lần đổi phiên — hữu ích cho audit thời điểm chuyển phiên trong ngày.',
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
    'Event enrichment · 5 nguồn sinh (VN30/Futures/CW/DealNotice/calExtraUpdate) · KHÔNG là object lưu lâu · mutate SymbolInfo + ForeignerDaily + SymbolDaily rồi biến mất',
  accent: '#ec4899',
  nodes: [
    {
      id: 's1',
      kind: 'source',
      layer: 'Source 1/5',
      title: 'handleAutoData(IndexUpdateData VN30)',
      subtitle: 'Tính basis cho futures',
      position: { x: 0, y: 0 },
      inputs: [{ name: 'VN30 tick', type: 'object', description: '' }],
      outputs: [{ name: 'ExtraUpdate { basis }', type: 'object', description: 'mỗi mã futures VN30F*' }],
      details:
        'Khi VN30 index tick đến, collector iterate các mã futures VN30F* đang active:\n' +
        '  • basis = futuresLast − vn30.last\n' +
        '  • Publish ExtraUpdate cho từng mã futures (có thể nhiều event cùng lúc)',
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
        'Ngược lại với s1: khi futures tick đến, compute basis với vn30.last cached gần nhất. Kết quả là ExtraUpdate chỉ cho mã futures đó.',
    },
    {
      id: 's3',
      kind: 'source',
      layer: 'Source 3/5',
      title: 'handleAutoData(StockUpdateData CW)',
      subtitle: 'Tính breakEven cho chứng quyền',
      position: { x: 0, y: ROW * 1.6 },
      inputs: [{ name: 'CW tick', type: 'object', description: '' }],
      outputs: [{ name: 'ExtraUpdate { breakEven }', type: 'object', description: '' }],
      details:
        'Khi stock tick đến và mã là chứng quyền (CW), collector compute breakEven = strikePrice + CW.last × exerciseRatio (tuỳ loại CW). Publish ExtraUpdate chỉ cho CW đó.',
    },
    {
      id: 's4',
      kind: 'source',
      layer: 'Source 4/5',
      title: 'DealNoticeData',
      subtitle: 'ExtraUpdate.fromDealNotice()',
      position: { x: 0, y: ROW * 2.4 },
      inputs: [{ name: 'Deal notice mới', type: 'object', description: '' }],
      outputs: [{ name: 'ExtraUpdate { ptVolume, ptValue }', type: 'object', description: 'tích lũy' }],
      details:
        'Mỗi thỏa thuận khớp đẩy thêm vào PT summary của mã:\n' +
        '  • ptVolume cộng dồn\n' +
        '  • ptValue cộng dồn\n\n' +
        'Collector publish SONG SONG 2 Kafka message: dealNoticeUpdate (raw) + extraUpdate (PT summary).',
    },
    {
      id: 's5',
      kind: 'source',
      layer: 'Source 5/5',
      title: 'QuoteService.reCalculate()',
      subtitle: 'Khi high/low year đổi',
      position: { x: 0, y: ROW * 3.4 },
      inputs: [{ name: 'SymbolQuote', type: 'object', description: '' }],
      outputs: [{ name: 'publish calExtraUpdate', type: 'Kafka', description: 'topic riêng nhưng cùng consumer' }],
      details:
        'Trong reCalculate, nếu tick.last vượt qua giá cao nhất/thấp nhất trong 52 tuần (1 năm), publish calExtraUpdate với { highYear, lowYear } để cập nhật SymbolInfo (highYear/lowYear là field hiển thị trên priceBoard).',
    },
    {
      id: 'kafka',
      kind: 'kafka',
      layer: 'Kafka',
      title: 'extraUpdate / calExtraUpdate',
      subtitle: '2 topic → cùng 1 consumer',
      position: { x: COL * 1.3, y: ROW * 1.7 },
      inputs: [{ name: '4 sources collector + 1 source realtime-v2', type: 'Kafka', description: '' }],
      outputs: [{ name: 'ExtraQuoteUpdateHandler + ws-v2', type: 'Kafka', description: '' }],
      details:
        'Chia 2 topic để routing rõ nhưng consumer thường handle cả 2 chung. extraUpdate cho basis/breakEven/pt, calExtraUpdate cho highYear/lowYear (do self-produce từ QuoteService trong realtime-v2).',
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
        'Handler không qua MonitorService — forward trực tiếp đến ExtraQuoteService vì event enrichment có tần suất thấp hơn quote/bidoffer.',
    },
    {
      id: 'service',
      kind: 'logic',
      layer: 'ExtraQuoteService',
      title: 'updateExtraQuote()',
      subtitle: 'Mutate 3 target object',
      position: { x: COL * 3.7, y: ROW * 1.7 },
      inputs: [{ name: 'ExtraQuote', type: 'object', description: '' }],
      outputs: [
        { name: '① SymbolInfo (basis/breakEven/pt/highYear/lowYear)', type: 'merge', description: '' },
        { name: '② ForeignerDaily', type: 'merge', description: '' },
        { name: '③ SymbolDaily (upsert)', type: 'upsert', description: '' },
      ],
      details:
        'Method này là "fanout mutator" — 1 ExtraQuote mutate 3 target:\n\n' +
        '  1. SymbolInfo:\n' +
        '     – ConvertUtils.updateByExtraQuote merge basis, breakEven, ptVolume/Value, highYear, lowYear\n' +
        '     – HSET realtime_mapSymbolInfo\n\n' +
        '  2. ForeignerDaily:\n' +
        '     – ConvertUtils.updateByExtraQuote(foreignerDaily, extra) merge field NĐTNN bổ sung\n' +
        '     – HSET realtime_mapForeignerDaily\n\n' +
        '  3. SymbolDaily:\n' +
        '     – upsertSymbolDaily merge ptTradingVolume/Value\n' +
        '     – HSET realtime_mapSymbolDaily\n\n' +
        'Sau khi xong, ExtraQuote không được lưu thêm ở đâu — chỉ tan biến.',
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
        'Cùng hash của lifecycle SymbolInfo — xem diagram riêng. ExtraQuote là 1 trong 6 mutator.',
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
        'Cùng hash của lifecycle ForeignerDaily — ExtraQuote là 1 trong 2 source (cùng với Quote).',
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
        'Cùng hash của lifecycle SymbolDaily — ExtraQuote là 1 trong 2 source (cùng với Quote).',
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
        'Channel riêng để client cập nhật các field enrichment mà không phải reload SymbolInfo. Hữu ích cho góc hiển thị "basis/breakEven/PT summary" realtime.',
    },
    {
      id: 'note',
      kind: 'config',
      layer: 'Note',
      title: 'KHÔNG persist độc lập',
      subtitle: 'Là event, không phải entity',
      position: { x: COL * 2.5, y: ROW * 3.6 },
      inputs: [],
      outputs: [],
      details:
        'ExtraUpdate/ExtraQuote không có Redis/Mongo store riêng — chỉ để mutate 3 target khác (SymbolInfo, ForeignerDaily, SymbolDaily). Sau khi xử lý xong object tan biến — không tìm lại được từng event riêng lẻ.\n\nNếu cần audit, phải nhìn vào SymbolInfo field updatedBy="ExtraUpdate" hoặc Kafka __consumer_offsets.',
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
    'Thỏa thuận đã khớp · đồng thời là nguồn PT summary · raw dealNoticeUpdate + sinh ExtraUpdate · history theo market',
  accent: '#14b8a6',
  nodes: [
    {
      id: 'ws',
      kind: 'source',
      layer: 'Lotte WS',
      title: 'put-through matched feed',
      subtitle: 'Deal đã khớp',
      position: { x: 0, y: ROW },
      inputs: [{ name: 'subscribe', type: 'WS', description: '' }],
      outputs: [{ name: 'raw deal line', type: 'string', description: '' }],
      details:
        'Lotte bắn event mỗi khi 1 thỏa thuận put-through (mua/bán khối lượng lớn thỏa thuận) được khớp chính thức. Mỗi event mang confirmNumber duy nhất do sàn cấp.',
    },
    {
      id: 'collector',
      kind: 'logic',
      layer: 'Collector',
      title: 'DealNoticeData + ExtraUpdate.fromDealNotice()',
      subtitle: '2 publish song song',
      position: { x: COL, y: ROW },
      inputs: [{ name: 'raw', type: 'string', description: '' }],
      outputs: [
        { name: 'dealNoticeUpdate (raw)', type: 'Kafka', description: '' },
        { name: 'extraUpdate { ptVolume, ptValue }', type: 'Kafka', description: 'tích lũy' },
      ],
      details:
        'Collector xử lý 1 deal thành 2 message:\n\n' +
        '  1. DealNoticeData raw:\n' +
        '     – publish dealNoticeUpdate để realtime-v2 ghi history + ws-v2 broadcast\n' +
        '  2. ExtraUpdate.fromDealNotice():\n' +
        '     – tạo ExtraUpdate có ptVolume=deal.volume, ptValue=deal.value\n' +
        '     – publish extraUpdate để ExtraQuoteService cộng dồn vào SymbolInfo.ptTradingVolume/Value\n\n' +
        'Tách 2 topic tránh coupling: consumer nào chỉ cần 1 loại có thể skip loại kia.',
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
        'Raw deal — consumer realtime-v2 ghi history, ws-v2 broadcast.',
    },
    {
      id: 'kafka-extra',
      kind: 'kafka',
      layer: 'Kafka',
      title: 'extraUpdate',
      subtitle: 'Sang lifecycle Extra',
      position: { x: COL * 2, y: ROW * 1.8 },
      inputs: [{ name: 'collector producer', type: 'Kafka', description: '' }],
      outputs: [{ name: '→ ExtraQuoteService', type: 'link', description: '' }],
      details:
        'ExtraQuote từ deal — xem lifecycle ExtraUpdate (source 4/5). Sẽ mutate SymbolInfo.ptTradingVolume/Value.',
    },
    {
      id: 'service',
      kind: 'logic',
      layer: 'DealNoticeService',
      title: 'updateDealNotice()',
      subtitle: '7 bước — dedupe quan trọng',
      position: { x: COL * 3.2, y: ROW * 0.5 },
      inputs: [{ name: 'DealNotice', type: 'object', description: '' }],
      outputs: [
        { name: '1) ensure SymbolInfo tồn tại', type: 'check', description: '' },
        { name: '2) load all DealNotice hiện có', type: 'read', description: '' },
        { name: '3) dedupe theo confirmNumber', type: 'compute', description: '' },
        { name: '4) ConvertUtils.updateByDealNotice(symbolInfo, deal)', type: 'merge', description: '' },
        { name: '5) HSET realtime_mapSymbolInfo[code]', type: 'Redis', description: '' },
        { name: '6) set dealNotice.id / date / timestamps', type: 'set', description: '' },
        { name: '7) RPUSH realtime_listDealNotice_{market}', type: 'Redis', description: '' },
      ],
      details:
        'Chi tiết:\n\n' +
        '  1. SymbolInfo phải load rồi (deal phải thuộc 1 mã đã biết), không → skip\n' +
        '  2. Đọc realtime_listDealNotice_{market} để kiểm tra deal đã có chưa\n' +
        '  3. Dedupe: Lotte có thể resend cùng deal (cùng confirmNumber) — chỉ xử lý nếu CHƯA có\n' +
        '  4. ConvertUtils.updateByDealNotice merge vào SymbolInfo:\n' +
        '     – symbolInfo.ptTradingVolume += deal.volume\n' +
        '     – symbolInfo.ptTradingValue += deal.value\n' +
        '     (realtime-v2 cũng compute lại độc lập với collector để phòng duplicate)\n' +
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
        'Key theo market (HOSE/HNX/UPCOM), không theo code — client xem "các deal mới nhất toàn sàn" chỉ cần 1 LRANGE.\n\n' +
        'Docs có đoạn mô tả key theo code — nếu cần chính xác tuyệt đối phải verify code thực tế.',
    },
    {
      id: 'r-info',
      kind: 'redis',
      layer: 'Redis',
      title: 'realtime_mapSymbolInfo[code]',
      subtitle: 'ptTradingVolume / ptTradingValue',
      position: { x: COL * 4.6, y: ROW * 1.2 },
      inputs: [{ name: 'HSET', type: 'Redis', description: '' }],
      outputs: [{ name: 'qua lifecycle SymbolInfo', type: 'link', description: '' }],
      details:
        'Xem lifecycle SymbolInfo. DealNotice là mutator thứ 6 (cùng với Init/Quote/BidOffer/Extra/MarketStatus).',
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
        { name: 'queryPutThroughDeal', type: 'endpoint', description: 'list deal' },
        { name: 'queryPtDealTotal', type: 'endpoint', description: 'tổng hợp PT toàn sàn' },
      ],
      details:
        'Client mở tab Thỏa thuận — 1 LRANGE lấy last N deals, hoặc aggregate tổng ptVolume/Value toàn sàn từ cùng list.',
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
        'Channel theo market để client tab Thỏa thuận nhận deal mới realtime mà không reload.',
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
        'LRANGE all realtime_listDealNotice_* → bulk write c_deal_notice theo _id = confirmNumber (idempotent).',
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
        'Xoá list để ngày mới bắt đầu rỗng. Các deal cũ đã được persist ở c_deal_notice từ saveRedisToDatabase các khung trước.',
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
    'Rao bán thỏa thuận · chỉ có history list theo market · không mutate SymbolInfo',
  accent: '#0ea5e9',
  nodes: [
    {
      id: 'ws',
      kind: 'source',
      layer: 'Lotte WS',
      title: 'advertised feed',
      subtitle: 'Đặt lệnh rao bán',
      position: { x: 0, y: ROW },
      inputs: [{ name: 'subscribe', type: 'WS', description: '' }],
      outputs: [{ name: 'raw advertise line', type: 'string', description: '' }],
      details:
        'Khi có công ty/người đăng "rao bán" khối lượng lớn (chưa khớp), Lotte bắn event. Khác DealNotice là đã khớp, Advertised chỉ là offer đang chờ đối tác.',
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
        'Parse raw → build AdvertisedData { code, market, side (BUY/SELL), price, volume, customer, time, ... } → sendMessageSafe("advertisedUpdate"). Không publish ExtraUpdate vì chưa khớp nên không ảnh hưởng PT summary.',
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
      details: 'Tần suất thấp — chỉ khi có đơn rao bán mới đăng.',
    },
    {
      id: 'service',
      kind: 'logic',
      layer: 'AdvertisedService',
      title: 'updateAdvertised()',
      subtitle: 'Chỉ RPUSH',
      position: { x: COL * 3, y: ROW },
      inputs: [{ name: 'Advertised', type: 'object', description: '' }],
      outputs: [
        { name: 'set id / date / timestamps', type: 'set', description: '' },
        { name: 'RPUSH realtime_listAdvertised_{market}', type: 'Redis', description: '' },
      ],
      details:
        'Service đơn giản nhất trong các lifecycle:\n' +
        '  1. Set id = code_yyyyMMddHHmmss_random\n' +
        '  2. Set date + createdAt + updatedAt\n' +
        '  3. RPUSH realtime_listAdvertised_{market}\n\n' +
        'KHÔNG mutate SymbolInfo vì advertised chưa khớp.',
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
        'List theo market — giống dealNotice. Không có key theo code vì advertise ít, client xem tổng hợp toàn sàn.',
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
        'Client mở tab Rao bán thỏa thuận — 1 LRANGE lấy list rao bán hôm nay của sàn.',
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
        'Channel realtime cho tab "Rao bán" không cần reload.',
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
        'LRANGE realtime_listAdvertised_* → bulk write c_advertise để audit.',
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
        'Xoá list để ngày mới sạch. Data đã được persist ở c_advertise từ các cron saveRedisToDatabase trước đó.',
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
    'Hậu xử lý — KHÔNG đến từ feed · updateSymbolPrevious chạy trong saveRedisToDatabase · nối phiên hôm nay ↔ phiên trước',
  accent: '#7dd3fc',
  nodes: [
    {
      id: 'daily',
      kind: 'redis',
      layer: 'Source',
      title: 'realtime_mapSymbolDaily',
      subtitle: 'Input cho previous',
      position: { x: 0, y: ROW },
      inputs: [{ name: 'HGET hôm nay', type: 'Redis', description: '' }],
      outputs: [{ name: 'SymbolDaily.last + SymbolDaily.date', type: 'read', description: '' }],
      details:
        'SymbolPrevious LOOKUP SymbolDaily hôm nay để biết giá đóng cửa cần cập nhật. Chỉ đọc sau khi cron saveRedisToDatabase chạy (daily đã mới nhất).',
    },
    {
      id: 'cron',
      kind: 'schedule',
      layer: 'Cron trigger',
      title: 'saveRedisToDatabase() → updateSymbolPrevious()',
      subtitle: '6×/day',
      position: { x: COL, y: ROW },
      inputs: [{ name: '@Scheduled', type: 'cron', description: '' }],
      outputs: [{ name: 'kích hoạt logic compare', type: 'call', description: '' }],
      details:
        'updateSymbolPrevious() là step cuối cùng trong pipeline saveRedisToDatabase. Sau khi SymbolDaily hôm nay đã được bulk-write sang Mongo, method này đảm bảo SymbolPrevious luôn đồng bộ.',
    },
    {
      id: 'logic',
      kind: 'logic',
      layer: 'Compare logic',
      title: 'updateSymbolPrevious()',
      subtitle: 'Same date vs khác date',
      position: { x: COL * 2, y: ROW },
      inputs: [
        { name: 'SymbolDaily hôm nay', type: 'object', description: '' },
        { name: 'SymbolPrevious hiện có', type: 'object', description: '' },
      ],
      outputs: [
        { name: 'IF sameDate → chỉ update close', type: 'branch', description: '' },
        { name: 'ELSE → previousClose = close cũ · previousTradingDate = lastTradingDate cũ · close = daily.last · lastTradingDate = daily.date', type: 'branch', description: '' },
      ],
      details:
        'Logic compare:\n\n' +
        '  • Nếu SymbolPrevious.lastTradingDate == SymbolDaily.date (cùng ngày giao dịch) → sameDate = true\n' +
        '      – CHỈ update close = daily.last (thực hiện khi intraday, cron chạy nhiều lần/ngày)\n' +
        '      – Không touching previousClose / previousTradingDate\n\n' +
        '  • Nếu khác ngày → RỘNG HƠN:\n' +
        '      – previousClose   = close cũ (close của phiên trước)\n' +
        '      – previousTradingDate = lastTradingDate cũ\n' +
        '      – close           = daily.last (ngày hiện tại)\n' +
        '      – lastTradingDate = daily.date (ngày hiện tại)\n\n' +
        '  Đây là cơ chế "advance" phiên — chỉ khi phát hiện ngày giao dịch mới.',
    },
    {
      id: 'mongo',
      kind: 'mongo',
      layer: 'Persistence',
      title: 'c_symbol_previous',
      subtitle: 'Day-level',
      position: { x: COL * 3, y: ROW },
      inputs: [{ name: 'upsert', type: 'Mongo', description: '' }],
      outputs: [{ name: 'client tính biến động so với phiên trước', type: 'read', description: '' }],
      details:
        'Shape: { code, close, lastTradingDate, previousClose, previousTradingDate, updatedAt }.\n\n' +
        'Khác referencePrice (tham chiếu của sàn có thể ≠ giá đóng cửa thực tế trong 1 số trường hợp cổ tức/chia tách). previousClose là giá đóng cửa THỰC TẾ phiên trước.',
    },
    {
      id: 'note',
      kind: 'config',
      layer: 'Note',
      title: 'Không có Redis key riêng',
      subtitle: 'Chỉ lưu Mongo',
      position: { x: COL * 2, y: ROW * 2.2 },
      inputs: [],
      outputs: [],
      details:
        'SymbolPrevious KHÔNG có hot state Redis — vì không cần update realtime mỗi tick. Chỉ update 6×/day đủ dùng.\n\nClient-side query trực tiếp Mongo khi cần (thường join với SymbolInfo để tính % change so với previous).',
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
    'Static extension data · KHÔNG mutate theo tick · merge với realtime_mapSymbolInfo trong querySymbolStaticInfo',
  accent: '#94a3b8',
  nodes: [
    {
      id: 'src',
      kind: 'source',
      layer: 'Ingest (ngoài flow realtime chính)',
      title: 'Static feed / admin job',
      subtitle: 'listedQty / avgTradingVol10 / reference/floor/ceiling...',
      position: { x: 0, y: ROW },
      inputs: [{ name: 'không rõ trigger realtime trong context', type: 'note', description: '' }],
      outputs: [{ name: 'symbolInfoExtend record', type: 'object', description: '' }],
      details:
        'Docs không mô tả rõ path mutate theo tick. Giả định: đây là data static (listedQty, avgTradingVol10 ngày, reference/floor/ceiling ngày, basicPrice...) được load từ:\n' +
        '  • Admin batch job đầu ngày\n' +
        '  • Hoặc ingest từ feed khác (Lotte batch, core system)\n\n' +
        'Hiện tại coi như static support — không có code path mutate trong flow realtime chính.',
    },
    {
      id: 'r',
      kind: 'redis',
      layer: 'Redis',
      title: 'symbolInfoExtend',
      subtitle: 'Hash by code',
      position: { x: COL, y: ROW },
      inputs: [{ name: 'HSET (batch admin)', type: 'Redis', description: '' }],
      outputs: [{ name: 'static support fields', type: 'hash', description: '' }],
      details:
        'Key trống không prefix "realtime_" — ngụ ý data không phải hot realtime. Field: listedQty, avgTradingVol10, referencePrice/floor/ceiling, basicPrice, tradingUnit, lotSize, ...',
    },
    {
      id: 'q',
      kind: 'api',
      layer: 'Delivery',
      title: 'querySymbolStaticInfo()',
      subtitle: 'Merge với realtime_mapSymbolInfo',
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
        '  1. HMGET realtime_mapSymbolInfo (field realtime)\n' +
        '  2. HMGET symbolInfoExtend (field static)\n' +
        '  3. MERGE 2 object — ưu tiên field từ realtime_mapSymbolInfo nếu conflict\n' +
        '  4. Trả về cho client màn "Thông tin cơ bản" của mã.',
    },
  ],
  edges: [
    { source: 'src', target: 'r', label: 'HSET (static)' },
    { source: 'r', target: 'q', label: 'merge với SymbolInfo' },
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
    'Thành phần chỉ số · admin/collector publish indexStockListUpdate · persist Mongo · getIndexRanks() join với Redis SymbolInfo',
  accent: '#fde68a',
  nodes: [
    {
      id: 'src',
      kind: 'logic',
      layer: 'Collector / Admin job',
      title: 'publish indexStockListUpdate',
      subtitle: 'Khi cấu trúc rổ đổi',
      position: { x: 0, y: ROW },
      inputs: [{ name: 'admin trigger hoặc collector init', type: 'call', description: '' }],
      outputs: [{ name: 'IndexStockList payload', type: 'object', description: '' }],
      details:
        'Event được publish khi:\n' +
        '  • Admin cập nhật rổ VN30/HNX30/VN100 khi sàn review định kỳ\n' +
        '  • Collector đầu ngày sync lại từ Lotte indexs-list nếu phát hiện đổi cấu trúc\n\n' +
        'Không phát theo tick — tần suất rất thấp (vài lần/tháng).',
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
        'Topic riêng để phân biệt với symbolInfoUpdate. Consumer chỉ có realtime-v2, không phải ws-v2 (client không cần realtime cho cấu trúc rổ).',
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
        '  1. Normalize indexCode (ví dụ "vn30" → "VN30", xoá khoảng trắng)\n' +
        '  2. Upsert vào IndexStockList collection theo _id = indexCode\n' +
        '  3. Không HSET Redis vì data static, đọc Mongo mỗi lần query cũng OK.',
    },
    {
      id: 'mongo',
      kind: 'mongo',
      layer: 'Persistence',
      title: 'IndexStockList',
      subtitle: 'Mongo collection',
      position: { x: COL * 3, y: ROW },
      inputs: [{ name: 'upsert', type: 'Mongo', description: '' }],
      outputs: [{ name: 'danh sách mã trong rổ', type: 'read', description: '' }],
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
        { name: 'realtime_mapSymbolInfo (Redis)', type: 'Redis', description: 'cho mỗi mã' },
      ],
      outputs: [
        { name: 'sort theo rate / tradingValue', type: 'compute', description: '' },
        { name: 'trả ranking trong index', type: 'response', description: '' },
      ],
      details:
        'Hot path khi client mở tab "Chi tiết rổ VN30":\n' +
        '  1. Find IndexStockList by indexCode → lấy mảng codes[]\n' +
        '  2. HMGET realtime_mapSymbolInfo với codes[] → lấy snapshot của mọi mã trong rổ\n' +
        '  3. Sort theo tiêu chí client yêu cầu (rate desc, tradingValue desc, ...)\n' +
        '  4. Trả response có rank + SymbolInfo compact\n\n' +
        'Đây là điểm JOIN cross-store — giảm được round-trip bằng cách HMGET 1 lần cho tất cả mã.',
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
        { name: 'queryIndexList', type: 'endpoint', description: 'danh sách rổ available' },
        { name: 'queryIndexStockList', type: 'endpoint', description: 'ranking trong 1 rổ' },
      ],
      details:
        'queryIndexList trả meta các rổ (VN30, HNX30, VN100...). queryIndexStockList trả ranking trong rổ chọn — delegate sang IndexStockService.getIndexRanks().',
    },
  ],
  edges: [
    { source: 'src', target: 'kafka', label: 'publish', animated: true },
    { source: 'kafka', target: 'handler', label: 'consume', animated: true },
    { source: 'handler', target: 'mongo', label: 'upsert' },
    { source: 'mongo', target: 'rank', label: 'find rổ' },
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
    '4 cron job cắt ngang lifecycle các object · removeAutoData (00:55) · refreshSymbolInfo (01:35) · clearOldSymbolDaily (22:50) · saveRedisToDatabase (6×/day)',
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
        'Job dọn dẹp LỚN NHẤT — xoá toàn bộ realtime intraday data của ngày trước.\n\n' +
        'Thời điểm 00:55 được chọn đủ xa giờ đóng cửa (15:00) để các cron saveRedisToDatabase đã chạy xong, đồng thời đủ sớm trước giờ mở cửa ngày mới (09:00).\n\n' +
        'Cuối cùng cacheService.reset() xoá in-memory cache để tránh stale sau khi Redis bị flush.',
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
        'Job "soft reset" — chỉ reset các field intraday CỦA SymbolInfo mà không xoá snapshot map.\n\n' +
        'Lý do KHÔNG xoá: baseline SymbolInfo (code/name/type/referencePrice/ceiling/floor/listedQty/foreignerTotalRoom...) không đổi theo ngày, không cần init lại từ REST. Chỉ các field intraday (sequence, matching*, bidOfferList) cần reset.',
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
        'Job nhỏ riêng cho SymbolDaily — thời điểm 22:50 (sau khi saveRedisToDatabase 14:29 đã ghi xong Mongo) đủ an toàn để xoá Redis.\n\n' +
        'Sau job này, Redis mapSymbolDaily rỗng. Tick đầu tiên của ngày mới sẽ tạo lại record.',
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
        { name: 'quote/minute/bid-ask: RUNTIME OFF — không persist', type: 'skip', description: '' },
      ],
      details:
        'Job persist LỚN — chạy 6 lần/ngày chia đều 3 khung:\n' +
        '  • Pre-lunch:  10:15, 10:29\n' +
        '  • Pre-close-lunch: 11:15, 11:29\n' +
        '  • Pre-market-close: 14:15, 14:29\n\n' +
        'Mỗi lần chạy thực hiện tuần tự:\n' +
        '  1. HGETALL realtime_mapSymbolInfo → bulk write c_symbol_info\n' +
        '  2. HGETALL realtime_mapSymbolInfoOddLot → bulk write odd-lot collection\n' +
        '  3. HGETALL realtime_mapSymbolDaily → bulk write c_symbol_daily\n' +
        '  4. HGETALL realtime_mapForeignerDaily → bulk write c_foreigner_daily (id=code_yyyyMMdd)\n' +
        '  5. HGETALL realtime_mapMarketStatus → bulk write c_market_session_status\n' +
        '  6. LRANGE realtime_listDealNotice_* → bulk write c_deal_notice\n' +
        '  7. LRANGE realtime_listAdvertised_* → bulk write c_advertise\n' +
        '  8. updateSymbolPrevious() → upsert c_symbol_previous\n\n' +
        'SKIP: quote ticks, minute bars, bid-offer history — do feature flags OFF.',
    },

    // Target objects
    {
      id: 'obj-quote',
      kind: 'logic',
      layer: 'Object',
      title: 'SymbolQuote + Meta',
      subtitle: 'Cleared 00:55',
      position: { x: COL * 2, y: 0 },
      inputs: [{ name: 'cleared bởi removeAutoData', type: 'affected', description: '' }],
      outputs: [{ name: 'realtime_listQuote_* / realtime_listQuoteMeta_*', type: 'Redis', description: '' }],
      details:
        'Tick list + partition meta. Không persist sang Mongo nên sau 00:55 tick hôm trước biến mất hoàn toàn.',
    },
    {
      id: 'obj-minute',
      kind: 'logic',
      layer: 'Object',
      title: 'SymbolQuoteMinute',
      subtitle: 'Cleared 00:55',
      position: { x: COL * 2, y: ROW * 0.5 },
      inputs: [{ name: 'cleared bởi removeAutoData', type: 'affected', description: '' }],
      outputs: [{ name: 'realtime_listQuoteMinute_*', type: 'Redis', description: '' }],
      details:
        'Minute bars hôm trước bị xoá. enableSaveQuoteMinute=false nên không có lịch sử minute trong DB.',
    },
    {
      id: 'obj-stat',
      kind: 'logic',
      layer: 'Object',
      title: 'SymbolStatistic',
      subtitle: 'Cleared 00:55',
      position: { x: COL * 2, y: ROW },
      inputs: [{ name: 'cleared bởi removeAutoData', type: 'affected', description: '' }],
      outputs: [{ name: 'realtime_mapSymbolStatistic', type: 'Redis', description: '' }],
      details:
        'Aggregate theo giá bị xoá. Ngày mới bắt đầu bucket giá rỗng.',
    },
    {
      id: 'obj-bo',
      kind: 'logic',
      layer: 'Object',
      title: 'BidOffer lists + OddLot',
      subtitle: 'Clear 00:55 + reset 01:35',
      position: { x: COL * 2, y: ROW * 1.5 },
      inputs: [{ name: 'cleared / reset partial', type: 'affected', description: '' }],
      outputs: [{ name: 'realtime_listBidOffer_* / realtime_listBidOfferOddLot_*', type: 'Redis', description: '' }],
      details:
        'List bị xoá 00:55. refreshSymbolInfo 01:35 reset thêm bidOfferList trong SymbolInfo và oddlotBidOfferList trong SymbolInfoOddLot.',
    },
    {
      id: 'obj-deal',
      kind: 'logic',
      layer: 'Object',
      title: 'DealNotice / Advertised',
      subtitle: 'Cleared 00:55',
      position: { x: COL * 2, y: ROW * 2 },
      inputs: [{ name: 'cleared bởi removeAutoData', type: 'affected', description: '' }],
      outputs: [{ name: 'realtime_listDealNotice_* / realtime_listAdvertised_*', type: 'Redis', description: '' }],
      details:
        'List bị xoá. Data đã được persist sang c_deal_notice / c_advertise ở các lần saveRedisToDatabase trước đó — lịch sử vẫn truy được.',
    },
    {
      id: 'obj-info',
      kind: 'logic',
      layer: 'Object',
      title: 'SymbolInfo (partial reset)',
      subtitle: 'refreshSymbolInfo KHÔNG xoá map',
      position: { x: COL * 2, y: ROW * 2.5 },
      inputs: [{ name: 'reset fields intraday', type: 'affected', description: '' }],
      outputs: [{ name: 'giữ lại snapshot map', type: 'preserve', description: '' }],
      details:
        'Là object ĐẶC BIỆT — KHÔNG bị xoá map hoàn toàn. Chỉ reset:\n' +
        '  • sequence, bidAskSequence\n' +
        '  • matchingVolume, matchedBy\n' +
        '  • bidOfferList (top book)\n\n' +
        'Giữ lại: code, name, type, referencePrice, ceiling, floor, listedQty, foreigner baseline... (không cần load lại từ REST mỗi ngày).',
    },
    {
      id: 'obj-daily',
      kind: 'logic',
      layer: 'Object',
      title: 'SymbolDaily',
      subtitle: 'Cleared 22:50 (cron riêng)',
      position: { x: COL * 2, y: ROW * 3.2 },
      inputs: [{ name: 'cleared bởi clearOldSymbolDaily', type: 'affected', description: '' }],
      outputs: [{ name: 'realtime_mapSymbolDaily', type: 'Redis', description: '' }],
      details:
        'Clear 22:50 vì Daily được persist cả ngày, đến tối không cần giữ Redis. Mongo c_symbol_daily có đầy đủ.',
    },
    {
      id: 'obj-persist',
      kind: 'logic',
      layer: 'Object',
      title: 'Persistable objects',
      subtitle: 'Snapshot 6×/day',
      position: { x: COL * 2, y: ROW * 3.9 },
      inputs: [{ name: 'snapshot bởi saveRedisToDatabase', type: 'affected', description: '' }],
      outputs: [
        { name: 'SymbolInfo · SymbolInfoOddLot · SymbolDaily · ForeignerDaily · MarketStatus · DealNotice · Advertised · SymbolPrevious', type: 'Mongo', description: '' },
      ],
      details:
        '8 object được snapshot định kỳ sang Mongo để có đủ lịch sử truy vấn. Không có quote tick / minute bar / bidOffer history do runtime flags OFF.',
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
