// Cytoscape graph for the C2 implant + tunnel topology.
// Reusable between the dedicated page and the dashboard widget.

import { useEffect, useMemo, useRef, useCallback } from 'react'
import cytoscape from 'cytoscape'
import type { Core, ElementDefinition } from 'cytoscape'
import {
  PROVIDER_COLORS,
  CLASSIFICATION_COLORS,
  tunnelEdgeLabel,
} from '../../lib/c2Topology'
import type { ImplantSession, Tunnel, TunnelStatus } from '../../lib/c2Topology'

const POSITION_STORAGE_PREFIX = 'ems_topo_positions_'

interface TunnelGraphProps {
  sessions: ImplantSession[]
  tunnels: Tunnel[]
  operationId?: string
  selectedNodeId?: string | null
  selectedEdgeId?: string | null
  onSelectNode?: (sessionId: string | null) => void
  onSelectEdge?: (tunnelId: string | null) => void
  onCytoscapeReady?: (cy: Core) => void
  // Display modes — widget uses compact, page uses full
  variant?: 'page' | 'widget'
  // Hide closed tunnels from the canvas — useful when the user wants to see
  // only what's currently active. Default: shown but obviously historical.
  showClosed?: boolean
}

function osIconDataUri(os: string, accent: string): string {
  const o = (os || '').toLowerCase()
  let glyph = ''
  if (o.includes('windows') || o.includes('win')) {
    // Windows-ish 4-pane glyph
    glyph = '<rect x="14" y="14" width="14" height="14" fill="' + accent + '"/><rect x="32" y="14" width="14" height="14" fill="' + accent + '"/><rect x="14" y="32" width="14" height="14" fill="' + accent + '"/><rect x="32" y="32" width="14" height="14" fill="' + accent + '"/>'
  } else if (o.includes('darwin') || o.includes('mac')) {
    // Apple-ish silhouette
    glyph = '<path d="M30 14 c-4 0-7 2-9 5 c-1-3-4-5-8-5 c-5 0-9 4-9 11 c0 9 6 17 9 17 c2 0 4-1 6-1 c2 0 4 1 6 1 c4 0 9-9 9-17 c0-7-4-11-4-11 z" fill="' + accent + '" transform="translate(5,5)"/>'
  } else {
    // Linux/penguin abstract
    glyph = '<circle cx="30" cy="22" r="9" fill="' + accent + '"/><rect x="20" y="28" width="20" height="18" rx="6" fill="' + accent + '"/>'
  }
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 60 60'>${glyph}</svg>`
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg)
}

function ghostHostIcon(): string {
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 60 60'>` +
    `<rect x='12' y='14' width='36' height='28' rx='4' fill='none' stroke='#5c6b7f' stroke-width='2' stroke-dasharray='3,3'/>` +
    `<line x1='20' y1='44' x2='40' y2='44' stroke='#5c6b7f' stroke-width='2'/>` +
    `<line x1='30' y1='42' x2='30' y2='50' stroke='#5c6b7f' stroke-width='2'/>` +
    `</svg>`
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg)
}

// Per-node classification indicator. UNCLASS gets nothing (returns a
// transparent 1×1 svg, since drawing a meaningless dot just adds visual
// noise to the most common case). CUI/SECRET get a top-edge banner with
// the abbreviation in dark text on the level's signal color. The viewBox
// is wide enough that "SECRET" fits without clipping.
function classificationDot(level: string): string {
  const lvl = (level || '').toUpperCase()
  const c = CLASSIFICATION_COLORS[lvl] || CLASSIFICATION_COLORS.UNCLASSIFIED
  if (lvl === 'CUI') {
    // 50×12 banner, "CUI" centered in 8px Arial bold. Slim band so it
    // doesn't overpower the OS icon on the implant body.
    const svg =
      `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 50 12'>` +
      `<rect x='0.5' y='0.5' width='49' height='11' rx='2.5' ry='2.5' ` +
      `fill='${c}' stroke='#0a0e14' stroke-width='1'/>` +
      `<text x='25' y='9' text-anchor='middle' font-family='Arial,sans-serif' ` +
      `font-weight='800' font-size='8' fill='#0a0e14' letter-spacing='0.5'>CUI</text>` +
      `</svg>`
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg)
  }
  if (lvl === 'SECRET') {
    // 50×12 banner, "SECRET" centered. 7px font + tight letter-spacing
    // to fit the 6 letters in cleanly without the chars touching.
    const svg =
      `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 50 12'>` +
      `<rect x='0.5' y='0.5' width='49' height='11' rx='2.5' ry='2.5' ` +
      `fill='${c}' stroke='#0a0e14' stroke-width='1'/>` +
      `<text x='25' y='9' text-anchor='middle' font-family='Arial,sans-serif' ` +
      `font-weight='800' font-size='7' fill='#0a0e14' letter-spacing='0.5'>SECRET</text>` +
      `</svg>`
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg)
  }
  // UNCLASS — no marking. The absence of a chip *is* the signal.
  // Return a transparent 1×1 so cytoscape doesn't draw anything.
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'></svg>`
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg)
}

// "Severity" rank for picking the worst listener status to color the badge with.
// Higher = more attention-grabbing. error > pending > active > closing > closed.
const LISTENER_STATUS_RANK: Record<TunnelStatus, number> = {
  error: 4,
  pending: 3,
  active: 2,
  closing: 1,
  closed: 0,
}

interface ListenerInfo {
  count: number
  // The first listen_port we encounter — shown in the label.
  primaryPort: number | null
  // Worst-case status across all listeners on this session.
  worstStatus: TunnelStatus | null
  // Mix of "listen" (socks5/dangling) vs "relay" (relay-child with no dst_host).
  primaryKind: 'listen' | 'relay'
}

// Manual L→R rank layout.
//
// We compute each node's rank (column) by depth from a "source" implant,
// then pack rows tightly so the graph stays compact vertically. Pure-source
// implants share a column; their direct ghosts sit one column right; if a
// pivot chain exists the chained implant gets its own column and its ghosts
// the column after that. Within a column we stack nodes with branch-aware
// spacing so a single chain reads as a horizontal sweep, not a vertical wall.
interface LayoutInputs {
  implantIds: string[]
  ghostIds: string[]
  // src_session_id → list of target node ids (other implants or ghosts)
  outgoing: Map<string, string[]>
  // target node id → list of source implant ids that point to it
  incoming: Map<string, string[]>
}

function computeManualPositions(
  inputs: LayoutInputs,
  variant: 'page' | 'widget'
): Record<string, { x: number; y: number }> {
  const { implantIds, ghostIds, outgoing, incoming } = inputs
  const COL_GAP = variant === 'widget' ? 180 : 240
  const ROW_GAP = variant === 'widget' ? 92 : 120
  // Used to nudge sibling rows apart when two ghosts hang off the same
  // implant — small additional spread, NOT a full row.
  const SIB_GAP = variant === 'widget' ? 20 : 30

  const isPivotTarget = new Set<string>()
  for (const iid of implantIds) {
    if ((incoming.get(iid) ?? []).length > 0) isPivotTarget.add(iid)
  }

  // Bucket ghosts by their source implant.
  const ghostsBySource = new Map<string, string[]>()
  for (const gid of ghostIds) {
    const srcs = incoming.get(gid) ?? []
    const src = srcs[0] ?? '__orphan'
    if (!ghostsBySource.has(src)) ghostsBySource.set(src, [])
    ghostsBySource.get(src)!.push(gid)
  }

  const out: Record<string, { x: number; y: number }> = {}

  // Two kinds of branches we lay out:
  //   PIVOT BRANCH: source implant → pivot-target implant → that target's
  //                 ghosts. Spans 3 columns. Always gets its own full row.
  //   SIMPLE BRANCH: source implant → 0+ ghost targets. Spans 2 columns.
  //                  These pack 2-up when there are enough of them, so a
  //                  fleet of 6 simple implants fills the canvas as a 3×2
  //                  grid instead of a 6×1 vertical wall.
  const sourceImplants = implantIds.filter((id) => !isPivotTarget.has(id))
  const pivotSources: string[] = []
  const simpleSources: string[] = []
  for (const iid of sourceImplants) {
    const targets = outgoing.get(iid) ?? []
    if (targets.some((t) => isPivotTarget.has(t))) {
      pivotSources.push(iid)
    } else {
      simpleSources.push(iid)
    }
  }

  // Pack simple branches into 2 column-groups when there are 4+ of them.
  // Each "side" is a vertical stack of 2-column branches (implant + ghost).
  // Side A starts at x=0; Side B starts at x = 2.5 * COL_GAP, leaving a
  // visual gutter between the two halves so they don't read as a single
  // grid where col-1 of side A bleeds into col-0 of side B.
  const TWO_UP = simpleSources.length >= 4
  const SIDE_B_X = TWO_UP ? COL_GAP * 2.6 : 0
  const sideAList = TWO_UP
    ? simpleSources.filter((_, i) => i % 2 === 0)
    : simpleSources
  const sideBList = TWO_UP ? simpleSources.filter((_, i) => i % 2 === 1) : []

  let yA = 0
  let yB = 0
  const layoutSimple = (iid: string, baseX: number, yCursor: number): number => {
    const directGhosts = (ghostsBySource.get(iid) ?? []).slice()
    const ghostCount = Math.max(1, directGhosts.length)
    const branchHeight = (ghostCount - 1) * SIB_GAP
    const implantY = yCursor + branchHeight / 2
    out[iid] = { x: baseX, y: implantY }
    let gy = yCursor
    for (const gid of directGhosts) {
      out[gid] = { x: baseX + COL_GAP, y: gy }
      gy += SIB_GAP
    }
    return yCursor + branchHeight + ROW_GAP
  }
  for (const iid of sideAList) yA = layoutSimple(iid, 0, yA)
  for (const iid of sideBList) yB = layoutSimple(iid, SIDE_B_X, yB)
  let yCursor = Math.max(yA, yB)

  // Pivot branches go below the simple-branch grid, full-width, one per row.
  // We place the pivot row at the LEFT edge (x=0) so the 3-column chain
  // visually anchors against the same alignment as the side-A column.
  for (const iid of pivotSources) {
    const targets = outgoing.get(iid) ?? []
    const pivotChildren = targets.filter((t) => isPivotTarget.has(t))
    const directGhosts = (ghostsBySource.get(iid) ?? []).slice()
    const subRows: Array<{
      childY: number
      ghosts: Array<{ id: string; y: number }>
    }> = []
    let subY = yCursor
    for (const pid of pivotChildren) {
      const childGhosts = ghostsBySource.get(pid) ?? []
      const ghostCount = Math.max(1, childGhosts.length)
      const subHeight = (ghostCount - 1) * SIB_GAP
      const childY = subY + subHeight / 2
      const ghosts: Array<{ id: string; y: number }> = []
      let gy = subY
      for (const gid of childGhosts) {
        ghosts.push({ id: gid, y: gy })
        gy += SIB_GAP
      }
      subRows.push({ childY, ghosts })
      subY += subHeight + ROW_GAP
    }
    const branchTop = yCursor
    const branchBottom = subY - ROW_GAP
    const implantY = (branchTop + branchBottom) / 2
    out[iid] = { x: 0, y: implantY }
    let auxY = branchTop
    for (const gid of directGhosts) {
      out[gid] = { x: COL_GAP, y: auxY }
      auxY += SIB_GAP
    }
    const childOffset = directGhosts.length > 0 ? auxY - branchTop + SIB_GAP : 0
    for (let i = 0; i < pivotChildren.length; i++) {
      const pid = pivotChildren[i]
      const sr = subRows[i]
      out[pid] = { x: COL_GAP, y: sr.childY + childOffset }
      for (const g of sr.ghosts) {
        out[g.id] = { x: COL_GAP * 2, y: g.y + childOffset }
      }
    }
    yCursor = branchBottom + childOffset + ROW_GAP
  }

  // Stragglers.
  for (const iid of implantIds) {
    if (out[iid]) continue
    out[iid] = { x: COL_GAP, y: yCursor }
    yCursor += ROW_GAP
  }
  for (const gid of ghostIds) {
    if (out[gid]) continue
    out[gid] = { x: COL_GAP, y: yCursor }
    yCursor += ROW_GAP
  }
  return out
}

function buildStylesheet(variant: 'page' | 'widget'): cytoscape.StylesheetJsonBlock[] {
  // Larger labels at default zoom — old 11px was illegible after fit-to-view.
  const labelSize = variant === 'widget' ? 10 : 12
  const nodeSize = variant === 'widget' ? 52 : 72
  const ghostSize = variant === 'widget' ? 40 : 56
  return [
    {
      selector: 'node',
      style: {
        shape: 'roundrectangle',
        'background-color': '#0d1117',
        'border-width': 2,
        'border-color': '#3a4a5c',
        label: 'data(label)',
        'font-size': `${labelSize}px`,
        'font-family': 'JetBrains Mono, monospace',
        color: '#c5cdd8',
        'text-valign': 'bottom',
        'text-margin-y': 6,
        'text-wrap': 'wrap',
        // Constrain label width so 3-line listener-bearing labels don't run
        // off and overlap neighbors.
        'text-max-width': `${nodeSize * 2.4}px`,
        // Tighter line-height keeps the multi-line label compact under
        // the node body so it doesn't visually collide with adjacent rows.
        'line-height': 1.15,
        width: nodeSize,
        height: nodeSize,
        'text-outline-width': 3,
        'text-outline-color': '#0a0e14',
      } as unknown as cytoscape.Css.Node,
    },
    // Provider-tinted borders. Sliver moved off pure cyan to avoid
    // melting into the cyan pivot_relay edge accent — a teal-leaning
    // shade keeps it provider-recognizable without colliding.
    { selector: 'node[provider="sliver"]', style: { 'border-color': PROVIDER_COLORS.sliver } },
    { selector: 'node[provider="mythic"]', style: { 'border-color': PROVIDER_COLORS.mythic } },
    { selector: 'node[provider="havoc"]', style: { 'border-color': PROVIDER_COLORS.havoc } },
    { selector: 'node[provider="merlin"]', style: { 'border-color': PROVIDER_COLORS.merlin } },
    // Ghost (external target) hosts — visually distinct: cut-rectangle
    // shape (visible chamfered corners read as "external/unowned" without
    // distorting the icon inside), dashed border, italic label.
    {
      selector: 'node[ghost="true"]',
      style: {
        shape: 'cut-rectangle',
        'border-style': 'dashed',
        'border-width': 2,
        'border-color': '#5d6f8a',
        'background-color': '#0c1320',
        opacity: 0.88,
        width: ghostSize,
        height: ghostSize,
        'font-style': 'italic',
        'font-size': `${labelSize - 1}px`,
        color: '#94a2b6',
      } as unknown as cytoscape.Css.Node,
    },
    // Classified ghosts: shift border color so even though we don't
    // draw a banner inside the diamond (geometry doesn't allow it),
    // the level is still visible at a glance.
    {
      selector: 'node[ghost="true"][classification="CUI"]',
      style: {
        'border-color': CLASSIFICATION_COLORS.CUI,
        color: '#cbb15c',
      } as unknown as cytoscape.Css.Node,
    },
    {
      selector: 'node[ghost="true"][classification="SECRET"]',
      style: {
        'border-color': CLASSIFICATION_COLORS.SECRET,
        color: '#e89191',
      } as unknown as cytoscape.Css.Node,
    },
    // Offline live implants — tombstoned. Distinct from ghost (external)
    // targets: keep the implant rectangle shape (not the ghost hex), but
    // dotted border + harder fade + dimmed label so an offline session
    // doesn't visually collapse into the "external host" class.
    {
      selector: 'node[ghost="false"][alive="false"]',
      style: {
        opacity: 0.42,
        'border-style': 'dotted',
        'border-color': '#5c6b7f',
        color: '#7a8294',
      } as unknown as cytoscape.Css.Node,
    },
    {
      selector: 'node[fresh="true"]',
      style: {
        'border-width': 4,
      },
    },
    // Listener status colors — the third label line ("listen :PORT") inherits
    // the node's text color, but when a listener is in trouble we want the
    // whole label to read with that warning hue. We color the entire node
    // label here based on the worst listener; when there are no listeners the
    // attribute is absent and the default color applies.
    {
      selector: 'node[listenerStatus="error"]',
      style: { color: '#ff6b6b' },
    },
    {
      selector: 'node[listenerStatus="pending"]',
      style: { color: '#fab005' },
    },
    // Selection: bright accent border + slight glow via shadow-style.
    {
      selector: 'node:selected',
      style: {
        'border-color': '#4dabf7',
        'border-width': 4,
      } as unknown as cytoscape.Css.Node,
    },
    // Faded state for un-selected neighbors when ANY node has the .focus-dim
    // class applied (set imperatively when something is selected).
    {
      selector: '.dim',
      style: { opacity: 0.18 } as unknown as cytoscape.Css.Node,
    },
    {
      selector: 'edge.dim',
      style: { opacity: 0.12 } as unknown as cytoscape.Css.Edge,
    },

    // Edges (tunnels). Type is encoded by line-style + arrow shape; we also
    // give portfwd_remote a warm tint so the (rarer) reverse-direction kind
    // pops at a glance. Width and arrow-scale bumped from the previous pass
    // — neutral grey at width 2 was reading as a faint sketch line.
    {
      selector: 'edge',
      style: {
        width: 2.5,
        'line-color': '#9aa9bd',
        'target-arrow-color': '#9aa9bd',
        'target-arrow-shape': 'triangle',
        // Bezier with auto-distribution for parallel edges. Cytoscape will
        // separate two tunnels between the same pair so they don't overlap.
        'curve-style': 'bezier',
        'control-point-step-size': 40,
        'arrow-scale': 1.3,
        opacity: 1,
        label: 'data(label)',
        'font-size': `${labelSize - 1}px`,
        'font-family': 'JetBrains Mono, monospace',
        color: '#cfd6e1',
        // Edge label "chip": rounded, padded, slightly transparent over the
        // canvas radial-gradient so it doesn't look like a black brick.
        'text-background-color': '#0e1622',
        'text-background-opacity': 0.92,
        'text-background-padding': '4px',
        'text-background-shape': 'roundrectangle',
        'text-border-color': '#2a3648',
        'text-border-opacity': 1,
        'text-border-width': 1,
        'text-rotation': 'autorotate',
      } as unknown as cytoscape.Css.Edge,
    },
    // portfwd_local: solid, default arrow. Most common tunnel type — keep
    // it neutral so the rarer types stand out.
    {
      selector: 'edge[tunnelType="portfwd_local"]',
      style: { 'line-style': 'solid', width: 2.5 },
    },
    // portfwd_remote: solid + tee arrow + warm tint. Reads as "remote
    // listener bound on the target" rather than the more common "local
    // forward into the target".
    {
      selector: 'edge[tunnelType="portfwd_remote"]',
      style: {
        'line-style': 'solid',
        width: 2.5,
        'target-arrow-shape': 'tee',
        'line-color': '#fd7e14',
        'target-arrow-color': '#fd7e14',
      },
    },
    // pivot_relay (with a dst_host — chained child): a thicker doubled
    // line in cool teal so a multi-hop pivot reads as the "spine" of the
    // chain. Distinct from the dashed pending state.
    {
      selector: 'edge[tunnelType="pivot_relay"]',
      style: {
        'line-style': 'solid',
        width: 4,
        'line-color': '#14b8a6',
        'target-arrow-color': '#14b8a6',
      },
    },
    // Pending: dashed amber so it reads as "in progress" rather than
    // "broken". pivot_relay is now solid (was dashed before this pass)
    // so dashed-grey-vs-dashed-cyan ambiguity is gone.
    {
      selector: 'edge[status="pending"]',
      style: {
        'line-style': 'dashed',
        'line-color': '#a08555',
        'target-arrow-color': '#a08555',
        opacity: 0.85,
      } as unknown as cytoscape.Css.Edge,
    },
    {
      selector: 'edge[status="error"]',
      style: {
        'line-style': 'dashed',
        'line-color': '#ff6b6b',
        'target-arrow-color': '#ff6b6b',
        width: 2.5,
      },
    },
    { selector: 'edge[status="closing"]', style: { opacity: 0.45 } },
    // Closed: dotted, very faint, smaller arrow, label hidden. Reads as
    // "this used to exist" without screaming for attention. (The page
    // also offers a toggle to hide closed tunnels entirely.)
    {
      selector: 'edge[status="closed"]',
      style: {
        opacity: 0.32,
        'line-style': 'dotted',
        width: 1.5,
        'arrow-scale': 1,
        label: '',
      } as unknown as cytoscape.Css.Edge,
    },
    {
      selector: 'edge:selected',
      style: {
        width: 4.5,
        'line-color': '#4dabf7',
        'target-arrow-color': '#4dabf7',
      },
    },
  ]
}

function loadPositions(operationId?: string): Record<string, { x: number; y: number }> {
  if (!operationId) return {}
  try {
    const raw = localStorage.getItem(POSITION_STORAGE_PREFIX + operationId)
    if (!raw) return {}
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

function savePositions(operationId: string | undefined, cy: Core) {
  if (!operationId) return
  const out: Record<string, { x: number; y: number }> = {}
  cy.nodes().forEach((n) => {
    const p = n.position()
    out[n.id()] = { x: p.x, y: p.y }
  })
  try {
    localStorage.setItem(POSITION_STORAGE_PREFIX + operationId, JSON.stringify(out))
  } catch {
    // Quota — ignore.
  }
}

export default function TunnelGraph({
  sessions,
  tunnels,
  operationId,
  selectedNodeId,
  selectedEdgeId,
  onSelectNode,
  onSelectEdge,
  onCytoscapeReady,
  variant = 'page',
  showClosed = true,
}: TunnelGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const cyRef = useRef<Core | null>(null)
  const layoutLockedRef = useRef(false)

  // Synthesize "ghost" target hosts from tunnel.dst_host that has no implant.
  // Also returns the computed manual layout positions so the cytoscape
  // useEffect can pass them through a `preset` layout.
  const { elements, manualPositions } = useMemo<{
    elements: ElementDefinition[]
    manualPositions: Record<string, { x: number; y: number }>
  }>(() => {
    const els: ElementDefinition[] = []
    const sessionIds = new Set(sessions.map((s) => s.id))
    const positions = loadPositions(operationId)

    // ── Pass 1: classify every tunnel ──────────────────────────────────
    // A tunnel is a "listener" (badge on the source node, NOT an edge) when:
    //   - it has no dst_host AND no parent_tunnel_id (socks5 / dangling), OR
    //   - it has no dst_host AND a parent_tunnel_id (relay child without a
    //     destination — drawing this would self-loop into the source).
    // Otherwise it's a real connection and renders as an edge.
    const tunnelById = new Map(tunnels.map((t) => [t.id, t]))
    const listenersBySession = new Map<string, ListenerInfo>()
    const drawnTunnels: Tunnel[] = []

    for (const t of tunnels) {
      if (!sessionIds.has(t.src_session_id)) continue
      const isListener = !t.dst_host
      if (!isListener) {
        drawnTunnels.push(t)
        continue
      }
      const kind: 'listen' | 'relay' = t.parent_tunnel_id ? 'relay' : 'listen'
      const cur = listenersBySession.get(t.src_session_id)
      if (!cur) {
        listenersBySession.set(t.src_session_id, {
          count: 1,
          primaryPort: t.listen_port ?? null,
          worstStatus: t.status,
          primaryKind: kind,
        })
      } else {
        cur.count += 1
        // Pick the highest-rank status as "worst" for the badge color.
        if (
          cur.worstStatus === null ||
          LISTENER_STATUS_RANK[t.status] > LISTENER_STATUS_RANK[cur.worstStatus]
        ) {
          cur.worstStatus = t.status
        }
        // Keep the first port as the primary; "listen" wins over "relay" for
        // the kind so a session with both reads as a listener.
        if (cur.primaryKind === 'relay' && kind === 'listen') {
          cur.primaryKind = 'listen'
          cur.primaryPort = t.listen_port ?? cur.primaryPort
        }
      }
    }

    // ── Pass 2: build implant nodes ────────────────────────────────────
    for (const s of sessions) {
      const accent = PROVIDER_COLORS[s.provider] || '#5c6b7f'
      const lastCheckin = Date.parse(s.last_checkin) || 0
      const fresh = s.is_alive && Date.now() - lastCheckin < 60_000

      // Build the (optionally three-line) label. Use a unicode bullet
      // separator on the listener line so it visually reads as a chip
      // distinct from the implant_name / hostname pair above. Wrapping
      // the listener in « » brackets gives it a clear edge so a quick
      // glance can tell where the listener spec starts.
      const listener = listenersBySession.get(s.id)
      let label = `${s.implant_name}\n${s.hostname}`
      if (listener) {
        const portText = listener.primaryPort != null ? `:${listener.primaryPort}` : ''
        const verb = listener.primaryKind === 'relay' ? 'relay' : 'listen'
        const extra = listener.count > 1 ? ` +${listener.count - 1}` : ''
        label += `\n‹ ${verb}${portText ? ' ' + portText : ''}${extra} ›`
      }

      // Classification chip: wide banner for CUI/SECRET, nothing for
      // UNCLASS (the absence of a banner *is* the unclass signal). Banner
      // sits flush against the top edge of the implant body. The
      // OS icon shifts down to make room.
      const lvl = (s.classification || '').toUpperCase()
      const classifiedBanner = lvl === 'CUI' || lvl === 'SECRET'
      els.push({
        data: {
          id: s.id,
          label,
          provider: s.provider,
          alive: String(s.is_alive),
          fresh: String(fresh),
          ghost: 'false',
          classification: s.classification,
          kind: 'session',
          // listenerStatus is only present when there's at least one listener.
          ...(listener ? { listenerStatus: listener.worstStatus ?? '' } : {}),
          hasListener: listener ? 'true' : 'false',
        },
        style: {
          'background-image': [osIconDataUri(s.os, accent), classificationDot(s.classification)],
          // OS icon centered + nudged down when a banner is present so the
          // banner doesn't crowd the icon. UNCLASS keeps the icon centered.
          'background-position-x': ['50%', '50%'],
          'background-position-y': [classifiedBanner ? '62%' : '50%', '8%'],
          // Banner: ~80% wide, ~16% tall (matches 50×12 viewBox aspect at
          // node 72px). UNCLASS: 0×0 effectively.
          'background-width': ['56%', classifiedBanner ? '78%' : '0%'],
          'background-height': ['56%', classifiedBanner ? '16%' : '0%'],
          'background-fit': 'contain',
          'background-clip': 'none',
        } as unknown as cytoscape.Css.Node,
        ...(positions[s.id] ? { position: positions[s.id] } : {}),
      })
    }

    // ── Pass 3: build ghost target hosts ──────────────────────────────
    const ghostKey = (host: string) => `ghost:${host}`
    const seenGhosts = new Set<string>()
    // Don't surface a ghost host that's only referenced by a closed
    // tunnel when the user has opted out of seeing closed tunnels.
    const ghostSourceTunnels = showClosed
      ? drawnTunnels
      : drawnTunnels.filter((t) => t.status !== 'closed')
    for (const t of ghostSourceTunnels) {
      if (!t.dst_host) continue
      const hostMatch = sessions.find(
        (s) => s.hostname.toLowerCase() === t.dst_host!.toLowerCase()
      )
      if (hostMatch) continue
      const gid = ghostKey(t.dst_host)
      if (seenGhosts.has(gid)) continue
      seenGhosts.add(gid)
      // Ghosts use the border color (set by classification selector in
      // the stylesheet) for level signaling; no banner image required.
      els.push({
        data: {
          id: gid,
          label: t.dst_host,
          provider: 'ghost',
          alive: 'false',
          fresh: 'false',
          ghost: 'true',
          classification: (t.classification || '').toUpperCase(),
          kind: 'ghost',
        },
        style: {
          'background-image': [ghostHostIcon()],
          'background-position-x': ['50%'],
          'background-position-y': ['50%'],
          'background-width': ['44%'],
          'background-height': ['44%'],
          'background-fit': 'contain',
          'background-clip': 'none',
        } as unknown as cytoscape.Css.Node,
        ...(positions[gid] ? { position: positions[gid] } : {}),
      })
    }

    // ── Pass 4: draw real connection edges only ───────────────────────
    // Track outgoing/incoming as we go so the manual layout can place
    // pivot-target implants in their own column and group ghost targets
    // under their source implant.
    const outgoing = new Map<string, string[]>()
    const incoming = new Map<string, string[]>()
    const ghostIds: string[] = []
    const seenGhostIds = new Set<string>()
    // When showClosed is off, drop closed tunnels from the rendered set so
    // they neither produce edges nor pull ghost target hosts onto the canvas.
    const visibleDrawn = showClosed
      ? drawnTunnels
      : drawnTunnels.filter((t) => t.status !== 'closed')
    for (const t of visibleDrawn) {
      let target: string | null = null
      if (t.dst_host) {
        const hostMatch = sessions.find(
          (s) => s.hostname.toLowerCase() === t.dst_host!.toLowerCase()
        )
        target = hostMatch ? hostMatch.id : ghostKey(t.dst_host)
      }
      // Defense-in-depth: should be unreachable since drawnTunnels only
      // contains tunnels with dst_host, but guard anyway so we never
      // accidentally produce a self-loop edge again.
      if (!target || target === t.src_session_id) continue
      // Use the parent tunnel's type when this is a chained child without
      // its own dst_host... but drawnTunnels filtered those out, so all
      // remaining edges have their own dst_host. tunnel_type stays as-is.
      void tunnelById // kept for future use (parent-typed children)
      if (!outgoing.has(t.src_session_id)) outgoing.set(t.src_session_id, [])
      outgoing.get(t.src_session_id)!.push(target)
      if (!incoming.has(target)) incoming.set(target, [])
      incoming.get(target)!.push(t.src_session_id)
      if (target.startsWith('ghost:') && !seenGhostIds.has(target)) {
        ghostIds.push(target)
        seenGhostIds.add(target)
      }
      els.push({
        data: {
          id: t.id,
          source: t.src_session_id,
          target,
          tunnelType: t.tunnel_type,
          status: t.status,
          provider: t.provider,
          label: tunnelEdgeLabel(t),
          kind: 'tunnel',
        },
      })
    }

    // Compute manual positions for any node that doesn't already have a
    // saved position. Saved positions still win — the user can drag
    // anything around and we'll honor it on the next render.
    const computed = computeManualPositions(
      {
        implantIds: sessions.map((s) => s.id),
        ghostIds,
        outgoing,
        incoming,
      },
      variant
    )
    return { elements: els, manualPositions: computed }
  }, [sessions, tunnels, operationId, variant, showClosed])

  // (Re)build the cytoscape instance whenever element identity changes.
  useEffect(() => {
    if (!containerRef.current) return
    if (cyRef.current) {
      cyRef.current.destroy()
      cyRef.current = null
    }
    if (elements.length === 0) return

    const savedPositions = loadPositions(operationId)
    // Merge saved drag positions on top of the manual computed layout. This
    // means a fresh op renders with our hand-tuned L→R rank layout (always
    // visible hierarchy), but anything the user has dragged stays put.
    const elementsWithPos: ElementDefinition[] = elements.map((el) => {
      if (el.group === 'edges' || !el.data?.id) return el
      const id = el.data.id as string
      const pos = savedPositions[id] ?? manualPositions[id]
      return pos ? { ...el, position: pos } : el
    })

    const cy = cytoscape({
      container: containerRef.current,
      elements: elementsWithPos,
      style: buildStylesheet(variant),
      // Use the preset layout — positions are computed manually in
      // computeManualPositions() to enforce a strict L→R ranking
      // (col 0: source implants, col 1: pivot-target implants,
      // col 2: ghost targets, col 3: far-side ghosts behind a pivot).
      // This avoids breadthfirst's tendency to stack root implants in a
      // single column when most nodes have no incoming edges.
      layout: { name: 'preset', fit: true, padding: 40 } as cytoscape.LayoutOptions,
      minZoom: 0.2,
      maxZoom: 4,
      wheelSensitivity: 0.3,
    })

    cy.on('tap', 'node', (evt) => {
      const id = evt.target.id() as string
      if (id.startsWith('ghost:')) {
        onSelectNode?.(null)
        return
      }
      onSelectNode?.(id)
      onSelectEdge?.(null)
    })
    cy.on('tap', 'edge', (evt) => {
      onSelectEdge?.(evt.target.id() as string)
      onSelectNode?.(null)
    })
    cy.on('tap', (evt) => {
      if (evt.target === cy) {
        onSelectNode?.(null)
        onSelectEdge?.(null)
      }
    })
    cy.on('dragfree', 'node', () => {
      if (!layoutLockedRef.current) {
        savePositions(operationId, cy)
      }
    })

    cyRef.current = cy
    // Expose the cytoscape instance on the container for E2E/dev tooling.
    ;(containerRef.current as HTMLDivElement & { __cy?: Core }).__cy = cy
    onCytoscapeReady?.(cy)

    // ResizeObserver — when the container resizes (especially after the
    // first layout pass when height transitions from 0 → non-zero), tell
    // cytoscape to recompute its viewport and refit the graph. Without
    // this, nodes laid out against a 0-height container stay clustered
    // off-screen even after the container expands.
    let didFitOnFirstResize = false
    const ro = new ResizeObserver(() => {
      const c = cyRef.current
      if (!c) return
      c.resize()
      // Re-fit only the first time we observe a non-zero size, so that a
      // user's manual zoom/pan isn't reset on every viewport change.
      if (!didFitOnFirstResize) {
        const r = containerRef.current?.getBoundingClientRect()
        if (r && r.width > 0 && r.height > 0) {
          c.fit(undefined, 30)
          didFitOnFirstResize = true
        }
      }
    })
    if (containerRef.current) ro.observe(containerRef.current)

    return () => {
      ro.disconnect()
      try {
        cy.stop(true, true)
        cy.removeAllListeners()
      } catch {
        // ignore — cy may already be partially torn down
      }
      cy.destroy()
      cyRef.current = null
    }
    // We intentionally rebuild on the element list and the operation id only.
    // manualPositions tracks 1:1 with `elements` (same useMemo).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elements, manualPositions, operationId, variant, showClosed])

  // Sync external selection to the graph + manage neighborhood-focus dimming.
  // When a node is selected, fade out anything that isn't the selected node,
  // its connected edges, or any node reachable along outgoing edges from
  // the selected node (so a click on the head of a pivot chain highlights
  // the entire chain through the relay implant). When an edge is selected,
  // fade everything except that edge's endpoints. Click-empty restores
  // normal opacity.
  useEffect(() => {
    const cy = cyRef.current
    if (!cy) return
    cy.elements().unselect()
    cy.elements().removeClass('dim')
    if (selectedNodeId) {
      const n = cy.getElementById(selectedNodeId)
      if (n.length) {
        n.select()
        // Outgoing successors (multi-hop) + incoming neighborhood — gives
        // both "what does this implant reach?" and "what reached me?".
        const keep = n
          .successors()
          .union(n.predecessors())
          .union(n.connectedEdges())
          .union(n)
        cy.elements().not(keep).addClass('dim')
      }
    }
    if (selectedEdgeId) {
      const e = cy.getElementById(selectedEdgeId)
      if (e.length) {
        e.select()
        const keep = e.connectedNodes().union(e)
        cy.elements().not(keep).addClass('dim')
      }
    }
  }, [selectedNodeId, selectedEdgeId])

  // Imperative helper exports via callbacks
  const exportPng = useCallback(() => {
    const cy = cyRef.current
    if (!cy) return
    const dataUrl = cy.png({ output: 'base64uri', full: true, scale: 2, bg: '#0a0e14' })
    const a = document.createElement('a')
    a.href = dataUrl
    a.download = `topology-${operationId ?? 'all'}.png`
    a.click()
  }, [operationId])

  // Expose the helper through CSS custom data (consumed by the page toolbar).
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    ;(el as HTMLDivElement & { __cyExportPng?: () => void }).__cyExportPng = exportPng
  }, [exportPng])

  return (
    <div
      ref={containerRef}
      data-tunnel-graph
      style={{
        width: '100%',
        height: '100%',
        minHeight: 0,
        minWidth: 0,
        background:
          'radial-gradient(ellipse at center, #0d1722 0%, #0a0e14 70%)',
      }}
    />
  )
}

// Imperative helpers exposed for the page toolbar
export function tunnelGraphZoom(cy: Core | null, factor: number) {
  if (!cy) return
  cy.zoom({ level: cy.zoom() * factor, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } })
}

export function tunnelGraphFit(cy: Core | null) {
  cy?.fit(undefined, 30)
}

export function tunnelGraphLock(cy: Core | null, locked: boolean) {
  if (!cy) return
  cy.nodes().forEach((n) => {
    if (locked) n.lock()
    else n.unlock()
  })
}

export function tunnelGraphExportPng(cy: Core | null, filename: string) {
  if (!cy) return
  const dataUrl = cy.png({ output: 'base64uri', full: true, scale: 2, bg: '#0a0e14' })
  const a = document.createElement('a')
  a.href = dataUrl
  a.download = filename
  a.click()
}
