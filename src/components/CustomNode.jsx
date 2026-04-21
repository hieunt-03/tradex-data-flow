import React, { memo } from 'react';
import { Handle, Position } from '@xyflow/react';

const KIND_META = {
  source:   { icon: '📡', label: 'NGUỒN',     color: '#38bdf8' },
  service:  { icon: '⚙️', label: 'SERVICE',    color: '#a78bfa' },
  kafka:    { icon: '📨', label: 'KAFKA',      color: '#f59e0b' },
  redis:    { icon: '🟥', label: 'REDIS',      color: '#ef4444' },
  mongo:    { icon: '🟢', label: 'MONGODB',    color: '#22c55e' },
  api:      { icon: '🔌', label: 'API',        color: '#0ea5e9' },
  ws:       { icon: '📺', label: 'WS GATEWAY', color: '#f97316' },
  client:   { icon: '📱', label: 'CLIENT',     color: '#ec4899' },
  schedule: { icon: '⏰', label: 'CRON',       color: '#eab308' },
  config:   { icon: '🧩', label: 'CONFIG',     color: '#94a3b8' },
  logic:    { icon: '🧠', label: 'LOGIC',      color: '#10b981' },
};

function CustomNodeImpl({ data, selected }) {
  const meta = KIND_META[data.kind] || KIND_META.logic;
  const inCount = data.inputs?.length || 0;
  const outCount = data.outputs?.length || 0;
  return (
    <div
      className={`tx-node tx-node--${data.kind} ${selected ? 'tx-node--selected' : ''}`}
      style={{ '--accent': meta.color }}
    >
      <Handle type="target" position={Position.Left} className="tx-handle" />
      <div className="tx-node__head">
        <span className="tx-node__icon">{meta.icon}</span>
        <span className="tx-node__kind">{meta.label}</span>
        {data.layer && <span className="tx-node__layer">{data.layer}</span>}
      </div>
      <div className="tx-node__title" title={data.title}>{data.title}</div>
      {data.subtitle && <div className="tx-node__subtitle">{data.subtitle}</div>}
      <div className="tx-node__io">
        <span title="inputs">▼ in: {inCount}</span>
        <span title="outputs">out: {outCount} ▲</span>
      </div>
      <Handle type="source" position={Position.Right} className="tx-handle" />
    </div>
  );
}

export default memo(CustomNodeImpl);
