"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { askFolioViewportRect } from "./ask-folio-viewport";

export function FolioCompactSheet({ open, onOpenChange, title, description, children, className = "", dismissBlocked = false, onDismissBlocked, onEscapeKeyDown, headerActions, initialExpanded = false, keyboardAware = false }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
  dismissBlocked?: boolean;
  onDismissBlocked?: () => void;
  onEscapeKeyDown?: (event: { preventDefault: () => void }) => void;
  headerActions?: ReactNode;
  initialExpanded?: boolean;
  keyboardAware?: boolean;
}) {
  const [expanded, setExpanded] = useState(initialExpanded);
  const panelRef = useRef<HTMLDivElement>(null);
  const touchStart = useRef<number | null>(null);
  const suppressClick = useRef(false);
  const syncPanelViewport = useCallback((panel: HTMLDivElement | null) => {
    if (!panel) return;
    const viewport = window.visualViewport;
    const rect = keyboardAware
      ? askFolioViewportRect(viewport, window.innerHeight, document.documentElement.clientHeight)
      : { height: viewport?.height || window.innerHeight, top: viewport?.offsetTop || 0, keyboardOpen: false };
    panel.style.setProperty("--folio-sheet-viewport-height", `${rect.height}px`);
    panel.style.setProperty("--folio-sheet-viewport-top", `${rect.top}px`);
    panel.style.setProperty("--folio-sheet-compact-height", `${Math.round(rect.height * 0.47)}px`);
    panel.dataset.keyboardOpen = String(rect.keyboardOpen);
    if (keyboardAware && rect.keyboardOpen) setExpanded(true);
  }, [keyboardAware]);
  const attachPanel = useCallback((panel: HTMLDivElement | null) => {
    panelRef.current = panel;
    syncPanelViewport(panel);
  }, [syncPanelViewport]);
  useEffect(() => {
    if (!open) return;
    const syncViewport = () => syncPanelViewport(panelRef.current);
    syncViewport();
    window.visualViewport?.addEventListener("resize", syncViewport);
    window.visualViewport?.addEventListener("scroll", syncViewport);
    window.addEventListener("resize", syncViewport);
    return () => {
      window.visualViewport?.removeEventListener("resize", syncViewport);
      window.visualViewport?.removeEventListener("scroll", syncViewport);
      window.removeEventListener("resize", syncViewport);
    };
  }, [open, syncPanelViewport]);
  const requestClose = () => {
    if (dismissBlocked) { onDismissBlocked?.(); return; }
    setExpanded(initialExpanded);
    onOpenChange(false);
  };
  return <Sheet open={open} onOpenChange={(next) => next ? onOpenChange(true) : requestClose()}>
    <SheetContent
      ref={attachPanel}
      side="bottom"
      showCloseButton={false}
      className={`folio-compact-sheet ${expanded ? "is-expanded" : "is-compact"} ${className}`}
      onEscapeKeyDown={(event) => { if (dismissBlocked) { event.preventDefault(); onDismissBlocked?.(); } else onEscapeKeyDown?.(event); }}
      onInteractOutside={(event) => { if (dismissBlocked) { event.preventDefault(); onDismissBlocked?.(); } }}
    >
      <button
        className="folio-compact-sheet-handle"
        type="button"
        aria-label={expanded ? `Collapse ${title}` : `Expand ${title}`}
        onClick={(event) => { if (suppressClick.current) { suppressClick.current = false; event.preventDefault(); return; } setExpanded(value => !value); }}
        onTouchStart={(event) => { touchStart.current = event.touches[0]?.clientY ?? null; }}
        onTouchEnd={(event) => {
          if (touchStart.current === null) return;
          const delta = event.changedTouches[0]?.clientY - touchStart.current;
          if (delta < -45) { setExpanded(true); suppressClick.current = true; }
          else if (delta > 45) { if (expanded) setExpanded(false); else requestClose(); suppressClick.current = true; }
          touchStart.current = null;
          if (suppressClick.current) window.setTimeout(() => { suppressClick.current = false; }, 350);
        }}
        onTouchCancel={() => { touchStart.current = null; }}
      ><span aria-hidden="true" /></button>
      <SheetHeader className="folio-compact-sheet-header">
        <div className="folio-compact-sheet-heading"><SheetTitle>{title}</SheetTitle>{description && <SheetDescription>{description}</SheetDescription>}</div>
        <div className="folio-compact-sheet-actions">
          {headerActions}
          <button type="button" aria-label={expanded ? `Collapse ${title}` : `Expand ${title}`} onClick={() => setExpanded(value => !value)}>{expanded ? <ChevronDown aria-hidden="true" /> : <ChevronUp aria-hidden="true" />}</button>
          <button type="button" aria-label={`Close ${title}`} onClick={requestClose} disabled={dismissBlocked}><X aria-hidden="true" /></button>
        </div>
      </SheetHeader>
      <div className="folio-compact-sheet-body">{children}</div>
    </SheetContent>
  </Sheet>;
}
