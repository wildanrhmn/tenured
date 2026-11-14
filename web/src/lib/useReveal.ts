import { useEffect, type RefObject } from "react";

/** Fades in every [data-reveal] inside `root` as it scrolls into view (CSS does the motion). */
export function useReveal(root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const items = [...el.querySelectorAll<HTMLElement>("[data-reveal]")];
    if (typeof IntersectionObserver === "undefined") {
      items.forEach((i) => i.classList.add("in"));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          e.target.classList.add("in");
          io.unobserve(e.target);
        }
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.05 },
    );
    items.forEach((i) => io.observe(i));
    return () => io.disconnect();
  }, [root]);
}
