import { useEffect, type RefObject } from 'react';

/**
 * Writes the rendered height of `ref`'s element into the custom property `name` on the root
 * element, and keeps it current as the element resizes, so CSS such as `scroll-padding-top` can
 * follow a top bar whose title wraps. Nothing is stored; the property goes when the page does.
 */
export function useMeasuredHeight(ref: RefObject<HTMLElement | null>, name: string): void {
  useEffect(() => {
    const element = ref.current;
    if (element === null || typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    const root = document.documentElement;
    const observer = new ResizeObserver(() => {
      root.style.setProperty(name, `${String(element.getBoundingClientRect().height)}px`);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      root.style.removeProperty(name);
    };
  }, [ref, name]);
}
