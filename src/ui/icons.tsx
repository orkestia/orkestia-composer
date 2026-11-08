// The editor's icons: simple monoline glyphs on a 24×24 grid in the current
// text colour. A host replaces any of them with its own set through the
// `icons` prop: `{ Search: MySearchIcon }`.
import { createContext, useContext, type ComponentType, type CSSProperties, type ReactNode, type SVGProps } from 'react'

export type IconSize = 'xs' | 'sm' | 'md' | 'lg' | number
const PX: Record<Exclude<IconSize, number>, number> = { xs: 12, sm: 14, md: 16, lg: 20 }

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'ref' | 'children' | 'width' | 'height' | 'viewBox'> {
  /** xs 12 · sm 14 · md 16 (default) · lg 20, or pixels. */
  size?: IconSize
  /** Selected/active state. */
  accent?: boolean
  /** Names the icon for assistive tech; without it (or an aria-label) the icon is decorative. */
  title?: string
  className?: string
  style?: CSSProperties
}

const PATHS = {
  AlertCircle: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM12 8v5M12 16v.5',
  ArrowLeft: 'M19 12H5M11 6l-6 6l6 6',
  ArrowRight: 'M5 12h14M13 6l6 6l-6 6',
  Braces: 'M9 4H8a2 2 0 0 0-2 2v3l-2 3l2 3v3a2 2 0 0 0 2 2h1M15 4h1a2 2 0 0 1 2 2v3l2 3l-2 3v3a2 2 0 0 1-2 2h-1',
  Branch: 'M7 4v16M7 12h4a6 6 0 0 0 6-6V4M17 20v-4',
  Check: 'M5 12l5 5l9-10',
  ChevronDown: 'M6 9l6 6l6-6',
  ChevronRight: 'M9 6l6 6l-6 6',
  ChevronsUpDown: 'M8 9l4-4l4 4M8 15l4 4l4-4',
  Clock: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM12 7v5l3 2',
  Code: 'M8 7l-5 5l5 5M16 7l5 5l-5 5',
  Copy: 'M8 8h11v11H8zM5 16V5h11',
  Database: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3s-3.6 3-8 3s-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  Done: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM8 12l3 3l5-6',
  Enter: 'M20 5v7a3 3 0 0 1-3 3H5M9 11l-4 4l4 4',
  Failed: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM9 9l6 6M15 9l-6 6',
  Filter: 'M4 5h16l-6 8v6l-4-2v-4z',
  Globe: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18',
  History: 'M4 12a8 8 0 1 0 2.3-5.6M4 4v4h4M12 8v4l3 2',
  ListOrdered: 'M10 6h10M10 12h10M10 18h10M5 4v4M4 12h2l-2 2h2M4 17h2l-1 1l1 1H4',
  Lock: 'M6 11h12v9H6zM8 11V8a4 4 0 0 1 8 0v3',
  Mail: 'M3 6h18v12H3zM3 7l9 6l9-6',
  Message: 'M4 5h16v11H9l-5 4z',
  MessageText: 'M4 5h16v11H9l-5 4zM8 9h8M8 12h5',
  More: 'M6 12h.01M12 12h.01M18 12h.01',
  Pause: 'M8 5v14M16 5v14',
  Play: 'M7 5l12 7l-12 7z',
  Plus: 'M12 5v14M5 12h14',
  Refresh: 'M20 12a8 8 0 1 1-2.3-5.6M20 4v4h-4',
  Repeat: 'M4 11V9a3 3 0 0 1 3-3h12M16 3l3 3l-3 3M20 13v2a3 3 0 0 1-3 3H5M8 21l-3-3l3-3',
  RepeatOnce: 'M4 11V9a3 3 0 0 1 3-3h12M16 3l3 3l-3 3M20 13v2a3 3 0 0 1-3 3H5M8 21l-3-3l3-3M12 10v4',
  RotateCcw: 'M4 12a8 8 0 1 0 2.3-5.6M4 4v4h4',
  RotateCw: 'M20 12a8 8 0 1 1-2.3-5.6M20 4v4h-4',
  Running: 'M12 3a9 9 0 1 0 9 9',
  Search: 'M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14zM16 16l4 4',
  SidebarCollapse: 'M4 5h16v14H4zM9 5v14M15 10l-2 2l2 2',
  SidebarExpand: 'M4 5h16v14H4zM9 5v14M13 10l2 2l-2 2',
  Sparkles: 'M12 4l1.5 4.5L18 10l-4.5 1.5L12 16l-1.5-4.5L6 10l4.5-1.5zM18 15l.8 2.2L21 18l-2.2.8L18 21l-.8-2.2L15 18l2.2-.8z',
  Swap: 'M7 4l-3 3l3 3M4 7h13M17 14l3 3l-3 3M20 17H7',
  Ticket: 'M4 7h16v3a2 2 0 0 0 0 4v3H4v-3a2 2 0 0 0 0-4zM14 7v10',
  Trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  Undo: 'M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3',
  UserCheck: 'M9 4a4 4 0 1 0 0 8a4 4 0 1 0 0-8zM3 20c0-3 3-5 6-5s6 2 6 5M16 11l2 2l4-4',
  Wand: 'M4 20L15 9l-2-2L2 18zM15 3v3M19 5l-2 2M21 9h-3',
  Workflows: 'M4 4h6v6H4zM14 14h6v6h-6zM7 10v4a3 3 0 0 0 3 3h4',
  Wrench: 'M15 4a4 4 0 0 0-1 5l-9 9a2 2 0 0 0 3 3l9-9a4 4 0 0 0 5-1l-3-1l-1-3z',
  X: 'M6 6l12 12M18 6L6 18',
  Zap: 'M13 3L5 14h6l-1 7l8-11h-6z',
} as const

export type IconName = keyof typeof PATHS
/** A host's icon set: any subset of the names, each a component taking IconProps. */
export type ComposerIcons = Partial<Record<IconName, ComponentType<IconProps>>>

export const IconsContext = createContext<ComposerIcons>({})

const stroke = (px: number) => Math.round(Math.min(2.1, Math.max(1.6, 25.2 / px)) * 100) / 100

function Glyph({ name, size = 'md', accent, title, className, style, ...rest }: IconProps & { name: IconName }) {
  const px = typeof size === 'number' ? size : PX[size]
  const labelled = !!title || !!rest['aria-label']
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={px} height={px} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={stroke(px)} strokeLinecap="round" strokeLinejoin="round"
      className={`oc-ic${accent ? ' oc-ic-on' : ''}${className ? ` ${className}` : ''}`} style={style}
      role={labelled ? 'img' : undefined} aria-hidden={labelled ? undefined : true} focusable="false" data-icon={name} {...rest}>
      {title ? <title>{title}</title> : null}
      <path d={PATHS[name]} />
    </svg>
  )
}

function icon(name: IconName) {
  const Ic = (props: IconProps) => {
    const Override = useContext(IconsContext)[name]
    return Override ? <Override {...props} /> : <Glyph {...props} name={name} />
  }
  Ic.displayName = `Ic${name}`
  return Ic
}

export const IcAlertCircle = icon('AlertCircle')
export const IcArrowLeft = icon('ArrowLeft')
export const IcArrowRight = icon('ArrowRight')
export const IcBraces = icon('Braces')
export const IcBranch = icon('Branch')
export const IcCheck = icon('Check')
export const IcChevronDown = icon('ChevronDown')
export const IcChevronRight = icon('ChevronRight')
export const IcChevronsUpDown = icon('ChevronsUpDown')
export const IcClock = icon('Clock')
export const IcCode = icon('Code')
export const IcCopy = icon('Copy')
export const IcDatabase = icon('Database')
export const IcDone = icon('Done')
export const IcEnter = icon('Enter')
export const IcFailed = icon('Failed')
export const IcFilter = icon('Filter')
export const IcGlobe = icon('Globe')
export const IcHistory = icon('History')
export const IcListOrdered = icon('ListOrdered')
export const IcLock = icon('Lock')
export const IcMail = icon('Mail')
export const IcMessage = icon('Message')
export const IcMessageText = icon('MessageText')
export const IcMore = icon('More')
export const IcPause = icon('Pause')
export const IcPlay = icon('Play')
export const IcPlus = icon('Plus')
export const IcRefresh = icon('Refresh')
export const IcRepeat = icon('Repeat')
export const IcRepeatOnce = icon('RepeatOnce')
export const IcRotateCcw = icon('RotateCcw')
export const IcRotateCw = icon('RotateCw')
export const IcRunning = icon('Running')
export const IcSearch = icon('Search')
export const IcSidebarCollapse = icon('SidebarCollapse')
export const IcSidebarExpand = icon('SidebarExpand')
export const IcSparkles = icon('Sparkles')
export const IcSwap = icon('Swap')
export const IcTicket = icon('Ticket')
export const IcTrash = icon('Trash')
export const IcUndo = icon('Undo')
export const IcUserCheck = icon('UserCheck')
export const IcWand = icon('Wand')
export const IcWorkflows = icon('Workflows')
export const IcWrench = icon('Wrench')
export const IcX = icon('X')
export const IcZap = icon('Zap')

// ---- Provider marks (host slot) ----

/**
 * A step's provider logo ("slack", "github"…): the host may draw brand marks
 * it is allowed to show. Return null for providers it has no mark for; the
 * editor then picks a generic glyph.
 */
export type ProviderMarkRender = (provider: string, size: IconSize) => ReactNode | null
let providerMarks: ProviderMarkRender | null = null
export function setProviderMarks(render: ProviderMarkRender | null) { providerMarks = render }
export const hasProviderMark = (provider: string | null | undefined) => !!provider && !!providerMarks && providerMarks(provider, 'md') != null
export function ProviderMark({ provider, size = 'md' }: { provider: string; size?: IconSize }) {
  return <>{providerMarks?.(provider, size) ?? null}</>
}
