import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { flowCategories } from './data/flows.js';
import FlowDiagram from './components/FlowDiagram.jsx';
import DetailPanel from './components/DetailPanel.jsx';

const LEGEND = [
  { kind: 'source', color: '#0ea5e9', label: 'Source' },
  { kind: 'service', color: '#8b5cf6', label: 'Service' },
  { kind: 'kafka', color: '#f59e0b', label: 'Kafka' },
  { kind: 'redis', color: '#ef4444', label: 'Redis' },
  { kind: 'mongo', color: '#10b981', label: 'MongoDB' },
  { kind: 'api', color: '#06b6d4', label: 'API' },
  { kind: 'ws', color: '#f97316', label: 'WS Gateway' },
  { kind: 'client', color: '#ec4899', label: 'Client' },
  { kind: 'schedule', color: '#eab308', label: 'Cron' },
  { kind: 'config', color: '#64748b', label: 'Config' },
  { kind: 'logic', color: '#14b8a6', label: 'Logic' },
];

export default function App() {
  const [activeCategoryId, setActiveCategoryId] = useState(flowCategories[0].id);
  const activeCategory = useMemo(
    () => flowCategories.find((c) => c.id === activeCategoryId) || flowCategories[0],
    [activeCategoryId]
  );

  const [activeId, setActiveId] = useState(activeCategory.flows[0].id);
  const [selectedNode, setSelectedNode] = useState(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [modeOpen, setModeOpen] = useState(false);
  const modeRef = useRef(null);

  const activeFlow =
    activeCategory.flows.find((f) => f.id === activeId) || activeCategory.flows[0];
  const activeIndex = activeCategory.flows.findIndex((f) => f.id === activeFlow.id);

  const handleSelectFlow = useCallback((id) => {
    setActiveId(id);
    setSelectedNode(null);
  }, []);

  const handleSelectCategory = useCallback((categoryId) => {
    const cat = flowCategories.find((c) => c.id === categoryId);
    if (!cat) return;
    setActiveCategoryId(categoryId);
    setActiveId(cat.flows[0].id);
    setSelectedNode(null);
    setModeOpen(false);
  }, []);

  // Close dropdown on outside click
  useEffect(() => {
    if (!modeOpen) return;
    const handler = (e) => {
      if (modeRef.current && !modeRef.current.contains(e.target)) setModeOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [modeOpen]);

  return (
    <div className={`tx-app ${sidebarCollapsed ? 'tx-app--collapsed' : ''}`}>
      {/* ────────── Sidebar ────────── */}
      <aside className="tx-sidebar">
        <div className="tx-sidebar__brand">
          <div className="tx-sidebar__logo">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 3v18h18" />
              <path d="M7 14l4-4 4 4 5-7" />
            </svg>
          </div>
          {!sidebarCollapsed && (
            <div className="tx-sidebar__brand-text">
              <div className="tx-sidebar__brand-title">TradeX DataFlow</div>
              <div className="tx-sidebar__brand-sub">Market Data Pipeline</div>
            </div>
          )}
          <button
            className="tx-sidebar__toggle"
            onClick={() => setSidebarCollapsed((v) => !v)}
            title={sidebarCollapsed ? 'Mở rộng' : 'Thu gọn'}
            aria-label="toggle sidebar"
          >
            {sidebarCollapsed ? '›' : '‹'}
          </button>
        </div>

        {/* Mode selector — 1 nút dropdown */}
        <div className="tx-mode" ref={modeRef}>
          <button
            className={`tx-mode__btn ${modeOpen ? 'tx-mode__btn--open' : ''}`}
            onClick={() => setModeOpen((v) => !v)}
            title={sidebarCollapsed ? activeCategory.label : undefined}
            aria-haspopup="listbox"
            aria-expanded={modeOpen}
          >
            <span className="tx-mode__icon" aria-hidden>
              {activeCategoryId === 'business' ? (
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 7h16M4 12h16M4 17h10" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="5" cy="6" r="2" />
                  <circle cx="19" cy="6" r="2" />
                  <circle cx="12" cy="18" r="2" />
                  <path d="M5 8v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8M12 13v3" />
                </svg>
              )}
            </span>
            {!sidebarCollapsed && (
              <>
                <span className="tx-mode__label">
                  <span className="tx-mode__label-hint">Mode</span>
                  <span className="tx-mode__label-main">{activeCategory.label}</span>
                </span>
                <span className="tx-mode__count">{activeCategory.flows.length}</span>
                <span className={`tx-mode__chev ${modeOpen ? 'tx-mode__chev--open' : ''}`} aria-hidden>
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </span>
              </>
            )}
          </button>

          {modeOpen && (
            <ul className="tx-mode__menu" role="listbox">
              {flowCategories.map((c) => {
                const isActive = c.id === activeCategoryId;
                return (
                  <li key={c.id}>
                    <button
                      role="option"
                      aria-selected={isActive}
                      className={`tx-mode__item ${isActive ? 'tx-mode__item--active' : ''}`}
                      onClick={() => handleSelectCategory(c.id)}
                    >
                      <span className="tx-mode__item-main">
                        <span className="tx-mode__item-label">{c.label}</span>
                        <span className="tx-mode__item-hint">{c.description}</span>
                      </span>
                      <span className="tx-mode__item-count">{c.flows.length}</span>
                      {isActive && (
                        <span className="tx-mode__item-check" aria-hidden>
                          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <nav className="tx-tabs">
          {activeCategory.flows.map((f, i) => {
            const isActive = activeId === f.id;
            return (
              <button
                key={f.id}
                className={`tx-tab ${isActive ? 'tx-tab--active' : ''}`}
                style={{ '--accent': f.accent }}
                onClick={() => handleSelectFlow(f.id)}
                title={f.title}
              >
                <span className="tx-tab__num">{String(i).padStart(2, '0')}</span>
                {!sidebarCollapsed && (
                  <span className="tx-tab__body">
                    <span className="tx-tab__title">{shortTitle(f.title)}</span>
                    <span className="tx-tab__meta">
                      {f.nodes.length} nodes · {f.edges.length} edges
                    </span>
                  </span>
                )}
                {isActive && <span className="tx-tab__indicator" />}
              </button>
            );
          })}
        </nav>

        {!sidebarCollapsed && (
          <div className="tx-sidebar__legend">
            <div className="tx-sidebar__section-label">Node types</div>
            <div className="tx-sidebar__legend-list">
              {LEGEND.map((l) => (
                <span key={l.kind} className="tx-legend-chip">
                  <i className="dot" style={{ background: l.color }} />
                  {l.label}
                </span>
              ))}
            </div>
          </div>
        )}
      </aside>

      {/* ────────── Main area ────────── */}
      <div className="tx-content">
        <header className="tx-header">
          <div className="tx-header__left">
            <span className="tx-header__crumb">
              {activeCategory.label} · Diagram {String(activeIndex).padStart(2, '0')}
            </span>
            <h1 className="tx-header__title">{activeFlow.title}</h1>
            <p className="tx-header__subtitle">{activeFlow.subtitle}</p>
          </div>
          <div className="tx-header__right">
            <span className="tx-stat">
              <span className="tx-stat__num">{activeFlow.nodes.length}</span>
              <span className="tx-stat__label">nodes</span>
            </span>
            <span className="tx-stat">
              <span className="tx-stat__num">{activeFlow.edges.length}</span>
              <span className="tx-stat__label">edges</span>
            </span>
            <span className="tx-header__hint">
              Cuộn để zoom · Kéo để pan · Click node để xem chi tiết
            </span>
          </div>
        </header>

        <main className="tx-main">
          <div className="tx-canvas">
            <ReactFlowProvider key={activeFlow.id}>
              <FlowDiagram
                flow={activeFlow}
                accent={activeFlow.accent}
                onNodeClick={setSelectedNode}
              />
            </ReactFlowProvider>
          </div>
          <DetailPanel
            node={selectedNode}
            accent={activeFlow.accent}
            onClose={() => setSelectedNode(null)}
          />
        </main>
      </div>
    </div>
  );
}

function shortTitle(t) {
  const head = t.split('—')[0].trim();
  return head
    .split(' ')
    .map((w) => (w.length > 2 ? w[0] + w.slice(1).toLowerCase() : w))
    .join(' ');
}
