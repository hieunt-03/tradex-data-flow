# 08 - TECHNICAL SEQUENCE FLOWS

> Nội dung chi tiết của file này đã được **gộp vào** [06_runtime_market_data_flow_current.md](./06_runtime_market_data_flow_current.md).

## Xem ở đâu trong file 06

- [06_runtime_market_data_flow_current.md](./06_runtime_market_data_flow_current.md)
- Phần `17. TECHNICAL SEQUENCE FLOWS`

## Các sequence đã được chuyển sang file 06

- `downloadSymbol` -> init baseline
- `auto.qt` -> `quoteUpdate` -> Redis/API/ws
- `auto.bo` -> `bidOfferUpdate` -> Redis/API/ws
- `auto.idxqt` -> `quoteUpdate(type=INDEX)`
- `marketStatus`
- `removeAutoData`
- `refreshSymbolInfo`
- `clearOldSymbolDaily`
- `saveRedisToDatabase`
- `querySymbolQuote` / `querySymbolQuoteTick`
- `querySymbolQuoteMinutes` / `queryMinuteChart`
- `ws-v2 publish + snapshot`

## Ghi chú

File này được giữ lại chỉ để tránh vỡ link cũ trong context. Tài liệu canonical hiện tại là file `06`.
