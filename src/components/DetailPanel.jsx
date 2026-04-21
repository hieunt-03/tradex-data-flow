import React from 'react';

const KIND_LABEL = {
  source: 'Nguồn dữ liệu', service: 'Service', kafka: 'Kafka topic',
  redis: 'Redis storage', mongo: 'MongoDB storage', api: 'REST/RPC API',
  ws: 'WebSocket Gateway', client: 'Client', schedule: 'Cron job',
  config: 'Config / Flag', logic: 'Business logic',
};

function IOSection({ label, items, fallbackText }) {
  if (!items?.length) {
    return (
      <div className="tx-io">
        <div className="tx-io__label">{label}</div>
        <div className="tx-io__empty">{fallbackText}</div>
      </div>
    );
  }
  return (
    <div className="tx-io">
      <div className="tx-io__label">{label} ({items.length})</div>
      <ul className="tx-io__list">
        {items.map((it, i) => (
          <li key={i} className="tx-io__item">
            <div className="tx-io__name">
              {it.name}
              {it.type && <span className="tx-io__type">{it.type}</span>}
            </div>
            {it.description && <div className="tx-io__desc">{it.description}</div>}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function DetailPanel({ node, accent, onClose }) {
  if (!node) {
    return (
      <aside className="tx-panel tx-panel--empty">
        <div className="tx-panel__hint">
          <div className="tx-panel__hint-icon">🖱️</div>
          <div className="tx-panel__hint-title">Click vào 1 node bất kỳ</div>
          <div className="tx-panel__hint-sub">
            để xem chi tiết Input / Output / Logic của từng layer.
          </div>
          <ul className="tx-panel__tips">
            <li>🔍 Cuộn để zoom in/out</li>
            <li>🤚 Kéo nền để pan</li>
            <li>🔄 Kéo node để sắp xếp lại</li>
            <li>🎛️ Dùng Controls để fit/center</li>
          </ul>
        </div>
      </aside>
    );
  }
  return (
    <aside className="tx-panel" style={{ '--accent': accent }}>
      <header className="tx-panel__head">
        <div className="tx-panel__kind">{KIND_LABEL[node.kind] || node.kind}</div>
        <button className="tx-panel__close" onClick={onClose} aria-label="Close">×</button>
      </header>
      <div className="tx-panel__scroll">
        <h2 className="tx-panel__title">{node.title}</h2>
        {node.subtitle && <div className="tx-panel__subtitle">{node.subtitle}</div>}
        {node.layer && <div className="tx-panel__layer">📍 Layer: <b>{node.layer}</b></div>}

        <IOSection label="🔽 INPUT" items={node.inputs} fallbackText="(không có input)" />
        <IOSection label="🔼 OUTPUT" items={node.outputs} fallbackText="(không có output)" />

        {node.details && (
          <div className="tx-panel__details">
            <div className="tx-panel__details-label">📝 Chi tiết logic</div>
            <pre className="tx-panel__details-body">{node.details}</pre>
          </div>
        )}
      </div>
    </aside>
  );
}
