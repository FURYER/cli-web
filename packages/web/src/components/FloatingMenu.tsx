import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

type Props = {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  onClose?: () => void;
  className?: string;
  children: ReactNode;
  placement?: "top-start" | "top-end";
};

/** Portal menu so overflow:hidden parents cannot clip it. */
export function FloatingMenu({
  open,
  anchorRef,
  onClose,
  className = "",
  children,
  placement = "top-start",
}: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({
    position: "fixed",
    left: 0,
    top: 0,
    zIndex: 80,
    visibility: "hidden",
  });

  useLayoutEffect(() => {
    if (!open) return;

    const update = () => {
      const anchor = anchorRef.current;
      const menu = menuRef.current;
      if (!anchor) return;
      const r = anchor.getBoundingClientRect();
      const mw = menu?.offsetWidth ?? 160;
      const mh = menu?.offsetHeight ?? 120;
      const gap = 6;
      let left = placement === "top-end" ? r.right - mw : r.left;
      left = Math.max(8, Math.min(left, window.innerWidth - mw - 8));
      let top = r.top - mh - gap;
      if (top < 8) {
        top = Math.min(r.bottom + gap, window.innerHeight - mh - 8);
      }
      setStyle({
        position: "fixed",
        left,
        top,
        zIndex: 80,
        visibility: "visible",
      });
    };

    update();
    const raf = requestAnimationFrame(update);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, anchorRef, placement, children]);

  useLayoutEffect(() => {
    if (!open || !onClose) return;
    const close = onClose;
    function onDoc(e: MouseEvent) {
      const t = e.target as Node;
      if (menuRef.current?.contains(t)) return;
      if (anchorRef.current?.contains(t)) return;
      close();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose, anchorRef]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div ref={menuRef} style={style} className={className}>
      {children}
    </div>,
    document.body,
  );
}
