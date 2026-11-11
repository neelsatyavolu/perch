/** Lucide icons at 16px with a 1.5 stroke, coloured by their text role (spec 6.5). Always decorative. */

import type { LucideIcon } from "lucide-preact";

export {
  ArrowDownToLine, ArrowLeft, ArrowUpRight, Bell, BookOpen, Box, Brain, Calendar, Check, ChevronDown, ChevronRight, Clock, Copy, Download, ExternalLink,
  FileText, Folder, Gauge, Globe, History, Info, KeyRound, Lock, Mail, MessageSquare, Monitor, MoreHorizontal, Palette, PanelLeft, PanelLeftClose,
  Pause, Pencil, Pin, Play, Plug, Plus, Puzzle, RefreshCw, Repeat, Search, Settings, Shield, ShieldCheck, SquarePen, Trash2, Upload, User, X, Zap,
} from "lucide-preact";

export function Icon({ of: Glyph, size = 16, label }: { readonly of: LucideIcon; readonly size?: number; readonly label?: string }) {
  return (
    <Glyph
      class="i"
      width={size}
      height={size}
      strokeWidth={1.5}
      aria-hidden={label ? undefined : "true"}
      aria-label={label}
      role={label ? "img" : undefined}
    />
  );
}
