// Ambient module declaration for lucide-react.
//
// The published lucide-react@0.424.0 package declares
// `typings: dist/lucide-react.d.ts` in its package.json but does not
// actually ship that file in the tarball, so TypeScript falls back to
// an implicit-any error. The TS diagnostic itself recommends adding
// this declaration. We enumerate every icon imported anywhere in the
// codebase plus the public `LucideIcon` / `LucideProps` types.

declare module 'lucide-react' {
  import type { SVGProps, ForwardRefExoticComponent, RefAttributes } from 'react'

  export interface LucideProps extends Omit<SVGProps<SVGSVGElement>, 'ref'> {
    size?: string | number
    absoluteStrokeWidth?: boolean
  }

  export type LucideIcon = ForwardRefExoticComponent<
    LucideProps & RefAttributes<SVGSVGElement>
  >

  export const Activity: LucideIcon
  export const AlertCircle: LucideIcon
  export const AlertTriangle: LucideIcon
  export const ArrowDownLeft: LucideIcon
  export const ArrowLeft: LucideIcon
  export const ArrowRight: LucideIcon
  export const ArrowRightLeft: LucideIcon
  export const ArrowUpRight: LucideIcon
  export const Bell: LucideIcon
  export const BookOpen: LucideIcon
  export const Cable: LucideIcon
  export const Calendar: LucideIcon
  export const Camera: LucideIcon
  export const Check: LucideIcon
  export const CheckCircle: LucideIcon
  export const CheckSquare: LucideIcon
  export const ChevronDown: LucideIcon
  export const ChevronLeft: LucideIcon
  export const ChevronRight: LucideIcon
  export const ChevronUp: LucideIcon
  export const Circle: LucideIcon
  export const Clock: LucideIcon
  export const Command: LucideIcon
  export const Copy: LucideIcon
  export const CornerDownLeft: LucideIcon
  export const Cpu: LucideIcon
  export const Crosshair: LucideIcon
  export const Database: LucideIcon
  export const ExternalLink: LucideIcon
  export const Eye: LucideIcon
  export const FileCode: LucideIcon
  export const FileJson: LucideIcon
  export const FileSearch: LucideIcon
  export const FileSpreadsheet: LucideIcon
  export const FileText: LucideIcon
  export const Filter: LucideIcon
  export const GanttChart: LucideIcon
  export const GitBranch: LucideIcon
  export const GitCommitHorizontal: LucideIcon
  export const Grid3X3: LucideIcon
  export const GripVertical: LucideIcon
  export const HardDrive: LucideIcon
  export const History: LucideIcon
  export const ImageDown: LucideIcon
  export const Info: LucideIcon
  export const Laptop: LucideIcon
  export const Layers: LucideIcon
  export const LayoutDashboard: LucideIcon
  export const ListTodo: LucideIcon
  export const Loader: LucideIcon
  export const Lock: LucideIcon
  export const LogOut: LucideIcon
  export const Maximize2: LucideIcon
  export const MessageSquare: LucideIcon
  export const Minimize2: LucideIcon
  export const Minus: LucideIcon
  export const Monitor: LucideIcon
  export const Network: LucideIcon
  export const Pencil: LucideIcon
  export const Play: LucideIcon
  export const Plus: LucideIcon
  export const Puzzle: LucideIcon
  export const Radio: LucideIcon
  export const RefreshCw: LucideIcon
  export const RotateCcw: LucideIcon
  export const Save: LucideIcon
  export const ScrollText: LucideIcon
  export const Search: LucideIcon
  export const Server: LucideIcon
  export const Settings: LucideIcon
  export const Share: LucideIcon
  export const Share2: LucideIcon
  export const Shield: LucideIcon
  export const ShieldAlert: LucideIcon
  export const ShieldCheck: LucideIcon
  export const Skull: LucideIcon
  export const Smartphone: LucideIcon
  export const Square: LucideIcon
  export const Star: LucideIcon
  export const StickyNote: LucideIcon
  export const Terminal: LucideIcon
  export const Ticket: LucideIcon
  export const ToggleLeft: LucideIcon
  export const ToggleRight: LucideIcon
  export const Trash: LucideIcon
  export const Trash2: LucideIcon
  export const Unlock: LucideIcon
  export const Upload: LucideIcon
  export const User: LucideIcon
  export const Users: LucideIcon
  export const Wifi: LucideIcon
  export const WifiOff: LucideIcon
  export const Workflow: LucideIcon
  export const X: LucideIcon
  export const XCircle: LucideIcon
  export const Zap: LucideIcon
  export const ZoomIn: LucideIcon
  export const ZoomOut: LucideIcon

  // Permit `import * as Icons from 'lucide-react'` access to any name.
  const allIcons: { [name: string]: LucideIcon }
  export default allIcons
}
