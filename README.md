# TradeX Market Data — Interactive Data Flow

Interactive React (.jsx) visualization của toàn bộ pipeline market-data TradeX:
**Lotte WS / REST → Collector-Lotte → Kafka → Realtime-V2 → Redis / MongoDB → Query-V2 (REST) & ws-v2 (SocketCluster) → Client**.

Built với [React 18](https://react.dev/) + [Vite](https://vite.dev/) + [@xyflow/react](https://reactflow.dev/) (React Flow).

## Tính năng

- **1 sơ đồ tổng quan + 6 sơ đồ luồng chi tiết** — chuyển bằng tab phía trên:
  1. Quote Flow — Giá khớp lệnh (Stock/Index/Futures/CW)
  2. BidOffer Flow — Sổ lệnh 3 bước giá + OddLot
  3. Index & Status Flow — Chỉ số, trạng thái phiên, Thỏa thuận PT
  4. Extra Update Flow — basis / breakEven / PT / High-Low Year / Foreigner
  5. Query-V2 API Flow — Comprehensive REST endpoint reference
  6. WebSocket Delivery Flow — ws-v2 SocketCluster Gateway
- **Zoom / Pan / Drag node** (có sẵn của React Flow).
- **Click 1 node** để mở **Detail Panel** bên phải:
  - Layer
  - **Input** (tên, kiểu, mô tả)
  - **Output** (tên, kiểu, mô tả)
  - Logic chi tiết (snippet pseudo-code)
- **MiniMap** + **Controls** (fit / +/-) ở góc dưới.
- Dark trading-style UI, color-coded theo "kind" (source / service / kafka / redis / mongo / api / ws / client / logic / config).

## Cài đặt & Chạy

```bash
cd DataFlow
npm install
npm run dev
# → http://localhost:5173
```

Build production:

```bash
npm run build
npm run preview
```

## Cấu trúc

```
DataFlow/
├── index.html
├── package.json
├── vite.config.js
├── README.md
└── src/
    ├── main.jsx
    ├── App.jsx                 # navigation + layout chính
    ├── index.css               # dark theme + react-flow overrides
    ├── components/
    │   ├── FlowDiagram.jsx     # ReactFlow wrapper, edges/nodes/minimap
    │   ├── CustomNode.jsx      # custom node renderer (color-coded by kind)
    │   └── DetailPanel.jsx     # side panel hiển thị I/O + details
    └── data/
        └── flows.js            # ⭐ tất cả 7 sơ đồ + nodes + edges + I/O
```

## Bổ sung / chỉnh sửa flow

Mở `src/data/flows.js` — mỗi flow là object:

```js
{
  id: 'flow-id',
  title: '...',
  subtitle: '...',
  accent: '#hex',
  nodes: [
    {
      id: 'node-id',
      kind: 'source' | 'service' | 'kafka' | 'redis' | 'mongo' |
            'api'    | 'ws'      | 'client' | 'schedule' |
            'config' | 'logic',
      layer: 'Tên layer (chip xếp dọc)',
      title: '...',
      subtitle: '...',
      position: { x: 0, y: 0 },        // toạ độ trên canvas
      inputs:  [{ name, type, description }],
      outputs: [{ name, type, description }],
      details: 'Multiline pseudo-code / mô tả',
    },
  ],
  edges: [
    { source, target, label?, animated? },
  ],
}
```

Sau khi thêm 1 node mới, đặt `position` thủ công để layout đẹp (canvas hỗ trợ kéo node, có thể chỉnh tay rồi copy lại tọa độ về data file).

## Nguồn dữ liệu

Toàn bộ semantics được dịch trực tiếp từ 7 file context (`/context/01..08*.md`) — code-backed specification. Các flag runtime (`enableSaveQuote=false`, `enableSocketCluster=false`, …) đã được note rõ trong Detail Panel của các node liên quan.
