import { useCallback, useEffect, type RefObject } from 'react';

/**
 * Writes the rendered height of `ref`'s element into the custom property `name` on the root
 * element, and keeps it current as the element resizes, so CSS such as `scroll-padding-top` can
 * follow a top bar whose title wraps. Nothing is stored; the property goes when the page does.
 *
 * A resize observer reports after the next layout, so an action that scrolls right after the
 * element grew would still see the old height. The returned function measures and writes the
 * height at once, for such an action to call first.
 */
export function useMeasuredHeight(ref: RefObject<HTMLElement | null>, name: string): () => void {
  const measure = useCallback(() => {
    const element = ref.current;
    if (element !== null) {
      document.documentElement.style.setProperty(
        name,
        `${String(element.getBoundingClientRect().height)}px`,
      );
    }
  }, [ref, name]);

  useEffect(() => {
    const element = ref.current;
    if (element === null || typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
      document.documentElement.style.removeProperty(name);
    };
  }, [ref, name, measure]);

  return measure;
}
