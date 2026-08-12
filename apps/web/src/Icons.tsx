import React from "react";

const P = (props: { d?: string; children?: React.ReactNode; size?: number; label?: string }) => (
  <svg viewBox="0 0 24 24" width={props.size ?? 17} height={props.size ?? 17} fill="none"
    stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round"
    aria-hidden={props.label ? undefined : true} role={props.label ? 'img' : undefined}
    aria-label={props.label}>{props.d ? <path d={props.d} /> : props.children}</svg>
);
export const Ic = {
  calendar: (s?: number) => <P size={s}><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></P>,
  clock:    (s?: number) => <P size={s}><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></P>,
  place:    (s?: number) => <P size={s}><path d="M12 21s-7-5.1-7-11a7 7 0 1 1 14 0c0 5.9-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/></P>,
  people:   (s?: number) => <P size={s}><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.4 3.4-5 6.5-5s5.7 1.6 6.5 5"/><path d="M15.5 5.9a3.5 3.5 0 0 1 0 6.4M16.5 15.2c2.6.3 4.4 1.8 5 4.8"/></P>,
  bell:     (s?: number) => <P size={s}><path d="M6 16v-5a6 6 0 1 1 12 0v5l1.5 2.5H4.5L6 16z"/><path d="M10 21a2.2 2.2 0 0 0 4 0"/></P>,
  comment:  (s?: number) => <P size={s} d="M4 5h16v11H9l-5 4V5z"/>,
  check:    (s?: number) => <P size={s} d="M5 13l4 4 10-10"/>,
  x:        (s?: number) => <P size={s} d="M6 6l12 12M18 6L6 18"/>,
  plus:     (s?: number) => <P size={s} d="M12 5v14M5 12h14"/>,
  link:     (s?: number) => <P size={s}><path d="M10 14a5 5 0 0 0 7 0l2.5-2.5a5 5 0 0 0-7-7L11 6"/><path d="M14 10a5 5 0 0 0-7 0L4.5 12.5a5 5 0 0 0 7 7L13 18"/></P>,
  home:     (s?: number) => <P size={s} d="M4 11l8-7 8 7v9h-5v-6h-6v6H4v-9z"/>,
  grid:     (s?: number) => <P size={s}><rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/></P>,
  person:   (s?: number) => <P size={s}><circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4.5-6 8-6s7 2 8 6"/></P>,
  camera:   (s?: number) => <P size={s}><path d="M4 8h3l2-2.5h6L17 8h3v12H4V8z"/><circle cx="12" cy="13.5" r="3.2"/></P>,
  edit:     (s?: number) => <P size={s} d="M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19l-4 1z"/>,
  back:     (s?: number) => <P size={s} d="M15 5l-7 7 7 7"/>,
};
