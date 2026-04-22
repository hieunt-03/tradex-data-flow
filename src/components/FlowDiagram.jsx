import React, { useMemo, useCallback, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MarkerType,
} from '@xyflow/react';
import CustomNode from './CustomNode.jsx';

const nodeTypes = { custom: CustomNode };

// Each kind has a color — edges are tinted by the source node's kind
// to make them easier to tell apart: edges from Kafka are orange, from Redis are red, etc.
const KIND_COLOR = {
  source:   '#0ea5e9',
  service:  '#8b5cf6',
  kafka:    '#f59e0b',
  redis:    '#ef4444',
  mongo:    '#10b981',
  mysql:    '#4f46e5',
  api:      '#06b6d4',
  ws:       '#f97316',
  client:   '#ec4899',
  schedule: '#eab308',
  config:   '#64748b',
  logic:    '#14b8a6',
};

function buildLayerGroups(nodes) {
  const map = new Map();
  for (const n of nodes) {
    if (!n.layer) continue;
    if (!map.has(n.layer)) map.set(n.layer, []);
    map.get(n.layer).push(n);
  }
  return [...map.keys()].map((layer) => ({ layer }));
}

export default function FlowDiagram({ flow, onNodeClick, accent }) {
  const [hoverId, setHoverId] = useState(null);
  const [selectedId, setSelectedId] = useState(null);

  // Map nodeId → kind so we know the edge color
  const kindByNode = useMemo(() => {
    const m = {};
    for (const n of flow.nodes) m[n.id] = n.kind;
    return m;
  }, [flow]);

  // Set of ids related to the hovered/selected node — used for highlighting
  const focusId = hoverId || selectedId;
  const relatedEdgeIds = useMemo(() => {
    if (!focusId) return null;
    const set = new Set();
    flow.edges.forEach((e, i) => {
      if (e.source === focusId || e.target === focusId) {
        set.add(`${e.source}__${e.target}__${i}`);
      }
    });
    return set;
  }, [focusId, flow]);

  const relatedNodeIds = useMemo(() => {
    if (!focusId) return null;
    const set = new Set([focusId]);
    flow.edges.forEach((e) => {
      if (e.source === focusId) set.add(e.target);
      if (e.target === focusId) set.add(e.source);
    });
    return set;
  }, [focusId, flow]);

  const rfNodes = useMemo(
    () =>
      flow.nodes.map((n) => {
        const dimmed = relatedNodeIds && !relatedNodeIds.has(n.id);
        return {
          id: n.id,
          type: 'custom',
          position: n.position,
          data: n,
          style: dimmed ? { opacity: 0.28 } : undefined,
        };
      }),
    [flow, relatedNodeIds]
  );

  const rfEdges = useMemo(
    () =>
      flow.edges.map((e, i) => {
        const id = `${e.source}__${e.target}__${i}`;
        const sourceKind = kindByNode[e.source] || 'logic';
        const color = KIND_COLOR[sourceKind] || accent;
        const isRelated = !relatedEdgeIds || relatedEdgeIds.has(id);
        const isFocused = relatedEdgeIds && relatedEdgeIds.has(id);

        const baseOpacity = !relatedEdgeIds ? 0.85 : isRelated ? 1 : 0.1;
        const baseWidth = isFocused ? 2.6 : 1.6;

        return {
          id,
          source: e.source,
          target: e.target,
          label: e.label,
          animated: !!e.animated,
          type: 'smoothstep',
          pathOptions: { borderRadius: 14, offset: 28 },
          zIndex: isFocused ? 1000 : 0,
          style: {
            stroke: color,
            strokeWidth: baseWidth,
            opacity: baseOpacity,
          },
          labelBgStyle: {
            fill: '#ffffff',
            fillOpacity: isRelated ? 0.98 : 0.5,
            stroke: color,
            strokeWidth: 1,
          },
          labelStyle: {
            fill: isRelated ? '#0f172a' : '#94a3b8',
            fontSize: 11,
            fontWeight: 600,
            fontFamily: 'ui-monospace, monospace',
          },
          labelBgPadding: [6, 3],
          labelBgBorderRadius: 6,
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color,
            width: 18,
            height: 18,
          },
          // class so CSS can animate dasharray when needed
          className: isFocused ? 'tx-edge tx-edge--focus' : 'tx-edge',
        };
      }),
    [flow, kindByNode, relatedEdgeIds, accent]
  );

  const layerGroups = useMemo(() => buildLayerGroups(flow.nodes), [flow]);

  const handleNodeClick = useCallback(
    (_, node) => {
      setSelectedId((prev) => (prev === node.id ? null : node.id));
      onNodeClick?.(node.data);
    },
    [onNodeClick]
  );

  const handleNodeMouseEnter = useCallback((_, node) => setHoverId(node.id), []);
  const handleNodeMouseLeave = useCallback(() => setHoverId(null), []);
  const handleEdgeMouseEnter = useCallback(
    (_, edge) => setHoverId(edge.source),
    []
  );
  const handleEdgeMouseLeave = useCallback(() => setHoverId(null), []);
  const handlePaneClick = useCallback(() => setSelectedId(null), []);

  return (
    <div className="tx-diagram-wrap">
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        onNodeClick={handleNodeClick}
        onNodeMouseEnter={handleNodeMouseEnter}
        onNodeMouseLeave={handleNodeMouseLeave}
        onEdgeMouseEnter={handleEdgeMouseEnter}
        onEdgeMouseLeave={handleEdgeMouseLeave}
        onPaneClick={handlePaneClick}
        fitView
        fitViewOptions={{ padding: 0.12, maxZoom: 1 }}
        minZoom={0.1}
        maxZoom={2.5}
        defaultEdgeOptions={{ type: 'smoothstep' }}
        proOptions={{ hideAttribution: true }}
        nodesDraggable
        nodesConnectable={false}
        elementsSelectable
      >
        <Background gap={24} size={1.2} color="#cbd5e1" />
        <Controls className="tx-controls" />
      </ReactFlow>
      <div className="tx-layer-legend">
        {layerGroups.map((g) => (
          <div key={g.layer} className="tx-layer-chip" style={{ borderColor: accent }}>
            {g.layer}
          </div>
        ))}
      </div>
      <div className="tx-edge-hint">
        Hover a node or edge to highlight · click a node to pin · click the background to unpin
      </div>
    </div>
  );
}
